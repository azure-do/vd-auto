import type {
  R2ObjectDescriptor,
  R2ReadClient,
  R2RangeResponse,
} from "./e5-contracts";

const DEFAULT_RANGE_SIZE = 8 * 1024 * 1024;
const DEFAULT_MAX_READ_FAILURES = 2;

export type R2StreamErrorCode =
  | "R2_SOURCE_UNAVAILABLE"
  | "R2_SIZE_MISMATCH"
  | "R2_CHECKSUM_MISMATCH"
  | "R2_RANGE_INVALID"
  | "R2_RANGE_READ_FAILED";

/** Deliberately contains no object key, URL, credential, or provider response text. */
export class R2StreamError extends Error {
  constructor(
    readonly code: R2StreamErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "R2StreamError";
  }
}

export interface VerifiedR2Source {
  readonly size: number;
  readonly checksumSha256: string;
  /** Safe to JSON serialize into the trusted publication ledger; contains no URL or credential. */
  readonly snapshot: R2VerifiedSnapshot;
  /** Opens exactly [offset, size). A resumed consumer never re-reads the prefix. */
  open(offset?: number): ReadableStream<Uint8Array>;
}

export interface R2VerifiedSnapshot {
  readonly schemaVersion: 1;
  readonly objectKey: string;
  readonly size: number;
  readonly checksumSha256: string;
  readonly etag: string;
  readonly version: string;
}

export interface R2StreamingSource {
  /** Reads and hashes the complete source before returning a downstream stream factory. */
  verify(source: Readonly<R2ObjectDescriptor>): Promise<VerifiedR2Source>;
  /** Restores a previously verified version without re-reading byte zero. */
  rehydrate(
    source: Readonly<R2ObjectDescriptor>,
    snapshot: unknown,
  ): VerifiedR2Source;
}

interface Snapshot {
  key: string;
  size: number;
  checksumSha256: string;
  etag: string;
  version: string;
}

function hex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function checksumHex(object: R2Object): string | null {
  return object.checksums.sha256 ? hex(object.checksums.sha256).toLowerCase() : null;
}

function rangeMatches(
  range: R2Range | undefined,
  offset: number,
  length: number,
): boolean {
  return Boolean(
    range &&
      "offset" in range &&
      range.offset === offset &&
      "length" in range &&
      range.length === length,
  );
}

function assertOffset(offset: number, size: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    throw new TypeError("offset must be a safe integer within the verified source");
  }
}

function assertSource(source: Readonly<R2ObjectDescriptor>): void {
  if (
    typeof source.objectKey !== "string" ||
    source.objectKey.length === 0 ||
    source.objectKey.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(source.objectKey) ||
    source.objectKey.includes("://") ||
    source.objectKey.includes("@")
  ) {
    throw new TypeError("objectKey must be a non-secret internal object reference");
  }
  if (!Number.isSafeInteger(source.expectedSize) || source.expectedSize <= 0) {
    throw new TypeError("expectedSize must be a positive safe integer");
  }
  if (!/^[0-9a-f]{64}$/i.test(source.expectedSha256)) {
    throw new TypeError("expectedSha256 must be a SHA-256 digest");
  }
}

const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "objectKey",
  "size",
  "checksumSha256",
  "etag",
  "version",
]);

function snapshotFromUnknown(
  source: Readonly<R2ObjectDescriptor>,
  value: unknown,
): Snapshot {
  assertSource(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new R2StreamError("R2_RANGE_INVALID", false, "The verified source snapshot was invalid");
  }
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(record));
  const keys = Reflect.ownKeys(record);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    descriptors.some((descriptor) => !("value" in descriptor)) ||
    keys.some((key) => typeof key !== "string" || !SNAPSHOT_KEYS.has(key)) ||
    keys.length !== SNAPSHOT_KEYS.size ||
    record.schemaVersion !== 1 ||
    record.objectKey !== source.objectKey ||
    record.size !== source.expectedSize ||
    typeof record.checksumSha256 !== "string" ||
    record.checksumSha256.toLowerCase() !== source.expectedSha256.toLowerCase() ||
    typeof record.etag !== "string" ||
    record.etag.length === 0 ||
    record.etag.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(record.etag) ||
    typeof record.version !== "string" ||
    record.version.length === 0 ||
    record.version.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(record.version)
  ) {
    throw new R2StreamError("R2_RANGE_INVALID", false, "The verified source snapshot was invalid");
  }
  return {
    key: source.objectKey,
    size: source.expectedSize,
    checksumSha256: source.expectedSha256.toLowerCase(),
    etag: record.etag,
    version: record.version,
  };
}

function serializableSnapshot(snapshot: Snapshot): R2VerifiedSnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    objectKey: snapshot.key,
    size: snapshot.size,
    checksumSha256: snapshot.checksumSha256,
    etag: snapshot.etag,
    version: snapshot.version,
  });
}

function byteChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new R2StreamError(
    "R2_RANGE_INVALID",
    false,
    "The source range returned an invalid byte stream",
  );
}

/**
 * Cloudflare binding adapter for E-5.5. It never creates a signed URL and never writes to disk.
 * Every range is conditional on the HEAD ETag so validation and downstream reads use one object
 * version even when the key is overwritten concurrently.
 */
export class CloudflareR2StreamingSource implements R2StreamingSource {
  private readonly rangeSize: number;
  private readonly maxReadFailures: number;

  constructor(
    private readonly bucket: R2Bucket,
    options: { rangeSize?: number; maxReadFailures?: number } = {},
  ) {
    this.rangeSize = options.rangeSize ?? DEFAULT_RANGE_SIZE;
    this.maxReadFailures = options.maxReadFailures ?? DEFAULT_MAX_READ_FAILURES;
    if (!Number.isSafeInteger(this.rangeSize) || this.rangeSize <= 0) {
      throw new TypeError("rangeSize must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxReadFailures) || this.maxReadFailures < 0) {
      throw new TypeError("maxReadFailures must be a non-negative safe integer");
    }
  }

  async verify(source: Readonly<R2ObjectDescriptor>): Promise<VerifiedR2Source> {
    assertSource(source);
    let head: R2Object | null;
    try {
      head = await this.bucket.head(source.objectKey);
    } catch {
      throw new R2StreamError(
        "R2_SOURCE_UNAVAILABLE",
        true,
        "The source object metadata could not be read",
      );
    }
    if (!head) {
      throw new R2StreamError(
        "R2_SOURCE_UNAVAILABLE",
        true,
        "The source object metadata could not be read",
      );
    }
    if (head.size !== source.expectedSize) {
      throw new R2StreamError(
        "R2_SIZE_MISMATCH",
        false,
        "The source object size did not match the approved metadata",
      );
    }
    const storedChecksum = checksumHex(head);
    if (storedChecksum !== source.expectedSha256.toLowerCase()) {
      throw new R2StreamError(
        "R2_CHECKSUM_MISMATCH",
        false,
        "The source object checksum did not match the approved metadata",
      );
    }

    if (!head.etag || !head.version) {
      throw new R2StreamError(
        "R2_RANGE_INVALID",
        false,
        "The source object version could not be pinned",
      );
    }
    const snapshot: Snapshot = {
      key: source.objectKey,
      size: head.size,
      checksumSha256: storedChecksum,
      etag: head.etag,
      version: head.version,
    };
    try {
      const stream = this.openSnapshot(snapshot, 0);
      // TypeScript's WebWorker lib declares Crypto without Cloudflare's extension; the runtime
      // binding and @cloudflare/workers-types expose DigestStream on crypto.
      const cloudflareCrypto = crypto as Crypto & { DigestStream: typeof DigestStream };
      const digestStream = new cloudflareCrypto.DigestStream("SHA-256");
      const [, digest] = await Promise.all([
        stream.pipeTo(digestStream),
        digestStream.digest,
      ]);
      if (hex(digest).toLowerCase() !== snapshot.checksumSha256) {
        throw new R2StreamError(
          "R2_CHECKSUM_MISMATCH",
          false,
          "The bytes returned by the source did not match the approved checksum",
        );
      }
    } catch (error) {
      if (error instanceof R2StreamError) throw error;
      throw new R2StreamError(
        "R2_RANGE_READ_FAILED",
        true,
        "The source range could not be read",
      );
    }

    return this.verifiedSource(snapshot);
  }

  rehydrate(
    source: Readonly<R2ObjectDescriptor>,
    persistedSnapshot: unknown,
  ): VerifiedR2Source {
    return this.verifiedSource(snapshotFromUnknown(source, persistedSnapshot));
  }

  private verifiedSource(snapshot: Snapshot): VerifiedR2Source {
    const openSnapshot = this.openSnapshot.bind(this);
    return Object.freeze({
      size: snapshot.size,
      checksumSha256: snapshot.checksumSha256,
      snapshot: serializableSnapshot(snapshot),
      open(offset = 0): ReadableStream<Uint8Array> {
        assertOffset(offset, snapshot.size);
        return openSnapshot(snapshot, offset);
      },
    });
  }

  private openSnapshot(snapshot: Snapshot, initialOffset: number): ReadableStream<Uint8Array> {
    assertOffset(initialOffset, snapshot.size);
    const bucket = this.bucket;
    const rangeSize = this.rangeSize;
    const maxReadFailures = this.maxReadFailures;
    let cursor = initialOffset;
    let requestEnd = initialOffset;
    let failures = 0;
    let cancelled = false;
    let reader: ReadableStreamDefaultReader | null = null;

    const discardReader = async (): Promise<void> => {
      const current = reader;
      reader = null;
      if (current) {
        try { await current.cancel(); } catch { /* The next GET is authoritative. */ }
      }
    };

    const openNextRange = async (): Promise<void> => {
      const length = Math.min(rangeSize, snapshot.size - cursor);
      let response: R2ObjectBody | R2Object | null;
      try {
        response = await bucket.get(snapshot.key, {
          range: { offset: cursor, length },
          onlyIf: { etagMatches: snapshot.etag },
        });
      } catch {
        if (cancelled) return;
        throw new R2StreamError(
          "R2_RANGE_READ_FAILED",
          true,
          "The source range could not be read",
        );
      }
      if (cancelled) {
        if (response && "body" in response) {
          try { await response.body.cancel(); } catch { /* Cancellation is terminal. */ }
        }
        return;
      }
      if (
        !response ||
        !("body" in response) ||
        response.size !== snapshot.size ||
        response.key !== snapshot.key ||
        response.etag !== snapshot.etag ||
        response.version !== snapshot.version ||
        checksumHex(response) !== snapshot.checksumSha256 ||
        !rangeMatches(response.range, cursor, length)
      ) {
        throw new R2StreamError(
          "R2_RANGE_INVALID",
          false,
          "The source range response was inconsistent",
        );
      }
      requestEnd = cursor + length;
      reader = response.body.getReader();
    };

    const retryOrThrow = async (error: unknown): Promise<void> => {
      const failedAtRangeEnd = reader !== null && cursor === requestEnd;
      await discardReader();
      if (cancelled) return;
      if (error instanceof R2StreamError && !error.retryable) throw error;
      // At a range boundary no unread bytes remain in that response. A later GET
      // cannot validate its missing EOF, so do not silently skip a tail failure.
      if (failedAtRangeEnd || cursor === snapshot.size || failures >= maxReadFailures) {
        throw new R2StreamError(
          "R2_RANGE_READ_FAILED",
          true,
          "The source range could not be read",
        );
      }
      failures += 1;
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Byte count alone cannot prove completion: consume the final range's EOF
        // so trailing bytes or a transport failure cannot be silently cancelled.
        while (!cancelled && (cursor < snapshot.size || reader !== null)) {
          try {
            if (!reader) await openNextRange();
            if (cancelled) return;
            const result = await reader!.read();
            if (cancelled) return;
            if (result.done) {
              reader = null;
              if (cursor !== requestEnd) {
                await retryOrThrow(new Error("range ended early"));
                continue;
              }
              continue;
            }
            const chunk = byteChunk(result.value);
            if (chunk.byteLength === 0) continue;
            if (chunk.byteLength > requestEnd - cursor) {
              throw new R2StreamError(
                "R2_RANGE_INVALID",
                false,
                "The source range response exceeded its requested boundary",
              );
            }
            cursor += chunk.byteLength;
            controller.enqueue(chunk);
            return;
          } catch (error) {
            await retryOrThrow(error);
          }
        }
        await discardReader();
        if (cancelled) return;
        controller.close();
      },
      async cancel() {
        cancelled = true;
        await discardReader();
      },
    });
  }
}

function isStreamingSource(
  value: R2ReadClient | R2StreamingSource,
): value is R2StreamingSource {
  const candidate = value as Partial<R2StreamingSource>;
  return typeof candidate.verify === "function" && typeof candidate.rehydrate === "function";
}

async function digestHex(stream: ReadableStream<Uint8Array>): Promise<string> {
  const cloudflareCrypto = crypto as Crypto & { DigestStream: typeof DigestStream };
  const digestStream = new cloudflareCrypto.DigestStream("SHA-256");
  const [, digest] = await Promise.all([stream.pipeTo(digestStream), digestStream.digest]);
  return hex(digest).toLowerCase();
}

/**
 * Compatibility for the E-5.1 fake contract. It preserves the old head/readRange interface while
 * replacing its whole-object concatenation with the same bounded stream verification semantics.
 */
class ContractRangeStreamingSource {
  constructor(
    private readonly client: R2ReadClient,
    private readonly rangeSize: number,
  ) {}

  async verify(source: Readonly<R2ObjectDescriptor>): Promise<VerifiedR2Source> {
    assertSource(source);
    let metadata;
    try {
      metadata = await this.client.headObject(source.objectKey);
    } catch {
      throw new R2StreamError("R2_SOURCE_UNAVAILABLE", true, "The source object could not be read");
    }
    if (metadata.size !== source.expectedSize) {
      throw new R2StreamError(
        "R2_SIZE_MISMATCH",
        false,
        "The source object size did not match the approved metadata",
      );
    }
    if (metadata.checksumSha256.toLowerCase() !== source.expectedSha256.toLowerCase()) {
      throw new R2StreamError(
        "R2_CHECKSUM_MISMATCH",
        false,
        "The source object checksum did not match the approved metadata",
      );
    }
    const snapshot: Snapshot = {
      key: source.objectKey,
      size: source.expectedSize,
      checksumSha256: source.expectedSha256.toLowerCase(),
      etag: `contract-${source.expectedSha256.toLowerCase()}`,
      version: "contract-v1",
    };
    const verified = this.verifiedSource(snapshot);
    try {
      if (await digestHex(verified.open()) !== snapshot.checksumSha256) {
        throw new R2StreamError(
          "R2_CHECKSUM_MISMATCH",
          false,
          "The bytes returned by the source did not match the approved checksum",
        );
      }
    } catch (error) {
      if (error instanceof R2StreamError) throw error;
      throw new R2StreamError("R2_RANGE_READ_FAILED", true, "The source range could not be read");
    }
    return verified;
  }

  private verifiedSource(snapshot: Snapshot): VerifiedR2Source {
    const client = this.client;
    const rangeSize = this.rangeSize;
    return Object.freeze({
      size: snapshot.size,
      checksumSha256: snapshot.checksumSha256,
      snapshot: serializableSnapshot(snapshot),
      open(offset = 0): ReadableStream<Uint8Array> {
        assertOffset(offset, snapshot.size);
        let cursor = offset;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (cursor === snapshot.size) {
              controller.close();
              return;
            }
            const length = Math.min(rangeSize, snapshot.size - cursor);
            let response: R2RangeResponse;
            try {
              response = await client.readRange({ objectKey: snapshot.key, offset: cursor, length });
            } catch {
              controller.error(new R2StreamError(
                "R2_RANGE_READ_FAILED",
                true,
                "The source range could not be read",
              ));
              return;
            }
            if (
              response.offset !== cursor ||
              response.totalSize !== snapshot.size ||
              !(response.bytes instanceof Uint8Array) ||
              response.bytes.byteLength !== length
            ) {
              controller.error(new R2StreamError(
                "R2_RANGE_INVALID",
                false,
                "The source range response was inconsistent",
              ));
              return;
            }
            cursor += response.bytes.byteLength;
            controller.enqueue(response.bytes);
          },
        });
      },
    });
  }
}

/** Single executable entry used by E5PublishContractService and later E-5.6 integration. */
export async function verifyR2Source(
  client: R2ReadClient | R2StreamingSource,
  source: Readonly<R2ObjectDescriptor>,
  options: { contractRangeSize: number },
): Promise<VerifiedR2Source> {
  if (isStreamingSource(client)) return client.verify(source);
  return new ContractRangeStreamingSource(client, options.contractRangeSize).verify(source);
}
