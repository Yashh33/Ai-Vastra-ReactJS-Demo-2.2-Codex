import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import type { ShopContext } from "../lib/types";

type MeResponse = ShopContext & {
  shop_name?: string | null;
  header_display_text?: string | null;
  credits_balance?: number | null;
};

function formatCredits(value: number | null | undefined) {
  if (value === null || value === undefined) return "?";
  return String(value);
}

function ScissorsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function StackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5M12 2 2 7l10 5 10-5-10-5z" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
      <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 21c1.5-4 4.2-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function AppShell() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [shopHeaderText, setShopHeaderText] = useState("Ai Vastra");
  const [creditBalance, setCreditBalance] = useState("...");
  const [loggingOut, setLoggingOut] = useState(false);

  const activeTab =
    location.pathname === "/" || location.pathname === "/generate"
      ? "sew"
      : location.pathname === "/catalog"
        ? "lookbook"
        : location.pathname === "/fabric-silo"
          ? "fabrics"
          : "";

  useEffect(() => {
    let cancelled = false;

    async function loadShopHeaderText() {
      if (!accessToken) return;

      try {
        const me = await apiFetch<MeResponse>("/me", accessToken, { method: "GET" });
        if (cancelled) return;

        setCreditBalance(formatCredits(me.credits_balance));

        let nextText = (me.shop_name || "").trim();

        const withHeader = await supabase
          .from("shops")
          .select("name, header_display_text")
          .eq("id", me.shop_id)
          .limit(1)
          .maybeSingle();

        if (withHeader.error && withHeader.error.message.toLowerCase().includes("header_display_text")) {
          const fallback = await supabase
            .from("shops")
            .select("name")
            .eq("id", me.shop_id)
            .limit(1)
            .maybeSingle();

          const fallbackName = String(fallback.data?.name || "").trim();
          if (fallbackName) {
            nextText = fallbackName;
          }
        } else if (withHeader.data) {
          const headerText = String((withHeader.data as { header_display_text?: string | null }).header_display_text || "").trim();
          const shopName = String((withHeader.data as { name?: string | null }).name || "").trim();
          if (headerText) {
            nextText = headerText;
          } else if (shopName) {
            nextText = shopName;
          }
        }

        if (!nextText) {
          nextText = (me.email || "Ai Vastra").trim() || "Ai Vastra";
        }

        if (!cancelled) {
          setShopHeaderText(nextText);
        }
      } catch {
        if (!cancelled) {
          setShopHeaderText("Ai Vastra");
          setCreditBalance("?");
        }
      }
    }

    void loadShopHeaderText();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const handleLogout = async () => {
    const confirmed = window.confirm("Log out of this device?");
    if (!confirmed) return;
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore errors
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <span className="app-brand-text">{shopHeaderText}</span>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <span className="credits-chip">{creditBalance} credits</span>
          <button
            className="catalog-icon-btn"
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
            aria-label="Logout"
            title="Logout"
          >
            <PersonIcon />
          </button>
        </div>
      </header>

      <div className="app-shell-content">
        <Outlet />
      </div>

      <nav className="app-bottom-nav" aria-label="Primary navigation">
        <button
          className={`nav-tab ${activeTab === "sew" ? "active" : ""}`}
          type="button"
          onClick={() => navigate("/generate")}
        >
          <ScissorsIcon />
          <span>Sew</span>
          {activeTab === "sew" ? <span className="nav-dot" /> : null}
        </button>
        <button
          className={`nav-tab ${activeTab === "lookbook" ? "active" : ""}`}
          type="button"
          onClick={() => navigate("/catalog")}
        >
          <GridIcon />
          <span>Lookbook</span>
          {activeTab === "lookbook" ? <span className="nav-dot" /> : null}
        </button>
        <button
          className={`nav-tab ${activeTab === "fabrics" ? "active" : ""}`}
          type="button"
          onClick={() => navigate("/fabric-silo")}
        >
          <StackIcon />
          <span>My Fabrics</span>
          {activeTab === "fabrics" ? <span className="nav-dot" /> : null}
        </button>
      </nav>
    </div>
  );
}
