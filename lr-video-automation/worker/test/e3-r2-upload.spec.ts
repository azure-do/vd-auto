import { describe, expect, it } from "vitest";
import { createFile, type MP4BoxBuffer } from "mp4box";
import {
  MAX_MP4_FTYP_BYTES,
  MAX_MP4_MOOV_BYTES,
  R2UploadObjectInspector,
  isValidCodecSampleProbe,
} from "../src/e3-r2-upload";
import corsConfig from "../config/r2-e3-dev-cors.json";
import { dummyVideoBytes } from "./fixtures/dummy-video-base64";
import { dummyVideo20SamplesBytes } from "./fixtures/dummy-video-20-samples-base64";

const checksum = new Uint8Array(32).buffer;

class FixtureR2Bucket {
  readonly requestedRanges: Array<{ offset?: number; length?: number; suffix?: number }> = [];
  constructor(private readonly bytes: Uint8Array, private readonly contentType: string, private readonly failLargeRead = false) {}

  async head(): Promise<R2Object> {
    return {
      key: "r2_object_fixture", version: "fixture", size: this.bytes.byteLength, etag: "fixture", httpEtag: "fixture",
      checksums: { sha256: checksum, toJSON: () => ({}) }, uploaded: new Date(), storageClass: "Standard",
      httpMetadata: { contentType: this.contentType }, writeHttpMetadata: () => {},
    } as unknown as R2Object;
  }

  async get(_key: string, options?: R2GetOptions): Promise<R2ObjectBody> {
    const range = options?.range as R2Range | undefined;
    if (range) this.requestedRanges.push({ ...range });
    if (this.failLargeRead && range && "offset" in range && range.offset === 16 && (range.length ?? 0) > 16) {
      throw new Error("injected range failure");
    }
    const selected = range && "suffix" in range
      ? this.bytes.slice(-Math.min(this.bytes.length, range.suffix))
      : range && "offset" in range
        ? this.bytes.slice(range.offset, range.offset + (range.length ?? this.bytes.length))
        : this.bytes;
    return { arrayBuffer: async () => selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength) } as unknown as R2ObjectBody;
  }
}

function bytes(...items: Array<number | string>): Uint8Array {
  const result: number[] = [];
  for (const item of items) {
    if (typeof item === "number") result.push(item);
    else result.push(...new TextEncoder().encode(item));
  }
  return new Uint8Array(result);
}

function mp4Box(type: string, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const result = new Uint8Array(8 + payload.length);
  new DataView(result.buffer).setUint32(0, result.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(payload, 8);
  return result;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function findAscii(haystack: Uint8Array, needle: string, start = 0): number {
  const pattern = new TextEncoder().encode(needle);
  for (let offset = start; offset <= haystack.length - pattern.length; offset += 1) {
    if (pattern.every((byte, index) => haystack[offset + index] === byte)) return offset;
  }
  return -1;
}

function withZeroMdatPayload(source: Uint8Array): Uint8Array {
  const result = source.slice();
  for (let offset = 0; offset + 8 <= result.length;) {
    const size = new DataView(result.buffer, result.byteOffset + offset, 4).getUint32(0);
    const type = new TextDecoder().decode(result.slice(offset + 4, offset + 8));
    if (size < 8 || offset + size > result.length) throw new Error("invalid fixture");
    if (type === "mdat") result.fill(0, offset + 8, offset + size);
    offset += size;
  }
  return result;
}

function withZeroTrackDuration(source: Uint8Array): Uint8Array {
  const result = source.slice();
  const typeOffset = findAscii(result, "mdhd");
  if (typeOffset < 0 || result[typeOffset + 4] !== 0) throw new Error("expected version-0 mdhd");
  new DataView(result.buffer, result.byteOffset).setUint32(typeOffset + 20, 0);
  return result;
}

function withExtremeVideoRatio(source: Uint8Array): Uint8Array {
  const result = source.slice();
  const stsdOffset = findAscii(result, "stsd");
  const typeOffset = findAscii(result, "avc1", stsdOffset + 4);
  if (typeOffset < 0) throw new Error("expected avc1 sample entry");
  const view = new DataView(result.buffer, result.byteOffset);
  view.setUint16(typeOffset + 28, 1);
  view.setUint16(typeOffset + 30, 32_767);
  return result;
}

async function videoSampleRanges(source: Uint8Array): Promise<Array<{ offset: number; size: number }>> {
  return new Promise((resolve, reject) => {
    const file = createFile();
    file.onError = () => reject(new Error("fixture MP4 parse failed"));
    file.onReady = (movie) => {
      const track = movie.videoTracks[0];
      if (!track) return reject(new Error("fixture video track missing"));
      resolve(file.getTrackSamplesInfo(track.id).map((sample) => ({ offset: sample.offset, size: sample.size })));
    };
    const buffer = source.slice().buffer as MP4BoxBuffer;
    buffer.fileStart = 0;
    file.appendBuffer(buffer);
    file.flush();
  });
}

async function withZeroedSamples(source: Uint8Array, indexes: readonly number[]): Promise<Uint8Array> {
  const result = source.slice();
  const samples = await videoSampleRanges(result);
  for (const index of indexes) {
    const sample = samples[index];
    if (!sample) throw new Error("fixture sample missing");
    result.fill(0, sample.offset, sample.offset + sample.size);
  }
  return result;
}

async function withParameterSetOnlySample(source: Uint8Array, index: number): Promise<Uint8Array> {
  const result = source.slice();
  const sample = (await videoSampleRanges(result))[index];
  if (!sample || sample.size < 6) throw new Error("fixture sample missing");
  result.fill(1, sample.offset, sample.offset + sample.size);
  new DataView(result.buffer, result.byteOffset).setUint32(sample.offset, sample.size - 4);
  result[sample.offset + 4] = 0x67; // forbidden_zero_bit=0, AVC SPS type=7 (non-VCL)
  return result;
}

function validMp4(handler = "vide", sampleOffset = 24, sampleSize = 1, mdatBytes = 16, variableFirstSize = 1): Uint8Array {
  const hdlr = mp4Box("hdlr", join(new Uint8Array(8), bytes(handler)));
  const stbl = mp4Box("stbl", join(
    mp4Box("stsd", bytes(0, 0, 0, 0, 0, 0, 0, 1, 0)),
    mp4Box("stts", bytes(0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)),
    mp4Box("stsc", bytes(0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)),
    mp4Box("stsz", sampleSize === 0
      ? bytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, (variableFirstSize >>> 24) & 255, (variableFirstSize >>> 16) & 255, (variableFirstSize >>> 8) & 255, variableFirstSize & 255)
      : bytes(0, 0, 0, 0, (sampleSize >>> 24) & 255, (sampleSize >>> 16) & 255, (sampleSize >>> 8) & 255, sampleSize & 255, 0, 0, 0, 1)),
    mp4Box("stco", bytes(0, 0, 0, 0, 0, 0, 0, 1, (sampleOffset >>> 24) & 255, (sampleOffset >>> 16) & 255, (sampleOffset >>> 8) & 255, sampleOffset & 255)),
  ));
  const trak = mp4Box("trak", join(mp4Box("tkhd", new Uint8Array(4)), mp4Box("mdia", join(hdlr, mp4Box("minf", stbl)))));
  return join(mp4Box("ftyp", bytes("isom", 0, 0, 0, 0)), mp4Box("mdat", new Uint8Array(mdatBytes)), mp4Box("moov", join(mp4Box("mvhd", new Uint8Array(4)), trak)));
}

function videoMoov(sampleOffset = 24): Uint8Array {
  const full = validMp4("vide", sampleOffset);
  const moovStart = new DataView(full.buffer).getUint32(0) + new DataView(full.buffer, 16).getUint32(0);
  return full.slice(moovStart);
}

function largeMdat(): Uint8Array {
  return mp4Box("mdat", new Uint8Array(5_000));
}

function fastStartFixture(mdatPayloadSize: number, moovPadding = 0): Uint8Array {
  const withPadding = (offset: number) => mp4Box("moov", join(videoMoov(offset).slice(8), mp4Box("free", new Uint8Array(moovPadding))));
  const offset = 16 + withPadding(0).length + 8;
  return join(mp4Box("ftyp", bytes("isom", 0, 0, 0, 0)), withPadding(offset), mp4Box("mdat", new Uint8Array(mdatPayloadSize)));
}

describe("E-3.2 R2 adapter", () => {
  it.each([
    ["ffmpeg generated dummy MP4", "video/mp4", dummyVideoBytes()],
    ["ffmpeg generated 20-sample dummy MP4", "video/mp4", dummyVideo20SamplesBytes()],
  ])("accepts a minimally complete %s container", async (_name, contentType, fixture) => {
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, contentType) as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(result.status).toBe("VERIFIED");
  });

  it("rejects a valid MP4 payload declared as QuickTime", async () => {
    const result = await new R2UploadObjectInspector(
      new FixtureR2Bucket(dummyVideoBytes(), "video/quicktime") as unknown as R2Bucket,
    ).inspect("r2_object_fixture");

    expect(result).toMatchObject({ status: "NON_VIDEO", contentType: "video/quicktime" });
  });

  it("rejects an MP4 whose declared samples point only to zero-filled media bytes", async () => {
    const result = await new R2UploadObjectInspector(
      new FixtureR2Bucket(withZeroMdatPayload(dummyVideoBytes()), "video/mp4") as unknown as R2Bucket,
    ).inspect("r2_object_fixture");

    expect(result.status).toBe("CORRUPT");
  });

  it("rejects a selected sample containing only a non-VCL SPS NAL", async () => {
    const fixture = await withParameterSetOnlySample(dummyVideo20SamplesBytes(), 10);
    const result = await new R2UploadObjectInspector(
      new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket,
    ).inspect("r2_object_fixture");

    expect(result.status).toBe("CORRUPT");
  });

  it("rejects an HEVC VCL NAL whose temporal_id_plus1 is zero", () => {
    const invalidTemporalId = bytes(0, 0, 0, 4, 2, 0, 1, 1);
    const validTemporalId = bytes(0, 0, 0, 4, 2, 1, 1, 1);

    expect(isValidCodecSampleProbe("hvc1", invalidTemporalId, invalidTemporalId.length, 4)).toBe(false);
    expect(isValidCodecSampleProbe("hvc1", validTemporalId, validTemporalId.length, 4)).toBe(true);
  });

  it.each([
    ["all samples after the first", Array.from({ length: 19 }, (_, index) => index + 1)],
    ["the middle sample", [10]],
    ["the last sample", [19]],
  ])("rejects a 20-sample MP4 when %s are zero-filled", async (_name, indexes) => {
    const fixture = await withZeroedSamples(dummyVideo20SamplesBytes(), indexes);
    const result = await new R2UploadObjectInspector(
      new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket,
    ).inspect("r2_object_fixture");

    expect(result.status).toBe("CORRUPT");
  });

  it("rejects an oversized ftyp declaration before issuing the declared range read", async () => {
    const fixture = new Uint8Array(MAX_MP4_FTYP_BYTES + 16);
    new DataView(fixture.buffer).setUint32(0, MAX_MP4_FTYP_BYTES + 1);
    fixture.set(bytes("ftyp"), 4);
    const bucket = new FixtureR2Bucket(fixture, "video/mp4");

    const result = await new R2UploadObjectInspector(bucket as unknown as R2Bucket).inspect("r2_object_fixture");

    expect(result.status).toBe("CORRUPT");
    expect(bucket.requestedRanges.some((range) => (range.length ?? 0) > MAX_MP4_FTYP_BYTES)).toBe(false);
  });

  it.each([
    ["zero duration", withZeroTrackDuration(dummyVideoBytes())],
    ["unsafe aspect ratio", withExtremeVideoRatio(dummyVideoBytes())],
  ])("rejects a real-codec MP4 with %s metadata", async (_name, fixture) => {
    const result = await new R2UploadObjectInspector(
      new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket,
    ).inspect("r2_object_fixture");

    expect(result.status).toBe("CORRUPT");
  });

  it.each([
    ["moov at the tail after a head mdat crossing the first range", join(mp4Box("ftyp", bytes("isom", 0, 0, 0, 0)), largeMdat(), videoMoov())],
    ["fast-start moov before a head mdat crossing the first range", fastStartFixture(5_000)],
  ])("rejects a hand-built MP4 layout that lacks real codec sample entries: %s", async (_name, fixture) => {
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(["CORRUPT", "NON_VIDEO"]).toContain(result.status);
  });

  it("rejects a hand-built fast-start MP4 when moov exceeds 4 KiB", async () => {
    const fixture = fastStartFixture(1_100_000, 5_000);
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(["CORRUPT", "NON_VIDEO"]).toContain(result.status);
  });

  it("fails closed before reading an unreasonably large declared moov", async () => {
    const fixture = new Uint8Array(MAX_MP4_MOOV_BYTES + 17);
    fixture.set(mp4Box("ftyp", bytes("isom", 0, 0, 0, 0)));
    new DataView(fixture.buffer).setUint32(16, MAX_MP4_MOOV_BYTES + 1);
    fixture.set(bytes("moov"), 20);
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(result.status).toBe("CORRUPT");
  });

  it("fails closed when the exact moov range cannot be read", async () => {
    const fixture = fastStartFixture(64);
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, "video/mp4", true) as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(result.status).toBe("CORRUPT");
  });

  it.each([
    ["truncated MP4", "video/mp4", bytes(0, 0, 0, 16, "ftyp", "isom", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)],
    ["truncated WebM", "video/webm", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, "webm", 0x18, 0x53, 0x80, 0x67, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)],
    ["truncated Ogg", "video/ogg", bytes("OggS", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)],
  ])("rejects a %s even when the MIME and first magic bytes look valid", async (_name, contentType, fixture) => {
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, contentType) as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(["CORRUPT", "NON_VIDEO"]).toContain(result.status);
  });

  it.each([
    ["empty moov", "video/mp4", join(mp4Box("ftyp", bytes("isom")), mp4Box("mdat", new Uint8Array(16)), mp4Box("moov"))],
    ["audio-only MP4", "video/mp4", validMp4("soun")],
    ["audio-only WebM", "video/webm", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, "webm", 0x18, 0x53, 0x80, 0x67, 0xae, 0x83, 0x81, 0x02, 0x1f, 0x43, 0xb6, 0x75, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)],
    ["audio-only Ogg", "video/ogg", bytes("OggS", 0, 0, 0, "OpusHead", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "OggS", 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)],
  ])("rejects structurally plausible but non-video %s", async (_name, contentType, fixture) => {
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, contentType) as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(["CORRUPT", "NON_VIDEO"]).toContain(result.status);
  });

  it.each([
    ["first fixed-size sample extends past mdat", validMp4("vide", 24, 17, 16)],
    ["first variable-size sample extends past mdat", validMp4("vide", 24, 0, 16, 17)],
  ])("rejects a sample table whose %s", async (_name, fixture) => {
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(result.status).toBe("CORRUPT");
  });

  it("rejects a fake moov sequence embedded inside mdat rather than treating it as a top-level box", async () => {
    const fakeMoov = videoMoov();
    const fixture = join(mp4Box("ftyp", bytes("isom", 0, 0, 0, 0)), mp4Box("mdat", fakeMoov));
    const result = await new R2UploadObjectInspector(new FixtureR2Bucket(fixture, "video/mp4") as unknown as R2Bucket)
      .inspect("r2_object_fixture");
    expect(result.status).toBe("CORRUPT");
  });

  it("keeps the CORS file in Wrangler's R2 rule shape and excludes wildcard and forbidden content-length", async () => {
    const config = corsConfig as {
      rules: Array<{ allowed: { origins: string[]; methods: string[]; headers: string[] } }>;
    };
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]?.allowed).toEqual({
      origins: ["http://localhost:8788"], methods: ["PUT", "HEAD"], headers: ["content-type", "x-amz-checksum-sha256"],
    });
  });
});
