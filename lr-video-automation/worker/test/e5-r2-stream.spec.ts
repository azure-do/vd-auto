import { describe, expect, it } from "vitest";
import type { R2ObjectDescriptor } from "../src/e5-contracts";
import {
  CloudflareR2StreamingSource,
  R2StreamError,
} from "../src/e5-r2-stream";

const ZERO_300_MIB_SHA256 = "17a88af83717f68b8bd97873ffcf022c8aed703416fe9b08e0fa9e3287692bf0";

function checksumBuffer(checksum: string): ArrayBuffer {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(checksum.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    size += result.value.byteLength;
  }
  const complete = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    complete.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return complete;
}

interface FakeBucketOptions {
  size: number;
  checksum: string;
  byteAt?: (offset: number) => number;
  reportedSize?: number;
  corruptAt?: number;
  failOnceAfterBytes?: number;
  providerError?: Error;
  replaceBeforeFirstGet?: boolean;
  finalTail?: "extra" | "error";
  tailAtOffset?: number;
}

function fakeBucket(options: FakeBucketOptions): {
  bucket: R2Bucket;
  requests: Array<{ offset: number; length: number }>;
  headCalls(): number;
  maxChunkBytes(): number;
  eofReads(): number;
  cancellations(): number;
} {
  const requests: Array<{ offset: number; length: number }> = [];
  let maximumChunkBytes = 0;
  let headCallCount = 0;
  let eofReadCount = 0;
  let cancellationCount = 0;
  let remainingBodyFailures = options.failOnceAfterBytes === undefined ? 0 : 1;
  const etag = "fixture-etag";
  const size = options.reportedSize ?? options.size;
  const checksums = {
    sha256: checksumBuffer(options.checksum),
    toJSON: () => ({}),
  } as R2Checksums;
  const metadata = {
    key: "r2_object_fixture",
    version: "fixture-version",
    size,
    etag,
    httpEtag: `\"${etag}\"`,
    checksums,
    uploaded: new Date("2026-08-16T00:00:00.000Z"),
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
  };

  const bucket = {
    async head() {
      headCallCount += 1;
      if (options.providerError) throw options.providerError;
      return metadata;
    },
    async get(
      _key: string,
      input: { range: { offset: number; length: number }; onlyIf: { etagMatches: string } },
    ) {
      if (options.providerError) throw options.providerError;
      if (options.replaceBeforeFirstGet && requests.length === 0) {
        return { ...metadata, etag: "replacement-etag" };
      }
      if (input.onlyIf.etagMatches !== etag) return metadata;
      const { offset, length } = input.range;
      requests.push({ offset, length });
      let emitted = 0;
      const shouldFail = remainingBodyFailures > 0;
      if (shouldFail) remainingBodyFailures -= 1;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (shouldFail && emitted >= (options.failOnceAfterBytes ?? 0)) {
            controller.error(new Error("injected transient body failure"));
            return;
          }
          if (emitted >= length) {
            const injectTail = offset + length === options.size || offset === options.tailAtOffset;
            if (injectTail && options.finalTail === "extra") {
              controller.enqueue(new Uint8Array([255]));
              return;
            }
            if (injectTail && options.finalTail === "error") {
              controller.error(new Error("injected final EOF failure"));
              return;
            }
            eofReadCount += 1;
            controller.close();
            return;
          }
          const beforeFailure = shouldFail
            ? Math.max(1, (options.failOnceAfterBytes ?? 0) - emitted)
            : 64 * 1024;
          const chunkLength = Math.min(64 * 1024, length - emitted, beforeFailure);
          const chunk = new Uint8Array(chunkLength);
          for (let index = 0; index < chunkLength; index += 1) {
            const absolute = offset + emitted + index;
            chunk[index] = options.byteAt?.(absolute) ?? 0;
            if (absolute === options.corruptAt) chunk[index] = chunk[index]! ^ 0xff;
          }
          maximumChunkBytes = Math.max(maximumChunkBytes, chunk.byteLength);
          emitted += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() { cancellationCount += 1; },
      }, { highWaterMark: 0 });
      return {
        ...metadata,
        range: { offset, length },
        body,
        bodyUsed: false,
      };
    },
  } as unknown as R2Bucket;

  return {
    bucket,
    requests,
    headCalls: () => headCallCount,
    maxChunkBytes: () => maximumChunkBytes,
    eofReads: () => eofReadCount,
    cancellations: () => cancellationCount,
  };
}

function descriptor(size: number, checksum: string): R2ObjectDescriptor {
  return { objectKey: "r2_object_fixture", expectedSize: size, expectedSha256: checksum };
}

describe("CloudflareR2StreamingSource", () => {
  it.each(["get", "get rejection", "read"] as const)("cancels a pending %s without retrying or delivering bytes", async (phase) => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let releaseGet!: () => void;
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve; });
    let getCalls = 0;
    let bodyReads = 0;
    let bodyCancels = 0;
    const checksum = "00".repeat(32);
    const bucket = {
      async get() {
        getCalls += 1;
        if (phase !== "read") {
          signalEntered();
          await getGate;
          if (phase === "get rejection") throw new Error("injected late GET failure");
        }
        return {
          key: "r2_object_fixture", size: 20, etag: "fixture-etag", version: "fixture-version",
          checksums: { sha256: checksumBuffer(checksum) }, range: { offset: 0, length: 4 },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              bodyReads += 1;
              if (phase === "read" && getCalls === 1) {
                signalEntered(); // Keep the first body read pending until cancellation.
              } else {
                controller.enqueue(new Uint8Array([1]));
              }
            },
            cancel() { bodyCancels += 1; },
          }, { highWaterMark: 0 }),
        };
      },
    } as unknown as R2Bucket;
    const source = new CloudflareR2StreamingSource(bucket, { rangeSize: 4 }).rehydrate(
      descriptor(20, checksum),
      { schemaVersion: 1, objectKey: "r2_object_fixture", size: 20,
        checksumSha256: checksum, etag: "fixture-etag", version: "fixture-version" },
    );
    const reader = source.open().getReader();
    const pendingRead = reader.read();
    await entered;
    await reader.cancel();
    releaseGet();
    expect(await pendingRead).toEqual({ done: true, value: undefined });
    await reader.closed;
    // Let the in-flight GET/read continuation settle; Vitest also reports any
    // unhandled rejection rather than hiding errors from the cancelled pull.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCalls).toBe(1);
    expect(bodyReads).toBe(phase === "read" ? 1 : 0);
    expect(bodyCancels).toBe(phase === "get rejection" ? 0 : 1);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("requires exact EOF after the final bytes during verification and downstream reads", async () => {
    const bytes = new TextEncoder().encode("exact EOF");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({ size: bytes.length, checksum, byteAt: (offset) => bytes[offset]! });
    const verified = await new CloudflareR2StreamingSource(fake.bucket)
      .verify(descriptor(bytes.length, checksum));
    expect(fake.eofReads()).toBe(1);
    expect(await collect(verified.open())).toEqual(bytes);
    expect(fake.eofReads()).toBe(2);
    expect(fake.cancellations()).toBe(0);
  });

  it.each(["extra", "error"] as const)("rejects correct final bytes followed by %s during verification", async (finalTail) => {
    const bytes = new TextEncoder().encode("final range");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({ size: bytes.length, checksum, byteAt: (offset) => bytes[offset]!, finalTail });
    await expect(new CloudflareR2StreamingSource(fake.bucket, { rangeSize: 6 })
      .verify(descriptor(bytes.length, checksum)))
      .rejects.toMatchObject({
        code: finalTail === "extra" ? "R2_RANGE_INVALID" : "R2_RANGE_READ_FAILED",
        retryable: finalTail === "error",
      });
    expect(fake.requests).toEqual([{ offset: 0, length: 6 }, { offset: 6, length: 5 }]);
    if (finalTail === "extra") expect(fake.cancellations()).toBe(1);
  });

  it.each(["extra", "error"] as const)("rejects correct final bytes followed by %s in a resumed downstream stream", async (finalTail) => {
    const bytes = new TextEncoder().encode("final range");
    const checksum = await sha256(bytes);
    const options: FakeBucketOptions = { size: bytes.length, checksum, byteAt: (offset) => bytes[offset]! };
    const fake = fakeBucket(options);
    const verified = await new CloudflareR2StreamingSource(fake.bucket)
      .verify(descriptor(bytes.length, checksum));
    fake.requests.length = 0;
    options.finalTail = finalTail;
    await expect(collect(verified.open(6))).rejects.toMatchObject({
      code: finalTail === "extra" ? "R2_RANGE_INVALID" : "R2_RANGE_READ_FAILED",
    });
    expect(fake.requests).toEqual([{ offset: 6, length: 5 }]);
  });

  it.each(["extra", "error"] as const)("rejects %s at an intermediate range boundary without skipping its EOF", async (finalTail) => {
    const bytes = new TextEncoder().encode("final range");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({
      size: bytes.length, checksum, byteAt: (offset) => bytes[offset]!, finalTail, tailAtOffset: 0,
    });
    await expect(new CloudflareR2StreamingSource(fake.bucket, { rangeSize: 6 })
      .verify(descriptor(bytes.length, checksum))).rejects.toMatchObject({
        code: finalTail === "extra" ? "R2_RANGE_INVALID" : "R2_RANGE_READ_FAILED",
      });
    expect(fake.requests).toEqual([{ offset: 0, length: 6 }]);
  });

  it("verifies the complete object, then exposes bounded downstream ranges", async () => {
    const bytes = new TextEncoder().encode("0123456789abcdef");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({ size: bytes.byteLength, checksum, byteAt: (offset) => bytes[offset]! });
    const source = new CloudflareR2StreamingSource(fake.bucket, { rangeSize: 5 });

    const verified = await source.verify(descriptor(bytes.byteLength, checksum));
    expect(await collect(verified.open())).toEqual(bytes);
    expect(fake.requests).toEqual([
      { offset: 0, length: 5 }, { offset: 5, length: 5 },
      { offset: 10, length: 5 }, { offset: 15, length: 1 },
      { offset: 0, length: 5 }, { offset: 5, length: 5 },
      { offset: 10, length: 5 }, { offset: 15, length: 1 },
    ]);
  });

  it("fails closed before returning a downstream source when bytes are corrupt", async () => {
    const bytes = new TextEncoder().encode("approved bytes");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({
      size: bytes.byteLength,
      checksum,
      byteAt: (offset) => bytes[offset]!,
      corruptAt: 3,
    });

    await expect(new CloudflareR2StreamingSource(fake.bucket, { rangeSize: 4 })
      .verify(descriptor(bytes.byteLength, checksum)))
      .rejects.toMatchObject({ code: "R2_CHECKSUM_MISMATCH", retryable: false });
  });

  it("rejects a size mismatch without issuing a Range GET", async () => {
    const checksum = "00".repeat(32);
    const fake = fakeBucket({ size: 8, reportedSize: 7, checksum });

    await expect(new CloudflareR2StreamingSource(fake.bucket)
      .verify(descriptor(8, checksum)))
      .rejects.toMatchObject({ code: "R2_SIZE_MISMATCH", retryable: false });
    expect(fake.requests).toEqual([]);
  });

  it("retries a failed body from the first byte not yet delivered", async () => {
    const bytes = new TextEncoder().encode("range-retry");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({
      size: bytes.byteLength,
      checksum,
      byteAt: (offset) => bytes[offset]!,
      failOnceAfterBytes: 2,
    });

    const verified = await new CloudflareR2StreamingSource(fake.bucket, {
      rangeSize: 6,
      maxReadFailures: 1,
    }).verify(descriptor(bytes.byteLength, checksum));

    expect(fake.requests.slice(0, 2)).toEqual([
      { offset: 0, length: 6 },
      { offset: 2, length: 6 },
    ]);
    fake.requests.length = 0;
    expect(await collect(verified.open(7))).toEqual(bytes.slice(7));
    expect(fake.requests[0]).toEqual({ offset: 7, length: 4 });
  });

  it("fails closed when the object changes after HEAD", async () => {
    const bytes = new TextEncoder().encode("immutable snapshot");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({
      size: bytes.byteLength,
      checksum,
      byteAt: (offset) => bytes[offset]!,
      replaceBeforeFirstGet: true,
    });

    await expect(new CloudflareR2StreamingSource(fake.bucket)
      .verify(descriptor(bytes.byteLength, checksum)))
      .rejects.toMatchObject({ code: "R2_RANGE_INVALID", retryable: false });
  });

  it("fails the downstream stream when the pinned object changes after verification", async () => {
    const bytes = new TextEncoder().encode("replace-after-verification");
    const checksum = await sha256(bytes);
    const options: FakeBucketOptions = {
      size: bytes.byteLength,
      checksum,
      byteAt: (offset) => bytes[offset]!,
    };
    const fake = fakeBucket(options);
    const verified = await new CloudflareR2StreamingSource(fake.bucket)
      .verify(descriptor(bytes.byteLength, checksum));
    fake.requests.length = 0;
    options.replaceBeforeFirstGet = true;

    await expect(collect(verified.open()))
      .rejects.toMatchObject({ code: "R2_RANGE_INVALID", retryable: false });
  });

  it("rehydrates a pinned source across invocations without rereading byte zero", async () => {
    const bytes = new TextEncoder().encode("resume-across-worker-invocations");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({ size: bytes.byteLength, checksum, byteAt: (offset) => bytes[offset]! });
    const approved = descriptor(bytes.byteLength, checksum);
    const firstInvocation = new CloudflareR2StreamingSource(fake.bucket, { rangeSize: 8 });
    const verified = await firstInvocation.verify(approved);
    const persisted = JSON.parse(JSON.stringify(verified.snapshot)) as unknown;

    fake.requests.length = 0;
    const secondInvocation = new CloudflareR2StreamingSource(fake.bucket, { rangeSize: 8 });
    const restored = secondInvocation.rehydrate(approved, persisted);
    expect(await collect(restored.open(12))).toEqual(bytes.slice(12));
    expect(fake.headCalls()).toBe(1);
    expect(fake.requests[0]).toEqual({ offset: 12, length: 8 });
    expect(fake.requests.every(({ offset }) => offset >= 12)).toBe(true);
  });

  it("rejects a snapshot rebound to another approved object before any Range GET", async () => {
    const bytes = new TextEncoder().encode("approved snapshot");
    const checksum = await sha256(bytes);
    const fake = fakeBucket({ size: bytes.byteLength, checksum, byteAt: (offset) => bytes[offset]! });
    const source = new CloudflareR2StreamingSource(fake.bucket);
    const verified = await source.verify(descriptor(bytes.byteLength, checksum));
    fake.requests.length = 0;

    expect(() => source.rehydrate(
      { ...descriptor(bytes.byteLength, checksum), objectKey: "r2_object_other" },
      verified.snapshot,
    )).toThrowError(R2StreamError);
    expect(fake.requests).toEqual([]);
  });

  it.each(["etag", "version"] as const)(
    "fails closed when a persisted %s pin is modified",
    async (field) => {
      const bytes = new TextEncoder().encode("pinned snapshot");
      const checksum = await sha256(bytes);
      const fake = fakeBucket({ size: bytes.byteLength, checksum, byteAt: (offset) => bytes[offset]! });
      const approved = descriptor(bytes.byteLength, checksum);
      const source = new CloudflareR2StreamingSource(fake.bucket);
      const verified = await source.verify(approved);
      const tampered = { ...verified.snapshot, [field]: `tampered-${field}` };
      fake.requests.length = 0;

      const restored = source.rehydrate(approved, tampered);
      await expect(collect(restored.open(4)))
        .rejects.toMatchObject({ code: "R2_RANGE_INVALID", retryable: false });
    },
  );

  it("validates a 300 MiB logical object without a whole-object allocation", async () => {
    const size = 300 * 1024 * 1024;
    const fake = fakeBucket({ size, checksum: ZERO_300_MIB_SHA256 });
    const verified = await new CloudflareR2StreamingSource(fake.bucket, {
      rangeSize: 8 * 1024 * 1024,
    }).verify(descriptor(size, ZERO_300_MIB_SHA256));

    expect(verified.size).toBe(size);
    expect(fake.requests).toHaveLength(38);
    expect(Math.max(...fake.requests.map(({ length }) => length))).toBe(8 * 1024 * 1024);
    expect(fake.maxChunkBytes()).toBe(64 * 1024);
  }, 30_000);

  it("does not copy provider errors, object keys, or URLs into public errors", async () => {
    const secret = "sensitive-provider-detail-must-not-escape";
    const fake = fakeBucket({
      size: 1,
      checksum: "00".repeat(32),
      providerError: new Error(secret),
    });

    const caught = await new CloudflareR2StreamingSource(fake.bucket)
      .verify(descriptor(1, "00".repeat(32)))
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(R2StreamError);
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain("r2_object_fixture");
  });
});
