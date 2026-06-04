# Charge Vercel API crash fix

Add these files to your project root:

- `api/[...path].js`
- `supabase/charge_schema.sql`

This patch avoids importing `server/index.js` in Vercel. Your Vercel API was crashing on `/api/state` and `/api/debug/env`; this file makes those routes self-contained.

## Supabase

1. Go to Supabase SQL Editor.
2. Paste and run `supabase/charge_schema.sql`.
3. Confirm Storage bucket `resumes` exists and is private.

## Vercel env vars

Set Production env vars:

```env
SUPABASE_URL=https://kgggjmdhlqtejjfajogb.supabase.co
SUPABASE_ANON_KEY=your_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_rotated_service_role_key
APP_URL=https://charge-agent-core.vercel.app
NODE_ENV=production
CHARGE_SHOW_BROWSER=0
CHARGE_AUTO_SUBMIT_TRUSTED=0
```

Do not commit `.env`.

## Test after deploy

- `https://charge-agent-core.vercel.app/api/debug/env`
- `https://charge-agent-core.vercel.app/api/state`

Both should return JSON, not a Vercel crash page.

## Git push

```bash
cd ~/Desktop/charge-agent-core

git add .
git commit -m "Fix Vercel API crash and resume upload route"
git push
```

If needed:

```bash
git push --set-upstream origin main
```
