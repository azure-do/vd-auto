import type { Actor, VideoJob } from "./domain";
import { classifyYouTubeObservation, type YouTubePublishObservation } from "./e5-contracts";
import { ConcurrentUpdateError, InvalidTransitionError } from "./errors";
import type { JobRepository, PublicationRecord } from "./repository";

export type YouTubeReconciliationObservation =
  | { kind: "found"; observation: YouTubePublishObservation & { kind: "status" } }
  // Authoritative absence for this exact ID in the verified target channel. A transient
  // empty response, permission failure or uncertain provider visibility must be "unknown".
  | { kind: "not_found" }
  | { kind: "unknown" };

export interface YouTubeReconciliationClient {
  listVideo(videoId: string): Promise<YouTubeReconciliationObservation>;
}

export type YouTubeReconciliationResult =
  | { state: "PUBLISHED"; newSessionAllowed: false; job: VideoJob; videoId: string }
  | { state: "PENDING"; newSessionAllowed: true; job: VideoJob }
  | { state: "RECONCILIATION_REQUIRED"; newSessionAllowed: false; job: VideoJob };

type ReconciliationRepository = Pick<
  JobRepository,
  "getPublicationRecord" | "getVideoJob" | "recordPublicationResult" |
  "recordYoutubeReconciliationNone" | "beginYoutubeReconciliationObservation" |
  "completeYoutubeReconciliationObservation"
>;

const OBSERVATION_LEASE_MS = 60_000;

/**
 * E-5.4 local orchestration boundary. The client is a videos.list-shaped fake in this unit;
 * OAuth and real Google HTTP remain outside this implementation.
 */
export class E5YoutubeReconciliationService {
  constructor(
    private readonly repository: ReconciliationRepository,
    private readonly client: YouTubeReconciliationClient,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async reconcile(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    actor: Actor;
  }): Promise<YouTubeReconciliationResult> {
    const startedAt = this.now();
    const lookup = {
      videoJobId: input.videoJobId,
      destination: "youtube" as const,
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
    };
    const record = await this.repository.getPublicationRecord(lookup);
    const job = await this.repository.getVideoJob(input.videoJobId);
    if (!record || !job) throw new Error("YouTube publication record was not found");
    if (record.status !== "RECONCILIATION_REQUIRED") {
      return this.currentResult(record, job);
    }

    // Without a validated provider ID videos.list cannot prove absence. Offset alone must block.
    if (!record.yt_video_id) {
      return { state: "RECONCILIATION_REQUIRED", newSessionAllowed: false, job };
    }
    const observationToken = `e5_reconciliation_${crypto.randomUUID()}`;
    const observationStarted = await this.repository.beginYoutubeReconciliationObservation({
      videoJobId: input.videoJobId,
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
      observationToken,
      now: startedAt,
      expiresAt: new Date(Date.parse(startedAt) + OBSERVATION_LEASE_MS).toISOString(),
    });
    if (!observationStarted) return this.readLatest(lookup, record, job);
    const observation = await this.client.listVideo(record.yt_video_id);
    const completedAt = this.now();
    if (observation.kind === "unknown") {
      return { state: "RECONCILIATION_REQUIRED", newSessionAllowed: false, job };
    }
    if (observation.kind === "found") {
      const completed = await this.repository.completeYoutubeReconciliationObservation({
        observationToken,
        result: "FOUND",
        now: completedAt,
      });
      if (!completed) return this.readLatest(lookup, record, job);
      const latestRecord = await this.repository.getPublicationRecord(lookup);
      if (latestRecord?.attempt_no !== record.attempt_no) {
        return this.readLatest(lookup, record, job);
      }
      const decision = classifyYouTubeObservation(observation.observation, completedAt);
      if (decision.state !== "PUBLISHED" || decision.videoId !== record.yt_video_id) {
        return { state: "RECONCILIATION_REQUIRED", newSessionAllowed: false, job };
      }
      let published: VideoJob;
      try {
        published = await this.repository.recordPublicationResult({
          ...lookup,
          result: "SUCCEEDED",
          resultRef: decision.videoId,
          actor: input.actor,
          now: completedAt,
          expectedAttemptNo: record.attempt_no,
        });
      } catch (error) {
        if (!(error instanceof ConcurrentUpdateError) &&
          !(error instanceof InvalidTransitionError) &&
          !(error instanceof Error && error.message.includes("SQLITE_CONSTRAINT"))) throw error;
        const latest = await this.readLatest(lookup, record, job);
        if (latest.state !== "RECONCILIATION_REQUIRED") return latest;
        throw error;
      }
      return {
        state: "PUBLISHED",
        newSessionAllowed: false,
        job: published,
        videoId: decision.videoId,
      };
    }

    // A missing video is not sufficient while an old resumable session might still work.
    if (record.yt_session_state !== "UNUSABLE") {
      const completed = await this.repository.completeYoutubeReconciliationObservation({
        observationToken,
        result: "NONE",
        now: completedAt,
      });
      if (!completed) return this.readLatest(lookup, record, job);
      return { state: "RECONCILIATION_REQUIRED", newSessionAllowed: false, job };
    }
    const completed = await this.repository.completeYoutubeReconciliationObservation({
      observationToken,
      result: "NONE",
      now: completedAt,
    });
    if (!completed) return this.readLatest(lookup, record, job);
    let cleared;
    try {
      cleared = await this.repository.recordYoutubeReconciliationNone({
        videoJobId: input.videoJobId,
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
        expectedVideoId: record.yt_video_id,
        actor: input.actor,
        now: completedAt,
      });
    } catch (error) {
      if (!(error instanceof ConcurrentUpdateError) &&
        !(error instanceof InvalidTransitionError) &&
        !(error instanceof Error && error.message.includes("SQLITE_CONSTRAINT"))) throw error;
      const latest = await this.readLatest(lookup, record, job);
      if (latest.state !== "RECONCILIATION_REQUIRED") return latest;
      throw error;
    }
    if (!cleared.cleared) {
      const latest = await this.repository.getPublicationRecord(lookup);
      return this.currentResult(latest ?? record, cleared.job);
    }
    return { state: "PENDING", newSessionAllowed: true, job: cleared.job };
  }

  private currentResult(record: PublicationRecord, job: VideoJob): YouTubeReconciliationResult {
    if (record.status === "SUCCEEDED" && record.result_ref) {
      return {
        state: "PUBLISHED",
        newSessionAllowed: false,
        job,
        videoId: record.result_ref,
      };
    }
    if (record.status === "PENDING" && record.yt_committed_offset === 0 &&
      !record.yt_video_id && record.yt_session_state === "NONE") {
      return { state: "PENDING", newSessionAllowed: true, job };
    }
    return { state: "RECONCILIATION_REQUIRED", newSessionAllowed: false, job };
  }

  private async readLatest(
    lookup: {
      videoJobId: string;
      destination: "youtube";
      targetAccountId: string;
      approvedContentVersion: string;
    },
    fallbackRecord: PublicationRecord,
    fallbackJob: VideoJob,
  ): Promise<YouTubeReconciliationResult> {
    const [record, job] = await Promise.all([
      this.repository.getPublicationRecord(lookup),
      this.repository.getVideoJob(lookup.videoJobId),
    ]);
    return this.currentResult(record ?? fallbackRecord, job ?? fallbackJob);
  }
}
