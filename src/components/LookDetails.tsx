// Product details card shown under a look in Browse (web app + TV). Empty rows are hidden,
// and nothing renders at all when a look has no details.

type LookDetailsProps = {
  barcode: string | null;
  mrp: number | null;
  description: string | null;
  // "tv" scales the type up so it reads from a distance on the portrait screen.
  variant?: "app" | "tv";
};

export function formatMrp(mrp: number): string {
  const hasPaise = Math.round(mrp * 100) % 100 !== 0;
  return `₹${mrp.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2
  })}`;
}

export function LookDetails({ barcode, mrp, description, variant = "app" }: LookDetailsProps) {
  const barcodeText = barcode?.trim() || null;
  const descriptionText = description?.trim() || null;
  const mrpValue = mrp !== null && Number.isFinite(mrp) ? mrp : null;

  if (!barcodeText && mrpValue === null && !descriptionText) return null;

  return (
    <div className={`mt-look-details${variant === "tv" ? " mt-look-details-tv" : ""}`}>
      <style>{`
        .mt-look-details {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 14px 16px;
          background: var(--mt-card, #FFFFFF);
          border: 1px solid var(--mt-border, #E6E4DE);
          border-radius: 14px;
          color: var(--mt-navy, #1B1B2F);
          text-align: left;
        }
        .mt-look-details-row { display: flex; align-items: baseline; gap: 12px; }
        .mt-look-details-label {
          flex-shrink: 0;
          width: 6.5em;
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--mt-muted, #6B6B72);
        }
        .mt-look-details-value { min-width: 0; font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
        .mt-look-details-mrp {
          font-size: 1.25rem;
          font-weight: 800;
          padding: 2px 12px;
          border-radius: 999px;
          background: var(--mt-gold, #C9A84C);
          color: var(--mt-navy, #1B1B2F);
        }
        .mt-look-details-description { font-weight: 500; line-height: 1.4; white-space: pre-wrap; }

        .mt-look-details-tv { gap: clamp(10px, 1.6vw, 20px); padding: clamp(16px, 2.4vw, 30px) clamp(18px, 3vw, 36px); border-radius: 18px; }
        .mt-look-details-tv .mt-look-details-row { gap: clamp(14px, 2.4vw, 28px); }
        .mt-look-details-tv .mt-look-details-label { font-size: clamp(0.95rem, 1.9vw, 1.5rem); }
        .mt-look-details-tv .mt-look-details-value { font-size: clamp(1.35rem, 3vw, 2.4rem); }
        .mt-look-details-tv .mt-look-details-mrp { font-size: clamp(1.7rem, 4vw, 3.2rem); padding: 4px clamp(14px, 2vw, 26px); }
        .mt-look-details-tv .mt-look-details-description {
          font-size: clamp(1.2rem, 2.6vw, 2.1rem);
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 6;
          overflow: hidden;
        }
      `}</style>
      {barcodeText ? (
        <div className="mt-look-details-row">
          <span className="mt-look-details-label">Barcode</span>
          <span className="mt-look-details-value">{barcodeText}</span>
        </div>
      ) : null}
      {mrpValue !== null ? (
        <div className="mt-look-details-row">
          <span className="mt-look-details-label">MRP</span>
          <span className="mt-look-details-value mt-look-details-mrp">{formatMrp(mrpValue)}</span>
        </div>
      ) : null}
      {descriptionText ? (
        <div className="mt-look-details-row">
          <span className="mt-look-details-label">Description</span>
          <span className="mt-look-details-value mt-look-details-description">{descriptionText}</span>
        </div>
      ) : null}
    </div>
  );
}
