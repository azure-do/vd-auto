export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Invalid job transition: ${from} -> ${to}`, "INVALID_TRANSITION", false);
  }
}

export class ConcurrentUpdateError extends DomainError {
  constructor() {
    super("The job changed before this operation completed", "CONCURRENT_UPDATE", true);
  }
}

export class MutationCollisionError extends DomainError {
  constructor() {
    super(
      "A mutation token was reused for a different operation or input",
      "MUTATION_TOKEN_COLLISION",
      false,
    );
  }
}

export class JobIdentityCollisionError extends DomainError {
  constructor() {
    super(
      "A video job ID was reused for different immutable input",
      "VIDEO_JOB_ID_COLLISION",
      false,
    );
  }
}

export class IdentityBindingConflictError extends DomainError {
  constructor() {
    super(
      "The verified identity is already bound to another teacher, or the teacher is already bound",
      "IDENTITY_BINDING_CONFLICT",
      false,
    );
  }
}

export class IdentityLinkNotFoundError extends DomainError {
  constructor() {
    super(
      "The verified identity could not be matched to exactly one teacher",
      "IDENTITY_LINK_NOT_FOUND",
      false,
    );
  }
}

export class ReadModelVersionError extends DomainError {
  constructor(code: "OLD_SOURCE_VERSION" | "SOURCE_VERSION_COLLISION" | "SOURCE_IMPORT_CONFLICT") {
    super("The class read-model version cannot be activated", code, code === "SOURCE_IMPORT_CONFLICT");
  }
}

export class IntakeIdentityCollisionError extends DomainError {
  constructor() {
    super(
      "A submission ID was reused for different intake input",
      "SUBMISSION_ID_COLLISION",
      false,
    );
  }
}

export class PublicationClaimBlockedError extends DomainError {
  constructor() {
    super(
      "Another YouTube target must finish or be reconciled before this target can be claimed",
      "PUBLICATION_CLAIM_BLOCKED",
      true,
    );
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string) {
    super(`${entity} was not found`, "NOT_FOUND", false);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "The actor is not allowed to perform this operation") {
    super(message, "FORBIDDEN", false);
  }
}

export function toErrorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  return "UNEXPECTED_ERROR";
}
