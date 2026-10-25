import { AttemptError, type Attempt } from "./attempt";
import { debugLog } from "./debugLog";
import { APP_ENV } from "./env";

type ErrorPayload = {
  detail?: string;
  request_id?: string;
};

function buildHeaders(init: RequestInit, accessToken: string, attempt?: Attempt) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (attempt) headers.set("X-Client-Request-Id", attempt.requestId);
  return headers;
}

async function send(path: string, init: RequestInit, headers: Headers, attempt?: Attempt): Promise<Response> {
  const isUpload = init.body instanceof FormData;
  if (isUpload) debugLog(`upload start ${path}`);
  let response: Response;
  try {
    response = await fetch(`${APP_ENV.apiBaseUrl}${path}`, {
      ...init,
      headers
    });
  } catch (err) {
    if (isUpload) debugLog("upload FAIL network");
    if (!attempt) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "Error";
    throw new AttemptError(message, { attempt, noResponse: true, clientError: `${name}: ${message}` });
  }
  if (isUpload) debugLog(`upload ${response.ok ? "OK" : "FAIL"} ${response.status}`);
  return response;
}

function parsePayload(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorFor(response: Response, payload: unknown, attempt?: Attempt): Error {
  const body = typeof payload === "object" && payload !== null ? (payload as ErrorPayload) : null;
  const detail = body && "detail" in body ? String(body.detail) : `HTTP ${response.status}`;

  if (!attempt) return new Error(detail);
  // The backend logged this attempt; its id comes back in the body or the X-Request-Id header.
  const backendRequestId =
    (typeof body?.request_id === "string" ? body.request_id : null) ?? response.headers.get("X-Request-Id");
  return new AttemptError(detail, { attempt, noResponse: false, backendRequestId });
}

/** `attempt`: a Generate / Try-on call; sends X-Client-Request-Id and throws AttemptError on failure. */
export async function apiFetch<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  attempt?: Attempt
): Promise<T> {
  const response = await send(path, init, buildHeaders(init, accessToken, attempt), attempt);

  const payload = parsePayload(await response.text());
  if (!response.ok) throw errorFor(response, payload, attempt);

  return payload as T;
}

export async function apiFetchBinary(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  attempt?: Attempt
): Promise<Blob> {
  const response = await send(path, init, buildHeaders(init, accessToken, attempt), attempt);

  if (!response.ok) {
    const payload = parsePayload(await response.text());
    throw errorFor(response, payload, attempt);
  }

  return response.blob();
}
