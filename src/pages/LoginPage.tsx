import { FormEvent, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { APP_ENV } from "../lib/env";
import { supabase } from "../lib/supabase";

type AuthMode = "login" | "signup";

export function LoginPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState<AuthMode>("login");
  const [shopName, setShopName] = useState("");
  const [email, setEmail] = useState(APP_ENV.demoEmail);
  const [password, setPassword] = useState(APP_ENV.demoPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  useEffect(() => {
    if (!loading && session) {
      const from = (location.state as { from?: string } | null)?.from || "/";
      navigate(from, { replace: true });
    }
  }, [loading, session, navigate, location.state]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }

    if (mode === "signup" && !shopName.trim()) {
      setError("Shop name is required for signup.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password
        });

        if (signInError) {
          throw signInError;
        }

        navigate("/", { replace: true });
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            shop_name: shopName.trim()
          }
        }
      });

      if (signUpError) {
        throw signUpError;
      }

      if (data.session) {
        navigate("/", { replace: true });
        return;
      }

      setMode("login");
      setNotice("Signup successful. Login to continue.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen auth-screen">
      <section className="auth-card">
        <h1>Ai Vastra</h1>
        <p className="muted">Shop account access</p>

        <div className="auth-mode-row" role="tablist" aria-label="Auth mode">
          <button
            className={`auth-mode-btn ${mode === "login" ? "auth-mode-btn-active" : ""}`}
            type="button"
            onClick={() => setMode("login")}
            disabled={busy}
            aria-pressed={mode === "login"}
          >
            Login
          </button>
          <button
            className={`auth-mode-btn ${mode === "signup" ? "auth-mode-btn-active" : ""}`}
            type="button"
            onClick={() => setMode("signup")}
            disabled={busy}
            aria-pressed={mode === "signup"}
          >
            Signup
          </button>
        </div>

        <form className="stack-md" onSubmit={onSubmit}>
          {mode === "signup" ? (
            <label className="field">
              <span>Shop Name</span>
              <input
                type="text"
                autoComplete="organization"
                value={shopName}
                onChange={(event) => setShopName(event.target.value)}
                placeholder="e.g. Yash Tailors"
                disabled={busy}
              />
            </label>
          ) : null}

          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="shop@example.com"
              disabled={busy}
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
              disabled={busy}
            />
          </label>

          {notice ? <p className="tiny notice-text">{notice}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}

          <button className="btn btn-dark" type="submit" disabled={busy}>
            {busy ? "Please wait..." : mode === "login" ? "Login" : "Create Shop Account"}
          </button>
        </form>

        <p className="tiny muted">
          {mode === "login"
            ? "Use the shop account email/password."
            : "Signup creates a shop automatically (via Supabase DB trigger)."}
        </p>

        <p className="tiny muted">
          Configure default login prefill in <code>.env</code> via
          <code> VITE_DEMO_EMAIL </code> and <code> VITE_DEMO_PASSWORD</code>.
        </p>
      </section>
    </main>
  );
}
