-- Phase 4 Step 27: Graph Storage — GraphNode, GraphEdge, Evidence tables with RLS and indexes.
-- Forward-only; applied by packages/db migrate runner.

-- 1. AnalysisRun (parent execution scope for graph nodes, edges, and evidence)
CREATE TABLE IF NOT EXISTS analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  snapshot_id uuid NOT NULL
    REFERENCES repository_snapshots (id)
    ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'pending',
  parser_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  coverage_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analysis_runs_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS analysis_runs_snapshot_id_idx
  ON analysis_runs (snapshot_id);

CREATE INDEX IF NOT EXISTS analysis_runs_snapshot_created_at_idx
  ON analysis_runs (snapshot_id, created_at DESC);

CREATE OR REPLACE FUNCTION fluxora_snapshot_in_current_tenant(p_snapshot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM repository_snapshots AS rs
    JOIN repositories AS r ON r.id = rs.repository_id
    WHERE rs.id = p_snapshot_id
      AND r.organization_id = fluxora_current_org_id()
  );
$$;

-- RLS helper function for analysis_runs and its child graph records
CREATE OR REPLACE FUNCTION fluxora_analysis_run_in_current_tenant(p_analysis_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM analysis_runs AS ar
    JOIN repository_snapshots AS rs ON rs.id = ar.snapshot_id
    JOIN repositories AS r ON r.id = rs.repository_id
    WHERE ar.id = p_analysis_run_id
      AND r.organization_id = fluxora_current_org_id()
  );
$$;

GRANT EXECUTE ON FUNCTION fluxora_snapshot_in_current_tenant(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_analysis_run_in_current_tenant(uuid) TO PUBLIC;

ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analysis_runs_tenant_select ON analysis_runs;
CREATE POLICY analysis_runs_tenant_select ON analysis_runs
  FOR SELECT
  USING (fluxora_snapshot_in_current_tenant(snapshot_id));

DROP POLICY IF EXISTS analysis_runs_tenant_insert ON analysis_runs;
CREATE POLICY analysis_runs_tenant_insert ON analysis_runs
  FOR INSERT
  WITH CHECK (fluxora_snapshot_in_current_tenant(snapshot_id));

DROP POLICY IF EXISTS analysis_runs_tenant_update ON analysis_runs;
CREATE POLICY analysis_runs_tenant_update ON analysis_runs
  FOR UPDATE
  USING (fluxora_snapshot_in_current_tenant(snapshot_id))
  WITH CHECK (fluxora_snapshot_in_current_tenant(snapshot_id));

DROP POLICY IF EXISTS analysis_runs_tenant_delete ON analysis_runs;
CREATE POLICY analysis_runs_tenant_delete ON analysis_runs
  FOR DELETE
  USING (fluxora_snapshot_in_current_tenant(snapshot_id));

-- 2. GraphNode table
CREATE TABLE IF NOT EXISTS graph_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  analysis_run_id uuid NOT NULL
    REFERENCES analysis_runs (id)
    ON DELETE CASCADE,

  canonical_id text NOT NULL,
  node_type text NOT NULL,
  name text NOT NULL,
  path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision NOT NULL DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT graph_nodes_analysis_run_canonical_id_unique
    UNIQUE (analysis_run_id, canonical_id),

  CONSTRAINT graph_nodes_id_analysis_run_unique
    UNIQUE (id, analysis_run_id),

  CONSTRAINT graph_nodes_canonical_id_not_empty
    CHECK (length(trim(canonical_id)) > 0),

  CONSTRAINT graph_nodes_node_type_not_empty
    CHECK (length(trim(node_type)) > 0),

  CONSTRAINT graph_nodes_name_not_empty
    CHECK (length(trim(name)) > 0),

  CONSTRAINT graph_nodes_confidence_range
    CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS graph_nodes_analysis_run_id_idx
  ON graph_nodes (analysis_run_id);

CREATE INDEX IF NOT EXISTS graph_nodes_analysis_run_node_type_idx
  ON graph_nodes (analysis_run_id, node_type);

ALTER TABLE graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_nodes_tenant_select ON graph_nodes;
CREATE POLICY graph_nodes_tenant_select ON graph_nodes
  FOR SELECT
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS graph_nodes_tenant_insert ON graph_nodes;
CREATE POLICY graph_nodes_tenant_insert ON graph_nodes
  FOR INSERT
  WITH CHECK (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS graph_nodes_tenant_update ON graph_nodes;
CREATE POLICY graph_nodes_tenant_update ON graph_nodes
  FOR UPDATE
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id))
  WITH CHECK (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS graph_nodes_tenant_delete ON graph_nodes;
CREATE POLICY graph_nodes_tenant_delete ON graph_nodes
  FOR DELETE
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id));

-- 3. GraphEdge table
CREATE TABLE IF NOT EXISTS graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  analysis_run_id uuid NOT NULL
    REFERENCES analysis_runs (id)
    ON DELETE CASCADE,

  source_node_id uuid NOT NULL,
  target_node_id uuid NOT NULL,
  edge_type text NOT NULL,
  canonical_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision NOT NULL DEFAULT 1.0,
  provenance text NOT NULL DEFAULT 'static-analysis',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT graph_edges_source_node_fk
    FOREIGN KEY (source_node_id, analysis_run_id)
    REFERENCES graph_nodes (id, analysis_run_id)
    ON DELETE CASCADE,

  CONSTRAINT graph_edges_target_node_fk
    FOREIGN KEY (target_node_id, analysis_run_id)
    REFERENCES graph_nodes (id, analysis_run_id)
    ON DELETE CASCADE,

  CONSTRAINT graph_edges_analysis_run_source_target_type_unique
    UNIQUE (analysis_run_id, source_node_id, target_node_id, edge_type),

  CONSTRAINT graph_edges_id_analysis_run_unique
    UNIQUE (id, analysis_run_id),

  CONSTRAINT graph_edges_edge_type_not_empty
    CHECK (length(trim(edge_type)) > 0),

  CONSTRAINT graph_edges_provenance_not_empty
    CHECK (length(trim(provenance)) > 0),

  CONSTRAINT graph_edges_confidence_range
    CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS graph_edges_analysis_run_id_idx
  ON graph_edges (analysis_run_id);

CREATE INDEX IF NOT EXISTS graph_edges_source_edge_type_idx
  ON graph_edges (source_node_id, edge_type);

CREATE INDEX IF NOT EXISTS graph_edges_target_edge_type_idx
  ON graph_edges (target_node_id, edge_type);

CREATE INDEX IF NOT EXISTS graph_edges_analysis_run_source_target_idx
  ON graph_edges (analysis_run_id, source_node_id, target_node_id);

ALTER TABLE graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_edges_tenant_select ON graph_edges;
CREATE POLICY graph_edges_tenant_select ON graph_edges
  FOR SELECT
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS graph_edges_tenant_insert ON graph_edges;
CREATE POLICY graph_edges_tenant_insert ON graph_edges
  FOR INSERT
  WITH CHECK (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS graph_edges_tenant_update ON graph_edges;
CREATE POLICY graph_edges_tenant_update ON graph_edges
  FOR UPDATE
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id))
  WITH CHECK (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS graph_edges_tenant_delete ON graph_edges;
CREATE POLICY graph_edges_tenant_delete ON graph_edges
  FOR DELETE
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id));

-- 4. Evidence table
CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  analysis_run_id uuid NOT NULL
    REFERENCES analysis_runs (id)
    ON DELETE CASCADE,

  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  file_path text NOT NULL,
  symbol_id text,
  line_start integer,
  line_end integer,
  column_start integer,
  column_end integer,
  relationship_description text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1.0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evidence_subject_type_not_empty
    CHECK (length(trim(subject_type)) > 0),

  CONSTRAINT evidence_file_path_not_empty
    CHECK (length(trim(file_path)) > 0),

  CONSTRAINT evidence_relationship_description_not_empty
    CHECK (length(trim(relationship_description)) > 0),

  CONSTRAINT evidence_confidence_range
    CHECK (confidence >= 0.0 AND confidence <= 1.0),

  CONSTRAINT evidence_line_start_positive
    CHECK (line_start IS NULL OR line_start >= 1),

  CONSTRAINT evidence_line_end_valid
    CHECK (line_end IS NULL OR (line_start IS NOT NULL AND line_end >= line_start)),

  CONSTRAINT evidence_column_start_positive
    CHECK (column_start IS NULL OR column_start >= 1),

  CONSTRAINT evidence_column_end_valid
    CHECK (column_end IS NULL OR (column_start IS NOT NULL AND column_end >= column_start))
);

CREATE INDEX IF NOT EXISTS evidence_analysis_run_id_idx
  ON evidence (analysis_run_id);

CREATE INDEX IF NOT EXISTS evidence_subject_idx
  ON evidence (analysis_run_id, subject_type, subject_id);

CREATE INDEX IF NOT EXISTS evidence_file_path_idx
  ON evidence (analysis_run_id, file_path);

ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evidence_tenant_select ON evidence;
CREATE POLICY evidence_tenant_select ON evidence
  FOR SELECT
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS evidence_tenant_insert ON evidence;
CREATE POLICY evidence_tenant_insert ON evidence
  FOR INSERT
  WITH CHECK (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS evidence_tenant_update ON evidence;
CREATE POLICY evidence_tenant_update ON evidence
  FOR UPDATE
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id))
  WITH CHECK (fluxora_analysis_run_in_current_tenant(analysis_run_id));

DROP POLICY IF EXISTS evidence_tenant_delete ON evidence;
CREATE POLICY evidence_tenant_delete ON evidence
  FOR DELETE
  USING (fluxora_analysis_run_in_current_tenant(analysis_run_id));
