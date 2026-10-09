import { debugLog } from "./debugLog";
import { supabase } from "./supabase";

const DEFAULT_TTL_SECONDS = 3600;
// A cached signed URL is handed out again until this close to its expiry.
const SIGNED_URL_REUSE_MARGIN_MS = 5 * 60 * 1000;
const MAX_PRELOADED_IMAGES = 12;

type StorageBucket = "hero-images" | "fabric-images" | "generated-outputs" | "shop-logos";

/**
 * Thumbnail path for a look's output path. Must stay identical to the backend's
 * look_thumbnail_path (image_thumbs.py):
 *   "shop/gen/output.png"       -> "shop/gen/thumb.jpg"
 *   "shop/gen/output_v123.webp" -> "shop/gen/thumb_v123.jpg"
 *   "shop/gen/other.png"        -> "shop/gen/thumb_other.jpg"
 */
export function lookThumbnailPathFor(outputPath: string) {
  const slash = outputPath.lastIndexOf("/");
  const directory = slash === -1 ? "" : outputPath.slice(0, slash);
  const filename = slash === -1 ? outputPath : outputPath.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const name = dot === -1 ? filename : filename.slice(0, dot);
  const thumbName = name.startsWith("output") ? `thumb${name.slice("output".length)}` : `thumb_${name}`;
  return directory ? `${directory}/${thumbName}.jpg` : `${thumbName}.jpg`;
}

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
const pendingSignBatches = new Map<string, { paths: Set<string>; promise: Promise<Record<string, string>> }>();

function signedCacheKey(bucket: StorageBucket, path: string) {
  return `${bucket}/${path}`;
}

/** A still-valid signed URL from the in-memory cache, without a network call. */
export function getCachedSignedUrl(bucket: StorageBucket, path: string) {
  const cached = signedUrlCache.get(signedCacheKey(bucket, path));
  return cached && cached.expiresAt - Date.now() > SIGNED_URL_REUSE_MARGIN_MS ? cached.url : null;
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
      const { data, error } = await supabase.storage.from(bucket).createSignedUrls(Array.from(batchPaths), ttlSeconds);
      if (error) throw new Error(error.message);

      const expiresAt = Date.now() + ttlSeconds * 1000;
      const signed: Record<string, string> = {};
      for (const item of data ?? []) {
        // A path whose file does not exist (e.g. a look without a thumbnail) comes back without a URL.
        if (!item.path || !item.signedUrl) continue;
        signed[item.path] = item.signedUrl;
        signedUrlCache.set(signedCacheKey(bucket, item.path), { url: item.signedUrl, expiresAt });
      }
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
 * the signed-in app alike.
 */
export async function signUrlsBatch(
  bucket: StorageBucket,
  paths: string[],
  ttlSeconds = DEFAULT_TTL_SECONDS,
  options: { bypassCache?: boolean } = {}
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const toSign: string[] = [];
  for (const path of new Set(paths)) {
    if (!path) continue;
    const cached = options.bypassCache ? null : getCachedSignedUrl(bucket, path);
    if (cached) result[path] = cached;
    else toSign.push(path);
  }
  if (!toSign.length) return result;

  const signed = await requestSignedUrls(bucket, toSign, ttlSeconds);
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
export async function preloadSignedImages(bucket: StorageBucket, paths: string[], ttlSeconds = DEFAULT_TTL_SECONDS) {
  try {
    const urls = await signUrlsBatch(bucket, paths, ttlSeconds);
    await Promise.all(Object.values(urls).map((url) => preloadImage(url)));
  } catch (err) {
    console.warn("storage: failed to preload images", err);
  }
}

export async function createSignedUrl(
  bucket: StorageBucket,
  path: string,
  expiresInSeconds = DEFAULT_TTL_SECONDS
) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);

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
  file: File
) {
  debugLog(`upload start ${bucket} ${file.type || "(no type)"}`);
  const { error } = await supabase.storage.from(bucket).upload(storagePath, file, {
    contentType: file.type || "image/jpeg",
    upsert: false
  });

  if (error) {
    debugLog(`upload FAIL ${error.message}`);
    throw new Error(error.message);
  }
  debugLog("upload OK");
}
