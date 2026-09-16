import { E2Repository, type ClassCandidate, type SubmissionIntake } from "./e2-repository";
import {
  verifyLocalTestIdToken,
  type LocalOidcConfig,
} from "./e2-oidc";
import { IdentityLinkNotFoundError } from "./errors";

export interface FakeNotifier {
  send(input: {
    notificationId: string;
    submissionId: string;
    reasonCode: string;
  }): Promise<void>;
}

export interface E2SubmissionOutcome {
  intake: SubmissionIntake;
  candidates: ClassCandidate[];
  identityWasRegistered: boolean;
}

export class E2LocalService {
  constructor(
    private readonly e2: E2Repository,
    private readonly oidc: LocalOidcConfig,
  ) {}

  private async identifyTeacher(
    token: string,
    now: string,
  ): Promise<{ teacherId: string; subjectFingerprint: string; wasRegistered: boolean }> {
    const identity = await verifyLocalTestIdToken(token, this.oidc, now);
    const existing = await this.e2.findTeacherBySubject(identity.subjectFingerprint);
    if (existing) {
      return {
        teacherId: existing,
        subjectFingerprint: identity.subjectFingerprint,
        wasRegistered: false,
      };
    }
    const matches = await this.e2.findTeacherIdsForInitialLink(identity.emailFingerprint, now);
    if (matches.length !== 1) throw new IdentityLinkNotFoundError();
    const teacherId = matches[0]!;
    await this.e2.bindTeacherIdentity({
      teacherId,
      subjectFingerprint: identity.subjectFingerprint,
      actorId: "system_identity",
      now,
    });
    return {
      teacherId,
      subjectFingerprint: identity.subjectFingerprint,
      wasRegistered: true,
    };
  }

  async submit(input: {
    idToken: string;
    submissionId: string;
    lessonOn: string;
    now: string;
  }): Promise<E2SubmissionOutcome> {
    const identity = await this.identifyTeacher(input.idToken, input.now);
    const existingIntake = await this.e2.getIntake(input.submissionId);
    let intake = await this.e2.beginIntake({
      submissionId: input.submissionId,
      intendedVideoJobId: existingIntake?.intended_video_job_id ?? crypto.randomUUID(),
      subjectFingerprint: identity.subjectFingerprint,
      teacherId: identity.teacherId,
      lessonOn: input.lessonOn,
      now: input.now,
    });
    if (intake.status === "RESOLVED") {
      return {
        intake,
        candidates: await this.e2.getCandidateSnapshots(input.submissionId),
        identityWasRegistered: identity.wasRegistered,
      };
    }

    let candidates: ClassCandidate[];
    if (intake.status === "JOB_CREATING") {
      candidates = await this.e2.getCandidateSnapshots(input.submissionId);
      intake = await this.e2.stageDecision({
        submissionId: input.submissionId,
        status: "RESOLVED",
        reasonCode: null,
        sourceVersion: intake.source_version,
        candidates,
        actorId: identity.teacherId,
        now: input.now,
      });
    } else {
      const snapshot = await this.e2.readCandidates(identity.teacherId, input.lessonOn, input.now);
      if (snapshot.status !== "AVAILABLE") {
        const reason = snapshot.status === "EXPIRED"
          ? "SOURCE_TTL_EXPIRED"
          : (snapshot.failureCode ?? "SOURCE_UNAVAILABLE");
        intake = await this.e2.stageDecision({
          submissionId: input.submissionId,
          status: "UNRESOLVED",
          reasonCode: reason,
          sourceVersion: snapshot.sourceVersion,
          candidates: [],
          actorId: identity.teacherId,
          now: input.now,
        });
        return {
          intake,
          candidates: [],
          identityWasRegistered: identity.wasRegistered,
        };
      }
      candidates = snapshot.candidates;
      if (candidates.length === 0) {
        intake = await this.e2.stageDecision({
          submissionId: input.submissionId,
          status: "UNRESOLVED",
          reasonCode: "NO_CLASS_MATCH",
          sourceVersion: snapshot.sourceVersion,
          candidates: [],
          actorId: identity.teacherId,
          now: input.now,
        });
        return {
          intake,
          candidates: [],
          identityWasRegistered: identity.wasRegistered,
        };
      }
      if (candidates.length > 1) {
        intake = await this.e2.stageDecision({
          submissionId: input.submissionId,
          status: "SELECTION_REQUIRED",
          reasonCode: "MULTIPLE_CLASS_CANDIDATES",
          sourceVersion: snapshot.sourceVersion,
          candidates,
          actorId: identity.teacherId,
          now: input.now,
        });
        return {
          intake,
          candidates,
          identityWasRegistered: identity.wasRegistered,
        };
      }
      intake = await this.e2.stageDecision({
        submissionId: input.submissionId,
        status: "RESOLVED",
        reasonCode: null,
        sourceVersion: snapshot.sourceVersion,
        candidates,
        actorId: identity.teacherId,
        now: input.now,
      });
    }

    const candidate = candidates[0];
    if (!candidate) throw new Error("A resolved intake is missing its canonical class snapshot");
    return {
      intake,
      candidates,
      identityWasRegistered: identity.wasRegistered,
    };
  }

  async flushFakeNotifications(notifier: FakeNotifier, now: string): Promise<number> {
    const pending = await this.e2.claimFakeNotifications({ now });
    let delivered = 0;
    for (const record of pending) {
      try {
        await notifier.send({
          notificationId: record.notification_id,
          submissionId: record.submission_id,
          reasonCode: record.reason_code,
        });
        if (await this.e2.recordFakeNotificationDelivered(
          record.notification_id,
          record.lease_token,
          now,
        )) delivered += 1;
      } catch {
        await this.e2.recordFakeNotificationFailed(
          record.notification_id,
          record.lease_token,
          now,
        );
        throw new Error("Fake notification delivery failed");
      }
    }
    return delivered;
  }
}

export class MemoryFakeNotifier implements FakeNotifier {
  readonly deliveries: Array<{
    notificationId: string;
    submissionId: string;
    reasonCode: string;
  }> = [];

  constructor(private failuresRemaining = 0) {}

  async send(input: {
    notificationId: string;
    submissionId: string;
    reasonCode: string;
  }): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Injected fake notifier failure");
    }
    if (!this.deliveries.some((delivery) => delivery.notificationId === input.notificationId)) {
      this.deliveries.push(input);
    }
  }
}
