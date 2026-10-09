import { debugLog } from "./debugLog";
import { APP_ENV } from "./env";

type ErrorPayload = {
  detail?: string;
};

export async function apiFetch<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

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
    throw err;
  }
  if (isUpload) debugLog(`upload ${response.ok ? "OK" : "FAIL"} ${response.status}`);

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "detail" in (payload as ErrorPayload)
        ? String((payload as ErrorPayload).detail)
        : `HTTP ${response.status}`;

    throw new Error(detail);
  }

  return payload as T;
}

export async function apiFetchBinary(
  path: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<Blob> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

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
    throw err;
  }
  if (isUpload) debugLog(`upload ${response.ok ? "OK" : "FAIL"} ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "detail" in (payload as ErrorPayload)
        ? String((payload as ErrorPayload).detail)
        : `HTTP ${response.status}`;

    throw new Error(detail);
  }

  return response.blob();
}
