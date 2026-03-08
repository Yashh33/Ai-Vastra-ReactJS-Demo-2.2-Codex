function inferExtensionFromPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const beforeHash = value.split("#")[0] ?? value;
  const clean = beforeHash.split("?")[0] ?? beforeHash;
  const lastSegment = clean.split("/").pop() || "";
  const dot = lastSegment.lastIndexOf(".");
  if (dot <= 0 || dot === lastSegment.length - 1) return null;
  const ext = lastSegment.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : null;
}

export function buildGenerationDownloadFilename(
  generationId: string,
  outputPath?: string | null,
  signedUrl?: string | null
) {
  const ext = inferExtensionFromPath(outputPath) || inferExtensionFromPath(signedUrl) || "jpg";
  return `ai-vastra-${generationId}.${ext}`;
}

export function triggerBrowserDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
