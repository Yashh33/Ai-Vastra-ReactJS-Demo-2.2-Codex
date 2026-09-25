import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { useMe } from "../lib/queries";
import {
  loadRazorpayCheckoutScript,
  openRazorpayCheckout,
  useCreateCreditOrder,
  useRefreshCreditsAfterPayment
} from "../lib/payments";
import { supabase } from "../lib/supabase";

const STARTER_PACK_ID = "starter";

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

function CarouselIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m10 9 5 3-5 3z" />
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
  const [buyCreditsBusy, setBuyCreditsBusy] = useState(false);
  const [buyCreditsMessage, setBuyCreditsMessage] = useState<string | null>(null);

  const { data: me, isError: meError } = useMe();
  const createOrder = useCreateCreditOrder();
  const refreshCreditsAfterPayment = useRefreshCreditsAfterPayment();

  const shopHeaderText = meError ? "" : (me?.header_display_text || me?.shop_name || "").trim();
  const creditBalance = meError ? "?" : formatCredits(me?.credits_balance);

  const activeTab =
    location.pathname === "/" || location.pathname === "/generate"
      ? "generate"
      : location.pathname === "/browse"
        ? "browse"
        : location.pathname === "/carousel"
          ? "carousel"
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

  const handleBuyCredits = async () => {
    if (buyCreditsBusy) return;
    setBuyCreditsBusy(true);
    setBuyCreditsMessage(null);
    try {
      const order = await createOrder.mutateAsync(STARTER_PACK_ID);
      await loadRazorpayCheckoutScript();
      openRazorpayCheckout({
        order,
        onSuccess: () => {
          setBuyCreditsMessage("Payment received! Credits add ho rahe hain...");
          refreshCreditsAfterPayment();
          setBuyCreditsBusy(false);
          setTimeout(() => setBuyCreditsMessage(null), 12000);
        },
        onDismiss: () => {
          setBuyCreditsBusy(false);
        },
        onFailure: (description) => {
          setBuyCreditsMessage(description);
          setBuyCreditsBusy(false);
          setTimeout(() => setBuyCreditsMessage(null), 6000);
        }
      });
    } catch (err) {
      setBuyCreditsMessage(err instanceof Error ? err.message : "Could not start payment. Please try again.");
      setBuyCreditsBusy(false);
      setTimeout(() => setBuyCreditsMessage(null), 6000);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <div className="app-brand">
          <span className="app-wordmark" aria-label="MyTryonAi">
            <span className="app-wordmark-primary">MyTryon</span>
            <span className="app-wordmark-accent">Ai</span>
          </span>
          {shopHeaderText ? <span className="app-brand-shop">{shopHeaderText}</span> : null}
        </div>
        <div className="row">
          <span className="credits-chip">{creditBalance} credits</span>
          <button
            className="buy-credits-btn"
            type="button"
            onClick={() => void handleBuyCredits()}
            disabled={buyCreditsBusy}
          >
            {buyCreditsBusy ? "Starting..." : "Buy 5 looks - Rs.70"}
          </button>
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

      {buyCreditsMessage ? <div className="buy-credits-toast">{buyCreditsMessage}</div> : null}

      <div className="app-shell-content">
        <Outlet />
      </div>

      <nav className="app-bottom-nav" aria-label="Primary navigation">
        <button
          className={`nav-tab ${activeTab === "generate" ? "active" : ""}`}
          type="button"
          onClick={() => navigate("/generate")}
        >
          <ScissorsIcon />
          <span>Generate</span>
          {activeTab === "generate" ? <span className="nav-dot" /> : null}
        </button>
        <button
          className={`nav-tab ${activeTab === "browse" ? "active" : ""}`}
          type="button"
          onClick={() => navigate("/browse")}
        >
          <GridIcon />
          <span>Browse</span>
          {activeTab === "browse" ? <span className="nav-dot" /> : null}
        </button>
        <button
          className={`nav-tab ${activeTab === "carousel" ? "active" : ""}`}
          type="button"
          onClick={() => navigate("/carousel")}
        >
          <CarouselIcon />
          <span>Carousel</span>
          {activeTab === "carousel" ? <span className="nav-dot" /> : null}
        </button>
      </nav>
    </div>
  );
}
