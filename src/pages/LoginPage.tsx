import { FormEvent, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { APP_ENV } from "../lib/env";
import { supabase } from "../lib/supabase";

export function LoginPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState(APP_ENV.demoEmail);
  const [password, setPassword] = useState(APP_ENV.demoPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!loading && session) {
      const from = (location.state as { from?: string } | null)?.from || "/";
      navigate(from, { replace: true });
    }
  }, [loading, session, navigate, location.state]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }

    setBusy(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (signInError) {
        throw signInError;
      }

      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen auth-screen">
      <section className="auth-card">
        <h1>Ai Vastra</h1>
        <p className="muted">Demo login</p>

        <form className="stack-md" onSubmit={onSubmit}>
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

          {error ? <p className="error-text">{error}</p> : null}

          <button className="btn btn-dark" type="submit" disabled={busy}>
            {busy ? "Signing in..." : "Login"}
          </button>
        </form>

        <p className="tiny muted">
          Use a fixed demo account. Configure defaults in <code>.env</code> via
          <code> VITE_DEMO_EMAIL </code> and <code> VITE_DEMO_PASSWORD</code>.
        </p>
      </section>
    </main>
  );
}
