import type { JsonValue } from "./types";

export type NexusEdgeErrorCode =
  | "FLOW_NOT_SET"
  | "AGENT_NOT_FOUND"
  | "INVALID_FLOW"
  | "INVALID_ROUTE"
  | "MAX_STEPS"
  | "MAX_TOOL_CALLS"
  | "TOOL_NOT_FOUND"
  | "TOOL_VALIDATION_ERROR"
  | "TOOL_EXECUTION_ERROR"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_STREAM_ERROR"
  | "PROVIDER_PARSE_ERROR"
  | "SSE_PARSE_LIMIT"
  | "CONTEXT_OVERFLOW"
  | "ABORTED"
  | "UNKNOWN";

export class NexusEdgeError extends Error {
  readonly code: NexusEdgeErrorCode;
  readonly details?: JsonValue;

  constructor(code: NexusEdgeErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "NexusEdgeError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeError(error: unknown): NexusEdgeError {
  if (error instanceof NexusEdgeError) {
    return error;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new NexusEdgeError("ABORTED", error.message || "The operation was aborted.");
    }

    return new NexusEdgeError("UNKNOWN", "Unknown NexusEdge error.");
  }

  return new NexusEdgeError("UNKNOWN", "Unknown NexusEdge error.");
}
