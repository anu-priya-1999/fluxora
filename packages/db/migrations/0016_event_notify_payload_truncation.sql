-- Migration 0016: Guard pg_notify against PostgreSQL 8000-byte payload limit
-- Durably stores full event payload in the events table, but truncates or summarizes the transient notification if payload exceeds 7500 bytes.

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

  IF octet_length(v_notification::text) > 7500 THEN
    v_notification := json_build_object(
      'event_id', NEW.id,
      'event_type', NEW.type,
      'organization_id', NEW.organization_id,
      'occurred_at', NEW.occurred_at,
      'idempotency_key', NEW.idempotency_key,
      'payload', json_build_object(
        '_truncated', true,
        'summary', NEW.payload->'summary',
        'analysis_run_id', NEW.payload->'analysis_run_id',
        'repository_id', NEW.payload->'repository_id'
      ),
      'schema_version', NEW.schema_version
    );
  END IF;

  PERFORM pg_notify('fluxora_events', v_notification::text);
  RETURN NEW;
END;
$$;
