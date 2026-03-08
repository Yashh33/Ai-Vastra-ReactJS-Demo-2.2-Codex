# Ai Vastra Web Demo

Demo-ready React web app that reuses the existing Ai Vastra FastAPI + Supabase backend contract from the mobile system.

## Stack Choice

- `Vite + React + TypeScript + React Router`
- `@supabase/supabase-js` for auth/session + storage upload + signed URLs
- Web Match Color uses:
  - in-browser prominent color extraction (from canvas image data)
  - live H/S/L preview on canvas while moving sliders
  - backend save via `POST /generations/{id}/match-color`

This stack is chosen specifically to support real-time, mobile-friendly Match Color behavior in browser.

## Implemented Pages

1. Login (demo login only)
2. Home (fixed order cards: Visualize, Hero Image, Output History)
3. Hero Folders
4. Hero Folder Detail (image grid, upload, picker mode)
5. Visualize
6. Output History (tiles + quick download + carousel entry)
7. Output Viewer (separate page)
8. Match Color (separate page)
9. Carousel

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Required:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_BASE_URL` (FastAPI base URL, no trailing slash needed)

Optional demo prefill:

- `VITE_DEMO_EMAIL`
- `VITE_DEMO_PASSWORD`

## Local Run

```bash
npm install
npm run dev
```

Open:

- `http://localhost:5173`

Production build:

```bash
npm run build
npm run preview
```

## Backend Contract Reuse

Frontend reuses these backend APIs without redesign:

- `/health`, `/me`
- `/folders` (create/list/update used, no delete UI in V1)
- `/hero-images` and `/fabric-images`
- `/generations` create/list/detail
- `/generations/{id}/download-url`
- `/generations/{id}/match-color`

Supabase auth/session token is sent as:

- `Authorization: Bearer <supabase_access_token>`

## CORS Patch Needed In Backend

If browser calls fail with CORS, patch your real FastAPI backend `main.py`:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        # add your deployed web origin(s)
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Note:
- keep your existing backend as the single source of truth.
- avoid maintaining a duplicate backend unless you intentionally fork server behavior.

## Demo Seed Flow

1. Login
2. Home -> `Visualize`
3. Select Hero Image (via folder picker)
4. Upload fabric image
5. Generate and wait for polling completion
6. Output Viewer opens
7. Open Match Color, edit swatches with live preview, save
8. Back to Output Viewer
9. Open Output History and refresh to confirm updated output

## Mobile/Desktop Behavior

- Mobile-first UI tuned for iPhone 12 Pro Max width (`428px`)
- Touch targets use ~44px minimum sizing
- Desktop layouts expand with responsive grids

## Important Project Note

- Reference files under `references/mobile-backend/...` were used as behavior/API reference only.
- No reference files are modified.
