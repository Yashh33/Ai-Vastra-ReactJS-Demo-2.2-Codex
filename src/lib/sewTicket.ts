import { ApiError } from "./apiError";
import { newRequestId } from "./attempt";

/**
 * Sew a look: one ticket (X-Client-Request-Id) per unchanged request, so a retry of
 * the same look is never charged twice (the backend answers a reused ticket with the
 * look already made, "duplicate": true).
 */

/** No answer or 503: the same ticket is sent again after these waits before the error shows. */
export const SEW_RETRY_DELAYS_MS = [2_000, 5_000];

/** The call may not have reached the backend (or it was briefly down): safe to send the same ticket again. */
export function isRetryableSewError(err: unknown) {
  return err instanceof ApiError && (err.noResponse || err.status === 503);
}

/** Runs `send`, sending again after 2 s and then 5 s while it gets no answer (or 503). */
export async function withSewRetries<T>(
  send: () => Promise<T>,
  options: {
    onRetry?: (retryNumber: number) => void;
    wait?: (ms: number) => Promise<void>;
    delays?: number[];
  } = {}
): Promise<T> {
  const delays = options.delays ?? SEW_RETRY_DELAYS_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let index = 0; ; index += 1) {
    try {
      return await send();
    } catch (err) {
      const delay = delays[index];
      if (delay === undefined || !isRetryableSewError(err)) throw err;
      options.onRetry?.(index + 1);
      await wait(delay);
    }
  }
}

/**
 * Keeps the ticket of the last Sew while it is unfinished. `ticketFor(key)` gives the
 * same ticket for the same request (same key) and a new one for anything changed;
 * `finish()` after an answer (or a definite error) makes the next Sew get a new one.
 */
export function createSewTicketBook(makeId: () => string = newRequestId) {
  let kept: { key: string; requestId: string } | null = null;
  return {
    ticketFor(key: string): string {
      if (kept?.key !== key) kept = { key, requestId: makeId() };
      return kept.requestId;
    },
    /** `err`: how the call ended (left out on success). No answer / 503 keeps the ticket for a retry. */
    finish(err?: unknown) {
      if (err === undefined || !isRetryableSewError(err)) kept = null;
    },
    peek() {
      return kept;
    }
  };
}

export type SewTicketBook = ReturnType<typeof createSewTicketBook>;
