import { apiFetch, apiFetchBinary } from "./api";
import { ApiError, CONNECTION_MESSAGE, errorCodeMessage, GENERIC_ERROR_MESSAGE } from "./apiError";
import { AttemptError, reportNoResponse, withMessage, type Attempt } from "./attempt";

/**
 * A try-on is never lost (shared by Generate, Browse and the Output Viewer).
 *
 * Each try-on carries one ticket (X-Client-Request-Id). Sending the same ticket again
 * never charges twice: the backend returns the stored picture, or 409 "still_running".
 * When the POST gets no answer (or that 409), the result is fetched with
 * GET /tryon/result/{ticket} instead of showing an error. On a backend without that
 * endpoint (404) everything behaves as before.
 */

/** Stop waiting on the try-on POST after this long and treat it as "no response". */
export const TRYON_POST_TIMEOUT_MS = 150_000;
export const TRYON_POLL_INTERVAL_MS = 3_000;
/** Ask GET /tryon/result for at most this long. */
export const TRYON_POLL_LIMIT_MS = 180_000;
/** "unknown" this long in a row means the backend never got the try-on. */
export const TRYON_UNKNOWN_LIMIT_MS = 20_000;

export type TryOnResultStatus = {
  status?: "ready" | "running" | "failed" | "unknown" | string;
  image_url?: string | null;
  thumb_url?: string | null;
  error_code?: string | null;
  message?: string | null;
};

/**
 * How a recovered try-on ended when it did not end with a picture. Its message is
 * already the plain text to show. `definite`: the try-on really failed, so the next
 * one needs a new ticket; otherwise a retry reuses the same ticket.
 */
export class TryOnRecoveryError extends AttemptError {
  definite: boolean;

  constructor(
    message: string,
    fields: { attempt: Attempt; definite: boolean; noResponse: boolean; errorCode?: string | null; clientError?: string }
  ) {
    super(message, {
      attempt: fields.attempt,
      noResponse: fields.noResponse,
      status: null,
      errorCode: fields.errorCode ?? null,
      clientError: fields.clientError
    });
    this.name = "TryOnRecoveryError";
    this.definite = fields.definite;
  }
}

export function isStillRunning(err: unknown) {
  return err instanceof ApiError && err.status === 409 && err.errorCode === "still_running";
}

/** No answer at all, or "your try-on with this ticket is still running": look for the result instead. */
function shouldRecover(err: unknown) {
  return err instanceof ApiError && (err.noResponse || isStillRunning(err));
}

/**
 * true when the next try-on needs a new ticket (this one got a definite answer).
 * No answer, 503, "still running", "connection hiccup", or a failure before anything
 * was sent keep the ticket, so a retry can never be charged twice.
 */
export function tryOnTicketSpent(err: unknown): boolean {
  if (err instanceof TryOnRecoveryError) return err.definite;
  if (err instanceof ApiError) return !(err.noResponse || err.status === 503 || isStillRunning(err));
  return false;
}

export type RecoverDeps = {
  getResult: (requestId: string) => Promise<TryOnResultStatus>;
  loadImage: (url: string) => Promise<Blob>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

function failedMessage(result: TryOnResultStatus) {
  return errorCodeMessage(result.error_code, "tryon") ?? (result.message?.trim() || GENERIC_ERROR_MESSAGE);
}

/**
 * Polls the try-on's result after the POST got no answer (or 409 still_running).
 * Resolves with the picture; throws `original` when the endpoint is missing (404),
 * otherwise a TryOnRecoveryError with the message to show.
 */
export async function recoverTryOn(attempt: Attempt, original: unknown, deps: RecoverDeps): Promise<Blob> {
  const start = deps.now();
  let unknownSince: number | null = null;
  const clientError = original instanceof AttemptError ? original.clientError : undefined;
  const originalNoResponse = original instanceof ApiError && original.noResponse;

  for (;;) {
    let result: TryOnResultStatus | null = null;
    try {
      result = await deps.getResult(attempt.requestId);
    } catch (err) {
      // Older backend without the endpoint: the same error as before.
      if (err instanceof ApiError && err.status === 404) throw original;
      console.warn("[try-on] result check failed", err);
    }

    const status = result?.status;
    if (status === "failed" && result) {
      throw new TryOnRecoveryError(failedMessage(result), {
        attempt,
        definite: true,
        noResponse: false,
        errorCode: result.error_code ?? null
      });
    }

    let known = status === "running";
    if (status === "ready" && result?.image_url) {
      try {
        return await deps.loadImage(result.image_url);
      } catch (err) {
        // The picture is stored; a later check (or a retry with this ticket) gets it.
        console.warn("[try-on] stored picture failed to load", err);
      }
      known = true;
    }

    const now = deps.now();
    if (known) {
      unknownSince = null;
    } else {
      unknownSince ??= now;
      if (now - unknownSince >= TRYON_UNKNOWN_LIMIT_MS) {
        throw new TryOnRecoveryError(CONNECTION_MESSAGE, {
          attempt,
          definite: false,
          noResponse: originalNoResponse,
          clientError
        });
      }
    }
    if (now - start >= TRYON_POLL_LIMIT_MS) {
      // Still running on the backend: a retry with the same ticket picks it up, never charged twice.
      throw new TryOnRecoveryError(CONNECTION_MESSAGE, { attempt, definite: false, noResponse: false, clientError });
    }
    await deps.sleep(TRYON_POLL_INTERVAL_MS);
  }
}

function defaultDeps(accessToken: string): RecoverDeps {
  return {
    getResult: (requestId) =>
      apiFetch<TryOnResultStatus>(`/tryon/result/${encodeURIComponent(requestId)}`, accessToken, { method: "GET" }),
    loadImage: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("empty picture");
      return blob;
    },
    sleep: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
    now: () => Date.now()
  };
}

/**
 * POSTs a try-on with its ticket and returns the picture. Gives up waiting on the
 * POST after 150 s; then (or on 409 still_running) asks GET /tryon/result/{ticket}
 * every 3 s for up to 3 minutes before an error is shown.
 */
export async function sendTryOn(
  path: string,
  accessToken: string,
  formData: FormData,
  attempt: Attempt,
  deps: RecoverDeps = defaultDeps(accessToken)
): Promise<Blob> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TRYON_POST_TIMEOUT_MS);
  let postError: unknown;
  try {
    return await apiFetchBinary(path, accessToken, { method: "POST", body: formData, signal: controller.signal }, attempt);
  } catch (err) {
    postError = err;
  } finally {
    window.clearTimeout(timer);
  }
  if (!shouldRecover(postError)) throw postError;
  return recoverTryOn(attempt, postError, deps);
}

/**
 * The error a page hands to TryOnFlow. A recovered try-on's error already carries its
 * plain message; anything else gets `message()` (the page's own wording), as before.
 * A try-on that never got an answer is reported to Operations either way.
 */
export function tryOnFailure(err: unknown, accessToken: string | null | undefined, message: () => string): Error {
  if (err instanceof TryOnRecoveryError) {
    reportNoResponse(accessToken, err, err.message);
    return err;
  }
  const text = message();
  reportNoResponse(accessToken, err, text);
  return withMessage(err, text);
}
