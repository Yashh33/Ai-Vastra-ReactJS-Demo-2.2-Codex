import { createClient } from "@supabase/supabase-js";

import { APP_ENV } from "./env";

export const supabase = createClient(APP_ENV.supabaseUrl, APP_ENV.supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
});
