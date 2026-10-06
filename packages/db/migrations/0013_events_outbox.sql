-- Phase 2 Step 15: Durable tenant-scoped PostgreSQL events/outbox with RLS + LISTEN/NOTIFY.
-- Forward-only; applied by packages/db migrate runner.

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id uuid NOT NULL
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  type text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT events_organization_idempotency_key_unique
    UNIQUE (organization_id, idempotency_key),

  CONSTRAINT events_type_not_empty
    CHECK (length(trim(type)) > 0),

  CONSTRAINT events_idempotency_key_not_empty
    CHECK (length(trim(idempotency_key)) > 0),

  CONSTRAINT events_schema_version_positive
    CHECK (schema_version > 0)
);

CREATE INDEX events_organization_id_idx
  ON events (organization_id);

CREATE INDEX events_organization_type_idx
  ON events (organization_id, type);

CREATE INDEX events_organization_created_at_idx
  ON events (organization_id, created_at DESC);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_tenant_select ON events;
CREATE POLICY events_tenant_select ON events
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS events_tenant_insert ON events;
CREATE POLICY events_tenant_insert ON events
  FOR INSERT
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS events_tenant_delete ON events;
CREATE POLICY events_tenant_delete ON events
  FOR DELETE
  USING (organization_id = fluxora_current_org_id());

CREATE OR REPLACE FUNCTION fluxora_notify_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_notification json;
BEGIN
  v_notification := json_build_object(
    'event_id', NEW.id,
    'event_type', NEW.type,
    'organization_id', NEW.organization_id,
    'occurred_at', NEW.occurred_at,
    'idempotency_key', NEW.idempotency_key,
    'payload', NEW.payload,
    'schema_version', NEW.schema_version
  );

  PERFORM pg_notify('fluxora_events', v_notification::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_notify_trigger ON events;
CREATE TRIGGER events_notify_trigger
AFTER INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION fluxora_notify_event();

