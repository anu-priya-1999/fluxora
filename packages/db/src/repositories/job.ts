import type {
  EnqueueJobInput,
  Job,
  JobPayload,
  JobStatus,
} from "@fluxora/shared-types";

import { getPool } from "../pool.ts";
import { withTenant } from "../tenant.ts";

interface JobRow {
  id: string;
  organization_id: string;
  type: string;
  payload: JobPayload;
  status: JobStatus;
  idempotency_key: string;
  attempt_count: number;
  max_attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
  };
}

function validateEnqueueInput(input: EnqueueJobInput): void {
  if (input.type.trim().length === 0) {
    throw new Error("job type must not be empty");
  }

  if (input.idempotencyKey.trim().length === 0) {
    throw new Error("job idempotency key must not be empty");
  }

  if (
    input.maxAttempts !== undefined &&
    (!Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0)
  ) {
    throw new Error("job maxAttempts must be a positive integer");
  }
}

export async function enqueueJob(input: EnqueueJobInput): Promise<Job> {
  validateEnqueueInput(input);

  const pool = getPool();

  return withTenant(pool, input.organizationId, async (client) => {
    const result = await client.query<JobRow>(
      `
        INSERT INTO jobs (
          organization_id,
          type,
          payload,
          idempotency_key,
          max_attempts,
          available_at
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
        ON CONFLICT (
          organization_id,
          idempotency_key
        )
        DO UPDATE SET id = jobs.id
        RETURNING
          id,
          organization_id,
          type,
          payload,
          status,
          idempotency_key,
          attempt_count,
          max_attempts,
          available_at,
          locked_at,
          locked_by,
          lease_expires_at,
          last_error,
          created_at,
          started_at,
          completed_at,
          failed_at
      `,
      [
        input.organizationId,
        input.type.trim(),
        input.payload ?? {},
        input.idempotencyKey.trim(),
        input.maxAttempts ?? 3,
        input.availableAt ?? null,
      ],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error("Failed to get job: PostgreSQL returned no row");
    }

    return mapJob(row);
  });
}

export async function getJobById(
  organizationId: string,
  jobId: string,
): Promise<Job | null> {
  const pool = getPool();

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<JobRow>(
      `
        SELECT
          id,
          organization_id,
          type,
          payload,
          status,
          idempotency_key,
          attempt_count,
          max_attempts,
          available_at,
          locked_at,
          locked_by,
          lease_expires_at,
          last_error,
          created_at,
          started_at,
          completed_at,
          failed_at
        FROM jobs
        WHERE id = $1
      `,
      [jobId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error("Failed to get job: PostgreSQL returned no row");
    }

    return mapJob(row);
  });
}

export async function claimNextJob(
  workerId: string,
  leaseSeconds = 60,
): Promise<Job | null> {
  if (workerId.trim().length === 0) {
    throw new Error("workerId must not be empty");
  }

  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be a positive integer");
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query<JobRow>(
      `
        SELECT
          id,
          organization_id,
          type,
          payload,
          status,
          idempotency_key,
          attempt_count,
          max_attempts,
          available_at,
          locked_at,
          locked_by,
          lease_expires_at,
          last_error,
          created_at,
          started_at,
          completed_at,
          failed_at
        FROM fluxora_claim_next_job($1, $2)
      `,
      [workerId.trim(), leaseSeconds],
    );

    const row = result.rows[0];

    if (row === undefined) {
      return null;
    }

    return mapJob(row);
  } finally {
    client.release();
  }
}

export async function completeJob(
  jobId: string,
  workerId: string,
): Promise<Job> {
  if (jobId.trim().length === 0) {
    throw new Error("jobId must not be empty");
  }

  if (workerId.trim().length === 0) {
    throw new Error("workerId must not be empty");
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query<JobRow>(
      `
        SELECT
          id,
          organization_id,
          type,
          payload,
          status,
          idempotency_key,
          attempt_count,
          max_attempts,
          available_at,
          locked_at,
          locked_by,
          lease_expires_at,
          last_error,
          created_at,
          started_at,
          completed_at,
          failed_at
        FROM fluxora_complete_job($1, $2)
      `,
      [jobId.trim(), workerId.trim()],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error(
        "Job completion rejected: job is not owned by the worker or its lease has expired",
      );
    }

    return mapJob(row);
  } finally {
    client.release();
  }
}

export async function failJob(
  jobId: string,
  workerId: string,
  errorMessage: string,
): Promise<Job> {
  if (jobId.trim().length === 0) {
    throw new Error("jobId must not be empty");
  }

  if (workerId.trim().length === 0) {
    throw new Error("workerId must not be empty");
  }

  if (errorMessage.trim().length === 0) {
    throw new Error("errorMessage must not be empty");
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query<JobRow>(
      `
        SELECT
          id,
          organization_id,
          type,
          payload,
          status,
          idempotency_key,
          attempt_count,
          max_attempts,
          available_at,
          locked_at,
          locked_by,
          lease_expires_at,
          last_error,
          created_at,
          started_at,
          completed_at,
          failed_at
        FROM fluxora_fail_job($1, $2, $3)
      `,
      [jobId.trim(), workerId.trim(), errorMessage.trim()],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error(
        "Job failure rejected: job is not owned by the worker or its lease has expired",
      );
    }

    return mapJob(row);
  } finally {
    client.release();
  }
}

export async function retryFailedJob(
  jobId: string,
  retryDelaySeconds = 0,
): Promise<Job> {
  if (jobId.trim().length === 0) {
    throw new Error("jobId must not be empty");
  }

  if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 0) {
    throw new Error("retryDelaySeconds must be a non-negative integer");
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query<JobRow>(
      `
        SELECT
          id,
          organization_id,
          type,
          payload,
          status,
          idempotency_key,
          attempt_count,
          max_attempts,
          available_at,
          locked_at,
          locked_by,
          lease_expires_at,
          last_error,
          created_at,
          started_at,
          completed_at,
          failed_at
        FROM fluxora_retry_failed_job($1, $2)
      `,
      [jobId.trim(), retryDelaySeconds],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error(
        "Job retry rejected: job is not failed or has exhausted its attempts",
      );
    }

    return mapJob(row);
  } finally {
    client.release();
  }
}
