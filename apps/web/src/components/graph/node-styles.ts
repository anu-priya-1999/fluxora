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

/**
 * Returns distinct chromatic border colors based on hop distance.
 * Shallower hops receive warmer, more saturated colors; deeper hops fade.
 */
export function getChangeModeHopColor(hop: number): string {
  if (hop <= 0) return "#dc2626"; // Red 600 (direct)
  if (hop === 1) return "#d97706"; // Amber 600
  if (hop === 2) return "#f59e0b"; // Amber 500
  return "#fbbf24"; // Amber 400
}

export interface NodeStyleComputationInput {
  readonly nodeType: GraphNodeType | string;
  readonly isSelected: boolean;
  readonly changeModeActive?: boolean | undefined;
  readonly impactRole?: "direct" | "downstream" | "unaffected" | undefined;
  readonly impactHopDistance?: number | undefined;
  readonly impactConfidence?: number | undefined;
}

export interface ComputedNodeStyles {
  readonly border: string;
  readonly backgroundColor: string;
  readonly boxShadow: string;
  readonly opacity: number;
  readonly filter?: string | undefined;
}

/**
 * Computes node visual styling based on base type, selection state, and change-mode overlay.
 *
 * Guarantees:
 * - Selected node styling takes absolute priority over change-mode overlay (Constraint 4.6 & 15.N).
 * - Direct changes get the strongest visual emphasis (#dc2626 border + ring).
 * - Downstream changes receive progressively weaker emphasis with hop distance.
 * - Low-confidence findings (< 0.70) are rendered with dashed borders.
 * - Unaffected nodes are de-emphasized (reduced opacity) but never deleted.
 */
export function computeNodeVisualStyles(input: NodeStyleComputationInput): ComputedNodeStyles {
  const config = getNodeVisualConfig(input.nodeType);

  // 1. Selection priority: selection always wins over change-mode styling
  if (input.isSelected) {
    return {
      border: "2px solid #2563eb",
      backgroundColor: config.backgroundColor,
      boxShadow: "0 0 0 3px rgba(37, 99, 235, 0.3), 0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      opacity: 1.0,
    };
  }

  // 2. Change-Mode styling (when active)
  if (input.changeModeActive) {
    if (input.impactRole === "direct") {
      return {
        border: "2px solid #dc2626", // Red 600: strongest visual emphasis
        backgroundColor: "#fef2f2", // Red 50
        boxShadow: "0 0 0 3px rgba(220, 38, 38, 0.25), 0 4px 6px -1px rgba(0, 0, 0, 0.1)",
        opacity: 1.0,
      };
    }

    if (input.impactRole === "downstream") {
      const hop = input.impactHopDistance ?? 1;
      const hopColor = getChangeModeHopColor(hop);
      const isLowConfidence =
        input.impactConfidence !== undefined && input.impactConfidence < 0.7;

      const borderStyle = isLowConfidence ? "2px dashed" : "2px solid";
      const ringOpacity = hop === 1 ? "0.25" : hop === 2 ? "0.15" : "0.08";

      return {
        border: `${borderStyle} ${hopColor}`,
        backgroundColor: hop === 1 ? "#fffbeb" : "#fffdf5",
        boxShadow: `0 0 0 2px rgba(217, 119, 6, ${ringOpacity}), 0 1px 3px rgba(0, 0, 0, 0.08)`,
        opacity: 1.0,
      };
    }

    if (input.impactRole === "unaffected") {
      return {
        border: `2px solid ${config.borderColor}`,
        backgroundColor: config.backgroundColor,
        boxShadow: "none",
        opacity: 0.45,
        filter: "grayscale(30%)",
      };
    }
  }

  // 3. Default base graph styling
  return {
    border: `2px solid ${config.borderColor}`,
    backgroundColor: config.backgroundColor,
    boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
    opacity: 1.0,
  };
}
