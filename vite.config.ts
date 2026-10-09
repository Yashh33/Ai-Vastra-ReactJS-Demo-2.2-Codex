import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Registered by src/lib/serviceWorker.ts instead, so the TV screen can stay without one.
      injectRegister: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webp,woff,woff2}"],
        // The HEIC converter is ~1.3 MB and only needed when a browser cannot decode
        // an iPhone HEIC photo itself; fetch it on demand instead of precaching it for everyone.
        globIgnores: ["**/heic2any-*.js"]
        // No runtimeCaching on purpose: Supabase storage images must go straight to the
        // network. Their signed URLs expire, so a cached copy is useless, and routing them
        // through the service worker left thumbnails hanging on old Android WebViews.
      }
    })
  ],
  server: {
    host: true,
    port: 5173
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          supabase: ["@supabase/supabase-js"]
        }
      }
    }
  }
});
