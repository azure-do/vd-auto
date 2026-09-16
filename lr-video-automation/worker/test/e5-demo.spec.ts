import { expect, it } from "vitest";
import { buildIdempotencyKey } from "../src/domain";
import { classifyYouTubeObservation } from "../src/e5-contracts";
import {
  fakeObjectFixture,
  FakeR2ReadClient,
  FakeYouTubePublishClient,
} from "../src/e5-fakes";
import { buildPrivateYouTubeUploadRequest } from "../src/e5-youtube-private-request";
import { dispatchGuardedPrivateYouTubeUpload } from "../src/e5-youtube-private-request";
import { verifyR2Source } from "../src/e5-r2-stream";

const NOW = "2026-08-19T00:00:00.000Z";

it("shows the E-5.1 external-I/O-free contract branches", async () => {
  const observations = {
    complete: classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVIDDEMO",
    }, NOW).state,
    processing: classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "uploaded",
      processingStatus: "processing",
      privacyStatus: "private",
    }, NOW).state,
    failed: classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "failed",
      processingStatus: "failed",
      privacyStatus: "private",
    }, NOW).state,
    rejected: classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "rejected",
      processingStatus: "failed",
      privacyStatus: "private",
    }, NOW).state,
    unknown: classifyYouTubeObservation({
      kind: "outcome_unknown",
      reason: "timeout",
    }, NOW).state,
  };

  const bytes = new TextEncoder().encode("fake-demo-only");
  const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const r2 = new FakeR2ReadClient([
    await fakeObjectFixture("object_fake_demo", bytes),
  ]);
  const firstRange = await r2.readRange({
    objectKey: "object_fake_demo",
    offset: 0,
    length: 4,
  });
  const youtube = new FakeYouTubePublishClient({
    kind: "status",
    uploadStatus: "processed",
    processingStatus: "succeeded",
    privacyStatus: "private",
    videoId: "FAKEVIDDEMO",
  });
  const request = buildPrivateYouTubeUploadRequest({
    idempotencyKey: buildIdempotencyKey(
      "00000000-0000-4000-8000-000000000599", "youtube", "youtube_account_fake", "approved-v1",
    ),
    videoJobId: "00000000-0000-4000-8000-000000000599",
    targetAccountId: "youtube_account_fake",
    approvedContentVersion: "approved-v1",
    source: {
      objectKey: "object_fake_demo",
      expectedSize: bytes.byteLength,
      expectedSha256: checksum,
    },
    privacyStatus: "private",
  });
  const verified = await verifyR2Source(r2, request.source, { contractRangeSize: 4 });
  await dispatchGuardedPrivateYouTubeUpload(youtube.client, request, verified);
  await dispatchGuardedPrivateYouTubeUpload(youtube.client, request, verified);

  const result = {
    external_connection: false,
    youtube_branches: observations,
    r2_range: {
      offset: firstRange.offset,
      returned_bytes: firstRange.bytes.byteLength,
      total_size: firstRange.totalSize,
    },
    duplicate_fake_side_effects: youtube.sideEffectCount(),
  };
  console.log("\nE-5.1 dummy contract demonstration:", result);

  expect(result).toEqual({
    external_connection: false,
    youtube_branches: {
      complete: "PUBLISHED",
      processing: "PUBLISHING",
      failed: "FAILED",
      rejected: "FAILED",
      unknown: "OUTCOME_UNKNOWN",
    },
    r2_range: { offset: 0, returned_bytes: 4, total_size: bytes.byteLength },
    duplicate_fake_side_effects: 1,
  });
});
