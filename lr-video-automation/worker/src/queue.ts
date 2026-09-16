import { normalizeQueueEvent, type QueueEvent } from "./domain";
import { DomainError, toErrorCode } from "./errors";
import {
  canonicalFingerprint,
  payloadTypeSummary,
  serializeForDigest,
  sha256Hex,
} from "./fingerprint";
import { JobRepository } from "./repository";
import { E3UploadReceiptConsumer } from "./e3-fake-upload";
import { R2_CALLBACK_ACTOR } from "./e3-r2-upload";

function videoJobIdOf(event: QueueEvent): string | undefined {
  if (event.event_type === "retention.sweep.requested" || event.event_type === "video.uploaded") {
    return undefined;
  }
  return event.payload.video_job_id;
}

async function queueEventFingerprint(event: QueueEvent): Promise<string> {
  return canonicalFingerprint({
    event_type: event.event_type,
    video_job_id: videoJobIdOf(event) ?? null,
    occurred_at: event.occurred_at,
    payload: event.payload,
  });
}

async function processEvent(
  repository: JobRepository,
  uploadConsumer: E3UploadReceiptConsumer,
  event: QueueEvent,
): Promise<void> {
  if (event.event_type === "video.uploaded") {
    await uploadConsumer.consume(event);
    return;
  }
  const actor = { type: "system" as const, id: event.payload.actor_id };
  if (event.event_type === "job.transition.requested") {
    // E-4 decisions must pass the allowlist, bound-token, expiry, and immutable
    // snapshot checks. The generic system Queue contract may not impersonate
    // that approval boundary with caller-supplied versions or targets.
    if (event.payload.next_state === "APPROVED" || event.payload.next_state === "REJECTED") {
      throw new DomainError(
        "Approval decisions are accepted only by the E-4 approval service",
        "APPROVAL_BOUNDARY_REQUIRED",
        false,
      );
    }
    await repository.transitionJob({
      videoJobId: event.payload.video_job_id,
      expectedState: event.payload.expected_state,
      nextState: event.payload.next_state,
      actor,
      now: event.occurred_at,
      mutationToken: event.event_id,
      ...(event.payload.approved_content_version
        ? { approvedContentVersion: event.payload.approved_content_version }
        : {}),
      ...(event.payload.publication_targets
        ? {
            publicationTargets: event.payload.publication_targets.map((target) => ({
              destination: target.destination,
              targetAccountId: target.target_account_id,
            })),
          }
        : {}),
    });
    return;
  }
  if (event.event_type === "publication.claim.requested") {
    await repository.claimPublication({
      videoJobId: event.payload.video_job_id,
      destination: event.payload.destination,
      targetAccountId: event.payload.target_account_id,
      approvedContentVersion: event.payload.approved_content_version,
      actor,
      now: event.occurred_at,
      mutationToken: event.event_id,
    });
    return;
  }
  await repository.markRetentionDue(event.occurred_at, actor);
}

export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const retentionDays = Number(env.RETENTION_DAYS);
  const repository = new JobRepository(env.DB, { retentionDays });
  // Both adapters persist the same immutable receipt contract.  No caller can
  // choose this actor: it is emitted only after server-side inspection.
  const uploadConsumer = new E3UploadReceiptConsumer(
    env.DB,
    new Set(["fake_upload_callback", R2_CALLBACK_ACTOR]),
  );
  if (batch.queue === env.DLQ_QUEUE_NAME) {
    for (const message of batch.messages) {
      const body = message.body;
      const capturedAt = clock().toISOString();
      const event = normalizeQueueEvent(body);
      if (!event) {
        const serialized = serializeForDigest(body);
        const payloadDigest = await sha256Hex(serialized);
        const payloadByteSize = new TextEncoder().encode(serialized).byteLength;
        await repository.captureDlqMessage({
          originalMessageId: message.id,
          eventId: "invalid_event",
          eventType: "invalid",
          payloadDigest,
          payloadByteSize,
          payloadType: payloadTypeSummary(body),
          quarantineReason: "INVALID_EVENT_SCHEMA",
          now: capturedAt,
        });
        message.ack();
        continue;
      }
      const eventFingerprint = await queueEventFingerprint(event);
      const collision = await repository.quarantineEventCollision(
        event.event_id,
        eventFingerprint,
        capturedAt,
      );
      await repository.captureDlqMessage({
        originalMessageId: message.id,
        eventId: event.event_id,
        eventType: event.event_type,
        event,
        ...(collision ? { quarantineReason: "EVENT_ID_COLLISION" as const } : {}),
        now: capturedAt,
      });
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) {
    const body = message.body;
    const processingStartedAt = clock().toISOString();
    const event = normalizeQueueEvent(body);
    if (!event) {
      message.retry();
      continue;
    }

    const eventFingerprint = await queueEventFingerprint(event);
    const videoJobId = videoJobIdOf(event);
    const delivery = await repository.recordQueueStart({
      messageId: message.id,
      eventId: event.event_id,
      eventType: event.event_type,
      eventFingerprint,
      ...(videoJobId ? { videoJobId } : {}),
      now: processingStartedAt,
    });
    if (delivery.status === "processed") {
      message.ack();
      continue;
    }
    if (delivery.status === "in_progress") {
      message.retry({ delaySeconds: 30 });
      continue;
    }
    if (delivery.status === "collision") {
      message.retry({ delaySeconds: 60 });
      continue;
    }
    if (delivery.status !== "started") continue;

    try {
      await processEvent(repository, uploadConsumer, event);
      const owned = await repository.recordQueueProcessed(
        event.event_id,
        delivery.leaseToken,
        clock().toISOString(),
      );
      if (owned) message.ack();
      else message.retry({ delaySeconds: 5 });
    } catch (error) {
      await repository.recordQueueFailed(
        event.event_id,
        delivery.leaseToken,
        toErrorCode(error),
        clock().toISOString(),
      );
      const delaySeconds = error instanceof DomainError && !error.retryable ? 60 : 5;
      message.retry({ delaySeconds });
    }
  }
}
