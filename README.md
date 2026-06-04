# Charge Agent Core

Charge is an AI job application operator MVP: landing/sign-up, onboarding, resume upload, profile parsing, job crawling, application packets, tracker, inbox/channel scaffolds, and browser-worker auto-apply scaffolding.

## Local

```bash
npm install --omit=optional
npm run dev
```

Open http://localhost:8787

## Vercel

This build includes `api/[...path].js`, so `/api/state`, `/api/resume`, `/api/profile`, `/api/apply`, etc. work on Vercel.

Add env vars in Vercel Project Settings, not in GitHub:

```env
APP_URL=https://your-vercel-url.vercel.app
NODE_ENV=production
CHARGE_SHOW_BROWSER=0
CHARGE_AUTO_SUBMIT_TRUSTED=0
```

Note: Vercel serverless storage is temporary. For durable production data, connect Supabase tables/storage next.

## Git push

```bash
git add .
git commit -m "Update Charge app"
git push
```
