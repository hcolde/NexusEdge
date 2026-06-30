import { normalizeError } from "../core/error";

export interface ParsedSseEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

const encoder = new TextEncoder();

export function encodeSse(event: string, data: unknown): Uint8Array {
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

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<ParsedSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | undefined;
  let currentId: string | undefined;
  let currentRetry: number | undefined;
  let dataLines: string[] = [];

  const dispatch = (): ParsedSseEvent | undefined => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      currentId = undefined;
      currentRetry = undefined;
      return undefined;
    }

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
    return event;
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
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
          dataLines.push(value);
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

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const finalLines = buffer.split(/\r?\n/);
      for (const line of finalLines) {
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
          dataLines.push(value);
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
