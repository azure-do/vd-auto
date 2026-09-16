import { describe, expect, it } from "vitest";
import { buildIdempotencyKey } from "../src/domain";
import * as privateBoundary from "../src/e5-youtube-private-request";
import type {
  YouTubePrivateUploadRequest,
  YouTubePublishObservation,
} from "../src/e5-contracts";
import {
  buildPrivateYouTubeUploadRequest,
  createScriptedYouTubePublishController,
  dispatchGuardedPrivateYouTubeUpload,
  startGuardedPrivateYouTubeUpload,
  YouTubePrivateRequestRejectedError,
  type YouTubePrivateRequestCandidate,
} from "../src/e5-youtube-private-request";
import type { VerifiedR2Source } from "../src/e5-r2-stream";

const BASE: YouTubePrivateRequestCandidate = {
  idempotencyKey: buildIdempotencyKey(
    "00000000-0000-4000-8000-000000000553", "youtube", "youtube_account_fake", "approved-v1",
  ),
  videoJobId: "00000000-0000-4000-8000-000000000553",
  targetAccountId: "youtube_account_fake",
  approvedContentVersion: "approved-v1",
  source: {
    objectKey: "object_fake_video",
    expectedSize: 21,
    expectedSha256: "c90232586b801f9558a76f2f963eccd831d9fe6775e4c8f1446b2331aa2132f2",
  },
};

function verifiedSource(size = BASE.source.expectedSize): VerifiedR2Source {
  const bytes = new Uint8Array(size);
  return {
    size,
    checksumSha256: BASE.source.expectedSha256,
    snapshot: {
      schemaVersion: 1,
      objectKey: BASE.source.objectKey,
      size,
      checksumSha256: BASE.source.expectedSha256,
      etag: "fake-etag",
      version: "fake-version",
    },
    open: (offset = 0) => new ReadableStream<Uint8Array>({
      start(controller) {
        if (offset < bytes.byteLength) controller.enqueue(bytes.slice(offset));
        controller.close();
      },
    }),
  };
}

function recordingClient() {
  const observation: YouTubePublishObservation = {
    kind: "status",
    uploadStatus: "uploaded",
    processingStatus: "processing",
    privacyStatus: "private",
  };
  const controller = createScriptedYouTubePublishController(observation);
  return { client: controller.client, controller };
}

describe("E-5.3 final private-only request boundary", () => {
  it.each([
    ["empty job ID", { videoJobId: "" }],
    ["malformed job ID", { videoJobId: "not-a-uuid" }],
    ["empty target", { targetAccountId: "" }],
    ["invalid target", { targetAccountId: "invalid target" }],
    ["empty version", { approvedContentVersion: "" }],
    ["invalid version", { approvedContentVersion: "invalid version" }],
    ["empty idempotency key", { idempotencyKey: "" }],
    ["unrelated idempotency key", { idempotencyKey: "fake_key" }],
    ["wrong destination", { idempotencyKey: buildIdempotencyKey(
      BASE.videoJobId, "instagram", BASE.targetAccountId, BASE.approvedContentVersion,
    ) }],
    ["wrong approval identity", { idempotencyKey: buildIdempotencyKey(
      BASE.videoJobId, "youtube", BASE.targetAccountId, "approved-v2",
    ) }],
    ["invalid optional actor", { actorId: "" }],
  ])("rejects %s before the direct helper calls the client", (_name, override) => {
    const { client, controller } = recordingClient();
    expect(() => startGuardedPrivateYouTubeUpload(client, { ...BASE, ...override }))
      .toThrow(TypeError);
    expect(controller.sideEffectCount()).toBe(0);
  });

  it.each([
    ["negative size", { expectedSize: -1 }],
    ["zero size", { expectedSize: 0 }],
    ["fractional size", { expectedSize: 1.5 }],
    ["NaN size", { expectedSize: NaN }],
    ["infinite size", { expectedSize: Infinity }],
    ["unsafe integer size", { expectedSize: Number.MAX_SAFE_INTEGER + 1 }],
    ["size string", { expectedSize: "21" }],
    ["empty object key", { objectKey: "" }],
    ["oversized object key", { objectKey: "x".repeat(513) }],
    ["URL object key", { objectKey: "https://example.invalid/dummy" }],
    ["control character object key", { objectKey: "dummy\nkey" }],
    ["non-string object key", { objectKey: 1 }],
    ["invalid checksum", { expectedSha256: "z".repeat(64) }],
    ["short checksum", { expectedSha256: "0".repeat(63) }],
    ["non-string checksum", { expectedSha256: 0 }],
  ])("rejects %s before the direct helper calls the client", (_name, override) => {
    const { client, controller } = recordingClient();
    expect(() => startGuardedPrivateYouTubeUpload(client, {
      ...BASE, source: { ...BASE.source, ...override },
    } as YouTubePrivateRequestCandidate)).toThrow(TypeError);
    expect(controller.sideEffectCount()).toBe(0);
  });

  it.each([
    ["omitted", {}],
    ["exact private", { privacyStatus: "private" }],
    ["explicit undefined", { privacyStatus: undefined }],
  ] as const)("rebuilds and freezes a private provider request when visibility is %s", (_name, policy) => {
    const request = buildPrivateYouTubeUploadRequest({ ...BASE, ...policy });

    expect(request.providerRequest).toEqual({
      part: "status",
      requestBody: { status: { privacyStatus: "private" } },
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.source)).toBe(true);
    expect(Object.isFrozen(request.providerRequest)).toBe(true);
    expect(Object.isFrozen(request.providerRequest.requestBody)).toBe(true);
    expect(Object.isFrozen(request.providerRequest.requestBody.status)).toBe(true);
    expect(request).toMatchObject({
      idempotencyKey: BASE.idempotencyKey,
      videoJobId: BASE.videoJobId,
      targetAccountId: BASE.targetAccountId,
      approvedContentVersion: BASE.approvedContentVersion,
      source: BASE.source,
    });
  });

  it("rejects a structurally private request that was not created by the guarded builder", () => {
    const { client, controller } = recordingClient();
    const forged = {
      ...BASE,
      providerRequest: {
        part: "status",
        requestBody: { status: { privacyStatus: "private" } },
      },
    } as unknown as YouTubePrivateUploadRequest;

    expect(() => dispatchGuardedPrivateYouTubeUpload(client, forged))
      .toThrowError(new YouTubePrivateRequestRejectedError("YOUTUBE_PRIVATE_ONLY"));
    expect(controller.sideEffectCount()).toBe(0);
  });

  it("exposes no callable raw adapter through destructuring or Reflect", () => {
    const { client, controller } = recordingClient();
    const reflected = Object.fromEntries(
      Reflect.ownKeys(client).map((key) => [String(key), Reflect.get(client as object, key)]),
    );
    const destructured = { ...client };

    expect(Reflect.ownKeys(client)).toEqual([]);
    expect(reflected).toEqual({});
    expect(destructured).toEqual({});
    expect(Reflect.get(client as object, "startPrivateUpload")).toBeUndefined();
    expect(controller.sideEffectCount()).toBe(0);
  });

  it("exports no arbitrary adapter factory and rejects callback or wire-body fake scripts", () => {
    expect(Reflect.get(privateBoundary, "createGuardedYouTubePublishClient")).toBeUndefined();
    expect(() => createScriptedYouTubePublishController((async () => ({
      kind: "outcome_unknown",
      reason: "timeout",
    })) as never)).toThrow(YouTubePrivateRequestRejectedError);
    expect(() => createScriptedYouTubePublishController({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      providerRequest: { requestBody: { status: { privacyStatus: "public" } } },
    } as never)).toThrow(YouTubePrivateRequestRejectedError);
  });

  it.each([
    ["publishAt", () => ({ options: { publishAt: "2026-09-01T00:00:00Z" } })],
    ["public privacyStatus", () => ({ options: { privacyStatus: "public" } })],
    ["providerRequest", () => ({
      options: { providerRequest: { requestBody: { status: { privacyStatus: "public" } } } },
    })],
    ["wire body", () => ({ options: { wire: { privacyStatus: "public" } } })],
    ["callback", () => {
      let reads = 0;
      return { options: { callback: () => { reads += 1; } }, reads: () => reads };
    }],
    ["unknown key", () => ({ options: { futureOption: true } })],
    ["symbol", () => ({ options: { [Symbol("pauseBeforeResult")]: true } })],
    ["non-enumerable", () => {
      const options = {};
      Object.defineProperty(options, "pauseBeforeResult", { value: true, enumerable: false });
      return { options };
    }],
    ["inherited", () => ({ options: Object.create({ pauseBeforeResult: true }) })],
    ["accessor", () => {
      let reads = 0;
      const options = {};
      Object.defineProperty(options, "pauseBeforeResult", {
        get: () => { reads += 1; return true; },
        enumerable: true,
      });
      return { options, reads: () => reads };
    }],
    ["custom prototype", () => ({ options: Object.create({}) })],
    ["Object.prototype inherited unknown", () => {
      Object.defineProperty(Object.prototype, "wire", {
        value: { privacyStatus: "public" },
        configurable: true,
      });
      return {
        options: {},
        cleanup: () => { delete (Object.prototype as { wire?: unknown }).wire; },
      };
    }],
  ] as const)("rejects unsafe scripted-controller options: %s", (_name, makeCase) => {
    const untouched = recordingClient().controller;
    const testCase = makeCase() as {
      options: unknown;
      reads?: () => number;
      cleanup?: () => void;
    };
    try {
      expect(() => createScriptedYouTubePublishController({
        kind: "outcome_unknown",
        reason: "timeout",
      }, testCase.options as never)).toThrow(YouTubePrivateRequestRejectedError);
    } finally {
      testCase.cleanup?.();
    }
    expect(testCase.reads?.() ?? 0).toBe(0);
    expect(untouched.sideEffectCount()).toBe(0);
  });

  it("serializes only an own private wire body under Object.prototype.toJSON pollution", async () => {
    const toJsonDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const controller = createScriptedYouTubePublishController({
      kind: "status",
      uploadStatus: "uploaded",
      processingStatus: "processing",
      privacyStatus: "private",
    });
    let wireBody = "";
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        value: () => ({ status: { privacyStatus: "public" } }),
        configurable: true,
      });
      await startGuardedPrivateYouTubeUpload(controller.client, BASE, verifiedSource());
      wireBody = controller.lastUpload()?.providerBodyJson ?? "";
    } finally {
      if (toJsonDescriptor) {
        Object.defineProperty(Object.prototype, "toJSON", toJsonDescriptor);
      } else {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      }
    }

    expect(wireBody).toBe('{"status":{"privacyStatus":"private"}}');
  });

  it.each([
    "public",
    "unlisted",
    "Private",
    "PRIVATE",
    " private ",
    "",
    null,
    false,
    1,
    {},
    [],
  ])("rejects runtime visibility %j before the client is called", async (privacyStatus) => {
    const { client, controller } = recordingClient();

    expect(() => startGuardedPrivateYouTubeUpload(client, { ...BASE, privacyStatus }))
      .toThrowError(new YouTubePrivateRequestRejectedError("YOUTUBE_PRIVATE_ONLY"));
    expect(controller.sideEffectCount()).toBe(0);
  });

  it.each([
    ["timestamp", "2026-09-01T00:00:00Z"],
    ["null", null],
    ["undefined", undefined],
    ["false", false],
  ])("rejects present publishAt (%s) before the client is called", (_name, publishAt) => {
    const { client, controller } = recordingClient();

    expect(() => startGuardedPrivateYouTubeUpload(client, { ...BASE, publishAt }))
      .toThrowError(new YouTubePrivateRequestRejectedError("YOUTUBE_SCHEDULE_NOT_ALLOWED"));
    expect(controller.sideEffectCount()).toBe(0);
  });

  it("cannot be opened by configuration or audit flags", () => {
    const { client, controller } = recordingClient();
    const unsafeConfiguration = {
      privacyStatus: "public",
      auditComplete: true,
      allowPublic: true,
    };

    expect(() => startGuardedPrivateYouTubeUpload(client, {
      ...BASE,
      ...unsafeConfiguration,
    }))
      .toThrowError(new YouTubePrivateRequestRejectedError("YOUTUBE_PRIVATE_ONLY"));
    expect(controller.sideEffectCount()).toBe(0);
  });

  it.each([
    ["provider request", {
      providerRequest: {
        part: "status",
        requestBody: { status: { privacyStatus: "public" } },
      },
    }],
    ["scheduled provider request", {
      providerRequest: {
        part: "status",
        requestBody: {
          status: { privacyStatus: "private", publishAt: "2026-09-01T00:00:00Z" },
        },
      },
    }],
    ["nested configuration", {
      configuration: { privacyStatus: "unlisted" },
    }],
    ["unknown field", {
      futureOverride: "public",
    }],
    ["source metadata injection", {
      source: { ...BASE.source, privacyStatus: "public" },
    }],
  ])("rejects %s injection instead of silently correcting it", (_name, injected) => {
    const { client, controller } = recordingClient();

    expect(() => startGuardedPrivateYouTubeUpload(client, { ...BASE, ...injected }))
      .toThrowError(YouTubePrivateRequestRejectedError);
    expect(controller.sideEffectCount()).toBe(0);
  });
});
