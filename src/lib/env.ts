function requireEnv(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

export const APP_ENV = {
  supabaseUrl: requireEnv("VITE_SUPABASE_URL"),
  supabaseAnonKey: requireEnv("VITE_SUPABASE_ANON_KEY"),
  apiBaseUrl: requireEnv("VITE_API_BASE_URL").replace(/\/+$/, ""),
  demoEmail: (import.meta.env.VITE_DEMO_EMAIL ?? "").trim(),
  demoPassword: (import.meta.env.VITE_DEMO_PASSWORD ?? "").trim()
};
