/**
 * Looks sewn on this phone that the shop has not seen yet (localStorage, per shop), so a
 * look in progress is not forgotten when Generate is left or the app goes to the back.
 * Only ids and times are kept. A look is forgotten once viewed, dismissed, shown as
 * failed, or 30 minutes old.
 */

export const PENDING_LOOK_MAX_AGE_MS = 30 * 60 * 1000;
const KEY_PREFIX = "aivastra-pending-looks-v1:";
const MAX_LOOKS = 20;

export type PendingLook = { id: string; createdAt: number };

function keyFor(shopId: string) {
  return `${KEY_PREFIX}${shopId}`;
}

function read(shopId: string): PendingLook[] {
  try {
    const raw = window.localStorage.getItem(keyFor(shopId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingLook =>
        !!item && typeof item.id === "string" && !!item.id && typeof item.createdAt === "number"
    );
  } catch {
    return [];
  }
}

function write(shopId: string, looks: PendingLook[]) {
  try {
    if (looks.length) window.localStorage.setItem(keyFor(shopId), JSON.stringify(looks));
    else window.localStorage.removeItem(keyFor(shopId));
  } catch {
    // storage full or blocked: the look still shows in Browse when ready
  }
}

/** Remembered looks younger than 30 minutes, newest first (older ones are dropped). */
export function listPendingLooks(shopId: string | null | undefined, now = Date.now()): PendingLook[] {
  if (!shopId) return [];
  const all = read(shopId);
  const fresh = all.filter((look) => now - look.createdAt < PENDING_LOOK_MAX_AGE_MS && look.createdAt <= now + 60_000);
  if (fresh.length !== all.length) write(shopId, fresh);
  return fresh.sort((a, b) => b.createdAt - a.createdAt);
}

export function rememberLook(shopId: string | null | undefined, id: string, createdAt = Date.now()) {
  if (!shopId || !id) return;
  const others = listPendingLooks(shopId, createdAt).filter((look) => look.id !== id);
  write(shopId, [{ id, createdAt }, ...others].slice(0, MAX_LOOKS));
}

export function forgetLook(shopId: string | null | undefined, id: string | null | undefined) {
  if (!shopId || !id) return;
  const all = read(shopId);
  const rest = all.filter((look) => look.id !== id);
  if (rest.length !== all.length) write(shopId, rest);
}

export function pendingLookCreatedAt(shopId: string | null | undefined, id: string): number | null {
  return listPendingLooks(shopId).find((look) => look.id === id)?.createdAt ?? null;
}
