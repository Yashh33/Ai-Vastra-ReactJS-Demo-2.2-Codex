import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import type { ShopContext } from "../lib/types";

export function HomePage() {
  const { accessToken, signOut } = useAuth();
  const navigate = useNavigate();

  const [shopContext, setShopContext] = useState<ShopContext | null>(null);
  const [statusText, setStatusText] = useState("Loading shop...");

  useEffect(() => {
    if (!accessToken) return;
    apiFetch<ShopContext>("/me", accessToken, { method: "GET" })
      .then((row) => {
        setShopContext(row);
        setStatusText(`Shop ready - ${row.role}`);
      })
      .catch((err) => {
        setStatusText(`Failed to load shop context: ${err instanceof Error ? err.message : "Unknown error"}`);
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
          <h1>Create Looks</h1>
          <p className="muted-light">Shop account</p>
          <p className="tiny muted-light">{statusText}</p>
          <p className="tiny muted-light">{shopContext?.shop_id ? `Shop ID: ${shopContext.shop_id}` : ""}</p>
        </header>

        <button className="home-card home-card-visualize" onClick={() => navigate("/visualize")}>
          <span className="home-card-badge">1</span>
          <strong>Visualize</strong>
          <span>Select hero image and fabric, then generate output.</span>
        </button>

        <button className="home-card home-card-hero" onClick={() => navigate("/hero-folders")}>
          <span className="home-card-badge">2</span>
          <strong>Hero Image</strong>
          <span>Create folders and manage hero image library.</span>
        </button>

        <button className="home-card home-card-history" onClick={() => navigate("/output-history")}>
          <span className="home-card-badge">3</span>
          <strong>Output History</strong>
          <span>View output tiles, quick download, and carousel mode.</span>
        </button>

        <div className="row">
          <button className="btn btn-light flex-1" onClick={() => navigate("/")}>
            Switch Mode
          </button>
          <button className="btn btn-light flex-1" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </section>
    </main>
  );
}
