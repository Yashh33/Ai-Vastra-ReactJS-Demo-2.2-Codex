export function makeRandomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

export function guessFileExtension(filename?: string | null, mimeType?: string | null) {
  const fromName = filename?.split(".").pop()?.toLowerCase();
  const fromMime = mimeType?.split("/").pop()?.toLowerCase();
  const value = (fromName || fromMime || "jpg").replace(/[^a-z0-9]/g, "");
  return value || "jpg";
}

export function formatDateLabel(value?: string | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function isPendingStatus(status?: string | null) {
  return status === "queued" || status === "processing";
}

export function truncateText(value: string | null | undefined, max = 220) {
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}
