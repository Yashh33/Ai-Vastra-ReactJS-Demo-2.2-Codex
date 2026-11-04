/** Plain messages a shop sees when a look / try-on call fails. Raw backend text only goes to the console. */
export const CONNECTION_MESSAGE = "Connection hiccup. Please try again.";
export const NO_CREDITS_MESSAGE = "Not enough credits. Please contact MyTryonAi to top up.";
export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** A failed backend call: an error response (status set) or no response at all (noResponse). */
export class ApiError extends Error {
  status: number | null;
  noResponse: boolean;

  constructor(message: string, fields: { status: number | null; noResponse: boolean }) {
    super(message);
    this.name = "ApiError";
    this.status = fields.status;
    this.noResponse = fields.noResponse;
  }
}

/** A fabric the call needs is missing on this device (caught before anything is sent). */
export class MissingFabricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingFabricError";
  }
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
 */
export function friendlyError(err: unknown, fabricMessage?: string): string {
  if (err instanceof ApiError) {
    if (err.noResponse || err.status === 503) return CONNECTION_MESSAGE;
    if (err.status === 402) return NO_CREDITS_MESSAGE;
    if (err.status === 400 && fabricMessage && /fabric/i.test(err.message)) return fabricMessage;
    return GENERIC_ERROR_MESSAGE;
  }
  if (err instanceof MissingFabricError && fabricMessage) return fabricMessage;
  if (looksLikeNetworkFailure(err)) return CONNECTION_MESSAGE;
  return GENERIC_ERROR_MESSAGE;
}
