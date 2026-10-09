import { useEffect, useRef, useState, type CSSProperties } from "react";

import { debugImageInfo, debugLog, debugTileState, isDebugEnabled } from "../lib/debugLog";
import { getCachedSignedUrl, signUrlsBatch } from "../lib/storage";

type Bucket = Parameters<typeof signUrlsBatch>[0];

type Props = {
  bucket: Bucket;
  path: string;
  /** Tried when `path` cannot be shown, e.g. the full image behind a missing thumbnail. */
  fallbackPath?: string;
  alt: string;
  className?: string;
  /** Load straight away instead of when the image nears the viewport. */
  eager?: boolean;
  /** How long a load may take before it counts as failed. Give full-size images more than the default. */
  timeoutMs?: number;
  /** Names this image (a grid tile number) in the ?debug=1 diagnostics. No effect otherwise. */
  debugLabel?: string;
};

// primary -> primary re-signed (in case the URL expired) -> fallback -> placeholder
type Stage = "primary" | "primary-retry" | "fallback" | "failed";

// Some old WebViews leave an image request hanging with neither onLoad nor onError.
const DEFAULT_TIMEOUT_MS = 8000;
// The fallback is the full-size image, which legitimately takes longer on a slow connection.
const FULL_IMAGE_TIMEOUT_MS = 30000;

// Kept in the layout while loading: a lazy image that is display:none never starts loading.
const LOADING_STYLE: CSSProperties = { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" };

function SignedImageInner({
  bucket,
  path,
  fallbackPath,
  alt,
  className,
  eager,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  debugLabel
}: Props) {
  const [stage, setStage] = useState<Stage>("primary");
  const [url, setUrl] = useState<string | null>(() => getCachedSignedUrl(bucket, path));
  const [loaded, setLoaded] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // ?debug=1 diagnostics only; `debug` is null in normal use and nothing below it runs.
  const debug = debugLabel && isDebugEnabled() ? debugLabel : null;
  const stageStartedAtRef = useRef(performance.now());
  const reportedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!debug) return;
    debugLog(`${debug} image START`);
    debugTileState(debug, "loading");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    stageStartedAtRef.current = performance.now();
  }, [stage]);

  /** Logs how the current stage ended. `final` marks a failure with nothing left to try. */
  function report(ok: boolean, detail = "", final = false) {
    if (!debug || stage === "failed") return;
    const ms = `${Math.round(performance.now() - stageStartedAtRef.current)}ms`;
    const name = stage === "primary" ? "image" : stage === "primary-retry" ? "retry" : "fallback FULL";
    debugLog(`${debug} ${name} ${ok ? "OK" : "FAIL"} ${ms}${detail ? ` ${detail}` : ""}`);
    if (ok) debugTileState(debug, stage === "fallback" ? "fallback" : "loaded");
    else if (final) debugTileState(debug, "failed");
  }

  function markLoaded(loadedUrl: string) {
    // The ref callback and onLoad can both see the same image; report it once.
    if (reportedUrlRef.current !== loadedUrl) {
      reportedUrlRef.current = loadedUrl;
      report(true, debugImageInfo(loadedUrl));
    }
    setLoaded(true);
  }

  useEffect(() => {
    if (stage === "failed" || (stage === "primary" && url)) return;
    let cancelled = false;
    const target = stage === "fallback" ? fallbackPath : path;
    const afterFailure: Stage =
      stage === "primary" ? "primary-retry" : stage === "primary-retry" && fallbackPath ? "fallback" : "failed";
    // No signed URL means the file is not there, so re-signing the same path would not help.
    const afterMissing: Stage = stage !== "fallback" && fallbackPath ? "fallback" : "failed";

    if (!target) {
      setStage("failed");
      return;
    }

    signUrlsBatch(bucket, [target], undefined, { bypassCache: stage !== "primary" })
      .then((urls) => {
        if (cancelled) return;
        const signed = urls[target];
        if (signed) {
          setUrl(signed);
          return;
        }
        report(false, "no signed URL (file missing)", afterMissing === "failed");
        setStage(afterMissing);
      })
      .catch((err) => {
        console.warn("SignedImage: failed to sign", target, err);
        if (cancelled) return;
        report(false, `sign failed: ${err instanceof Error ? err.message : String(err)}`, afterFailure === "failed");
        setStage(afterFailure);
      });

    return () => {
      cancelled = true;
    };
    // `url` is left out on purpose: it only matters for skipping the first sign on a cache hit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, bucket, path, fallbackPath]);

  function handleFailure(reason: string) {
    const next: Stage =
      stage === "primary" ? "primary-retry" : stage === "primary-retry" && fallbackPath ? "fallback" : "failed";
    report(false, reason, next === "failed");
    setUrl(null);
    setLoaded(false);
    setStage(next);
  }

  // Load timeout. A lazy image only starts loading near the viewport, so its clock
  // starts when it scrolls into view rather than when it is mounted.
  useEffect(() => {
    if (!url || loaded || stage === "failed") return;
    const limit = stage === "fallback" ? Math.max(timeoutMs, FULL_IMAGE_TIMEOUT_MS) : timeoutMs;
    let timer: number | undefined;
    let observer: IntersectionObserver | undefined;

    function startClock() {
      if (timer === undefined) timer = window.setTimeout(() => handleFailure("TIMEOUT"), limit);
    }

    const image = imageRef.current;
    if (eager) {
      startClock();
    } else if (image && typeof IntersectionObserver === "function") {
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
    // handleFailure reads only `stage` and `fallbackPath`, which are covered below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, loaded, stage, eager, timeoutMs, fallbackPath]);

  if (stage === "failed") {
    return <span className="signed-image-placeholder" role="img" aria-label={alt} />;
  }

  return (
    <>
      {!loaded ? <span className="signed-image-skeleton" aria-hidden="true" /> : null}
      {url ? (
        <img
          key={url}
          ref={(element) => {
            imageRef.current = element;
            // An image served from the browser cache can be complete before onLoad is attached.
            if (element?.complete && element.naturalWidth > 0) markLoaded(url);
          }}
          className={className}
          src={url}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          style={loaded ? undefined : LOADING_STYLE}
          onLoad={() => markLoaded(url)}
          onError={() => handleFailure("image load error")}
        />
      ) : null}
    </>
  );
}

/**
 * An image from a private bucket. Signs its own URL (batched with the other
 * images mounting at the same time), shows a skeleton while loading, and heals
 * itself when the URL has expired or the file is missing.
 */
export function SignedImage(props: Props) {
  // A different image starts from scratch.
  return <SignedImageInner key={`${props.bucket}/${props.path}|${props.fallbackPath ?? ""}`} {...props} />;
}
