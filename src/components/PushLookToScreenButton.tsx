import { useState } from "react";

import { apiFetch } from "../lib/api";
import { AttemptError, attemptRef, newAttempt } from "../lib/attempt";
import { useAuth } from "../lib/auth";

type Props = {
  generationId: string;
  garmentTypeId?: string | null;
};

const PUSH_FAILED = "Could not push to the big screen.";

function pushErrorMessage(err: unknown): string {
  if (!(err instanceof Error) || (err instanceof AttemptError && err.noResponse)) return PUSH_FAILED;
  // FastAPI's own 404: the backend doesn't have this endpoint yet.
  if (err.message === "Not Found") return "Push to big screen is not available yet.";
  return err.message;
}

/**
 * "Push to big screen" for a finished look; the backend copies the look's current image.
 * Callers set key to the look's id + output_path, so another look or a new image resets the button.
 */
export function PushLookToScreenButton({ generationId, garmentTypeId }: Props) {
  const { accessToken } = useAuth();
  const [pushing, setPushing] = useState(false);
  const [pushedLive, setPushedLive] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushErrorRef, setPushErrorRef] = useState<string | null>(null);

  async function handlePush() {
    if (pushing) return;
    setPushing(true);
    setPushError(null);
    setPushErrorRef(null);
    try {
      if (!accessToken) throw new Error("Not authenticated");
      // One id per tap.
      const attempt = newAttempt("look", garmentTypeId);
      await apiFetch(`/generations/${encodeURIComponent(generationId)}/push-to-screen`, accessToken, { method: "POST" }, attempt);
      setPushedLive(true);
    } catch (err) {
      setPushedLive(false);
      setPushError(pushErrorMessage(err));
      setPushErrorRef(attemptRef(err));
    } finally {
      setPushing(false);
    }
  }

  return (
    <div style={{ width: "100%", display: "grid", gap: "10px" }}>
      <button
        type="button"
        onClick={() => void handlePush()}
        disabled={pushing}
        style={{
          width: "100%",
          minHeight: "52px",
          background: "#1B1B2F",
          color: "#C9A84C",
          border: "none",
          borderRadius: "14px",
          fontSize: "15px",
          fontWeight: 700,
          cursor: pushing ? "default" : "pointer",
          fontFamily: "inherit",
          opacity: pushing ? 0.6 : 1,
        }}
      >
        {pushing ? "Pushing…" : pushedLive ? "📺 Push again" : "📺 Push to big screen"}
      </button>
      {pushedLive && (
        <p
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#1B1B2F",
            background: "#FDF6E8",
            border: "1px solid rgba(201,168,76,0.35)",
            padding: "10px 12px",
            borderRadius: "10px",
            margin: 0,
            textAlign: "center",
          }}
        >
          Now live on the big screen
        </p>
      )}
      {pushError && (
        <p
          style={{
            fontSize: "13px",
            color: "#991B1B",
            background: "#FEF2F2",
            padding: "10px 12px",
            borderRadius: "10px",
            margin: 0,
          }}
        >
          {pushError}
        </p>
      )}
      {pushError && pushErrorRef && (
        <p
          style={{
            fontSize: "12px",
            color: "var(--text-muted)",
            margin: 0,
          }}
        >
          Ref: {pushErrorRef}
        </p>
      )}
    </div>
  );
}
