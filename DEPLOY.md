# Manual deploy checklist (frontend)

Render static site: **Ai-Vastra-ReactJS-Demo-2.2-Codex** — deploys from the `production` branch, Auto-Deploy OFF.

## 1. Before you start
- If this release needs backend changes, deploy the backend first (see the backend repo's DEPLOY.md). Order: database → backend + worker → frontend.
- Add any new `VITE_*` env vars in Render (Environment) first — they are baked in at build time.

## 2. Merge main into production (PowerShell)
Replace `YYYY-MM-DD` with today's date.

```powershell
git checkout main
git pull
git status
git checkout production
git pull
git branch backup-prod-YYYY-MM-DD
git push origin backup-prod-YYYY-MM-DD
git merge main
git push
git checkout main
```

## 3. Deploy
- Render → "Ai-Vastra-ReactJS-Demo-2.2-Codex" → Manual Deploy → **Deploy latest commit**.
- Wait until the status is **Live**.

## 4. Check
- Log in to the demo shop.
- Open Browse.
- Generate one look.
- Open https://screen.mytryonai.in.

## 5. If broken
- Render → Events → **Rollback** to the previous deploy.
