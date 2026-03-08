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
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${APP_ENV.apiBaseUrl}${path}`, {
    ...init,
    headers
  });

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
