import { makeThumbnailJpeg } from "./compressImage";
import { debugLog } from "./debugLog";
import { supabase } from "./supabase";

const DEFAULT_TTL_SECONDS = 3600;
// Looks and fabric photos get long-lived links in the app, so the browser can reuse
// the pictures it already downloaded. The TV screen keeps the 1-hour default.
const LONG_TTL_SECONDS = 6 * 60 * 60;
// A cached signed URL is handed out again until this close to its expiry.
const SIGNED_URL_REUSE_MARGIN_MS = 5 * 60 * 1000;
const MAX_PRELOADED_IMAGES = 12;
// Saved signed links survive a reload / app reopen (never on the TV screen).
const PERSISTED_URLS_KEY = "aivastra-signed-urls-v1";
const MAX_PERSISTED_URLS = 800;
const PERSIST_DELAY_MS = 400;
// A light copy found missing is not asked for again for a while (the backend makes them gradually).
const MISSING_COPY_RETRY_MS = 10 * 60 * 1000;
// New fabric uploads have unique names, so they can be cached for a year.
const ONE_YEAR_CACHE_CONTROL = "31536000";
const FABRIC_THUMB_MAX_EDGE = 400;
const FABRIC_THUMB_QUALITY = 0.7;

type StorageBucket = "hero-images" | "fabric-images" | "generated-outputs" | "shop-logos";

/** The TV screen (/screen/...) keeps its original behaviour: 1-hour links, nothing saved. */
function isScreenRoute() {
  try {
    return window.location.pathname.startsWith("/screen");
  } catch {
    return false;
  }
}

function defaultTtlFor(bucket: StorageBucket) {
  if (isScreenRoute()) return DEFAULT_TTL_SECONDS;
  return bucket === "generated-outputs" || bucket === "fabric-images" ? LONG_TTL_SECONDS : DEFAULT_TTL_SECONDS;
}

function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash);
  const filename = slash === -1 ? path : path.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const name = dot === -1 ? filename : filename.slice(0, dot);
  return { directory, name };
}

/** Backend rule shared by the look thumbnail and the light "view" copy. */
function lookCopyPathFor(outputPath: string, prefix: "thumb" | "view") {
  const { directory, name } = splitPath(outputPath);
  const copyName = name.startsWith("output") ? `${prefix}${name.slice("output".length)}` : `${prefix}_${name}`;
  return directory ? `${directory}/${copyName}.jpg` : `${copyName}.jpg`;
}

/**
 * Thumbnail path for a look's output path. Must stay identical to the backend's
 * look_thumbnail_path (image_thumbs.py):
 *   "shop/gen/output.png"       -> "shop/gen/thumb.jpg"
 *   "shop/gen/output_v123.webp" -> "shop/gen/thumb_v123.jpg"
 *   "shop/gen/other.png"        -> "shop/gen/thumb_other.jpg"
 */
export function lookThumbnailPathFor(outputPath: string) {
  return lookCopyPathFor(outputPath, "thumb");
}

/**
 * Light display copy of a look, saved by the backend next to the original
 * (same rule as the thumbnail, with "view", always .jpg). Old looks may not have one yet:
 *   "shop/gen/output.png"       -> "shop/gen/view.jpg"
 *   "shop/gen/output_v123.webp" -> "shop/gen/view_v123.jpg"
 *   "shop/gen/other.png"        -> "shop/gen/view_other.jpg"
 */
export function lookViewPathFor(outputPath: string) {
  return lookCopyPathFor(outputPath, "view");
}

/** Small copy of a fabric photo, in the same folder: "shop/123-abc.jpg" -> "shop/123-abc_thumb.jpg". */
export function fabricThumbnailPathFor(storagePath: string) {
  const { directory, name } = splitPath(storagePath);
  return directory ? `${directory}/${name}_thumb.jpg` : `${name}_thumb.jpg`;
}

type CachedSignedUrl = { url: string; expiresAt: number };

const signedUrlCache = new Map<string, CachedSignedUrl>();
const pendingSignBatches = new Map<string, { paths: Set<string>; promise: Promise<Record<string, string>> }>();
// Light copies found missing, until when not to ask for them again (memory only).
const missingCopies = new Map<string, number>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function signedCacheKey(bucket: StorageBucket, path: string) {
  return `${bucket}/${path}`;
}

function isUsable(entry: CachedSignedUrl, now = Date.now()) {
  return entry.expiresAt - now > SIGNED_URL_REUSE_MARGIN_MS;
}

/** Restores the saved links (dropping expired ones) so a reopened app reuses the same picture URLs. */
function loadPersistedSignedUrls() {
  if (isScreenRoute()) return;
  try {
    const raw = window.localStorage.getItem(PERSISTED_URLS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    const entries: [string, CachedSignedUrl][] = [];
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length !== 3) continue;
      const [key, url, expiresAt] = item as unknown[];
      if (typeof key !== "string" || typeof url !== "string" || typeof expiresAt !== "number") continue;
      const entry = { url, expiresAt };
      if (isUsable(entry, now)) entries.push([key, entry]);
    }
    entries.sort((a, b) => b[1].expiresAt - a[1].expiresAt);
    for (const [key, entry] of entries.slice(0, MAX_PERSISTED_URLS)) {
      if (!signedUrlCache.has(key)) signedUrlCache.set(key, entry);
    }
  } catch {
    // Storage blocked or the saved list is damaged: start empty.
  }
}

function persistSignedUrlsNow() {
  persistTimer = undefined;
  if (isScreenRoute()) return;
  try {
    const now = Date.now();
    const entries = Array.from(signedUrlCache.entries())
      .filter(([, entry]) => isUsable(entry, now))
      .sort((a, b) => b[1].expiresAt - a[1].expiresAt)
      .slice(0, MAX_PERSISTED_URLS)
      .map(([key, entry]) => [key, entry.url, entry.expiresAt]);
    window.localStorage.setItem(PERSISTED_URLS_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or blocked: the in-memory cache still works.
  }
}

function schedulePersist() {
  if (isScreenRoute() || persistTimer !== undefined) return;
  persistTimer = setTimeout(persistSignedUrlsNow, PERSIST_DELAY_MS);
}

/** Forgets every saved link, in memory and in localStorage. Called on logout. */
export function clearSignedUrlCache() {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  // The TV screen's own in-memory links are left alone (it never saves any).
  if (!isScreenRoute()) {
    signedUrlCache.clear();
    missingCopies.clear();
  }
  try {
    window.localStorage.removeItem(PERSISTED_URLS_KEY);
  } catch {
    // ignore storage errors
  }
}

loadPersistedSignedUrls();
try {
  // Write a pending change before the page goes away.
  window.addEventListener("pagehide", () => {
    if (persistTimer === undefined) return;
    clearTimeout(persistTimer);
    persistSignedUrlsNow();
  });
} catch {
  // no window
}

/** A still-valid signed URL from the in-memory cache, without a network call. */
export function getCachedSignedUrl(bucket: StorageBucket, path: string) {
  const cached = signedUrlCache.get(signedCacheKey(bucket, path));
  return cached && isUsable(cached) ? cached.url : null;
}

// Everything asked for in the same tick (e.g. a grid of tiles mounting together)
// goes out as a single createSignedUrls call.
function requestSignedUrls(bucket: StorageBucket, paths: string[], ttlSeconds: number) {
  const batchKey = `${bucket}|${ttlSeconds}`;
  let batch = pendingSignBatches.get(batchKey);
  if (!batch) {
    const batchPaths = new Set<string>();
    const promise = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      pendingSignBatches.delete(batchKey);
      const startedAt = performance.now();
      const { data, error } = await supabase.storage.from(bucket).createSignedUrls(Array.from(batchPaths), ttlSeconds);
      const elapsed = `${Math.round(performance.now() - startedAt)}ms`;
      if (error) {
        debugLog(`signUrlsBatch ${batchPaths.size} paths -> FAIL ${elapsed} ${error.message}`);
        throw new Error(error.message);
      }
      debugLog(`signUrlsBatch ${batchPaths.size} paths -> OK ${elapsed}`);

      const expiresAt = Date.now() + ttlSeconds * 1000;
      const signed: Record<string, string> = {};
      for (const item of data ?? []) {
        // A path whose file does not exist (e.g. a look without a thumbnail) comes back without a URL.
        if (!item.path || !item.signedUrl) continue;
        signed[item.path] = item.signedUrl;
        signedUrlCache.set(signedCacheKey(bucket, item.path), { url: item.signedUrl, expiresAt });
      }
      schedulePersist();
      return signed;
    });
    batch = { paths: batchPaths, promise };
    pendingSignBatches.set(batchKey, batch);
  }
  for (const path of paths) batch.paths.add(path);
  return batch.promise;
}

/**
 * Signs many paths in one request and returns path -> signed URL. Paths that
 * could not be signed (missing file) are simply absent from the result.
 * Uses the shared supabase client, so it works for the anonymous TV screen and
 * the signed-in app alike. Without `ttlSeconds`, looks and fabric photos get
 * 6-hour links in the app (1 hour on the TV screen and for other buckets).
 */
export async function signUrlsBatch(
  bucket: StorageBucket,
  paths: string[],
  ttlSeconds?: number,
  options: { bypassCache?: boolean } = {}
): Promise<Record<string, string>> {
  const ttl = ttlSeconds ?? defaultTtlFor(bucket);
  const result: Record<string, string> = {};
  const toSign: string[] = [];
  for (const path of new Set(paths)) {
    if (!path) continue;
    const cached = options.bypassCache ? null : getCachedSignedUrl(bucket, path);
    if (cached) result[path] = cached;
    else toSign.push(path);
  }
  if (!toSign.length) return result;

  const signed = await requestSignedUrls(bucket, toSign, ttl);
  for (const path of toSign) {
    const url = signed[path];
    if (url) result[path] = url;
  }
  return result;
}

// Preloaded images stay referenced for a while so the browser can show them instantly.
const preloadedImages = new Map<string, { image: HTMLImageElement; loaded: Promise<boolean> }>();

/** Downloads an image ahead of time. Resolves true once it has loaded, false if it failed. */
export function preloadImage(url: string): Promise<boolean> {
  const existing = preloadedImages.get(url);
  if (existing) return existing.loaded;

  const image = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => {
      preloadedImages.delete(url);
      resolve(false);
    };
  });
  image.src = url;
  preloadedImages.set(url, { image, loaded });
  while (preloadedImages.size > MAX_PRELOADED_IMAGES) {
    const oldest = preloadedImages.keys().next().value;
    if (oldest === undefined) break;
    preloadedImages.delete(oldest);
  }
  return loaded;
}

/** Signs (in one batch) and preloads images the user is likely to look at next. Never throws. */
export async function preloadSignedImages(bucket: StorageBucket, paths: string[], ttlSeconds?: number) {
  try {
    const urls = await signUrlsBatch(bucket, paths, ttlSeconds);
    await Promise.all(Object.values(urls).map((url) => preloadImage(url)));
  } catch (err) {
    console.warn("storage: failed to preload images", err);
  }
}

export async function createSignedUrl(bucket: StorageBucket, path: string, expiresInSeconds?: number) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds ?? defaultTtlFor(bucket));

  if (error) {
    throw new Error(error.message);
  }

  const signed =
    (data as { signedUrl?: string; signedURL?: string } | null)?.signedUrl ??
    (data as { signedUrl?: string; signedURL?: string } | null)?.signedURL;

  if (!signed) {
    throw new Error("Signed URL response was empty");
  }

  return signed;
}

export async function uploadToStorage(
  bucket: "hero-images" | "fabric-images",
  storagePath: string,
  file: Blob,
  options: { cacheControl?: string; contentType?: string } = {}
) {
  const contentType = options.contentType || file.type || "image/jpeg";
  debugLog(`upload start ${bucket} ${file.type || "(no type)"}`);
  const { error } = await supabase.storage.from(bucket).upload(storagePath, file, {
    contentType,
    upsert: false,
    ...(options.cacheControl ? { cacheControl: options.cacheControl } : {})
  });

  if (error) {
    debugLog(`upload FAIL ${error.message}`);
    throw new Error(error.message);
  }
  debugLog("upload OK");
}

// ---- Fabric photos: the photo plus a small copy for lists and previews ----

/**
 * Uploads a fabric photo exactly as before and, in parallel, a small copy made
 * on the phone ("<path without extension>_thumb.jpg", longest edge 400 px) for
 * the fabric library and previews. Only the photo decides success: a failed
 * small copy is logged and ignored, and the app then shows the full photo.
 * Both get a one-year cache lifetime (their names are unique).
 */
export async function uploadFabricPhoto(storagePath: string, file: File) {
  const thumbPath = fabricThumbnailPathFor(storagePath);
  const thumbUpload = (async () => {
    try {
      const thumb = await makeThumbnailJpeg(file, FABRIC_THUMB_MAX_EDGE, FABRIC_THUMB_QUALITY);
      const { error } = await supabase.storage.from("fabric-images").upload(thumbPath, thumb, {
        contentType: "image/jpeg",
        upsert: false,
        cacheControl: ONE_YEAR_CACHE_CONTROL
      });
      if (error) throw new Error(error.message);
      debugLog("fabric small copy OK");
      return true;
    } catch (err) {
      console.warn("storage: fabric small copy failed (the full photo is shown instead)", err);
      debugLog(`fabric small copy FAIL ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  })();

  try {
    await uploadToStorage("fabric-images", storagePath, file, { cacheControl: ONE_YEAR_CACHE_CONTROL });
  } catch (err) {
    // Don't leave a small copy behind for a photo that was never saved.
    void thumbUpload.then((uploaded) => {
      if (!uploaded) return;
      supabase.storage
        .from("fabric-images")
        .remove([thumbPath])
        .catch(() => undefined);
    });
    throw err;
  }
}

/**
 * Display link for a saved fabric: its small copy, or the full photo when it has
 * no small copy (yet). Both links are asked for in one request. Null if neither.
 */
export async function signFabricPreviewUrl(storagePath: string): Promise<string | null> {
  try {
    const thumbPath = fabricThumbnailPathFor(storagePath);
    const urls = await signUrlsBatch("fabric-images", [thumbPath, storagePath]);
    return urls[thumbPath] ?? urls[storagePath] ?? null;
  } catch (err) {
    console.warn("storage: failed to sign fabric preview", err);
    return null;
  }
}

// ---- Looks: thumbnail first, then the light view copy (or the original) ----

function isKnownMissing(bucket: StorageBucket, path: string) {
  const key = signedCacheKey(bucket, path);
  const until = missingCopies.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  missingCopies.delete(key);
  return false;
}

function markMissing(bucket: StorageBucket, path: string) {
  missingCopies.set(signedCacheKey(bucket, path), Date.now() + MISSING_COPY_RETRY_MS);
}

export type LookImageUrls = {
  thumb: string | null;
  view: string | null;
  original: string | null;
  /** The view copy is known not to exist (yet), so the original is the sharp picture. */
  viewMissing: boolean;
};

/** Whatever is already known about a look's pictures, without a network call. */
export function getCachedLookImageUrls(outputPath: string): LookImageUrls {
  const bucket: StorageBucket = "generated-outputs";
  const viewPath = lookViewPathFor(outputPath);
  return {
    thumb: getCachedSignedUrl(bucket, lookThumbnailPathFor(outputPath)),
    view: getCachedSignedUrl(bucket, viewPath),
    original: getCachedSignedUrl(bucket, outputPath),
    viewMissing: isKnownMissing(bucket, viewPath)
  };
}

/**
 * Signs a look's thumbnail, view copy and (unless `includeOriginal` is false)
 * original in ONE request, so a missing view copy costs no extra wait.
 */
export async function signLookImageUrls(
  outputPath: string,
  options: { includeOriginal?: boolean; bypassCache?: boolean } = {}
): Promise<LookImageUrls> {
  const bucket: StorageBucket = "generated-outputs";
  const thumbPath = lookThumbnailPathFor(outputPath);
  const viewPath = lookViewPathFor(outputPath);
  const viewKnownMissing = !options.bypassCache && isKnownMissing(bucket, viewPath);
  const paths = [thumbPath];
  if (!viewKnownMissing) paths.push(viewPath);
  if (options.includeOriginal !== false) paths.push(outputPath);

  const urls = await signUrlsBatch(bucket, paths, undefined, { bypassCache: options.bypassCache });
  const view = viewKnownMissing ? null : urls[viewPath] ?? null;
  if (!view && !viewKnownMissing) markMissing(bucket, viewPath);
  return {
    thumb: urls[thumbPath] ?? null,
    view,
    original: urls[outputPath] ?? null,
    viewMissing: !view
  };
}

/**
 * Gets the looks the user is likely to open next ready: one request for all
 * their links, then downloads each look's view copy (or the original when it
 * has none, or its view copy fails to load). Never throws.
 */
export async function preloadLookImages(outputPaths: string[]) {
  try {
    const bucket: StorageBucket = "generated-outputs";
    const unique = Array.from(new Set(outputPaths.filter(Boolean)));
    if (!unique.length) return;
    const paths = unique.flatMap((outputPath) => {
      const viewPath = lookViewPathFor(outputPath);
      const own = [lookThumbnailPathFor(outputPath), outputPath];
      return isKnownMissing(bucket, viewPath) ? own : [...own, viewPath];
    });
    const urls = await signUrlsBatch(bucket, paths);
    await Promise.all(
      unique.map(async (outputPath) => {
        const viewPath = lookViewPathFor(outputPath);
        const viewUrl = urls[viewPath];
        if (!viewUrl && !isKnownMissing(bucket, viewPath)) markMissing(bucket, viewPath);
        const thumbUrl = urls[lookThumbnailPathFor(outputPath)];
        if (thumbUrl) void preloadImage(thumbUrl);
        if (viewUrl && (await preloadImage(viewUrl))) return;
        const originalUrl = urls[outputPath];
        if (originalUrl) await preloadImage(originalUrl);
      })
    );
  } catch (err) {
    console.warn("storage: failed to preload looks", err);
  }
}
