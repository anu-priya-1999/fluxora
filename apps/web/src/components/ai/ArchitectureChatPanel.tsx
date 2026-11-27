"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  AIAnalysisResponse,
  ChatHistoryMessageDto,
  ChatToolActivityDto,
  GraphQueryResponseEvidence,
} from "@fluxora/shared-types";

import { EvidenceCitationList } from "../graph/EvidenceCitation.tsx";
import { fetchAIAnalysis } from "./ai-analysis-data.ts";
import { submitChatQuery } from "./chat-query-data.ts";

export const MAX_CHAT_HISTORY_CONTEXT = 10;
export const CHAT_POLL_INTERVAL_MS = 1500;
export const MAX_CHAT_POLL_ATTEMPTS = 20;

export interface ChatTurnMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly status?: "pending" | "completed" | "rejected" | "failed" | undefined;
  readonly aiAnalysis?: AIAnalysisResponse | undefined;
  readonly toolActivity?: readonly ChatToolActivityDto[] | undefined;
  readonly errorMessage?: string | undefined;
  readonly questionForRetry?: string | undefined;
}

export interface ArchitectureChatPanelProps {
  readonly apiUrl?: string | undefined;
  readonly getToken?: (() => Promise<string | null>) | undefined;
  readonly repositoryId: string;
  readonly analysisRunId: string;
  readonly evidencePool?: readonly GraphQueryResponseEvidence[] | undefined;
  readonly repositoryName?: string | null | undefined;
  readonly commitSha?: string | null | undefined;
  readonly gitRef?: string | null | undefined;
  readonly initialMessages?: readonly ChatTurnMessage[] | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly className?: string | undefined;
}

function getToolLabel(toolName: string): string {
  switch (toolName) {
    case "query_graph":
      return "Graph Traversal";
    case "get_evidence":
      return "Evidence Lookup";
    case "run_simulation":
      return "Failure Simulation";
    default:
      return toolName;
  }
}

export function ArchitectureChatPanel({
  apiUrl,
  getToken,
  repositoryId,
  analysisRunId,
  evidencePool,
  repositoryName,
  commitSha,
  gitRef,
  initialMessages,
  onClose,
  className,
}: ArchitectureChatPanelProps): React.JSX.Element {
  const [messages, setMessages] = useState<readonly ChatTurnMessage[]>(
    initialMessages ?? [],
  );
  const [inputValue, setInputValue] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isMountedRef = useRef<boolean>(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const pollAIAnalysis = useCallback(
    async (
      assistantMsgId: string,
      aiAnalysisId: string,
      questionText: string,
      attempt: number,
    ) => {
      if (!apiUrl || !getToken || !isMountedRef.current) {
        return;
      }

      const result = await fetchAIAnalysis({
        apiUrl,
        aiAnalysisId,
        getToken,
      });

      if (!isMountedRef.current) {
        return;
      }

      if (!result.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  status: "failed",
                  errorMessage: result.message,
                  questionForRetry: questionText,
                }
              : m,
          ),
        );
        setIsSubmitting(false);
        return;
      }

      const data = result.data;
      const toolActivity = Array.isArray(data.metadata?.toolActivity)
        ? (data.metadata.toolActivity as ChatToolActivityDto[])
        : undefined;

      if (data.status === "pending") {
        if (attempt >= MAX_CHAT_POLL_ATTEMPTS) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    status: "failed",
                    errorMessage: "Timed out waiting for architecture chat response.",
                    questionForRetry: questionText,
                  }
                : m,
            ),
          );
          setIsSubmitting(false);
          return;
        }

        pollTimerRef.current = setTimeout(() => {
          void pollAIAnalysis(assistantMsgId, aiAnalysisId, questionText, attempt + 1);
        }, CHAT_POLL_INTERVAL_MS);
        return;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                status: data.status,
                content: data.output_structured?.summary ?? data.output_text ?? "",
                aiAnalysis: data,
                toolActivity,
                errorMessage:
                  data.status === "rejected"
                    ? "Response withheld: citations failed grounding validation."
                    : data.status === "failed"
                      ? (data.error_message ?? "Chat query failed.")
                      : undefined,
                questionForRetry:
                  data.status === "rejected" || data.status === "failed"
                    ? questionText
                    : undefined,
              }
            : m,
        ),
      );
      setIsSubmitting(false);
    },
    [apiUrl, getToken],
  );

  const sendQuestion = useCallback(
    async (questionText: string) => {
      const trimmed = questionText.trim();
      if (!trimmed || isSubmitting) {
        return;
      }
      if (!apiUrl || !getToken) {
        setSubmitError("API connection is not configured.");
        return;
      }

      setSubmitError(null);
      setIsSubmitting(true);

      const boundedHistory: ChatHistoryMessageDto[] = messages
        .filter((m) => m.status === undefined || m.status === "completed")
        .slice(-MAX_CHAT_HISTORY_CONTEXT)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      const userMsgId = `user-${Date.now()}`;
      const assistantMsgId = `assistant-${Date.now()}`;

      setMessages((prev) => [
        ...prev,
        {
          id: userMsgId,
          role: "user",
          content: trimmed,
        },
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          status: "pending",
          questionForRetry: trimmed,
        },
      ]);
      setInputValue("");

      const submitResult = await submitChatQuery({
        apiUrl,
        getToken,
        repositoryId,
        analysisRunId,
        question: trimmed,
        history: boundedHistory,
      });

      if (!isMountedRef.current) {
        return;
      }

      if (!submitResult.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  status: "failed",
                  errorMessage: submitResult.message,
                  questionForRetry: trimmed,
                }
              : m,
          ),
        );
        setIsSubmitting(false);
        return;
      }

      void pollAIAnalysis(
        assistantMsgId,
        submitResult.data.ai_analysis_id,
        trimmed,
        1,
      );
    },
    [analysisRunId, apiUrl, getToken, isSubmitting, messages, pollAIAnalysis, repositoryId],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendQuestion(inputValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendQuestion(inputValue);
    }
  };

  const evidenceLookup = new Map<string, GraphQueryResponseEvidence>();
  for (const ev of evidencePool ?? []) {
    evidenceLookup.set(ev.id, ev);
  }

  return React.createElement(
    "section",
    {
      "data-testid": "architecture-chat-panel",
      "aria-label": "Architecture AI Chat",
      className: `flex flex-col h-full bg-white ${className ?? ""}`,
    },
    // Header
    React.createElement(
      "div",
      {
        className:
          "flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50",
      },
      React.createElement(
        "div",
        null,
        React.createElement(
          "h2",
          { className: "text-sm font-semibold text-slate-900" },
          "Architecture Chat",
        ),
        React.createElement(
          "p",
          { className: "text-[11px] text-slate-500" },
          "Grounded in graph traversal, evidence & bounded simulation",
        ),
      ),
      onClose
        ? React.createElement(
            "button",
            {
              type: "button",
              onClick: onClose,
              "aria-label": "Close Architecture Chat",
              className:
                "text-xs text-slate-500 hover:text-slate-800 px-2 py-1 rounded border border-slate-200 bg-white",
            },
            "Close",
          )
        : null,
    ),
    // Message History
    React.createElement(
      "div",
      {
        "data-testid": "chat-message-list",
        className: "flex-1 overflow-y-auto p-4 space-y-4",
      },
      messages.length === 0
        ? React.createElement(
            "div",
            {
              "data-testid": "chat-empty-state",
              className: "text-center py-8 px-4 text-xs text-slate-500 space-y-2",
            },
            React.createElement(
              "p",
              { className: "font-medium text-slate-700" },
              "Ask a question about this repository's architecture.",
            ),
            React.createElement(
              "p",
              null,
              "Fluxora uses controlled tools (",
              React.createElement("code", null, "query_graph"),
              ", ",
              React.createElement("code", null, "get_evidence"),
              ", ",
              React.createElement("code", null, "run_simulation"),
              ") to ground every claim in verified evidence.",
            ),
          )
        : null,
      ...messages.map((msg) => {
        if (msg.role === "user") {
          return React.createElement(
            "div",
            {
              key: msg.id,
              "data-testid": "chat-message-user",
              className: "flex justify-end",
            },
            React.createElement(
              "div",
              {
                className:
                  "max-w-[85%] rounded-lg bg-blue-600 text-white px-3 py-2 text-xs shadow-xs",
              },
              React.createElement("span", { className: "sr-only" }, "User: "),
              React.createElement(
                "p",
                { className: "whitespace-pre-wrap" },
                msg.content,
              ),
            ),
          );
        }

        const structured = msg.aiAnalysis?.output_structured;

        return React.createElement(
          "div",
          {
            key: msg.id,
            "data-testid": "chat-message-assistant",
            className: "flex flex-col items-start space-y-2",
          },
          React.createElement(
            "div",
            {
              className:
                "w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800 space-y-2.5",
            },
            // Assistant header + confidence badge
            React.createElement(
              "div",
              { className: "flex items-center justify-between gap-2" },
              React.createElement(
                "span",
                { className: "font-semibold text-slate-700" },
                "Fluxora AI",
              ),
              structured?.confidence
                ? React.createElement(
                    "span",
                    {
                      "data-testid": "chat-confidence-badge",
                      className:
                        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-200 text-slate-700 uppercase",
                    },
                    `${structured.confidence} confidence`,
                  )
                : null,
            ),
            // Tool Activity Indicators
            msg.toolActivity && msg.toolActivity.length > 0
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "chat-tool-activity",
                    className: "flex flex-wrap gap-1.5",
                  },
                  ...msg.toolActivity.map((act, idx) =>
                    React.createElement(
                      "span",
                      {
                        key: `${act.tool_name}-${idx}`,
                        className: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${
                          act.status === "completed"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-amber-50 text-amber-700 border-amber-200"
                        }`,
                        title: act.summary,
                      },
                      React.createElement("span", null, getToolLabel(act.tool_name)),
                      React.createElement("span", null, `(${act.status})`),
                    ),
                  ),
                )
              : null,
            // Pending state
            msg.status === "pending"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "chat-pending-state",
                    className: "flex items-center gap-2 text-slate-500 py-1",
                  },
                  React.createElement("span", {
                    className:
                      "inline-block h-2 w-2 rounded-full bg-blue-500 animate-pulse",
                  }),
                  React.createElement(
                    "span",
                    null,
                    "Querying deterministic graph & evidence tools...",
                  ),
                )
              : null,
            // Rejected / Failed state
            msg.status === "rejected" || msg.status === "failed"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": `chat-${msg.status}-state`,
                    className:
                      "rounded border border-rose-200 bg-rose-50 p-2.5 text-rose-800 space-y-2",
                  },
                  React.createElement(
                    "p",
                    null,
                    msg.errorMessage ?? "Unable to produce a grounded answer.",
                  ),
                  msg.questionForRetry
                    ? React.createElement(
                        "button",
                        {
                          type: "button",
                          "data-testid": "chat-retry-button",
                          onClick: () => void sendQuestion(msg.questionForRetry!),
                          disabled: isSubmitting,
                          className:
                            "text-[11px] font-semibold text-rose-700 hover:underline disabled:opacity-50",
                        },
                        "Retry question",
                      )
                    : null,
                )
              : null,
            // Completed grounded answer
            msg.status === "completed" && structured
              ? React.createElement(
                  "div",
                  { className: "space-y-2.5" },
                  React.createElement(
                    "p",
                    { className: "text-slate-900 leading-relaxed whitespace-pre-wrap" },
                    structured.summary,
                  ),
                  structured.claims.length > 0
                    ? React.createElement(
                        "ul",
                        { className: "space-y-2 border-t border-slate-200 pt-2" },
                        ...structured.claims.map((claim, cIdx) => {
                          const resolvedEvidence = claim.evidence_ids
                            .map((id) => evidenceLookup.get(id))
                            .filter(
                              (e): e is GraphQueryResponseEvidence =>
                                e !== undefined,
                            );

                          return React.createElement(
                            "li",
                            {
                              key: cIdx,
                              className:
                                "space-y-1 bg-white rounded border border-slate-200 p-2",
                            },
                            React.createElement(
                              "p",
                              { className: "text-slate-800" },
                              claim.text,
                            ),
                            React.createElement(EvidenceCitationList, {
                              evidenceIds: claim.evidence_ids,
                              evidenceList: resolvedEvidence,
                              repositoryName,
                              commitSha,
                              gitRef,
                              analysisRunId,
                            }),
                          );
                        }),
                      )
                    : null,
                  structured.caveats.length > 0
                    ? React.createElement(
                        "div",
                        { className: "border-t border-slate-200 pt-2" },
                        React.createElement(
                          "p",
                          {
                            className:
                              "text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1",
                          },
                          "Caveats & Scope",
                        ),
                        React.createElement(
                          "ul",
                          {
                            className:
                              "list-disc list-inside text-[11px] text-slate-600 space-y-0.5",
                          },
                          ...structured.caveats.map((cav, cavIdx) =>
                            React.createElement("li", { key: cavIdx }, cav),
                          ),
                        ),
                      )
                    : null,
                )
              : null,
          ),
        );
      }),
    ),
    // Input Area
    React.createElement(
      "form",
      {
        onSubmit: handleSubmit,
        className: "border-t border-slate-200 p-3 bg-slate-50 space-y-2",
      },
      submitError
        ? React.createElement(
            "p",
            { className: "text-[11px] text-rose-600", role: "alert" },
            submitError,
          )
        : null,
      React.createElement(
        "div",
        { className: "flex flex-col gap-2" },
        React.createElement("textarea", {
          "data-testid": "chat-question-input",
          "aria-label": "Ask an architecture question",
          rows: 2,
          value: inputValue,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
            setInputValue(e.target.value),
          onKeyDown: handleKeyDown,
          disabled: isSubmitting,
          placeholder: "Ask about dependencies, evidence, or failure impact...",
          className:
            "w-full rounded border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:bg-slate-100 resize-none",
        }),
        React.createElement(
          "div",
          { className: "flex items-center justify-between" },
          React.createElement(
            "span",
            { className: "text-[10px] text-slate-400" },
            "Press Enter to send, Shift+Enter for newline",
          ),
          React.createElement(
            "button",
            {
              type: "submit",
              "data-testid": "chat-submit-button",
              disabled: isSubmitting || inputValue.trim().length === 0,
              className:
                "px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed",
            },
            isSubmitting ? "Asking..." : "Ask",
          ),
        ),
      ),
    ),
  );
}
