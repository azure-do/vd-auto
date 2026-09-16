export interface MirrorRecord {
  mirror_event_id: string;
  video_job_id: string;
  event_type: string;
  payload_json: string;
  attempt_count: number;
}

export interface SheetsMirrorSink {
  /** Must upsert by mirror_event_id so a retry never creates a duplicate row. */
  upsertByEventId(records: readonly MirrorRecord[]): Promise<void>;
}

export async function flushMirrorOutbox(
  db: D1Database,
  sink: SheetsMirrorSink,
  now: string,
  limit = 50,
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT mirror_event_id, video_job_id, event_type, payload_json, attempt_count
       FROM mirror_outbox
       WHERE status IN ('PENDING', 'FAILED') AND available_at <= ?
       ORDER BY created_at LIMIT ?`,
    )
    .bind(now, limit)
    .all<MirrorRecord>();
  if (result.results.length === 0) return 0;

  try {
    await sink.upsertByEventId(result.results);
    await db.batch(
      result.results.map((record) =>
        db
          .prepare(
            `UPDATE mirror_outbox
             SET status = 'DELIVERED', delivered_at = ?, updated_at = ?, last_error_code = NULL
             WHERE mirror_event_id = ? AND status IN ('PENDING', 'FAILED')`,
          )
          .bind(now, now, record.mirror_event_id),
      ),
    );
    return result.results.length;
  } catch {
    await db.batch(
      result.results.map((record) =>
        db
          .prepare(
            `UPDATE mirror_outbox
             SET status = 'FAILED', attempt_count = attempt_count + 1,
                 last_error_code = 'MIRROR_WRITE_FAILED', updated_at = ?
             WHERE mirror_event_id = ? AND status IN ('PENDING', 'FAILED')`,
          )
          .bind(now, record.mirror_event_id),
      ),
    );
    throw new Error("Sheets mirror write failed");
  }
}
