import { useEffect, useRef, useState, type CSSProperties } from "react";

import { getCachedLookImageUrls, signLookImageUrls, type LookImageUrls } from "../lib/storage";

type Props = {
  /** The look's output_path in generated-outputs. */
  outputPath: string;
  alt: string;
  /** Extra class on the wrapper; the page gives the wrapper its size. */
  className?: string;
  /** A sharp picture that is already downloaded (e.g. by the carousel); shown straight away. */
  sharpUrl?: string | null;
  /** Link to the original to use instead of signing it (e.g. the backend's download link). */
  originalUrl?: string | null;
  /** Called each time the sharp picture has loaded. */
  onSharpLoad?: () => void;
  /** Called when not even the original could be shown (after one automatic re-sign). */
  onError?: () => void;
  /** How long the sharp picture may take before it counts as failed. */
  timeoutMs?: number;
};

// Some old WebViews leave an image request hanging with neither onLoad nor onError.
const DEFAULT_TIMEOUT_MS = 30000;

type SignState = "pending" | "done" | "failed";

function hasEnough(urls: LookImageUrls, originalUrl: string | null | undefined) {
  return !!urls.view || (urls.viewMissing && (!!urls.original || !!originalUrl));
}

function unique(values: (string | null | undefined)[]) {
  const seen: string[] = [];
  for (const value of values) if (value && !seen.includes(value)) seen.push(value);
  return seen;
}

function LookImageInner({
  outputPath,
  alt,
  className,
  sharpUrl,
  originalUrl,
  onSharpLoad,
  onError,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: Props) {
  const [urls, setUrls] = useState<LookImageUrls>(() => getCachedLookImageUrls(outputPath));
  // Already known from earlier (e.g. the grid or a preload): no request at all.
  const [signState, setSignState] = useState<SignState>(() =>
    hasEnough(getCachedLookImageUrls(outputPath), originalUrl) ? "done" : "pending"
  );
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [sharpLoadedUrl, setSharpLoadedUrl] = useState<string | null>(null);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  /** The links were already signed again once (an expired link looks like a broken image). */
  const resignedRef = useRef(false);

  // Thumbnail, view copy and original links in ONE request.
  useEffect(() => {
    if (signState !== "pending") return;
    let cancelled = false;
    signLookImageUrls(outputPath, { includeOriginal: !originalUrl, bypassCache: resignedRef.current })
      .then((next) => {
        if (cancelled) return;
        setUrls((prev) => ({
          thumb: next.thumb ?? prev.thumb,
          view: next.view,
          original: next.original ?? prev.original,
          viewMissing: next.viewMissing
        }));
        setSignState("done");
      })
      .catch((err) => {
        console.warn("LookImage: failed to sign", outputPath, err);
        if (!cancelled) setSignState("failed");
      });
    return () => {
      cancelled = true;
    };
    // originalUrl only decides whether the original is signed too; a change alone needs no new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signState, outputPath]);

  // The sharp picture is chosen only once it is known whether a view copy exists,
  // so the heavy original is never downloaded when a light copy is there.
  const ready = signState !== "pending" || !!sharpUrl;
  const candidates = ready ? unique([sharpUrl, urls.view, originalUrl ?? urls.original]) : [];
  const sharp = candidates.find((candidate) => !failedUrls.includes(candidate)) ?? null;
  const exhausted = ready && !sharp;
  const sharpLoaded = !!sharp && sharpLoadedUrl === sharp;

  useEffect(() => {
    if (!exhausted) return;
    if (!resignedRef.current) {
      resignedRef.current = true;
      setFailedUrls([]);
      setSignState("pending");
      return;
    }
    setGaveUp(true);
    onError?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exhausted]);

  useEffect(() => {
    if (sharp) setGaveUp(false);
  }, [sharp]);

  function failSharp(url: string) {
    setFailedUrls((prev) => (prev.includes(url) ? prev : [...prev, url]));
  }

  useEffect(() => {
    if (!sharp || sharpLoaded) return;
    const timer = window.setTimeout(() => failSharp(sharp), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [sharp, sharpLoaded, timeoutMs]);

  function markSharpLoaded(url: string, element: HTMLImageElement) {
    if (sharpLoadedUrl === url) return;
    if (element.naturalWidth && element.naturalHeight) setAspect(element.naturalWidth / element.naturalHeight);
    setSharpLoadedUrl(url);
    onSharpLoad?.();
  }

  const thumbUrl = !thumbFailed ? urls.thumb : null;
  const style = aspect ? ({ "--look-aspect": String(aspect) } as CSSProperties) : undefined;

  return (
    <span className={`look-image${className ? ` ${className}` : ""}`} style={style}>
      {!sharpLoaded && !thumbLoaded && !gaveUp ? (
        <span className="look-image-layer look-image-skeleton" aria-hidden="true" />
      ) : null}
      {gaveUp && !thumbLoaded ? (
        <span className="look-image-layer look-image-placeholder" role="img" aria-label={alt} />
      ) : null}
      {thumbUrl ? (
        <img
          className={`look-image-layer look-image-thumb${thumbLoaded ? " is-loaded" : ""}`}
          src={thumbUrl}
          alt=""
          aria-hidden="true"
          decoding="async"
          onLoad={(event) => {
            const element = event.currentTarget;
            if (!aspect && element.naturalWidth && element.naturalHeight) {
              setAspect(element.naturalWidth / element.naturalHeight);
            }
            setThumbLoaded(true);
          }}
          onError={() => setThumbFailed(true)}
        />
      ) : null}
      {sharp ? (
        <img
          key={sharp}
          ref={(element) => {
            // An image served from the browser cache can be complete before onLoad is attached.
            if (element?.complete && element.naturalWidth > 0) markSharpLoaded(sharp, element);
          }}
          className={`look-image-layer look-image-sharp${sharpLoaded ? " is-loaded" : ""}`}
          src={sharp}
          alt={alt}
          decoding="async"
          onLoad={(event) => markSharpLoaded(sharp, event.currentTarget)}
          onError={() => failSharp(sharp)}
        />
      ) : null}
    </span>
  );
}

/**
 * A look shown large. Shows its thumbnail at once (usually already downloaded
 * by the grid), then fades the sharp picture in over it once it has loaded:
 * the light "view" copy when the look has one, otherwise the original. A look
 * without either copy simply shows the original, as before. Display only:
 * download, share, try-on and Match colour keep using the original.
 */
export function LookImage(props: Props) {
  // A different look (or a new version after Match colour) starts from scratch.
  return <LookImageInner key={props.outputPath} {...props} />;
}
