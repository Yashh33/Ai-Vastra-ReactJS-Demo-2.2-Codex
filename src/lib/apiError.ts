/** Plain messages a shop sees when a look / try-on call fails. Raw backend text only goes to the console. */
export const CONNECTION_MESSAGE = "Connection hiccup. Please try again.";
export const NO_CREDITS_MESSAGE = "Not enough credits. Please contact MyTryonAi to top up.";
export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const AI_BUSY_MESSAGE =
  "The AI service is busy right now. Your credits were not used. Please try again in a few minutes.";
export const AI_TRYON_REJECTED_MESSAGE =
  "The AI could not use this photo. Your credits were not used. Please try a different photo.";
export const AI_LOOK_REJECTED_MESSAGE =
  "The AI could not make this look. Your credits were not used. Please try a different fabric photo.";

/** Which flow failed: a look (fabric photo) or a try-on / look try-on (customer photo). */
export type FailureKind = "look" | "tryon";

/**
 * The message for the backend's optional error_code ("ai_busy" | "ai_blocked" | "ai_no_image").
 * null for a missing or unknown code, so callers fall back to today's message.
 */
export function errorCodeMessage(code: string | null | undefined, kind: FailureKind): string | null {
  if (code === "ai_busy") return AI_BUSY_MESSAGE;
  if (code === "ai_blocked" || code === "ai_no_image") {
    return kind === "look" ? AI_LOOK_REJECTED_MESSAGE : AI_TRYON_REJECTED_MESSAGE;
  }
  return null;
}

/** A failed backend call: an error response (status set) or no response at all (noResponse). */
export class ApiError extends Error {
  status: number | null;
  noResponse: boolean;
  /** The backend's optional error_code from the error body (older backends don't send it). */
  errorCode: string | null;

  constructor(
    message: string,
    fields: { status: number | null; noResponse: boolean; errorCode?: string | null }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = fields.status;
    this.noResponse = fields.noResponse;
    this.errorCode = fields.errorCode ?? null;
  }
}

/** A fabric the call needs is missing on this device (caught before anything is sent). */
export class MissingFabricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingFabricError";
  }
}

/** AttemptError (attempt.ts) carries the attempt type; read it structurally to avoid an import cycle. */
function kindOf(err: ApiError): FailureKind {
  const attemptType = (err as { attempt?: { attemptType?: unknown } }).attempt?.attemptType;
  return attemptType === "look" ? "look" : "tryon";
}

/** Supabase storage / fetch failures that never reached a server. */
function looksLikeNetworkFailure(err: unknown) {
  if (!(err instanceof Error)) return false;
  const text = `${err.name} ${err.message}`.toLowerCase();
  return (
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("network request failed") ||
    text.includes("load failed")
  );
}

/**
 * The message to show for a failed look / try-on / look try-on.
 * `fabricMessage`: the "Check the fabric(s)…" wording, used only for a missing / invalid fabric.
 * `kind`: which flow failed, for the error_code wording; defaults to the call's attempt type
 * (a look -> "look", a try-on / look try-on -> "tryon"), else "tryon".
 * A known error_code wins over the status rules; without one the message is unchanged.
 */
export function friendlyError(err: unknown, fabricMessage?: string, kind?: FailureKind): string {
  if (err instanceof ApiError) {
    const codeMessage = errorCodeMessage(err.errorCode, kind ?? kindOf(err));
    if (codeMessage) return codeMessage;
    if (err.noResponse || err.status === 503) return CONNECTION_MESSAGE;
    if (err.status === 402) return NO_CREDITS_MESSAGE;
    if (err.status === 400 && fabricMessage && /fabric/i.test(err.message)) return fabricMessage;
    return GENERIC_ERROR_MESSAGE;
  }
  if (err instanceof MissingFabricError && fabricMessage) return fabricMessage;
  if (looksLikeNetworkFailure(err)) return CONNECTION_MESSAGE;
  return GENERIC_ERROR_MESSAGE;
}
