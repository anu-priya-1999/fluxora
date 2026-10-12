import type { GraphNodeType } from "@fluxora/shared-types";

/**
 * Standard visual styling and metadata configuration for Fluxora graph nodes.
 */
export interface NodeVisualConfig {
  readonly label: string;
  readonly category: string;
  readonly borderColor: string;
  readonly backgroundColor: string;
  readonly badgeBg: string;
  readonly badgeColor: string;
}

export const NODE_VISUAL_CONFIGS: Record<string, NodeVisualConfig> = {
  application: {
    label: "Application",
    category: "System Boundary",
    borderColor: "#4f46e5", // Indigo 600
    backgroundColor: "#eef2ff", // Indigo 50
    badgeBg: "#e0e7ff",
    badgeColor: "#3730a3",
  },
  service: {
    label: "Service",
    category: "Compute Service",
    borderColor: "#0284c7", // Sky 600
    backgroundColor: "#f0f9ff", // Sky 50
    badgeBg: "#e0f2fe",
    badgeColor: "#0369a1",
  },
  package: {
    label: "Package",
    category: "Workspace Package",
    borderColor: "#0d9488", // Teal 600
    backgroundColor: "#f0fdfa", // Teal 50
    badgeBg: "#ccfbf1",
    badgeColor: "#0f766e",
  },
  module: {
    label: "Module",
    category: "Source File",
    borderColor: "#2563eb", // Blue 600
    backgroundColor: "#eff6ff", // Blue 50
    badgeBg: "#dbeafe",
    badgeColor: "#1d4ed8",
  },
  symbol: {
    label: "Symbol",
    category: "Code Declaration",
    borderColor: "#7c3aed", // Violet 600
    backgroundColor: "#f5f3ff", // Violet 50
    badgeBg: "#ede9fe",
    badgeColor: "#6d28d9",
  },
  api: {
    label: "API Route",
    category: "HTTP / RPC Route",
    borderColor: "#059669", // Emerald 600
    backgroundColor: "#ecfdf5", // Emerald 50
    badgeBg: "#d1fae5",
    badgeColor: "#047857",
  },
  event: {
    label: "Event",
    category: "Async Message",
    borderColor: "#d97706", // Amber 600
    backgroundColor: "#fffbeb", // Amber 50
    badgeBg: "#fef3c7",
    badgeColor: "#b45309",
  },
  database: {
    label: "Database",
    category: "Persistence",
    borderColor: "#dc2626", // Red 600
    backgroundColor: "#fef2f2", // Red 50
    badgeBg: "#fee2e2",
    badgeColor: "#b91c1c",
  },
};

const DEFAULT_NODE_CONFIG: NodeVisualConfig = {
  label: "Unknown",
  category: "Component",
  borderColor: "#64748b", // Slate 500
  backgroundColor: "#f8fafc", // Slate 50
  badgeBg: "#f1f5f9",
  badgeColor: "#475569",
};

export function getNodeVisualConfig(nodeType: GraphNodeType | string): NodeVisualConfig {
  const normalized = nodeType.toLowerCase();
  return NODE_VISUAL_CONFIGS[normalized] ?? {
    ...DEFAULT_NODE_CONFIG,
    label: nodeType.charAt(0).toUpperCase() + nodeType.slice(1),
  };
}
