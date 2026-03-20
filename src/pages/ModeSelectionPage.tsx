import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { ShopContext } from "../lib/types";

export function ModeSelectionPage() {
  const { accessToken, signOut } = useAuth();
  const navigate = useNavigate();

  const [shopContext, setShopContext] = useState<ShopContext | null>(null);
  const [statusText, setStatusText] = useState("Loading shop...");

  useEffect(() => {
    if (!accessToken) return;

    apiFetch<ShopContext>("/me", accessToken, { method: "GET" })
      .then((row) => {
        setShopContext(row);
        setStatusText("Select a mode to continue.");
      })
      .catch((err) => {
        setStatusText(`Failed to load shop: ${err instanceof Error ? err.message : "Unknown error"}`);
      });
  }, [accessToken]);

  async function handleLogout() {
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setStatusText(`Logout failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  return (
    <main className="screen">
      <section className="page-shell">
        <header className="hero-panel">
          <h1>Ai Vastra</h1>
          <p className="muted-light">Shop mode chooser</p>
          <p className="tiny muted-light">{statusText}</p>
          {shopContext?.email ? <p className="tiny muted-light">{shopContext.email}</p> : null}
        </header>

        <button className="mode-card mode-card-create" onClick={() => navigate("/create-looks")}>
          <strong>Create Looks</strong>
          <span>Staff workflow for visualize, hero images, and output history.</span>
        </button>

        <button className="mode-card mode-card-catalog" onClick={() => navigate("/catalog")}>
          <strong>Catalog</strong>
          <span>Customer-facing browsing by folder and generated outputs.</span>
        </button>

        <div className="row">
          <button className="btn btn-light flex-1" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </section>
    </main>
  );
}

