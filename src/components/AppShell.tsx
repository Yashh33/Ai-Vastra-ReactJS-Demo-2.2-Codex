import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import type { ShopContext } from "../lib/types";

type MeResponse = ShopContext & {
  shop_name?: string | null;
  header_display_text?: string | null;
};

export function AppShell() {
  const { accessToken, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [shopHeaderText, setShopHeaderText] = useState("Ai Vastra");
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const menuRef = useRef<HTMLDivElement | null>(null);

  const backDisabled = location.pathname === "/";
  const showFabricOption = location.pathname === "/output-history";

  useEffect(() => {
    let cancelled = false;

    async function loadShopHeaderText() {
      if (!accessToken) return;

      try {
        const me = await apiFetch<MeResponse>("/me", accessToken, { method: "GET" });
        if (cancelled) return;

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
        }
      }
    }

    void loadShopHeaderText();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      setMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  function handleBack() {
    if (backDisabled) return;

    if (window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate("/", { replace: true });
  }

  function handleSwitchMode() {
    setMenuOpen(false);
    navigate("/");
  }

  function handleFabricFilters() {
    setMenuOpen(false);
    window.dispatchEvent(new CustomEvent("aivastra:toggle-fabric-filters"));
  }

  async function handleLogout() {
    const confirmed = window.confirm("Logout from this device?");
    if (!confirmed) return;

    setLoggingOut(true);
    setMenuOpen(false);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Logout failed");
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <button
          className="app-icon-btn"
          onClick={handleBack}
          disabled={backDisabled}
          aria-label="Back"
          title="Back"
        >
          <span aria-hidden>&larr;</span>
        </button>

        <div className="app-brand" aria-label={shopHeaderText}>
          <span className="app-brand-text">{shopHeaderText}</span>
        </div>

        <div className="app-menu-wrap" ref={menuRef}>
          <button
            className="app-menu-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-label="Menu"
            title="Menu"
          >
            <span aria-hidden>&#9776;</span>
          </button>

          {menuOpen ? (
            <div className="app-menu-popover" role="menu" aria-label="Header menu">
              <button className="app-menu-item" onClick={handleSwitchMode} role="menuitem">
                Home
              </button>
              {showFabricOption ? (
                <button className="app-menu-item" onClick={handleFabricFilters} role="menuitem">
                  Fabric Filters
                </button>
              ) : null}
              <button
                className="app-menu-item app-menu-item-danger"
                onClick={() => void handleLogout()}
                role="menuitem"
                disabled={loggingOut}
              >
                {loggingOut ? "Logging out..." : "Logout"}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="app-shell-content">
        <Outlet />
      </div>

      <footer className="app-shell-footer">
        <span>Powered by Ai Vastra</span>
      </footer>
    </div>
  );
}
