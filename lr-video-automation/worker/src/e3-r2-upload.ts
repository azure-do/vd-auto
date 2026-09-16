import {
  E3FakeUploadService,
  type FakeUploadSession,
  type TrustedClock,
  type UploadIdentityGenerator,
  type UploadObjectInspection,
  type UploadObjectInspector,
  type VideoUploadedQueueEvent,
} from "./e3-fake-upload";
import { createFile, type MP4BoxBuffer, type Movie, type Sample, type Track } from "mp4box";

/**
 * Development-only R2 adapter.  The durable receipt and job fences remain in
 * the E-3.1 tables so a callback retry can recover an event if Queue.send()
 * succeeds or fails independently from the HTTP response.
 */
export const R2_CALLBACK_ACTOR = "r2_upload_callback";
export const R2_UPLOAD_HOST_SUFFIX = ".r2.cloudflarestorage.com";
/** moov is metadata, not media; cap one inspected index to bound Worker memory. */
export const MAX_MP4_MOOV_BYTES = 4 * 1024 * 1024;
/** ftyp is a short brand declaration. Refuse hostile declarations before a range read. */
export const MAX_MP4_FTYP_BYTES = 4 * 1024;
/** A codec header is at the start of a sample; cap probes independently of upload size. */
export const MAX_MP4_SAMPLE_PROBE_BYTES = 64 * 1024;
export const MAX_MP4_SAMPLE_PROBES_PER_TRACK = 7;
export const MAX_VIDEO_DIMENSION = 32_768;
export const MAX_VIDEO_ASPECT_RATIO = 100;

export interface R2SigningCredentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

export interface PresignedPut {
  url: string;
  requiredHeaders: Record<string, string>;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64FromHex(value: string): string {
  const bytes = new Uint8Array(value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmac(key: ArrayBuffer | string, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function amzDate(now: Date): { timestamp: string; date: string } {
  const iso = now.toISOString();
  return { timestamp: `${iso.slice(0, 10).replaceAll("-", "")}T${iso.slice(11, 19).replaceAll(":", "")}Z`, date: iso.slice(0, 10).replaceAll("-", "") };
}

/** S3 SigV4 presigning; secrets are used only in memory and never logged. */
export async function presignR2Put(
  credentials: R2SigningCredentials,
  objectKey: string,
  input: { contentType: string; sizeBytes: number; checksumSha256: string; expiresAt: Date },
  now = new Date(),
): Promise<PresignedPut> {
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(credentials.bucketName)) throw new TypeError("Invalid bucket name");
  if (!/^[0-9a-f]{64}$/i.test(input.checksumSha256)) throw new TypeError("Invalid checksum");
  if (input.contentType.toLowerCase() !== "video/mp4" || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new TypeError("Invalid upload contract");
  }
  const expires = Math.floor((input.expiresAt.getTime() - now.getTime()) / 1_000);
  if (!Number.isInteger(expires) || expires <= 0 || expires > 900) throw new TypeError("Invalid upload expiry");
  const region = "auto";
  const service = "s3";
  const date = amzDate(now);
  const host = `${credentials.accountId}${R2_UPLOAD_HOST_SUFFIX}`;
  const canonicalUri = `/${awsEncode(credentials.bucketName)}/${awsEncode(objectKey)}`;
  // Fetch forbids JavaScript from assigning Content-Length, but the browser
  // supplies the real body length itself. Sign that header without returning it
  // in requiredHeaders; real-browser R2 E2E remains the final compatibility check.
  const signedHeaders = "content-length;content-type;host;x-amz-checksum-sha256";
  const scope = `${date.date}/${region}/${service}/aws4_request`;
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": date.timestamp,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders,
  });
  const canonicalQuery = [...query.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`).join("&");
  const checksum = base64FromHex(input.checksumSha256.toLowerCase());
  const canonicalHeaders = `content-length:${input.sizeBytes}\ncontent-type:${input.contentType.toLowerCase()}\nhost:${host}\nx-amz-checksum-sha256:${checksum}\n`;
  const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date.timestamp}\n${scope}\n${await sha256(canonicalRequest)}`;
  const kDate = await hmac(`AWS4${credentials.secretAccessKey}`, date.date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const signature = hex(await hmac(await hmac(kService, "aws4_request"), stringToSign));
  query.set("X-Amz-Signature", signature);
  return {
    url: `https://${host}${canonicalUri}?${query.toString()}`,
    requiredHeaders: {
      "content-type": input.contentType.toLowerCase(),
      "x-amz-checksum-sha256": checksum,
    },
  };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(bytes.slice(offset, offset + length));
}

interface Mp4Box { type: string; start: number; end: number; payload: number; }

interface Mp4BoxHeader { type: string; size: number; header: number; }

function mp4Boxes(bytes: Uint8Array, start = 0, end = bytes.length): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) return null;
    let size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const wide = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8).getBigUint64(0);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(wide); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return null;
    boxes.push({ type, start: offset, end: offset + size, payload: offset + header });
    offset += size;
  }
  return boxes;
}

function mp4BoxHeader(bytes: Uint8Array): Mp4BoxHeader | null {
  if (bytes.length < 8) return null;
  let size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  const type = ascii(bytes, 4, 4);
  let header = 8;
  if (size === 1) {
    if (bytes.length < 16) return null;
    const wide = new DataView(bytes.buffer, bytes.byteOffset + 8, 8).getBigUint64(0);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(wide); header = 16;
  }
  return size >= header ? { type, size, header } : null;
}

function plausibleVideoTrack(track: Track): boolean {
  const durationSeconds = track.duration / track.timescale;
  const width = track.video?.width;
  const height = track.video?.height;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(track.timescale) || track.timescale <= 0) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height
    || width <= 0 || height <= 0 || width > MAX_VIDEO_DIMENSION || height > MAX_VIDEO_DIMENSION) return false;
  const ratio = width / height;
  // No normal portrait/landscape policy is assumed. This only rejects values
  // that are not credible dimensions and would be unsafe for later processing.
  return Number.isFinite(ratio) && ratio >= 1 / MAX_VIDEO_ASPECT_RATIO && ratio <= MAX_VIDEO_ASPECT_RATIO;
}

function representativeSampleIndexes(sampleCount: number, durationSeconds: number): number[] {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) return [];
  if (sampleCount <= 2) return Array.from({ length: sampleCount }, (_, index) => index);
  // Always cover beginning/middle/end. Longer videos add bounded probes while
  // keeping R2 reads independent of total upload size.
  const probeCount = Math.min(
    sampleCount,
    MAX_MP4_SAMPLE_PROBES_PER_TRACK,
    Math.max(3, Math.ceil(durationSeconds / 60) + 2),
  );
  return [...new Set(Array.from(
    { length: probeCount },
    (_, index) => Math.round(index * (sampleCount - 1) / (probeCount - 1)),
  ))];
}

function sampleCodec(sample: Sample): { codec: string; nalLengthBytes: number } | null {
  const description = sample.description as unknown as {
    type?: unknown;
    avcC?: { lengthSizeMinusOne?: unknown };
    hvcC?: { lengthSizeMinusOne?: unknown };
  };
  const codec = typeof description.type === "string" ? description.type.toLowerCase() : "";
  const configuration = codec === "hvc1" || codec === "hev1" ? description.hvcC : description.avcC;
  const lengthSizeMinusOne = configuration?.lengthSizeMinusOne;
  if (!/^(avc1|avc3|hvc1|hev1)$/.test(codec) || !Number.isInteger(lengthSizeMinusOne)
    || (lengthSizeMinusOne as number) < 0 || (lengthSizeMinusOne as number) > 3) return null;
  return { codec, nalLengthBytes: (lengthSizeMinusOne as number) + 1 };
}

export function isValidCodecSampleProbe(
  codec: string,
  bytes: Uint8Array,
  declaredSize: number,
  nalLengthBytes: number,
): boolean {
  if (bytes.length === 0 || bytes.every((byte) => byte === 0)) return false;
  const family = codec.toLowerCase();
  if (family === "avc1" || family === "avc3" || family === "hvc1" || family === "hev1") {
    if (!Number.isInteger(nalLengthBytes) || nalLengthBytes < 1 || nalLengthBytes > 4
      || bytes.length <= nalLengthBytes || declaredSize <= nalLengthBytes) return false;
    let cursor = 0;
    let hasVclNal = false;
    while (cursor < declaredSize) {
      if (cursor + nalLengthBytes > bytes.length) return bytes.length < declaredSize && hasVclNal;
      let nalSize = 0;
      for (let index = 0; index < nalLengthBytes; index += 1) {
        nalSize = nalSize * 256 + bytes[cursor + index]!;
      }
      const headerOffset = cursor + nalLengthBytes;
      const declaredNalEnd = headerOffset + nalSize;
      if (nalSize === 0 || declaredNalEnd > declaredSize || headerOffset >= bytes.length) return false;
      if (family === "avc1" || family === "avc3") {
        if ((bytes[headerOffset]! & 0x80) !== 0) return false;
        const nalType = bytes[headerOffset]! & 0x1f;
        if (nalType === 0 || nalType > 23) return false;
        const payloadEnd = Math.min(bytes.length, declaredNalEnd);
        if (!bytes.slice(headerOffset + 1, payloadEnd).some((byte) => byte !== 0)) return false;
        if (nalType >= 1 && nalType <= 5) hasVclNal = true;
      } else {
        if ((bytes[headerOffset]! & 0x80) !== 0 || nalSize < 2 || headerOffset + 1 >= bytes.length) return false;
        const nalType = (bytes[headerOffset]! >> 1) & 0x3f;
        const temporalIdPlusOne = bytes[headerOffset + 1]! & 0x07;
        if (temporalIdPlusOne === 0) return false;
        const payloadEnd = Math.min(bytes.length, declaredNalEnd);
        if (!bytes.slice(headerOffset + 2, payloadEnd).some((byte) => byte !== 0)) return false;
        if (nalType <= 31) hasVclNal = true;
      }
      if (declaredNalEnd > bytes.length) return hasVclNal;
      cursor = declaredNalEnd;
    }
    return cursor === declaredSize && hasVclNal;
  }
  // E-3 accepts only codecs for which the bounded probe can validate a frame
  // structure. Unknown sample entries fail closed instead of trusting metadata.
  return false;
}

interface ParsedMp4 {
  movie: Movie;
  videoSamples: ReadonlyMap<number, readonly Sample[]>;
}

function parseMp4(segments: ReadonlyArray<{ offset: number; bytes: Uint8Array }>): Promise<ParsedMp4 | null> {
  return new Promise((resolve) => {
    const file = createFile(); let done = false;
    const finish = (value: ParsedMp4 | null) => { if (!done) { done = true; resolve(value); } };
    file.onReady = (movie) => {
      try {
        finish({
          movie,
          // mp4box expands stsc with stco/co64 and stsz here. Do not duplicate
          // that offset mapping with a partial hand-written interpretation.
          videoSamples: new Map(movie.videoTracks.map((track) => [track.id, file.getTrackSamplesInfo(track.id)])),
        });
      } catch { finish(null); }
    };
    file.onError = () => finish(null);
    try {
      for (const segment of segments) {
        const buffer = segment.bytes.slice().buffer as MP4BoxBuffer;
        buffer.fileStart = segment.offset; file.appendBuffer(buffer);
      }
      file.flush(); queueMicrotask(() => finish(null));
    } catch { finish(null); }
  });
}

/** Does not trust metadata alone: HEAD is followed by bounded container and codec-sample reads. */
export class R2UploadObjectInspector implements UploadObjectInspector {
  constructor(private readonly bucket: R2Bucket) {}

  private async readRange(objectRef: string, offset: number, length: number): Promise<Uint8Array | null> {
    try {
      const body = await this.bucket.get(objectRef, { range: { offset, length } });
      return body ? new Uint8Array(await body.arrayBuffer()) : null;
    } catch { return null; }
  }

  private async validMp4(objectRef: string, objectSize: number): Promise<boolean> {
    let offset = 0;
    let seenFtyp = false;
    const mdatRanges: Array<{ start: number; end: number }> = [];
    let moovBytes: Uint8Array | null = null;
    let ftypBytes: Uint8Array | null = null;
    let moovOffset = 0;
    // Top-level ISO BMFF boxes are contiguous. Headers are read at declared
    // boundaries; a moov larger than the initial range is fetched exactly.
    for (let count = 0; count < 64 && offset < objectSize; count += 1) {
      const headerBytes = await this.readRange(objectRef, offset, 16);
      const header = headerBytes && mp4BoxHeader(headerBytes);
      if (!header || header.size > objectSize - offset) return false;
      if (count === 0 && header.type !== "ftyp") return false;
      if (header.type === "ftyp") {
        if (header.size > MAX_MP4_FTYP_BYTES) return false;
        seenFtyp = true;
        ftypBytes = await this.readRange(objectRef, offset, header.size);
        if (!ftypBytes) return false;
      }
      if (header.type === "mdat" && header.size > header.header) {
        mdatRanges.push({ start: offset + header.header, end: offset + header.size });
      }
      if (header.type === "moov") {
        if (header.size > MAX_MP4_MOOV_BYTES) return false;
        moovBytes = await this.readRange(objectRef, offset, header.size);
        moovOffset = offset;
        const boxes = moovBytes && mp4Boxes(moovBytes);
        const moov = boxes?.length === 1 && boxes[0]?.type === "moov" ? boxes[0] : null;
        if (!moov) return false;
      }
      if (header.size === 0) return false;
      offset += header.size;
    }
    if (!moovBytes || mdatRanges.length === 0 || offset !== objectSize || !seenFtyp) return false;
    const boxes = mp4Boxes(moovBytes);
    const moov = boxes?.length === 1 && boxes[0]?.type === "moov" ? boxes[0] : null;
    if (!moov || !ftypBytes) return false;
    const parsed = await parseMp4([{ offset: 0, bytes: ftypBytes }, { offset: moovOffset, bytes: moovBytes }]);
    if (!parsed || parsed.movie.videoTracks.length === 0) return false;
    for (const track of parsed.movie.videoTracks) {
      if (track.nb_samples <= 0 || !plausibleVideoTrack(track)) return false;
      const samples = parsed.videoSamples.get(track.id);
      if (!samples || samples.length !== track.nb_samples) return false;
      const indexes = representativeSampleIndexes(samples.length, track.duration / track.timescale);
      if (indexes.length === 0) return false;
      for (const index of indexes) {
        const probe = samples[index];
        if (!probe || !Number.isSafeInteger(probe.offset) || !Number.isSafeInteger(probe.size) || probe.size <= 0
          || !mdatRanges.some((range) => probe.offset >= range.start && probe.offset + probe.size <= range.end)) return false;
        const codec = sampleCodec(probe);
        if (!codec || !track.codec.toLowerCase().startsWith(codec.codec)) return false;
        const length = Math.min(probe.size, MAX_MP4_SAMPLE_PROBE_BYTES);
        const sample = await this.readRange(objectRef, probe.offset, length);
        if (!sample || sample.byteLength !== length
          || !isValidCodecSampleProbe(codec.codec, sample, probe.size, codec.nalLengthBytes)) return false;
      }
    }
    return true;
  }

  async inspect(objectRef: string): Promise<UploadObjectInspection> {
    const head = await this.bucket.head(objectRef);
    if (!head) return { status: "MISSING" };
    const contentType = head.httpMetadata?.contentType?.toLowerCase() ?? "";
    const checksum = head.checksums.sha256 ? hex(head.checksums.sha256) : "";
    if (contentType !== "video/mp4" || !checksum) return { status: "NON_VIDEO", sizeBytes: head.size, checksumSha256: checksum, contentType };
    if (head.size < 32) return { status: "CORRUPT", sizeBytes: head.size, checksumSha256: checksum, contentType };
    const [body, tailBody] = await Promise.all([
      this.bucket.get(objectRef, { range: { offset: 0, length: 4096 } }),
      this.bucket.get(objectRef, { range: { suffix: Math.min(head.size, 1_048_576) } }),
    ]);
    if (!body || !tailBody) return { status: "MISSING" };
    let firstBytes: Uint8Array;
    let tailBytes: Uint8Array;
    try {
      [firstBytes, tailBytes] = await Promise.all([
        body.arrayBuffer().then((value) => new Uint8Array(value)),
        tailBody.arrayBuffer().then((value) => new Uint8Array(value)),
      ]);
    } catch { return { status: "UNREADABLE" }; }
    const valid = await this.validMp4(objectRef, head.size);
    if (!valid) {
      return { status: "CORRUPT", sizeBytes: head.size, checksumSha256: checksum, contentType };
    }
    return { status: "VERIFIED", sizeBytes: head.size, checksumSha256: checksum, contentType };
  }
}

const r2Identities: UploadIdentityGenerator = {
  createUploadId: () => crypto.randomUUID(),
  createObjectRef: () => `r2_object_${crypto.randomUUID().replaceAll("-", "")}`,
};

export class E3R2UploadService {
  private readonly receipts: E3FakeUploadService;
  private readonly clock: TrustedClock;

  constructor(
    db: D1Database,
    inspector: UploadObjectInspector,
    private readonly credentials: R2SigningCredentials,
    clock: TrustedClock = { now: () => new Date() },
  ) {
    this.clock = clock;
    this.receipts = new E3FakeUploadService(db, inspector, r2Identities, clock, R2_CALLBACK_ACTOR);
  }

  async begin(input: { submissionId: string; sizeBytes: number; checksumSha256: string; contentType: string }): Promise<{
    session: FakeUploadSession;
    upload: PresignedPut;
  }> {
    if (input.contentType.toLowerCase() !== "video/mp4") throw new TypeError("Only video/mp4 is accepted");
    const session = await this.receipts.begin(input);
    const upload = await presignR2Put(this.credentials, session.expected_object_ref, {
      contentType: session.expected_content_type,
      sizeBytes: session.expected_size_bytes,
      checksumSha256: session.expected_checksum_sha256,
      expiresAt: new Date(session.expires_at),
    }, this.clock.now());
    return { session, upload };
  }

  complete(input: { submissionId: string; uploadId: string; eventId: string }): Promise<VideoUploadedQueueEvent> {
    return this.receipts.complete(input);
  }
}
