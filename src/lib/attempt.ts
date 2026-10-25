import { APP_ENV } from "./env";

/** One Generate / Try-on click, as the backend's attempt log ("Operations") knows it. */
export type AttemptType = "look" | "tryon" | "look_tryon";

export type Attempt = {
  /** Sent as X-Client-Request-Id; one per click. */
  requestId: string;
  attemptType: AttemptType;
  garmentTypeId?: string | null;
};

const TEXT_MAX = 1000;
const REPORT_RETRY_MS = 3000;

function uuidFromBytes(bytes: Uint8Array) {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** v4 UUID; randomUUID is missing outside secure contexts (e.g. the dev server over LAN http). */
export function newRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return uuidFromBytes(bytes);
}

export function newAttempt(attemptType: AttemptType, garmentTypeId?: string | null): Attempt {
  return { requestId: newRequestId(), attemptType, garmentTypeId: garmentTypeId || null };
}

/** A failed generation call: either no response at all, or an error response the backend already logged. */
export class AttemptError extends Error {
  attempt: Attempt;
  noResponse: boolean;
  backendRequestId?: string;
  clientError: string;

  constructor(
    message: string,
    fields: { attempt: Attempt; noResponse: boolean; backendRequestId?: string | null; clientError?: string }
  ) {
    super(message);
    this.name = "AttemptError";
    this.attempt = fields.attempt;
    this.noResponse = fields.noResponse;
    this.backendRequestId = fields.backendRequestId || undefined;
    this.clientError = fields.clientError ?? message;
  }
}

/** Same failure, with the plain message the user is shown. */
export function withMessage(err: unknown, message: string): Error {
  if (!(err instanceof AttemptError)) return new Error(message);
  return new AttemptError(message, {
    attempt: err.attempt,
    noResponse: err.noResponse,
    backendRequestId: err.backendRequestId,
    clientError: err.clientError
  });
}

/** The short id a shop reads out ("Ref: 1a2b3c4d") to find the attempt in Operations. */
export function refFromId(id: string | null | undefined): string | null {
  return id ? id.slice(0, 8) : null;
}

export function attemptRef(err: unknown): string | null {
  if (!(err instanceof AttemptError)) return null;
  return refFromId(err.backendRequestId ?? err.attempt.requestId);
}

/** Same labels as the backend's device_label(), e.g. "iPhone · Safari". */
export function deviceLabel(): string {
  const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "").toLowerCase();
  if (!ua) return "Other";

  let os: string | null = null;
  if (ua.includes("iphone")) os = "iPhone";
  else if (ua.includes("ipad")) os = "iPad";
  else if (ua.includes("android")) os = "Android";
  else if (ua.includes("windows")) os = "Windows";
  else if (ua.includes("macintosh") || ua.includes("mac os")) os = "Mac";
  else if (ua.includes("linux")) os = "Linux";

  let browser: string | null = null;
  if (ua.includes("edg/") || ua.includes("edga/") || ua.includes("edgios/")) browser = "Edge";
  else if (ua.includes("opr/") || ua.includes("opera")) browser = "Opera";
  else if (ua.includes("samsungbrowser")) browser = "Samsung Internet";
  else if (ua.includes("fxios") || ua.includes("firefox")) browser = "Firefox";
  else if (ua.includes("crios") || ua.includes("chrome/")) browser = "Chrome";
  else if (ua.includes("safari")) browser = "Safari";

  return [os, browser].filter(Boolean).join(" · ") || "Other";
}

/** true = worth one retry (network error or 5xx). A 404 (backend not deployed yet) or other 4xx is final. */
async function sendReport(accessToken: string, body: string): Promise<boolean> {
  try {
    const response = await fetch(`${APP_ENV.apiBaseUrl}/attempt-logs/client-report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body
    });
    return response.status >= 500;
  } catch {
    return true;
  }
}

/**
 * Best effort: tells the backend about a click that never got a response, so it shows in
 * Operations. Does nothing for error responses (the backend logged those). Never throws or waits.
 */
export function reportNoResponse(accessToken: string | null | undefined, err: unknown, userMessage: string) {
  if (!accessToken || !(err instanceof AttemptError) || !err.noResponse) return;

  const body = JSON.stringify({
    request_id: err.attempt.requestId,
    attempt_type: err.attempt.attemptType,
    garment_type_id: err.attempt.garmentTypeId || null,
    user_message: userMessage.slice(0, TEXT_MAX),
    client_error: err.clientError.slice(0, TEXT_MAX),
    device_label: deviceLabel()
  });

  void sendReport(accessToken, body)
    .then((retry) => {
      if (retry) window.setTimeout(() => void sendReport(accessToken, body), REPORT_RETRY_MS);
    })
    .catch(() => undefined);
}
