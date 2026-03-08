import { supabase } from "./supabase";

const DEFAULT_TTL_SECONDS = 3600;

export async function createSignedUrl(
  bucket: "hero-images" | "fabric-images" | "generated-outputs",
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
  const { error } = await supabase.storage.from(bucket).upload(storagePath, file, {
    contentType: file.type || "image/jpeg",
    upsert: false
  });

  if (error) {
    throw new Error(error.message);
  }
}
