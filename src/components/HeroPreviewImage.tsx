import { useEffect, useRef, useState } from "react";

type Props = {
  /** Small display version; preferred. */
  thumbUrl?: string | null;
  /** Full hero image; used when there is no thumbnail or it fails to load. */
  fullUrl?: string | null;
  alt: string;
  /** Called once when an image fails, so the caller can fetch fresh signed URLs. */
  onUrlsExpired: () => void;
};

/**
 * Hero preview on the Generate screen. Display only: what is sent for
 * generation is unaffected by which of the two URLs ends up on screen.
 */
export function HeroPreviewImage({ thumbUrl, fullUrl, alt, onUrlsExpired }: Props) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const refreshRequestedRef = useRef(false);

  const url = [thumbUrl, fullUrl].find((candidate) => candidate && !failedUrls.includes(candidate)) ?? null;

  // Freshly fetched URLs get one more refresh if they ever fail in turn.
  useEffect(() => {
    if (loadedUrl) refreshRequestedRef.current = false;
  }, [loadedUrl]);

  function handleError(failedUrl: string) {
    setFailedUrls((prev) => (prev.includes(failedUrl) ? prev : [...prev, failedUrl]));
    if (!refreshRequestedRef.current) {
      refreshRequestedRef.current = true;
      onUrlsExpired();
    }
  }

  if (!url) return <div className="model-preview-placeholder">No hero preview available</div>;

  const loaded = loadedUrl === url;
  return (
    <>
      {!loaded ? <span className="signed-image-skeleton model-preview-skeleton" aria-hidden="true" /> : null}
      <img
        key={url}
        className="model-preview-img"
        src={url}
        alt={alt}
        style={loaded ? undefined : { position: "absolute", width: 1, height: 1, opacity: 0 }}
        onLoad={() => setLoadedUrl(url)}
        onError={() => handleError(url)}
      />
    </>
  );
}
