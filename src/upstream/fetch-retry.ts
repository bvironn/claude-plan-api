import { MAX_RETRY_AFTER_MS } from "../config.ts";
import { emit } from "../observability/logger.ts";

/**
 * Wait `ms`, or resolve early when `signal` aborts. A plain sleep would keep
 * a request parked in backoff long after its caller has gone away.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Parse a `retry-after` header (seconds) into ms; undefined when absent/invalid. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number.parseInt(headerValue, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * `fetch` with bounded retry on 429/529. Honours `retry-after` up to
 * MAX_RETRY_AFTER_MS; a longer hint means a quota reset hours away, so the
 * response is returned immediately instead of hanging. Backoff ends early
 * (returning the rate-limit response) when `init.signal` aborts.
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  retries = 3,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(input, init);
    if ((res.status !== 429 && res.status !== 529) || i === retries - 1) return res;

    const delay = parseRetryAfterMs(res.headers.get("retry-after")) ?? (i + 1) * 2000;
    if (delay > MAX_RETRY_AFTER_MS) {
      emit("warn", "http.retry.cap_exceeded", { status: res.status, delayMs: delay });
      return res;
    }
    emit("warn", "http.retry", { status: res.status, attempt: i + 1, delayMs: delay });
    await sleepUnlessAborted(delay, init.signal);
    if (init.signal?.aborted) return res;
  }
  // Only reachable when retries < 1.
  return fetch(input, init);
}
