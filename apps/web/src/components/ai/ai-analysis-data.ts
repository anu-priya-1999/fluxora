/**
 * @file ai-analysis-data.ts
 * Frontend data helpers for AI Explanation records (Phase 9 Step 62).
 */

import type { AIAnalysisResponse } from "@fluxora/shared-types";

export type FetchAIAnalysisResult =
  | { readonly ok: true; readonly data: AIAnalysisResponse }
  | { readonly ok: false; readonly message: string; readonly code?: string | undefined };

export interface FetchAIAnalysisParams {
  readonly apiUrl: string;
  readonly aiAnalysisId: string;
  readonly getToken: () => Promise<string | null>;
}

export async function fetchAIAnalysis({
  apiUrl,
  aiAnalysisId,
  getToken,
}: FetchAIAnalysisParams): Promise<FetchAIAnalysisResult> {
  if (!aiAnalysisId || typeof aiAnalysisId !== "string") {
    return {
      ok: false,
      message: "AI analysis ID is required.",
      code: "invalid_id",
    };
  }

  try {
    const token = await getToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const base = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;
    const url = `${base}/api/v1/ai-analyses/${encodeURIComponent(aiAnalysisId)}`;

    const res = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      let code = "http_error";
      let message = `Request failed with status ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body.error?.message) {
          message = body.error.message;
        }
        if (body.error?.code) {
          code = body.error.code;
        }
      } catch {
        // Fallback to HTTP status text
      }

      return { ok: false, message, code };
    }

    const data = (await res.json()) as AIAnalysisResponse;
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Network error fetching AI analysis.",
      code: "network_error",
    };
  }
}
