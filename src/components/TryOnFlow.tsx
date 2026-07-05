import { useEffect, useRef, useState } from "react";

import { compressImage } from "../lib/compressImage";

type Props = {
  onClose: () => void;
  onSubmit: (customerPhotoFile: File) => Promise<string>;
};

export function TryOnFlow({ onClose, onSubmit }: Props) {
  const [customerPhoto, setCustomerPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const captureRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!previewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    if (!resultUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  async function handleFileSelect(file: File) {
    const compressed = await compressImage(file, 1280);
    setCustomerPhoto(compressed);
    setPreviewUrl(URL.createObjectURL(compressed));
    setResultUrl(null);
    setError(null);
  }

  async function handleGenerate() {
    if (!customerPhoto) return;
    setBusy(true);
    setError(null);
    try {
      const url = await onSubmit(customerPhoto);
      setResultUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function handleShare() {
    if (!resultUrl) return;
    setSharing(true);
    try {
      const response = await fetch(resultUrl);
      const blob = await response.blob();
      const file = new File([blob], "ai-vastra-tryon.jpg", {
        type: "image/jpeg",
      });
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        window.open(resultUrl, "_blank");
      }
    } catch {
      window.open(resultUrl, "_blank");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          background: "var(--white)",
          borderBottom: "0.5px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h2
          style={{
            fontSize: "17px",
            fontWeight: 700,
            color: "var(--navy)",
            margin: 0,
          }}
        >
          {resultUrl ? "Try-On Preview" : "Customer Try-On"}
        </h2>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            fontSize: "22px",
            cursor: "pointer",
            color: "var(--text-muted)",
            lineHeight: 1,
            padding: "4px",
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "16px",
          display: "grid",
          gap: "14px",
          alignContent: "start",
        }}
      >
        {resultUrl && (
          <>
            <img
              src={resultUrl}
              alt="Try-on result"
              style={{
                width: "100%",
                borderRadius: "16px",
                border: "0.5px solid var(--border)",
                display: "block",
              }}
            />
            <button
              onClick={handleShare}
              disabled={sharing}
              style={{
                width: "100%",
                minHeight: "52px",
                background: "#1B1B2F",
                color: "#C9A84C",
                border: "none",
                borderRadius: "14px",
                fontSize: "15px",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
                opacity: sharing ? 0.6 : 1,
              }}
            >
              {sharing ? "Preparing..." : "↑ Share / Save"}
            </button>
            <button
              onClick={() => {
                setResultUrl(null);
                setCustomerPhoto(null);
                setPreviewUrl(null);
              }}
              style={{
                width: "100%",
                minHeight: "44px",
                background: "transparent",
                color: "var(--text-muted)",
                border: "0.5px solid var(--border)",
                borderRadius: "12px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Try Another Photo
            </button>
          </>
        )}

        {!resultUrl && (
          <>
            {!previewUrl && (
              <div
                style={{
                  background: "var(--white)",
                  border: "0.5px solid var(--border)",
                  borderRadius: "16px",
                  padding: "14px",
                  display: "grid",
                  gap: "10px",
                }}
              >
                <p
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    margin: 0,
                  }}
                >
                  Take or choose a photo of your customer
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <button
                    onClick={() => captureRef.current?.click()}
                    style={{
                      minHeight: "48px",
                      background: "#1B1B2F",
                      color: "#C9A84C",
                      border: "none",
                      borderRadius: "12px",
                      fontSize: "14px",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    📷 Capture
                  </button>
                  <button
                    onClick={() => galleryRef.current?.click()}
                    style={{
                      minHeight: "48px",
                      background: "var(--white)",
                      color: "var(--text-primary)",
                      border: "0.5px solid var(--border)",
                      borderRadius: "12px",
                      fontSize: "14px",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    🖼 Gallery
                  </button>
                </div>
                <input
                  ref={captureRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFileSelect(f);
                  }}
                />
                <input
                  ref={galleryRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFileSelect(f);
                  }}
                />
              </div>
            )}

            {previewUrl && (
              <>
                <div style={{ position: "relative" }}>
                  <img
                    src={previewUrl}
                    alt="Customer photo"
                    style={{
                      width: "100%",
                      borderRadius: "16px",
                      border: "0.5px solid var(--border)",
                      display: "block",
                    }}
                  />
                  <button
                    onClick={() => {
                      setCustomerPhoto(null);
                      setPreviewUrl(null);
                    }}
                    style={{
                      position: "absolute",
                      top: "10px",
                      right: "10px",
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      background: "#1B1B2F",
                      border: "2px solid white",
                      color: "#C9A84C",
                      fontSize: "16px",
                      fontWeight: 700,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>

                {error && (
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
                    {error}
                  </p>
                )}

                <button
                  onClick={handleGenerate}
                  disabled={busy}
                  style={{
                    width: "100%",
                    minHeight: "52px",
                    background: "#1B1B2F",
                    color: "#C9A84C",
                    border: "none",
                    borderRadius: "14px",
                    fontSize: "15px",
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    opacity: busy ? 0.7 : 1,
                  }}
                >
                  {busy ? "Fitting..." : "Generate Preview"}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
