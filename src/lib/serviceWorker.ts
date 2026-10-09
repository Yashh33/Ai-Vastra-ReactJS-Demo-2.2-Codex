// Service worker set-up. The phone app uses one for its offline app shell; the TV
// screen (/screen/*) must not have one at all - it needs no offline mode, and a
// service worker in front of its image requests left thumbnails hanging on old
// Android WebViews.

const RELOAD_FLAG = "screenServiceWorkerRemoved";
// Runtime cache of an earlier service worker version. Nothing writes to it any more.
const OLD_IMAGE_CACHE = "supabase-images";

function isScreenRoute() {
  return window.location.pathname.startsWith("/screen/");
}

async function removeServiceWorkerFromScreen() {
  const wasControlled = !!navigator.serviceWorker.controller;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  // An unregistered worker keeps serving the page it already controls, so reload
  // once to get out from under it. The flag stops this from ever looping.
  if (!wasControlled) return;
  try {
    if (window.sessionStorage.getItem(RELOAD_FLAG) === "1") return;
    window.sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    return;
  }
  window.location.reload();
}

export function setUpServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  if ("caches" in window) {
    void caches.delete(OLD_IMAGE_CACHE).catch(() => undefined);
  }

  if (isScreenRoute()) {
    removeServiceWorkerFromScreen().catch((err) => {
      console.warn("serviceWorker: could not remove the service worker from the TV screen", err);
    });
    return;
  }

  // Only the production build ships /sw.js.
  if (!import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("serviceWorker: registration failed", err);
    });
  });
}
