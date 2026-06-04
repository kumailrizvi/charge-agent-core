# Charge signup + resume route patch

Adds Vercel API routes:
- GET /api/debug/env
- GET /api/state
- POST /api/state
- POST /api/signup
- POST /api/login
- POST /api/logout
- POST /api/resume
- POST /api/upload-resume
- POST /api/upload

Drop `api/[...path].js` into the project root and run `supabase/charge_schema.sql` in Supabase SQL editor.
