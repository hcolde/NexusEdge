export interface TimeoutSignal {
  readonly signal: AbortSignal;
  clear(): void;
}

export function createAbortSignal(source?: AbortSignal): AbortSignal {
  if (source) {
    return source;
  }

  return new AbortController().signal;
}

export function withTimeoutSignal(source: AbortSignal | undefined, timeoutMs: number | undefined): TimeoutSignal {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: createAbortSignal(source),
      clear() {
        return;
      }
    };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const abortFromSource = (): void => controller.abort();
  source?.addEventListener("abort", abortFromSource, { once: true });

  return {
    signal: controller.signal,
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      source?.removeEventListener("abort", abortFromSource);
    }
  };
}
