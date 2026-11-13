import { useEffect, useRef, useState } from "react";

import type { CarouselRow } from "./screenData";
import { preloadImage, preloadLookImages, signLookImageUrls, signUrlsBatch } from "./storage";

const BUCKET = "generated-outputs";
const PRELOAD_AHEAD = 2;
// Don't let one bad slide hold the screen for a full interval - hop past it quickly.
const BAD_SLIDE_DELAY_MS = 1500;

export type CarouselSlide = { id: string; url: string; index: number };

/** Signed URL of a slide's full image once it has finished downloading, or null if it cannot be shown. */
async function loadSlide(row: CarouselRow, ttlSeconds: number) {
  // Second attempt re-signs in case the cached URL has expired.
  for (const bypassCache of [false, true]) {
    try {
      const urls = await signUrlsBatch(BUCKET, [row.output_path], ttlSeconds, { bypassCache });
      const url = urls[row.output_path];
      if (url && (await preloadImage(url))) return url;
    } catch (err) {
      console.error("carousel: failed to sign slide", row.id, err);
    }
  }
  return null;
}

/**
 * Like loadSlide, but shows the look's light view copy when it has one (asked
 * for in the same request as the original), falling back to the original.
 * Uses the app's default link lifetime (6 hours), the same as the phone carousel asks for.
 */
async function loadSlidePreferView(row: CarouselRow) {
  for (const bypassCache of [false, true]) {
    try {
      const urls = await signLookImageUrls(row.output_path, { bypassCache });
      if (urls.view && (await preloadImage(urls.view))) return urls.view;
      if (urls.original && (await preloadImage(urls.original))) return urls.original;
    } catch (err) {
      console.error("carousel: failed to sign slide", row.id, err);
    }
  }
  return null;
}

export type CarouselSlidesOptions = {
  /** Show each look's light view copy when it has one (the phone app). Off by default (the TV). */
  preferView?: boolean;
};

/**
 * Drives the look carousel shared by the app and the TV. Shows each look's full
 * image for `intervalMs`, preloads the next two, and only moves on to a slide
 * whose image has already loaded - otherwise the current one stays a bit longer,
 * so there is never a blank frame between slides.
 */
export function useCarouselSlides(
  rows: CarouselRow[],
  active: boolean,
  intervalMs: number,
  ttlSeconds: number,
  options: CarouselSlidesOptions = {}
) {
  const preferView = !!options.preferView;
  const [slide, setSlide] = useState<CarouselSlide | null>(null);
  const indexRef = useRef(0);

  useEffect(() => {
    if (!active) {
      indexRef.current = 0;
      setSlide(null);
      return;
    }
    if (!rows.length) {
      setSlide(null);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const length = rows.length;

    function wait(ms: number) {
      return new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, ms);
      });
    }

    async function preloadAhead(index: number) {
      const paths: string[] = [];
      for (let step = 1; step <= Math.min(PRELOAD_AHEAD, length - 1); step++) {
        const row = rows[(index + step) % length];
        if (row) paths.push(row.output_path);
      }
      if (!paths.length) return;
      if (preferView) {
        if (!cancelled) await preloadLookImages(paths);
        return;
      }
      try {
        const urls = await signUrlsBatch(BUCKET, paths, ttlSeconds);
        if (!cancelled) Object.values(urls).forEach((url) => void preloadImage(url));
      } catch (err) {
        console.error("carousel: failed to preload upcoming slides", err);
      }
    }

    async function run() {
      let index = indexRef.current % length;
      while (!cancelled) {
        const row = rows[index];
        const url = row ? await (preferView ? loadSlidePreferView(row) : loadSlide(row, ttlSeconds)) : null;
        if (cancelled) return;

        if (!row || !url) {
          await wait(BAD_SLIDE_DELAY_MS);
          index = (index + 1) % length;
          continue;
        }

        const shownIndex = index;
        indexRef.current = shownIndex;
        setSlide((prev) =>
          prev && prev.id === row.id && prev.url === url && prev.index === shownIndex
            ? prev
            : { id: row.id, url, index: shownIndex }
        );
        void preloadAhead(shownIndex);

        if (length <= 1) return;
        await wait(intervalMs);
        index = (shownIndex + 1) % length;
      }
    }

    void run();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [rows, active, intervalMs, ttlSeconds, preferView]);

  return slide;
}
