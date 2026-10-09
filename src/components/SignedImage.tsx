import { useEffect, useState, type CSSProperties } from "react";

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
};

// primary -> primary re-signed (in case the URL expired) -> fallback -> placeholder
type Stage = "primary" | "primary-retry" | "fallback" | "failed";

// Kept in the layout while loading: a lazy image that is display:none never starts loading.
const LOADING_STYLE: CSSProperties = { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" };

function SignedImageInner({ bucket, path, fallbackPath, alt, className, eager }: Props) {
  const [stage, setStage] = useState<Stage>("primary");
  const [url, setUrl] = useState<string | null>(() => getCachedSignedUrl(bucket, path));
  const [loaded, setLoaded] = useState(false);

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
        if (signed) setUrl(signed);
        else setStage(afterMissing);
      })
      .catch((err) => {
        console.warn("SignedImage: failed to sign", target, err);
        if (!cancelled) setStage(afterFailure);
      });

    return () => {
      cancelled = true;
    };
    // `url` is left out on purpose: it only matters for skipping the first sign on a cache hit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, bucket, path, fallbackPath]);

  function handleError() {
    setUrl(null);
    setLoaded(false);
    setStage((current) =>
      current === "primary" ? "primary-retry" : current === "primary-retry" && fallbackPath ? "fallback" : "failed"
    );
  }

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
            // An image served from the browser cache can be complete before onLoad is attached.
            if (element?.complete && element.naturalWidth > 0) setLoaded(true);
          }}
          className={className}
          src={url}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          style={loaded ? undefined : LOADING_STYLE}
          onLoad={() => setLoaded(true)}
          onError={handleError}
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
