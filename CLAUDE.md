# AI Vastra React web app — working rules

This repo is the AI Vastra React web app. It also serves the TV screen at screen.mytryonai.in.
Live runs from the `production` branch on Render (static site "Ai-Vastra-ReactJS-Demo-2.2-Codex"), Auto-Deploy OFF. The owner deploys manually (see DEPLOY.md). A second developer also pushes to `main`.

## Branches and deploys
- Work only on `main`.
- Never checkout, merge into, or push to `production`.
- Never trigger a deploy (Render or otherwise).
- Never say a change is "live". Say: "pushed to main, goes live after merge + manual deploy".

## Git
- Run `git pull` before starting any task.
- Stage only the files you changed: `git add <path>`. Never `git add .` or `git add -A`.
- Never stage `*_latest*.txt` or other dump `.txt` files, or `.env`.
- Run `git status` before every commit.

## Data safety
- Local runs use the SAME live backend and Supabase as production.
- Test only with the demo shop (demo@gmail.com account). Never touch real shops' data.

## Backend compatibility
- This app must keep working with the CURRENTLY LIVE backend until the backend is deployed.
- Deploy order: database → backend + worker → frontend.
- If a change needs a new backend endpoint or field, say so clearly in the report, and make the UI handle its absence gracefully.

## Supabase (TV screen + Android TV app depend on these)
- Never change or remove these RPCs/tables: `resolve_shop_by_slug`, `get_shop_display_name`, `shop_screen_state`, `set_screen_mode`, `set_generation_hero`, `get_carousel_looks`, `get_browse_garment_types`, `get_browse_looks`, `get_browse_looks_page`.
- Any SQL change: add-only, in a new file `sql/YYYY-MM-DD_short_name.sql`. Do not run it — the owner runs it.

## Environment variables
- `VITE_*` variables are baked in at build time. Any new one must be added in Render BEFORE the deploy.
- Add every new name to `.env.example` (names only) and list it in the report.
- Never print or commit secret values.

## End-of-task report (always)
- Commits pushed to `main` (hashes)
- Database change: yes/no (and which `sql/` file)
- New env vars: yes/no (names)
- Backend must be deployed first: yes/no (what it needs)
- Anything the owner must do in Render / Supabase
