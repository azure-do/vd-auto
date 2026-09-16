import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueEvent } from "../src/domain";
import { canonicalFingerprint } from "../src/fingerprint";
import { handleQueueBatch } from "../src/queue";
import { JobRepository } from "../src/repository";

const NOW = new Date("2026-08-16T00:00:00.000Z");
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function fakeMessage(id: string, body: unknown, timestamp = NOW): Message<unknown> {
  return {
    id,
    timestamp,
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function fakeBatch(queue: string, messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

async function eventFingerprint(event: QueueEvent): Promise<string> {
  return canonicalFingerprint({
    event_type: event.event_type,
    video_job_id:
      event.event_type === "retention.sweep.requested" || event.event_type === "video.uploaded"
        ? null
        : event.payload.video_job_id,
    occurred_at: event.occurred_at,
    payload: event.payload,
  });
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dlq_messages"),
    env.DB.prepare("DELETE FROM queue_deliveries"),
    env.DB.prepare("DELETE FROM mirror_outbox"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM applied_mutations"),
    env.DB.prepare("DELETE FROM video_jobs"),
  ]);
}

describe("Queue boundary", () => {
  beforeEach(clearDatabase);

  it("leases an event so concurrent consumers cannot process it together", async () => {
    const repository = new JobRepository(env.DB);
    const input = {
      messageId: "message_lease_1",
      eventId: "event_lease_1",
      eventType: "retention.sweep.requested",
      eventFingerprint: "0".repeat(64),
      now: NOW.toISOString(),
    };
    const first = await repository.recordQueueStart(input);
    expect(first.status).toBe("started");
    expect(
      await repository.recordQueueStart({ ...input, messageId: "message_lease_2" }),
    ).toEqual({ status: "in_progress" });
    const reclaimed = await repository.recordQueueStart({
        ...input,
        messageId: "message_lease_3",
        now: "2026-08-16T00:01:01.000Z",
      });
    expect(reclaimed).toMatchObject({ status: "started" });
    if (first.status === "started") {
      expect(
        await repository.recordQueueProcessed(
          input.eventId,
          first.leaseToken,
          "2026-08-16T00:01:02.000Z",
        ),
      ).toBe(false);
    }
  });

  it("acknowledges a duplicate delivery without repeating the transition", async () => {
    const repository = new JobRepository(env.DB);
    await repository.createVideoJob({
      videoJobId: uuid(1),
      submissionId: uuid(10_001),
      branchId: "branch_dummy",
      studioId: "studio_dummy",
      classId: "class_dummy",
      teacherId: "teacher_dummy",
      actor: { type: "system", id: "system_test" },
      now: NOW.toISOString(),
    });
    const event: QueueEvent = {
      version: 1,
      event_id: uuid(20_001),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(1),
        expected_state: "RECEIVED",
        next_state: "VALIDATING",
        actor_id: "system_queue",
      },
    };
    const first = fakeMessage("message_1", event);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [first]), env);
    expect(first.ack).toHaveBeenCalledOnce();

    const duplicate = fakeMessage("message_2_same_event", {
      ...event,
      occurred_at: "2026-08-16T09:00:00.000+09:00",
    });
    await handleQueueBatch(fakeBatch("lr-video-jobs", [duplicate]), env);
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect((await repository.getVideoJob(uuid(1)))?.row_version).toBe(1);
  });

  it("rejects APPROVED and REJECTED transitions at the generic Queue boundary", async () => {
    for (const [suffix, nextState] of [[81, "APPROVED"], [82, "REJECTED"]] as const) {
      const repository = new JobRepository(env.DB);
      await repository.createVideoJob({
        videoJobId: uuid(suffix), submissionId: uuid(10_000 + suffix),
        branchId: "branch_dummy", studioId: "studio_dummy", classId: "class_dummy",
        teacherId: "teacher_dummy", actor: { type: "system", id: "system_test" },
        now: NOW.toISOString(),
      });
      for (const [expectedState, state] of [
        ["RECEIVED", "VALIDATING"], ["VALIDATING", "PROCESSING"],
        ["PROCESSING", "WAITING_APPROVAL"],
      ] as const) {
        await repository.transitionJob({
          videoJobId: uuid(suffix), expectedState, nextState: state,
          actor: { type: "system", id: "system_test" }, now: NOW.toISOString(),
        });
      }
      const event: QueueEvent = {
        version: 1, event_id: uuid(25_000 + suffix),
        event_type: "job.transition.requested", occurred_at: NOW.toISOString(),
        payload: {
          video_job_id: uuid(suffix), expected_state: "WAITING_APPROVAL", next_state: nextState,
          actor_id: "system_queue",
          ...(nextState === "APPROVED" ? {
            approved_content_version: "caller_supplied_version",
            publication_targets: [{ destination: "youtube", target_account_id: "caller_target" }],
          } : {}),
        },
      };
      const message = fakeMessage(`message_bypass_${suffix}`, event);
      await handleQueueBatch(fakeBatch("lr-video-jobs", [message]), env);
      expect(message.retry).toHaveBeenCalled();
      expect((await repository.getVideoJob(uuid(suffix)))?.state).toBe("WAITING_APPROVAL");
      expect(await env.DB.prepare(
        "SELECT last_error_code FROM queue_deliveries WHERE event_id = ?",
      ).bind(event.event_id).first()).toEqual({ last_error_code: "APPROVAL_BOUNDARY_REQUIRED" });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM idempotency_records").first())
      .toEqual({ count: 0 });
  });

  it("reclaims an expired lease even when redelivery keeps the original message timestamp", async () => {
    const repository = new JobRepository(env.DB);
    await repository.createVideoJob({
      videoJobId: uuid(2),
      submissionId: uuid(10_002),
      branchId: "branch_dummy",
      studioId: "studio_dummy",
      classId: "class_dummy",
      teacherId: "teacher_dummy",
      actor: { type: "system", id: "system_test" },
      now: NOW.toISOString(),
    });
    const event: QueueEvent = {
      version: 1,
      event_id: uuid(20_004),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(2),
        expected_state: "RECEIVED",
        next_state: "VALIDATING",
        actor_id: "system_queue",
      },
    };
    const lease = await repository.recordQueueStart({
      messageId: "message_crashed",
      eventId: event.event_id,
      eventType: event.event_type,
      eventFingerprint: await eventFingerprint(event),
      videoJobId: event.payload.video_job_id,
      now: NOW.toISOString(),
    });
    await repository.transitionJob({
      videoJobId: uuid(2),
      expectedState: "RECEIVED",
      nextState: "VALIDATING",
      actor: { type: "system", id: "system_queue" },
      now: NOW.toISOString(),
      mutationToken: event.event_id,
    });
    expect(lease.status).toBe("started");

    const redelivery = fakeMessage(
      "message_after_crash",
      event,
      NOW,
    );
    await handleQueueBatch(
      fakeBatch("lr-video-jobs", [redelivery]),
      env,
      () => new Date("2026-08-16T00:01:01.000Z"),
    );
    expect(redelivery.ack).toHaveBeenCalledOnce();
    expect((await repository.getVideoJob(uuid(2)))?.row_version).toBe(1);
  });

  it("acknowledges an old applied event after a newer event has advanced the job", async () => {
    const repository = new JobRepository(env.DB);
    await repository.createVideoJob({
      videoJobId: uuid(3),
      submissionId: uuid(10_003),
      branchId: "branch_dummy",
      studioId: "studio_dummy",
      classId: "class_dummy",
      teacherId: "teacher_dummy",
      actor: { type: "system", id: "system_test" },
      now: NOW.toISOString(),
    });
    const eventA: QueueEvent = {
      version: 1,
      event_id: uuid(20_006),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(3),
        expected_state: "RECEIVED",
        next_state: "VALIDATING",
        actor_id: "system_queue",
      },
    };
    const eventB: QueueEvent = {
      ...eventA,
      event_id: uuid(20_007),
      payload: {
        ...eventA.payload,
        expected_state: "VALIDATING",
        next_state: "PROCESSING",
      },
    };
    await repository.recordQueueStart({
      messageId: "message_a_crashed",
      eventId: eventA.event_id,
      eventType: eventA.event_type,
      eventFingerprint: await eventFingerprint(eventA),
      videoJobId: eventA.payload.video_job_id,
      now: NOW.toISOString(),
    });
    await repository.transitionJob({
      videoJobId: uuid(3),
      expectedState: "RECEIVED",
      nextState: "VALIDATING",
      actor: { type: "system", id: "system_queue" },
      now: NOW.toISOString(),
      mutationToken: eventA.event_id,
    });
    const newer = fakeMessage("message_b", eventB);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [newer]), env);
    expect(newer.ack).toHaveBeenCalledOnce();

    const oldRedelivery = fakeMessage(
      "message_a_redelivery",
      eventA,
      new Date("2026-08-16T00:01:01.000Z"),
    );
    await handleQueueBatch(fakeBatch("lr-video-jobs", [oldRedelivery]), env);
    expect(oldRedelivery.ack).toHaveBeenCalledOnce();
    expect((await repository.getVideoJob(uuid(3)))?.state).toBe("PROCESSING");
    const count = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'job.state.changed'")
      .first<{ count: number }>();
    expect(count?.count).toBe(2);
  });

  it("retries failures so Cloudflare can move them to the configured DLQ", async () => {
    const invalid: QueueEvent = {
      version: 1,
      event_id: uuid(20_002),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(999),
        expected_state: "RECEIVED",
        next_state: "VALIDATING",
        actor_id: "system_queue",
      },
    };
    const message = fakeMessage("message_invalid", invalid);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [message]), env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("claims the configured media account from a queue event", async () => {
    const repository = new JobRepository(env.DB);
    await repository.createVideoJob({
      videoJobId: uuid(4),
      submissionId: uuid(10_004),
      branchId: "branch_dummy",
      studioId: "studio_dummy",
      classId: "class_dummy",
      teacherId: "teacher_dummy",
      actor: { type: "system", id: "system_test" },
      now: NOW.toISOString(),
    });
    for (const [expectedState, nextState] of [
      ["RECEIVED", "VALIDATING"],
      ["VALIDATING", "PROCESSING"],
      ["PROCESSING", "WAITING_APPROVAL"],
    ] as const) {
      await repository.transitionJob({
        videoJobId: uuid(4),
        expectedState,
        nextState,
        actor: { type: "system", id: "system_test" },
        now: NOW.toISOString(),
      });
    }
    await repository.transitionJob({
      videoJobId: uuid(4),
      expectedState: "WAITING_APPROVAL",
      nextState: "APPROVED",
      approvedContentVersion: "v1",
      publicationTargets: [
        { destination: "youtube", targetAccountId: "youtube_account_queue" },
      ],
      actor: { type: "approver", id: "approver_test" },
      now: NOW.toISOString(),
    });
    const event: QueueEvent = {
      version: 1,
      event_id: uuid(20_009),
      event_type: "publication.claim.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(4),
        destination: "youtube",
        target_account_id: "youtube_account_queue",
        approved_content_version: "v1",
        actor_id: "system_queue",
      },
    };
    const message = fakeMessage("message_claim", event);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [message]), env);
    expect(message.ack).toHaveBeenCalledOnce();
    const claim = await env.DB
      .prepare(
        `SELECT target_account_id, status FROM idempotency_records
         WHERE destination = 'youtube'`,
      )
      .first<{ target_account_id: string; status: string }>();
    expect(claim).toEqual({
      target_account_id: "youtube_account_queue",
      status: "CLAIMED",
    });
  });

  it("fails closed when an old publication event omits target_account_id", async () => {
    const oldPayload = {
      version: 1,
      event_id: uuid(20_008),
      event_type: "publication.claim.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(1),
        destination: "youtube",
        approved_content_version: "v1",
        actor_id: "system_queue",
      },
    };
    const message = fakeMessage("message_old_claim", oldPayload);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [message]), env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    const count = await env.DB
      .prepare("SELECT COUNT(*) count FROM queue_deliveries")
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("rejects a non-string publication target account before creating a queue delivery", async () => {
    const invalidTarget = {
      version: 1,
      event_id: uuid(20_040),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(1),
        expected_state: "WAITING_APPROVAL",
        next_state: "APPROVED",
        actor_id: "system_queue",
        approved_content_version: "v1",
        publication_targets: [
          { destination: "youtube", target_account_id: 982_734 },
        ],
      },
    };
    const message = fakeMessage("message_numeric_target", invalidTarget);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [message]), env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    const count = await env.DB
      .prepare("SELECT COUNT(*) count FROM queue_deliveries")
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("quarantines a non-string publication target at the DLQ without storing raw input", async () => {
    const invalidTarget = {
      version: 1,
      event_id: uuid(20_041),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      unknown_token: "dummy-invalid-target-token",
      payload: {
        video_job_id: uuid(1),
        expected_state: "WAITING_APPROVAL",
        next_state: "APPROVED",
        actor_id: "system_queue",
        approved_content_version: "v1",
        publication_targets: [
          { destination: "youtube", target_account_id: 982_734 },
        ],
      },
    };
    const message = fakeMessage("message_numeric_target_dlq", invalidTarget);
    await handleQueueBatch(fakeBatch(env.DLQ_QUEUE_NAME, [message]), env);
    expect(message.ack).toHaveBeenCalledOnce();
    const captured = await env.DB
      .prepare(
        `SELECT status, quarantine_reason, payload_json
         FROM dlq_messages WHERE dlq_message_id = 'dlq_message_numeric_target_dlq'`,
      )
      .first<{
        status: string;
        quarantine_reason: string;
        payload_json: string;
      }>();
    expect(captured).toMatchObject({
      status: "QUARANTINED",
      quarantine_reason: "INVALID_EVENT_SCHEMA",
    });
    expect(captured?.payload_json).not.toContain("dummy-invalid-target-token");
    expect(captured?.payload_json).not.toContain("982734");

    const send = vi.fn(async () => undefined);
    const replayed = await new JobRepository(env.DB, {
      deletionOperatorIds: ["operator_local"],
    }).replayDlqMessage(
      "dlq_message_numeric_target_dlq",
      { send } as unknown as Queue,
      "operator_local",
      NOW.toISOString(),
    );
    expect(replayed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("quarantines a changed event_id after the original was processed", async () => {
    const repository = new JobRepository(env.DB);
    await repository.createVideoJob({
      videoJobId: uuid(5),
      submissionId: uuid(10_005),
      branchId: "branch_dummy",
      studioId: "studio_dummy",
      classId: "class_dummy",
      teacherId: "teacher_dummy",
      actor: { type: "system", id: "system_test" },
      now: NOW.toISOString(),
    });
    const original: QueueEvent = {
      version: 1,
      event_id: uuid(20_010),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(5),
        expected_state: "RECEIVED",
        next_state: "VALIDATING",
        actor_id: "system_queue",
      },
    };
    const first = fakeMessage("message_collision_processed_first", original);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [first]), env);
    expect(first.ack).toHaveBeenCalledOnce();

    const changed: QueueEvent = {
      ...original,
      occurred_at: "2026-08-16T00:05:00.000Z",
      payload: { ...original.payload, next_state: "PROCESSING" },
    };
    const collision = fakeMessage("message_collision_processed_changed", changed);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [collision]), env);
    expect(collision.ack).not.toHaveBeenCalled();
    expect(collision.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(await repository.getVideoJob(uuid(5))).toMatchObject({
      state: "VALIDATING",
      row_version: 1,
    });
    const delivery = await env.DB
      .prepare(
        `SELECT status, last_error_code FROM queue_deliveries WHERE event_id = ?`,
      )
      .bind(original.event_id)
      .first<{ status: string; last_error_code: string }>();
    expect(delivery).toEqual({
      status: "QUARANTINED",
      last_error_code: "EVENT_ID_COLLISION",
    });
    const audits = await env.DB
      .prepare(
        `SELECT COUNT(*) count FROM audit_logs
         WHERE action = 'queue.event_id.collision'`,
      )
      .first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it("quarantines a changed event_id after the original failed without ghost work", async () => {
    const repository = new JobRepository(env.DB);
    await repository.createVideoJob({
      videoJobId: uuid(6),
      submissionId: uuid(10_006),
      branchId: "branch_dummy",
      studioId: "studio_dummy",
      classId: "class_dummy",
      teacherId: "teacher_dummy",
      actor: { type: "system", id: "system_test" },
      now: NOW.toISOString(),
    });
    const original: QueueEvent = {
      version: 1,
      event_id: uuid(20_011),
      event_type: "job.transition.requested",
      occurred_at: NOW.toISOString(),
      payload: {
        video_job_id: uuid(999),
        expected_state: "RECEIVED",
        next_state: "VALIDATING",
        actor_id: "system_queue",
      },
    };
    const failed = fakeMessage("message_collision_failed_first", original);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [failed]), env);
    expect(failed.retry).toHaveBeenCalledOnce();

    const changed: QueueEvent = {
      ...original,
      occurred_at: "2026-08-16T00:05:00.000Z",
    };
    const collision = fakeMessage("message_collision_failed_changed", changed);
    await handleQueueBatch(fakeBatch("lr-video-jobs", [collision]), env);
    expect(collision.ack).not.toHaveBeenCalled();
    expect(collision.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(await repository.getVideoJob(uuid(6))).toMatchObject({
      state: "RECEIVED",
      row_version: 0,
    });
    const delivery = await env.DB
      .prepare(
        `SELECT status, last_error_code FROM queue_deliveries WHERE event_id = ?`,
      )
      .bind(original.event_id)
      .first<{ status: string; last_error_code: string }>();
    expect(delivery).toEqual({
      status: "QUARANTINED",
      last_error_code: "EVENT_ID_COLLISION",
    });
    const audits = await env.DB
      .prepare(
        `SELECT COUNT(*) count FROM audit_logs
         WHERE action = 'queue.event_id.collision'`,
      )
      .first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it("rejects unsafe approved content versions before creating a queue delivery", async () => {
    for (const [index, approvedContentVersion] of [
      "person@example.invalid",
      "bad version",
      "bad\nversion",
      "../version",
      "<version>",
    ].entries()) {
      const event = {
        version: 1,
        event_id: uuid(20_020 + index),
        event_type: "publication.claim.requested",
        occurred_at: NOW.toISOString(),
        payload: {
          video_job_id: uuid(1),
          destination: "youtube",
          target_account_id: "youtube_account_queue",
          approved_content_version: approvedContentVersion,
          actor_id: "system_queue",
        },
      };
      const message = fakeMessage(`message_unsafe_version_${index}`, event);
      await handleQueueBatch(fakeBatch("lr-video-jobs", [message]), env);
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
    }
    const count = await env.DB
      .prepare("SELECT COUNT(*) count FROM queue_deliveries")
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("captures DLQ messages and can replay them safely", async () => {
    const event: QueueEvent = {
      version: 1,
      event_id: uuid(20_003),
      event_type: "retention.sweep.requested",
      occurred_at: NOW.toISOString(),
      payload: { actor_id: "system_retention" },
    };
    const message = fakeMessage("message_dlq", event);
    await handleQueueBatch(fakeBatch(env.DLQ_QUEUE_NAME, [message]), env);
    expect(message.ack).toHaveBeenCalledOnce();

    const send = vi.fn(async () => undefined);
    const replayed = await new JobRepository(env.DB, {
      deletionOperatorIds: ["operator_local"],
    }).replayDlqMessage(
      "dlq_message_dlq",
      { send } as unknown as Queue,
      "operator_local",
      NOW.toISOString(),
    );
    expect(replayed).toBe(true);
    expect(send).toHaveBeenCalledWith(event);
  });

  it("normalizes known DLQ events and drops unknown fields before storage and replay", async () => {
    const body = {
      version: 1,
      event_id: uuid(20_030),
      event_type: "retention.sweep.requested",
      occurred_at: NOW.toISOString(),
      unknown_top_level: "drop_top_level",
      password: "dummy-password-in-unknown-field",
      payload: {
        actor_id: "system_retention",
        unknown_nested: {
          email: "unknown-field@example.invalid",
          token: "dummy-token-in-unknown-field",
        },
      },
    };
    const message = fakeMessage("message_dlq_unknown_fields", body);
    await handleQueueBatch(fakeBatch(env.DLQ_QUEUE_NAME, [message]), env);
    expect(message.ack).toHaveBeenCalledOnce();
    const captured = await env.DB
      .prepare(
        `SELECT payload_json, status, quarantine_reason FROM dlq_messages
         WHERE dlq_message_id = 'dlq_message_dlq_unknown_fields'`,
      )
      .first<{
        payload_json: string;
        status: string;
        quarantine_reason: string | null;
      }>();
    expect(captured?.payload_json).not.toContain("drop_top_level");
    expect(captured?.payload_json).not.toContain("dummy-password-in-unknown-field");
    expect(captured?.payload_json).not.toContain("unknown-field@example.invalid");
    expect(captured?.payload_json).not.toContain("dummy-token-in-unknown-field");
    expect(captured).toMatchObject({ status: "PENDING", quarantine_reason: null });

    const send = vi.fn(async () => undefined);
    const replayed = await new JobRepository(env.DB, {
      deletionOperatorIds: ["operator_local"],
    }).replayDlqMessage(
      "dlq_message_dlq_unknown_fields",
      { send } as unknown as Queue,
      "operator_local",
      NOW.toISOString(),
    );
    expect(replayed).toBe(true);
    expect(send).toHaveBeenCalledWith({
      version: 1,
      event_id: uuid(20_030),
      event_type: "retention.sweep.requested",
      occurred_at: NOW.toISOString(),
      payload: { actor_id: "system_retention" },
    });
  });

  it("recovers an expired DLQ replay lease and rejects an unapproved operator", async () => {
    const event: QueueEvent = {
      version: 1,
      event_id: uuid(20_005),
      event_type: "retention.sweep.requested",
      occurred_at: NOW.toISOString(),
      payload: { actor_id: "system_retention" },
    };
    const message = fakeMessage("message_dlq_lease", event);
    await handleQueueBatch(fakeBatch(env.DLQ_QUEUE_NAME, [message]), env);
    await env.DB
      .prepare(
        `UPDATE dlq_messages
         SET status = 'REPLAYING', replayed_by = 'operator_previous',
             replay_lease_expires_at = '2026-08-15T23:59:00.000Z'
         WHERE dlq_message_id = 'dlq_message_dlq_lease'`,
      )
      .run();

    const unauthorized = new JobRepository(env.DB, {
      deletionOperatorIds: ["operator_local"],
    });
    await expect(
      unauthorized.replayDlqMessage(
        "dlq_message_dlq_lease",
        { send: vi.fn() } as unknown as Queue,
        "operator_other",
        NOW.toISOString(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const send = vi.fn(async () => undefined);
    expect(
      await unauthorized.replayDlqMessage(
        "dlq_message_dlq_lease",
        { send } as unknown as Queue,
        "operator_local",
        NOW.toISOString(),
      ),
    ).toBe(true);
    expect(send).toHaveBeenCalledWith(event);
  });

  it("quarantines malformed DLQ messages without retaining or replaying raw secrets", async () => {
    const poison = {
      unexpected: true,
      email: "sensitive-person@example.invalid",
      nested: {
        password: "dummy-password-must-not-persist",
        token: "dummy-token-must-not-persist",
      },
    };
    const message = fakeMessage("message_bad_dlq", poison);
    await handleQueueBatch(fakeBatch(env.DLQ_QUEUE_NAME, [message]), env);
    expect(message.ack).toHaveBeenCalledOnce();
    const captured = await env.DB
      .prepare(
        `SELECT event_type, status, quarantine_reason, payload_json,
                payload_digest, payload_byte_size, payload_type
         FROM dlq_messages`,
      )
      .first<{
        event_type: string;
        status: string;
        quarantine_reason: string;
        payload_json: string;
        payload_digest: string;
        payload_byte_size: number;
        payload_type: string;
      }>();
    expect(captured).toMatchObject({
      event_type: "invalid",
      status: "QUARANTINED",
      quarantine_reason: "INVALID_EVENT_SCHEMA",
      payload_type: "object",
    });
    expect(captured?.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(captured?.payload_byte_size).toBeGreaterThan(0);
    for (const secret of [
      "sensitive-person@example.invalid",
      "dummy-password-must-not-persist",
      "dummy-token-must-not-persist",
      "unexpected",
    ]) {
      expect(captured?.payload_json).not.toContain(secret);
    }

    const send = vi.fn(async () => undefined);
    const repository = new JobRepository(env.DB, {
      deletionOperatorIds: ["operator_local"],
    });
    expect(
      await repository.replayDlqMessage(
        "dlq_message_bad_dlq",
        { send } as unknown as Queue,
        "operator_local",
        NOW.toISOString(),
      ),
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();

    const duplicate = fakeMessage("message_bad_dlq", poison);
    await handleQueueBatch(fakeBatch(env.DLQ_QUEUE_NAME, [duplicate]), env);
    expect(duplicate.ack).toHaveBeenCalledOnce();
    const count = await env.DB
      .prepare("SELECT COUNT(*) count FROM dlq_messages")
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
