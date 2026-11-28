/**
 * @file telemetry.ts
 * Repository for TelemetrySource and Observation records (Phase 10 Step 67).
 *
 * Implements tenant-scoped persistence and retrieval for external observability
 * source configurations and runtime metric observations.
 */

import {
  TELEMETRY_SOURCE_STATUS_TRANSITIONS,
  TelemetryProviders,
  TelemetrySourceStatuses,
  type EncryptedConnectionConfig,
  type Observation,
  type TelemetryProvider,
  type TelemetrySource,
  type TelemetrySourceStatus,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENCRYPTED_ENVELOPE_REGEX = /^(enc|kms):v[0-9]+:[^\s]+$/;
const DECIMAL_VALUE_REGEX = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_METRIC_NAME_LENGTH = 255;
const DEFAULT_OBSERVATION_LIMIT = 100;
const MAX_OBSERVATION_LIMIT = 1000;

export class TelemetryValidationError extends Error {
  readonly code = "invalid_input";
  constructor(message = "Telemetry input fields are invalid.") {
    super(message);
    this.name = "TelemetryValidationError";
  }
}

export class TelemetrySourceNotFoundError extends Error {
  readonly code = "telemetry_source_not_found";
  constructor(message = "Telemetry source not found or inaccessible for this organization.") {
    super(message);
    this.name = "TelemetrySourceNotFoundError";
  }
}

export class TelemetryConflictError extends Error {
  readonly code = "conflict";
  constructor(message = "Telemetry persistence conflict occurred.") {
    super(message);
    this.name = "TelemetryConflictError";
  }
}

export interface CreateTelemetrySourceInput {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly provider: TelemetryProvider;
  readonly connectionConfig: EncryptedConnectionConfig;
  readonly status?: TelemetrySourceStatus | undefined;
}

export interface ListTelemetrySourcesFilters {
  readonly repositoryId?: string | undefined;
  readonly provider?: TelemetryProvider | undefined;
  readonly status?: TelemetrySourceStatus | undefined;
}

export interface UpdateTelemetrySourceInput {
  readonly connectionConfig?: EncryptedConnectionConfig | undefined;
  readonly status?: TelemetrySourceStatus | undefined;
}

export interface AppendObservationInput {
  readonly organizationId: string;
  readonly telemetrySourceId: string;
  readonly nodeId?: string | null | undefined;
  readonly metricName: string;
  readonly value: string | number;
  readonly observedAt: Date;
}

export interface QueryObservationsInput {
  readonly organizationId: string;
  readonly telemetrySourceId: string;
  readonly nodeId?: string | undefined;
  readonly metricName?: string | undefined;
  readonly startTime?: Date | undefined;
  readonly endTime?: Date | undefined;
  readonly limit?: number | undefined;
}

interface TelemetrySourceRow {
  id: string;
  repository_id: string;
  provider: string;
  connection_config: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface ObservationRow {
  id: string;
  telemetry_source_id: string;
  repository_id: string;
  node_id: string | null;
  metric_name: string;
  value: string;
  observed_at: Date;
  created_at: Date;
}

const TELEMETRY_SOURCE_COLUMNS = `
  id,
  repository_id,
  provider,
  connection_config,
  status,
  created_at,
  updated_at
`;

const OBSERVATION_COLUMNS = `
  id,
  telemetry_source_id,
  repository_id,
  node_id,
  metric_name,
  value::text AS value,
  observed_at,
  created_at
`;

function assertUuid(value: string, label: string): void {
  if (!value || !UUID_REGEX.test(value)) {
    throw new TelemetryValidationError(`Invalid ${label} format. Must be a valid UUID.`);
  }
}

function assertProvider(provider: string): asserts provider is TelemetryProvider {
  if (!(TelemetryProviders as readonly string[]).includes(provider)) {
    throw new TelemetryValidationError(
      `Unsupported telemetry provider '${provider}'. Must be one of: ${TelemetryProviders.join(", ")}.`,
    );
  }
}

function assertStatus(status: string): asserts status is TelemetrySourceStatus {
  if (!(TelemetrySourceStatuses as readonly string[]).includes(status)) {
    throw new TelemetryValidationError(
      `Unsupported telemetry source status '${status}'. Must be one of: ${TelemetrySourceStatuses.join(", ")}.`,
    );
  }
}

function assertEncryptedConnectionConfig(config: string): void {
  if (typeof config !== "string" || config.trim().length === 0) {
    throw new TelemetryValidationError("Encrypted connectionConfig must be a non-empty string.");
  }
  if (!ENCRYPTED_ENVELOPE_REGEX.test(config)) {
    throw new TelemetryValidationError(
      "connectionConfig must be an opaque encrypted envelope (enc:v<N>:... or kms:v<N>:...); plaintext credentials are rejected.",
    );
  }
}

function normalizeMetricName(metricName: string): string {
  if (typeof metricName !== "string") {
    throw new TelemetryValidationError("metricName must be a string.");
  }
  const trimmed = metricName.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_METRIC_NAME_LENGTH) {
    throw new TelemetryValidationError(
      `metricName must be between 1 and ${MAX_METRIC_NAME_LENGTH} characters.`,
    );
  }
  if (trimmed !== metricName) {
    throw new TelemetryValidationError("metricName must not have leading or trailing whitespace.");
  }
  return trimmed;
}

function normalizeNumericValue(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TelemetryValidationError("Observation value must be a finite number.");
    }
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !DECIMAL_VALUE_REGEX.test(trimmed)) {
      throw new TelemetryValidationError("Observation value must be a valid finite decimal string.");
    }
    return trimmed;
  }
  throw new TelemetryValidationError("Observation value must be a finite number or decimal string.");
}

function assertValidDate(date: Date, label: string): Date {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TelemetryValidationError(`${label} must be a valid Date.`);
  }
  return new Date(date.toISOString());
}

function mapTelemetrySourceRow(row: TelemetrySourceRow): TelemetrySource {
  assertProvider(row.provider);
  assertStatus(row.status);
  return {
    id: row.id,
    repositoryId: row.repository_id,
    provider: row.provider,
    connectionConfig: row.connection_config,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapObservationRow(row: ObservationRow): Observation {
  return {
    id: row.id,
    telemetrySourceId: row.telemetry_source_id,
    repositoryId: row.repository_id,
    nodeId: row.node_id,
    metricName: row.metric_name,
    value: row.value,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}

export async function createTelemetrySource(
  pool: pg.Pool,
  input: CreateTelemetrySourceInput,
): Promise<TelemetrySource> {
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.repositoryId, "repositoryId");
  assertProvider(input.provider);
  assertEncryptedConnectionConfig(input.connectionConfig);

  const status: TelemetrySourceStatus = input.status ?? "pending";
  assertStatus(status);

  return withTenant(pool, input.organizationId, async (client) => {
    const result = await client.query<TelemetrySourceRow>(
      `INSERT INTO public.telemetry_sources (
         repository_id,
         provider,
         connection_config,
         status
       )
       VALUES ($1::uuid, $2, $3, $4)
       RETURNING ${TELEMETRY_SOURCE_COLUMNS}`,
      [input.repositoryId, input.provider, input.connectionConfig, status],
    );

    const row = result.rows[0];
    if (!row) {
      throw new TelemetryConflictError("Failed to create telemetry source.");
    }
    return mapTelemetrySourceRow(row);
  });
}

export async function getTelemetrySourceById(
  pool: pg.Pool,
  organizationId: string,
  telemetrySourceId: string,
): Promise<TelemetrySource | null> {
  assertUuid(organizationId, "organizationId");
  assertUuid(telemetrySourceId, "telemetrySourceId");

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<TelemetrySourceRow>(
      `SELECT ${TELEMETRY_SOURCE_COLUMNS}
       FROM public.telemetry_sources
       WHERE id = $1::uuid`,
      [telemetrySourceId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapTelemetrySourceRow(row);
  });
}

export async function listTelemetrySources(
  pool: pg.Pool,
  organizationId: string,
  filters?: ListTelemetrySourcesFilters,
): Promise<TelemetrySource[]> {
  assertUuid(organizationId, "organizationId");

  if (filters?.repositoryId !== undefined) {
    assertUuid(filters.repositoryId, "repositoryId");
  }
  if (filters?.provider !== undefined) {
    assertProvider(filters.provider);
  }
  if (filters?.status !== undefined) {
    assertStatus(filters.status);
  }

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<TelemetrySourceRow>(
      `SELECT ${TELEMETRY_SOURCE_COLUMNS}
       FROM public.telemetry_sources
       WHERE ($1::uuid IS NULL OR repository_id = $1::uuid)
         AND ($2::text IS NULL OR provider = $2)
         AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC, id DESC`,
      [
        filters?.repositoryId ?? null,
        filters?.provider ?? null,
        filters?.status ?? null,
      ],
    );

    return result.rows.map(mapTelemetrySourceRow);
  });
}

export async function updateTelemetrySource(
  pool: pg.Pool,
  organizationId: string,
  telemetrySourceId: string,
  patch: UpdateTelemetrySourceInput,
): Promise<TelemetrySource | null> {
  assertUuid(organizationId, "organizationId");
  assertUuid(telemetrySourceId, "telemetrySourceId");

  if (patch.connectionConfig === undefined && patch.status === undefined) {
    throw new TelemetryValidationError("At least one field must be provided for update.");
  }
  if (patch.connectionConfig !== undefined) {
    assertEncryptedConnectionConfig(patch.connectionConfig);
  }
  if (patch.status !== undefined) {
    assertStatus(patch.status);
  }

  return withTenant(pool, organizationId, async (client) => {
    const existingResult = await client.query<TelemetrySourceRow>(
      `SELECT ${TELEMETRY_SOURCE_COLUMNS}
       FROM public.telemetry_sources
       WHERE id = $1::uuid
       FOR UPDATE`,
      [telemetrySourceId],
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      return null;
    }

    assertStatus(existing.status);
    if (patch.status !== undefined) {
      const allowed = TELEMETRY_SOURCE_STATUS_TRANSITIONS[existing.status];
      if (!allowed.includes(patch.status)) {
        throw new TelemetryValidationError(
          `Invalid status transition from '${existing.status}' to '${patch.status}'.`,
        );
      }
    }

    const updatedResult = await client.query<TelemetrySourceRow>(
      `UPDATE public.telemetry_sources
       SET
         connection_config = COALESCE($2, connection_config),
         status = COALESCE($3, status),
         updated_at = now()
       WHERE id = $1::uuid
       RETURNING ${TELEMETRY_SOURCE_COLUMNS}`,
      [
        telemetrySourceId,
        patch.connectionConfig ?? null,
        patch.status ?? null,
      ],
    );

    const updated = updatedResult.rows[0];
    return updated === undefined ? null : mapTelemetrySourceRow(updated);
  });
}

export async function appendObservation(
  pool: pg.Pool,
  input: AppendObservationInput,
): Promise<Observation> {
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.telemetrySourceId, "telemetrySourceId");
  if (input.nodeId !== undefined && input.nodeId !== null) {
    assertUuid(input.nodeId, "nodeId");
  }
  const metricName = normalizeMetricName(input.metricName);
  const numericValue = normalizeNumericValue(input.value);
  const observedAt = assertValidDate(input.observedAt, "observedAt");

  return withTenant(pool, input.organizationId, async (client) => {
    // Authoritatively resolve repository_id from the tenant-visible telemetry_sources row.
    // RLS on telemetry_sources ensures cross-tenant source IDs are invisible and rejected.
    const sourceResult = await client.query<{ repository_id: string }>(
      `SELECT repository_id
       FROM public.telemetry_sources
       WHERE id = $1::uuid`,
      [input.telemetrySourceId],
    );

    const sourceRow = sourceResult.rows[0];
    if (!sourceRow) {
      throw new TelemetrySourceNotFoundError();
    }

    const insertResult = await client.query<ObservationRow>(
      `INSERT INTO public.observations (
         telemetry_source_id,
         repository_id,
         node_id,
         metric_name,
         value,
         observed_at
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::timestamptz)
       RETURNING ${OBSERVATION_COLUMNS}`,
      [
        input.telemetrySourceId,
        sourceRow.repository_id,
        input.nodeId ?? null,
        metricName,
        numericValue,
        observedAt.toISOString(),
      ],
    );

    const row = insertResult.rows[0];
    if (!row) {
      throw new TelemetryConflictError("Failed to append observation.");
    }
    return mapObservationRow(row);
  });
}

export async function queryObservations(
  pool: pg.Pool,
  query: QueryObservationsInput,
): Promise<Observation[]> {
  assertUuid(query.organizationId, "organizationId");
  assertUuid(query.telemetrySourceId, "telemetrySourceId");

  if (query.nodeId !== undefined) {
    assertUuid(query.nodeId, "nodeId");
  }
  const metricName =
    query.metricName !== undefined ? normalizeMetricName(query.metricName) : null;
  const startTime =
    query.startTime !== undefined ? assertValidDate(query.startTime, "startTime") : null;
  const endTime =
    query.endTime !== undefined ? assertValidDate(query.endTime, "endTime") : null;

  if (startTime !== null && endTime !== null && startTime > endTime) {
    throw new TelemetryValidationError("startTime must be less than or equal to endTime.");
  }

  const limit = query.limit ?? DEFAULT_OBSERVATION_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_OBSERVATION_LIMIT) {
    throw new TelemetryValidationError(
      `limit must be an integer between 1 and ${MAX_OBSERVATION_LIMIT}.`,
    );
  }

  return withTenant(pool, query.organizationId, async (client) => {
    const result = await client.query<ObservationRow>(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM public.observations
       WHERE telemetry_source_id = $1::uuid
         AND ($2::uuid IS NULL OR node_id = $2::uuid)
         AND ($3::text IS NULL OR metric_name = $3)
         AND ($4::timestamptz IS NULL OR observed_at >= $4::timestamptz)
         AND ($5::timestamptz IS NULL OR observed_at <= $5::timestamptz)
       ORDER BY observed_at DESC, id DESC
       LIMIT $6::integer`,
      [
        query.telemetrySourceId,
        query.nodeId ?? null,
        metricName,
        startTime ? startTime.toISOString() : null,
        endTime ? endTime.toISOString() : null,
        limit,
      ],
    );

    return result.rows.map(mapObservationRow);
  });
}
