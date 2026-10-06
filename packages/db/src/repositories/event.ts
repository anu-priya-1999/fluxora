import type { CreateEventInput, FluxoraEvent } from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

interface EventRow {
  id: string;
  organization_id: string;
  type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  schema_version: number;
  occurred_at: Date;
  created_at: Date;
}

const EVENT_COLUMNS = `
  id,
  organization_id,
  type,
  idempotency_key,
  payload,
  schema_version,
  occurred_at,
  created_at
`;

function mapEvent<T extends Record<string, unknown> = Record<string, unknown>>(
  row: EventRow,
): FluxoraEvent<T> {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    payload: row.payload as T,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function validateCreateEventInput(input: CreateEventInput): void {
  if (input.type.trim().length === 0) {
    throw new Error("event type must not be empty");
  }

  if (input.idempotencyKey.trim().length === 0) {
    throw new Error("event idempotency key must not be empty");
  }

  if (
    input.schemaVersion !== undefined &&
    (!Number.isInteger(input.schemaVersion) || input.schemaVersion <= 0)
  ) {
    throw new Error("event schema version must be a positive integer");
  }
}

export async function createEventClient<
  T extends Record<string, unknown> = Record<string, unknown>,
>(client: pg.PoolClient, input: CreateEventInput<T>): Promise<FluxoraEvent<T>> {
  validateCreateEventInput(input);

  const result = await client.query<EventRow>(
    `
      INSERT INTO events (
        organization_id,
        type,
        idempotency_key,
        payload,
        schema_version,
        occurred_at
      )
      VALUES ($1, $2, $3, $4, COALESCE($5, 1), COALESCE($6, now()))
      ON CONFLICT (organization_id, idempotency_key)
      DO UPDATE SET id = events.id
      RETURNING ${EVENT_COLUMNS}
    `,
    [
      input.organizationId,
      input.type.trim(),
      input.idempotencyKey.trim(),
      JSON.stringify(input.payload ?? {}),
      input.schemaVersion ?? 1,
      input.occurredAt ?? null,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("failed to insert or retrieve event");
  }

  return mapEvent<T>(row);
}

export async function createEvent<
  T extends Record<string, unknown> = Record<string, unknown>,
>(pool: pg.Pool, input: CreateEventInput<T>): Promise<FluxoraEvent<T>> {
  validateCreateEventInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    return createEventClient(client, input);
  });
}

export async function getEventById<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  pool: pg.Pool,
  organizationId: string,
  eventId: string,
): Promise<FluxoraEvent<T> | null> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<EventRow>(
      `
        SELECT ${EVENT_COLUMNS}
        FROM events
        WHERE id = $1::uuid
          AND organization_id = $2::uuid
      `,
      [eventId, organizationId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapEvent<T>(row);
  });
}

export async function listEvents<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  pool: pg.Pool,
  organizationId: string,
  options?: {
    type?: string;
    limit?: number;
  },
): Promise<Array<FluxoraEvent<T>>> {
  return withTenant(pool, organizationId, async (client) => {
    const limit = options?.limit ?? 50;
    const type = options?.type;

    let query = `
      SELECT ${EVENT_COLUMNS}
      FROM events
      WHERE organization_id = $1::uuid
    `;
    const params: unknown[] = [organizationId];

    if (type !== undefined) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }

    params.push(limit);
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

    const result = await client.query<EventRow>(query, params);
    return result.rows.map((row) => mapEvent<T>(row));
  });
}
