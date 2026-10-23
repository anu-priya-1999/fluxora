import type {
  GraphQueryResponseEdge,
  GraphQueryResponseNode,
  ScenarioFailureType,
  ScenarioResponse,
  SimulationCausalStep,
  SimulationResponse,
  SimulationResultResponse,
  SimulationResultState,
  SimulationStatus,
} from "@fluxora/shared-types";

export type {
  GraphQueryResponseEdge,
  GraphQueryResponseNode,
  ScenarioFailureType,
  ScenarioResponse,
  SimulationCausalStep,
  SimulationResponse,
  SimulationResultResponse,
  SimulationResultState,
  SimulationStatus,
};

export const SUPPORTED_FAILURE_TYPES = [
  "unavailable",
  "latency",
] as const satisfies readonly ScenarioFailureType[];

export type SupportedFailureType = (typeof SUPPORTED_FAILURE_TYPES)[number];

export interface SimulationImpactSummary {
  readonly totalAffected: number;
  readonly failedCount: number;
  readonly degradedCount: number;
  readonly atRiskCount: number;
  readonly healthyCount: number;
  readonly cappedCount: number;
  readonly converged?: boolean | undefined;
  readonly iterations?: number | undefined;
  readonly ruleTableVersion?: string | undefined;
}

export type SortByOption = "state" | "name" | "confidence" | "steps";
export type SortDirection = "asc" | "desc";

export interface StudioFilterState {
  readonly stateFilter: "all" | SimulationResultState;
  readonly searchQuery: string;
  readonly sortBy: SortByOption;
  readonly sortDirection: SortDirection;
}

export const DEFAULT_STUDIO_FILTERS: StudioFilterState = {
  stateFilter: "all",
  searchQuery: "",
  sortBy: "state",
  sortDirection: "desc",
};

export type ApiResultReason =
  | "not_authenticated"
  | "not_found"
  | "invalid_request"
  | "unsupported_failure_type"
  | "convergence_failure"
  | "network_error"
  | "server_error";

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: ApiResultReason;
      readonly message: string;
      readonly statusCode?: number | undefined;
      readonly details?: unknown;
    };

