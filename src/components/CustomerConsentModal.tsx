import { useEffect } from "react";

type Props = {
  onConsent: () => void;
  onCancel: () => void;
};

export function CustomerConsentModal({ onConsent, onCancel }: Props) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "var(--white)",
          borderRadius: "20px 20px 0 0",
          padding: "24px 20px 36px",
          width: "100%",
          maxWidth: "480px",
          display: "grid",
          gap: "16px",
        }}
      >
        <div
          style={{
            width: "40px",
            height: "4px",
            borderRadius: "2px",
            background: "var(--border)",
            margin: "0 auto",
          }}
        />

        <div style={{ display: "grid", gap: "6px" }}>
          <h2
            style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "var(--navy)",
              margin: 0,
            }}
          >
            📷 Customer Photo Notice
          </h2>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-muted)",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            Before taking a photo, please make sure your customer understands
            the following:
          </p>
        </div>

        <div
          style={{
            background: "#F8F8F8",
            borderRadius: "12px",
            padding: "14px",
            display: "grid",
            gap: "10px",
          }}
        >
          {[
            "Photo is sent to an AI service to generate a preview",
            "Deleted immediately after the preview is created",
            "Never saved to our servers",
            "Used only for this single visualization",
          ].map((point, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
              }}
            >
              <span
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "50%",
                  background: "#1B1B2F",
                  color: "#C9A84C",
                  fontSize: "11px",
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: "1px",
                }}
              >
                ✓
              </span>
              <span
                style={{
                  fontSize: "13px",
                  color: "var(--text-primary)",
                  lineHeight: 1.4,
                }}
              >
                {point}
              </span>
            </div>
          ))}
        </div>

        <p
          style={{
            fontSize: "12px",
            color: "var(--text-muted)",
            margin: 0,
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          This preview is a visualization only and does not predict actual fit
          or appearance.
        </p>

        <div style={{ display: "grid", gap: "10px" }}>
          <button
            onClick={onConsent}
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
            }}
          >
            Customer Consents ✓
          </button>
          <button
            onClick={onCancel}
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
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
