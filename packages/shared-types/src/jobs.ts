export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter";

export type JobPayload = Record<string, unknown>;

export interface Job {
  id: string;
  organizationId: string;
  type: string;
  payload: JobPayload;
  status: JobStatus;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
}

export interface EnqueueJobInput {
  organizationId: string;
  type: string;
  payload?: JobPayload;
  idempotencyKey: string;
  maxAttempts?: number;
  availableAt?: Date;
}
