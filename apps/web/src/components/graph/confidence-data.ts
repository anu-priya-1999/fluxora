/**
 * Presentation-only confidence normalization and visual weighting for Fluxora (Step 50).
 *
 * Invariant: The backend/API is authoritative. This module performs presentation
 * normalization only. It never calculates or recomputes backend confidence, never
 * runs depth decay formulas, and never fabricates synthetic confidence values.
 */

export type ConfidenceTier = "high" | "medium" | "low";

/**
 * Normalized confidence presentation model.
 * Monotonic, deterministic, and preserves original numeric value.
 */
export interface NormalizedConfidence {
  /** Original numeric confidence value from backend. */
  readonly raw: number;
  /** Clamped numeric value in [0, 1] range for visual calculations. */
  readonly value: number;
  /** Integer percentage (0–100). */
  readonly percentage: number;
  /** Formatted percentage string (e.g. "95%"). */
  readonly formattedPercentage: string;
  /** Presentation tier based on architectural thresholds. */
  readonly tier: ConfidenceTier;
  /** Human-readable tier label (e.g. "High confidence"). */
  readonly label: string;
  /** Accessible text for screen readers (e.g. "High confidence, 95 percent"). */
  readonly accessibleLabel: string;
  /** Stroke width in pixels for edge presentation. */
  readonly strokeWidth: number;
  /** Opacity for edge presentation. */
  readonly opacity: number;
  /** SVG dasharray for edge presentation (undefined for solid). */
  readonly strokeDasharray?: string | undefined;
}

/**
 * Authoritative confidence tier thresholds per Fluxora architecture:
 * - High (>= 0.90): Direct AST imports, 1-hop impact, verified facts.
 * - Medium (>= 0.70 && < 0.90): Dynamic imports, 2-3 hops impact, resolved inferences.
 * - Low (< 0.70): Heuristic links, 4+ hops impact, uncertain hypotheses.
 */
export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.9,
  MEDIUM: 0.7,
} as const;

/**
 * Normalizes an authoritative backend confidence value for presentation.
 * Returns null if confidence is missing, null, undefined, or NaN.
 * Never fabricates fallback confidence values.
 */
export function normalizeConfidence(value: unknown): NormalizedConfidence | null {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }

  const raw = value;
  const clamped = Math.max(0, Math.min(1, value));
  const percentage = Math.round(clamped * 100);
  const formattedPercentage = `${percentage}%`;

  let tier: ConfidenceTier;
  let label: string;
  let strokeWidth: number;
  let opacity: number;
  let strokeDasharray: string | undefined;

  if (clamped >= CONFIDENCE_THRESHOLDS.HIGH) {
    tier = "high";
    label = "High confidence";
    strokeWidth = 2.0;
    opacity = 1.0;
    strokeDasharray = undefined;
  } else if (clamped >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    tier = "medium";
    label = "Medium confidence";
    strokeWidth = 1.5;
    opacity = 0.85;
    strokeDasharray = undefined;
  } else {
    tier = "low";
    label = "Low confidence";
    strokeWidth = 1.25;
    opacity = 0.65;
    strokeDasharray = "4 4";
  }

  return {
    raw,
    value: clamped,
    percentage,
    formattedPercentage,
    tier,
    label,
    accessibleLabel: `${label}, ${percentage} percent`,
    strokeWidth,
    opacity,
    strokeDasharray,
  };
}

export interface EdgeConfidenceStyleOptions {
  readonly isSelected?: boolean;
}

export interface EdgeConfidenceStyles {
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number;
  readonly strokeDasharray?: string | undefined;
}

/**
 * Computes deterministic React Flow SVG edge styles from authoritative confidence.
 *
 * Rules:
 * - Selected state takes absolute visual priority (#3b82f6 blue, strokeWidth: 3).
 * - Higher confidence receives stronger visual prominence (darker stroke, wider width, full opacity).
 * - Lower confidence receives weaker visual prominence (lighter stroke, thinner width, reduced opacity, dashed).
 * - Low-confidence edges remain visible, selectable, and structurally intact.
 * - If confidence is missing, uses default neutral edge styles without fabricating values.
 */
export function computeEdgeConfidenceStyles(
  confidence: number | null | undefined,
  options?: EdgeConfidenceStyleOptions,
): EdgeConfidenceStyles {
  const isSelected = Boolean(options?.isSelected);
  const normalized = normalizeConfidence(confidence);

  if (isSelected) {
    return {
      stroke: "#3b82f6",
      strokeWidth: 3,
      opacity: 1.0,
      strokeDasharray: normalized?.strokeDasharray,
    };
  }

  if (!normalized) {
    // Missing confidence: neutral presentation, no fake confidence
    return {
      stroke: "#94a3b8",
      strokeWidth: 1.5,
      opacity: 0.85,
      strokeDasharray: undefined,
    };
  }

  const stroke = normalized.tier === "high" ? "#64748b" : "#94a3b8";

  return {
    stroke,
    strokeWidth: normalized.strokeWidth,
    opacity: normalized.opacity,
    strokeDasharray: normalized.strokeDasharray,
  };
}

