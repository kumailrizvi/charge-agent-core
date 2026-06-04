# Charge resume route patch

This patch fixes the current Vercel error:

`Upload failed: Unknown API route: /api/resume`

It adds support for:

- `GET /api/debug/env`
- `GET /api/state`
- `POST /api/state`
- `POST /api/resume`
- `POST /api/upload-resume`
- `POST /api/upload`

It stores uploaded resume files in the private Supabase Storage bucket named `resumes`, and saves app state in the `charge_state` table.

## Install

Copy the files into your project root:

```bash
cp -R charge_resume_route_patch/api .
cp -R charge_resume_route_patch/supabase .
```

Run the SQL in Supabase SQL Editor:

```sql
-- supabase/charge_schema.sql
```

Push to GitHub:

```bash
git add .
git commit -m "Fix resume API route on Vercel"
git push
```
