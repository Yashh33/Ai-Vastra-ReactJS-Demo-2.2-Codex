import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { useMe } from "../lib/queries";
import { supabase } from "../lib/supabase";

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
  const navigate = useNavigate();
  const location = useLocation();

  const [loggingOut, setLoggingOut] = useState(false);

  const { data: me, isError: meError } = useMe();

  const shopHeaderText = meError
    ? "Ai Vastra"
    : (me?.header_display_text || me?.shop_name || me?.email || "Ai Vastra").trim() || "Ai Vastra";
  const creditBalance = meError ? "?" : formatCredits(me?.credits_balance);

  const activeTab =
    location.pathname === "/" || location.pathname === "/generate"
      ? "sew"
      : location.pathname === "/catalog"
        ? "lookbook"
        : location.pathname === "/fabric-silo"
          ? "fabrics"
          : "";

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
