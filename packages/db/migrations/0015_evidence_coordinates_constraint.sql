-- Migration 0015: Relax evidence column_end constraint for multi-line spans & truncate oversized pg_notify payloads
-- When line_end > line_start, column_end indicates the column on line_end, which can be less than column_start.

ALTER TABLE evidence
  DROP CONSTRAINT IF EXISTS evidence_column_end_valid;

ALTER TABLE evidence
  ADD CONSTRAINT evidence_column_end_valid
  CHECK (
    column_end IS NULL OR
    (column_start IS NOT NULL AND (
      (line_end IS NOT NULL AND line_start IS NOT NULL AND line_end > line_start)
      OR column_end >= column_start
    ))
  );

-- Update fluxora_notify_event to ensure pg_notify never fails due to 8000-byte payload limit.
-- Full payload remains durably stored in events table.
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
