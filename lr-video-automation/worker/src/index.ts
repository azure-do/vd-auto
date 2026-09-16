import { WorkerEntrypoint } from "cloudflare:workers";
import { handleQueueBatch } from "./queue";
import { JobRepository } from "./repository";
import { E3R2UploadService, R2UploadObjectInspector } from "./e3-r2-upload";
import { handleE5YoutubeOAuthHttp } from "./e5-oauth-http";

const DEV_ORIGIN = "http://localhost:8788";

function json(status: number, value: Record<string, unknown>, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function devCors(request: Request): HeadersInit | null {
  const origin = request.headers.get("origin");
  if (origin !== DEV_ORIGIN) return null;
  return {
    "access-control-allow-origin": DEV_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-dev-test-secret",
    "access-control-max-age": "300",
    vary: "Origin",
  };
}

export class UploadQueueUnavailableError extends Error {
  constructor() { super("Upload receipt is durable but Queue delivery failed"); }
}

export async function enqueueCompletedUploadEvent(
  service: Pick<E3R2UploadService, "complete">,
  queue: Queue,
  input: { submissionId: string; uploadId: string; eventId: string },
): Promise<void> {
  const event = await service.complete(input);
  try {
    await queue.send(event);
  } catch {
    // The callback may safely retry because complete() recovers the durable
    // receipt and returns the same event.
    throw new UploadQueueUnavailableError();
  }
}

export function e3UploadErrorResponse(error: unknown, cors: HeadersInit = {}): Response {
  if (error instanceof UploadQueueUnavailableError) {
    return json(503, { code: "QUEUE_UNAVAILABLE", retryable: true }, { ...cors, "retry-after": "1" });
  }
  return json(400, { code: "UPLOAD_REJECTED" }, cors);
}

export default class E1Worker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__ops/e5/youtube-oauth/")) {
      // Keep the global fetch invocation inside the active request context.
      // Tests can still inject their own fetch implementation into the HTTP handler.
      const requestFetch: typeof fetch = (input, init) => fetch(input, init);
      return handleE5YoutubeOAuthHttp(request, this.env, requestFetch);
    }
    if (url.pathname.startsWith("/__dev/e3/")) return this.handleE3Dev(request, url);
    return new Response("Not found", { status: 404 });
  }

  private async handleE3Dev(request: Request, url: URL): Promise<Response> {
    // This entire boundary disappears when the development-only secret is not
    // set. It is not a substitute for the production OIDC route.
    if (!this.env.DEV_TEST_SECRET || !this.env.VIDEO_UPLOADS_R2 || !this.env.R2_BUCKET_NAME || !this.env.R2_ACCOUNT_ID ||
      !this.env.R2_UPLOAD_ACCESS_KEY_ID || !this.env.R2_UPLOAD_SECRET_ACCESS_KEY) {
      return new Response("Not found", { status: 404 });
    }
    const cors = devCors(request);
    if (!cors) return new Response("Forbidden", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST" || request.headers.get("x-dev-test-secret") !== this.env.DEV_TEST_SECRET) {
      return new Response("Not found", { status: 404 });
    }
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return json(400, { code: "INVALID_JSON" }, cors); }
    const service = new E3R2UploadService(
      this.env.DB,
      new R2UploadObjectInspector(this.env.VIDEO_UPLOADS_R2),
      {
        accountId: this.env.R2_ACCOUNT_ID,
        accessKeyId: this.env.R2_UPLOAD_ACCESS_KEY_ID,
        secretAccessKey: this.env.R2_UPLOAD_SECRET_ACCESS_KEY,
        bucketName: this.env.R2_BUCKET_NAME,
      },
    );
    try {
      if (url.pathname === "/__dev/e3/uploads/begin") {
        const result = await service.begin({
          submissionId: String(body.submission_id ?? ""), sizeBytes: Number(body.size_bytes),
          checksumSha256: String(body.checksum_sha256 ?? ""), contentType: String(body.content_type ?? ""),
        });
        return json(201, {
          upload_id: result.session.upload_id, expires_at: result.session.expires_at,
          // The client needs the presigned URL, but it is intentionally never logged or persisted.
          upload_url: result.upload.url, required_headers: result.upload.requiredHeaders,
        }, cors);
      }
      if (url.pathname === "/__dev/e3/uploads/complete") {
        await enqueueCompletedUploadEvent(service, this.env.VIDEO_JOBS_QUEUE, {
          submissionId: String(body.submission_id ?? ""), uploadId: String(body.upload_id ?? ""),
          eventId: String(body.event_id ?? ""),
        });
        return json(202, { accepted: true }, cors);
      }
    } catch (error) {
      // Do not reflect object refs, URLs, credentials, or caller body values.
      return e3UploadErrorResponse(error, cors);
    }
    return new Response("Not found", { status: 404 });
  }

  async queue(batch: MessageBatch<unknown>): Promise<void> {
    await handleQueueBatch(batch, this.env);
  }

  /** Service Binding RPC only. There is intentionally no public HTTP admin route. */
  async replayDlqMessage(dlqMessageId: string, actorId: string): Promise<boolean> {
    const operatorIds = this.env.OPERATOR_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const repository = new JobRepository(this.env.DB, {
      retentionDays: Number(this.env.RETENTION_DAYS),
      deletionOperatorIds: operatorIds,
    });
    return repository.replayDlqMessage(
      dlqMessageId,
      this.env.VIDEO_JOBS_QUEUE,
      actorId,
      new Date().toISOString(),
    );
  }
}
