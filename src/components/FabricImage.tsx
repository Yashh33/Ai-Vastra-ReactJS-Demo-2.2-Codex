import { useEffect, useRef, useState, type CSSProperties } from "react";

import { fabricThumbnailPathFor, getCachedSignedUrl, signUrlsBatch } from "../lib/storage";

type Props = {
  /** The fabric photo's storage_path in fabric-images. */
  storagePath: string;
  alt: string;
  className?: string;
};

const BUCKET = "fabric-images";
// Some old WebViews leave an image request hanging with neither onLoad nor onError.
const LOAD_TIMEOUT_MS = 20000;
// Kept in the layout while loading: a lazy image that is display:none never starts loading.
const LOADING_STYLE: CSSProperties = { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" };

type Urls = { thumb: string | null; full: string | null };

function FabricImageInner({ storagePath, alt, className }: Props) {
  const thumbPath = fabricThumbnailPathFor(storagePath);
  const [urls, setUrls] = useState<Urls | null>(() => {
    const thumb = getCachedSignedUrl(BUCKET, thumbPath);
    return thumb ? { thumb, full: getCachedSignedUrl(BUCKET, storagePath) } : null;
  });
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  /** 0 = first try, 1 = links signed again (an expired link looks like a broken image). */
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // Small copy and full photo in one request; tiles mounting together share one batch.
  useEffect(() => {
    if (urls || gaveUp) return;
    let cancelled = false;
    signUrlsBatch(BUCKET, [thumbPath, storagePath], undefined, { bypassCache: attempt > 0 })
      .then((signed) => {
        if (!cancelled) setUrls({ thumb: signed[thumbPath] ?? null, full: signed[storagePath] ?? null });
      })
      .catch((err) => {
        console.warn("FabricImage: failed to sign", storagePath, err);
        if (cancelled) return;
        if (attempt === 0) setAttempt(1);
        else setGaveUp(true);
      });
    return () => {
      cancelled = true;
    };
  }, [urls, attempt, gaveUp, thumbPath, storagePath]);

  const current = urls ? [urls.thumb, urls.full].find((url) => url && !failedUrls.includes(url)) ?? null : null;
  // Nothing left to show: sign both links again once (this also fetches the full photo's
  // link when only the small copy's was cached), then give up.
  useEffect(() => {
    if (!urls || current) return;
    if (attempt === 0) {
      setFailedUrls([]);
      setUrls(null);
      setAttempt(1);
      return;
    }
    setGaveUp(true);
  }, [urls, current, attempt]);

  const loaded = !!current && loadedUrl === current;

  // Load timeout. A lazy image only starts loading near the viewport, so the clock
  // starts when it scrolls into view rather than when it is mounted.
  useEffect(() => {
    if (!current || loaded) return;
    const failing = current;
    let timer: number | undefined;
    let observer: IntersectionObserver | undefined;
    function startClock() {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        setFailedUrls((prev) => (prev.includes(failing) ? prev : [...prev, failing]));
      }, LOAD_TIMEOUT_MS);
    }
    const image = imageRef.current;
    if (image && typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          startClock();
          observer?.disconnect();
        }
      });
      observer.observe(image);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [current, loaded]);

  const extra = className ? ` ${className}` : "";
  if (gaveUp) return <span className={`signed-image-placeholder${extra}`} role="img" aria-label={alt} />;

  return (
    <>
      {!loaded ? <span className={`signed-image-skeleton${extra}`} aria-hidden="true" /> : null}
      {current ? (
        <img
          key={current}
          ref={(element) => {
            imageRef.current = element;
            if (element?.complete && element.naturalWidth > 0 && loadedUrl !== current) setLoadedUrl(current);
          }}
          className={className}
          src={current}
          alt={alt}
          loading="lazy"
          decoding="async"
          style={loaded ? undefined : LOADING_STYLE}
          onLoad={() => setLoadedUrl(current)}
          onError={() => setFailedUrls((prev) => (prev.includes(current) ? prev : [...prev, current]))}
        />
      ) : null}
    </>
  );
}

/**
 * A saved fabric's picture: its small copy, falling back to the full photo when
 * there is no small copy (yet) or it fails to load.
 */
export function FabricImage(props: Props) {
  return <FabricImageInner key={props.storagePath} {...props} />;
}
