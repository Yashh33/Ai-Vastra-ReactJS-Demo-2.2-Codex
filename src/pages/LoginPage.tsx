import { FormEvent, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";

type AuthMode = "login" | "signup";

export function LoginPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState<AuthMode>("login");
  const [shopName, setShopName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <main className="auth-screen">
      <div className="login-hero">
        <div
          style={{
            fontSize: "12px",
            color: "rgba(201,168,76,0.5)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            lineHeight: 1
          }}
        >
          Powered by
        </div>
        <div className="login-wordmark">AI VASTRA</div>
        <div className="login-tagline">Craft Your Collection</div>
        <div className="login-divider" />
      </div>
      <div className="login-sheet">
        <h2>Welcome back</h2>

        <form className="stack-sm" onSubmit={onSubmit}>
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

          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Please wait..." : mode === "login" ? "Login" : "Create Shop Account"}
          </button>
        </form>

        <p className="tiny muted" style={{ textAlign: "center" }}>
          Shop account access only
        </p>
      </div>
    </main>
  );
}
