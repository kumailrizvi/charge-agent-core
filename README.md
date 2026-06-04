# Charge Agent Core — persistence/edit fixes

Run:

```bash
npm install --omit=optional
npm run dev
```

Open http://localhost:8787

This build fixes:
- logout button
- resume upload stored state + visible uploaded filename
- master resume editable and saved for future applications
- application resume/cover letter editable and saved to the application packet
- application form fields editable and saved before approval/submit
- job posting HTML entity cleanup
- local ATS account/email/password table remains available

Notes:
- PDF text extraction uses local `pdftotext` when installed. The file is stored either way.
- Browser auto-apply still depends on supported ATS forms and Chrome/Playwright availability.
