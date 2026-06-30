import { NexusEdgeError, normalizeError } from "../core/error";

export interface ParsedSseEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export interface ParseSseOptions {
  readonly maxLineChars?: number;
  readonly maxEventDataChars?: number;
  readonly maxStreamChars?: number;
  readonly maxEvents?: number;
}

const DEFAULT_PARSE_SSE_LIMITS: Required<ParseSseOptions> = {
  maxLineChars: 64 * 1024,
  maxEventDataChars: 1024 * 1024,
  maxStreamChars: 8 * 1024 * 1024,
  maxEvents: 10_000
};

const encoder = new TextEncoder();
const SSE_EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function encodeSse(event: string, data: unknown): Uint8Array {
  validateSseEventName(event);
  const payload = [`event: ${event}`, `data: ${JSON.stringify(data)}`, "", ""].join("\n");
  return encoder.encode(payload);
}

export function createSseStream(
  run: (emit: (event: string, data: unknown) => Promise<void>) => Promise<void>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = async (event: string, data: unknown): Promise<void> => {
        controller.enqueue(encodeSse(event, data));
        if ((controller.desiredSize ?? 1) <= 0) {
          await Promise.resolve();
        }
      };

      try {
        await run(emit);
      } catch (error) {
        const normalized = normalizeError(error);
        controller.enqueue(
          encodeSse("error", {
            code: normalized.code,
            message: normalized.message,
            details: normalized.details
          })
        );
      } finally {
        controller.close();
      }
    }
  });
}

function validateSseEventName(event: string): void {
  if (!SSE_EVENT_NAME_PATTERN.test(event)) {
    throw new NexusEdgeError("INVALID_SSE_EVENT", "SSE event name contains unsupported characters.");
  }
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  options: ParseSseOptions = {}
): AsyncIterable<ParsedSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const limits = { ...DEFAULT_PARSE_SSE_LIMITS, ...options };
  let buffer = "";
  let streamChars = 0;
  let eventDataChars = 0;
  let eventCount = 0;
  let currentEvent: string | undefined;
  let currentId: string | undefined;
  let currentRetry: number | undefined;
  let dataLines: string[] = [];

  const ensureWithinLimit = (value: number, limit: number, message: string): void => {
    if (value > limit) {
      throw new NexusEdgeError("SSE_PARSE_LIMIT", message, {
        limit,
        value
      });
    }
  };

  const addToStreamBuffer = (text: string): void => {
    streamChars += text.length;
    ensureWithinLimit(streamChars, limits.maxStreamChars, "SSE stream exceeded maximum size.");
    buffer += text;
    ensureWithinLimit(buffer.length, limits.maxLineChars, "SSE line exceeded maximum size.");
  };

  const addDataLine = (value: string): void => {
    eventDataChars += value.length + (dataLines.length > 0 ? 1 : 0);
    ensureWithinLimit(eventDataChars, limits.maxEventDataChars, "SSE event data exceeded maximum size.");
    dataLines.push(value);
  };

  const dispatch = (): ParsedSseEvent | undefined => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      currentId = undefined;
      currentRetry = undefined;
      eventDataChars = 0;
      return undefined;
    }

    eventCount += 1;
    ensureWithinLimit(eventCount, limits.maxEvents, "SSE stream exceeded maximum event count.");

    const event: ParsedSseEvent = {
      event: currentEvent,
      data: dataLines.join("\n"),
      id: currentId,
      retry: currentRetry
    };

    currentEvent = undefined;
    currentId = undefined;
    currentRetry = undefined;
    dataLines = [];
    eventDataChars = 0;
    return event;
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      addToStreamBuffer(decoder.decode(result.value, { stream: true }));
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      ensureWithinLimit(buffer.length, limits.maxLineChars, "SSE line exceeded maximum size.");

      for (const line of lines) {
        ensureWithinLimit(line.length, limits.maxLineChars, "SSE line exceeded maximum size.");
        if (line.length === 0) {
          const event = dispatch();
          if (event) {
            yield event;
          }
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        const colon = line.indexOf(":");
        const field = colon >= 0 ? line.slice(0, colon) : line;
        const rawValue = colon >= 0 ? line.slice(colon + 1) : "";
        const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

        if (field === "event") {
          currentEvent = value;
        } else if (field === "data") {
          addDataLine(value);
        } else if (field === "id") {
          currentId = value;
        } else if (field === "retry") {
          const retry = Number(value);
          if (Number.isFinite(retry)) {
            currentRetry = retry;
          }
        }
      }
    }

    addToStreamBuffer(decoder.decode());
    if (buffer.length > 0) {
      const finalLines = buffer.split(/\r?\n/);
      for (const line of finalLines) {
        ensureWithinLimit(line.length, limits.maxLineChars, "SSE line exceeded maximum size.");
        if (line.length === 0) {
          const event = dispatch();
          if (event) {
            yield event;
          }
          continue;
        }

        const colon = line.indexOf(":");
        const field = colon >= 0 ? line.slice(0, colon) : line;
        const rawValue = colon >= 0 ? line.slice(colon + 1) : "";
        const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
        if (field === "event") {
          currentEvent = value;
        } else if (field === "data") {
          addDataLine(value);
        }
      }
    }

    const event = dispatch();
    if (event) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
