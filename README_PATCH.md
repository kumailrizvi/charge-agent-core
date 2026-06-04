# Charge signup 500 fix

This patch makes the Vercel API handler safer for POST requests by supporting both raw streams and Vercel-parsed `req.body`.

Files:
- api/[...path].js
- supabase/charge_schema.sql

After copying, run the SQL in Supabase SQL Editor, then redeploy on Vercel.

Test:
- /api/health
- /api/debug/env
- /api/state
