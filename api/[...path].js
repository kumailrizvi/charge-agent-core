/* Charge Vercel API catch-all
   Fixes: /api/resume, /api/state, /api/debug/env on Vercel without local filesystem.
   Uses Supabase REST + Storage directly so it works in serverless.
*/

const DEFAULT_STATE = {
  user: null,
  onboarding: { step: 0, done: false },
  profile: {
    name: "",
    email: "",
    applicationEmail: "",
    phone: "",
    linkedin: "",
    location: "",
    address: "",
    city: "",
    state: "",
    country: "",
    postalCode: "",
    summary: "",
    resumeText: "",
    resumeFileName: "",
    resumeFilePath: "",
    experiences: [],
    education: [],
    skills: [],
    projects: [],
    defaults: {
      workAuthorization: "",
      sponsorship: "",
      salary: "Open to market range",
      relocate: "No",
      remote: "Yes",
      start: "Immediately",
      dei: "Prefer not to answer",
      autoSubmit: false,
      tailoring: "light",
      coverMode: "light",
      applicationPassword: ""
    }
  },
  target: {
    roles: [],
    countries: [],
    cities: [],
    workplace: "remote",
    industries: ["fintech", "payments", "lending", "saas"]
  },
  jobs: [],
  applications: [],
  sources: [],
  messages: [],
  atsAccounts: [],
  logs: [],
  credits: 25,
  jobsCount: 0
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function getPath(req) {
  const url = new URL(req.url, `https://${req.headers.host || "charge.local"}`);
  return url.pathname.replace(/^\/api\/?/, "").replace(/^\/+/, "");
}

function getUserKey(req) {
  const fromHeader = req.headers["x-charge-user"] || req.headers["x-user-id"];
  return String(fromHeader || "default").slice(0, 120);
}

function env() {
  return {
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
    appUrl: process.env.APP_URL,
    nodeEnv: process.env.NODE_ENV
  };
}

function requireSupabase() {
  const e = env();
  if (!e.supabaseUrl || !e.serviceRole) {
    const missing = [];
    if (!e.supabaseUrl) missing.push("SUPABASE_URL");
    if (!e.serviceRole) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    const err = new Error(`Missing env vars: ${missing.join(", ")}`);
    err.statusCode = 500;
    throw err;
  }
  return e;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function supabaseFetch(path, options = {}) {
  const e = requireSupabase();
  const url = `${e.supabaseUrl}${path}`;
  const headers = {
    apikey: e.serviceRole,
    Authorization: `Bearer ${e.serviceRole}`,
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers });
}

async function getSavedState(userKey) {
  try {
    const r = await supabaseFetch(`/rest/v1/charge_state?user_key=eq.${encodeURIComponent(userKey)}&select=state&limit=1`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!r.ok) return structuredClone(DEFAULT_STATE);
    const rows = await r.json();
    return rows && rows[0] && rows[0].state ? { ...structuredClone(DEFAULT_STATE), ...rows[0].state } : structuredClone(DEFAULT_STATE);
  } catch (_) {
    return structuredClone(DEFAULT_STATE);
  }
}

async function saveState(userKey, state) {
  const payload = [{ user_key: userKey, state, updated_at: new Date().toISOString() }];
  const r = await supabaseFetch(`/rest/v1/charge_state?on_conflict=user_key`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Supabase state save failed: ${r.status} ${text}`);
  }
  return r.json().catch(() => []);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:(?:\")([^\"]+)(?:\")|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new Error("Upload must be multipart/form-data");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const headersText = buffer.slice(start, headerEnd).toString("utf8");
    let end = buffer.indexOf(boundary, headerEnd + 4);
    if (end === -1) break;
    let dataEnd = end;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const disposition = /content-disposition:[^\n]*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headersText);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headersText);
    if (disposition) {
      parts.push({
        name: disposition[1],
        filename: disposition[2] || "",
        contentType: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
        data: buffer.slice(headerEnd + 4, dataEnd)
      });
    }
    start = end;
  }
  return parts;
}

function basicResumeProfileFromText(text, filename) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const joined = lines.join("\n");
  const email = (joined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0];
  const phone = (joined.match(/(?:\+?\d[\d\s().-]{7,}\d)/) || [""])[0].trim();
  const linkedin = (joined.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i) || [""])[0];
  const name = lines[0] && lines[0].length < 80 ? lines[0] : "";
  const skills = [];
  const skillBank = [
    "Product Strategy", "Roadmapping", "User Research", "Fintech", "Payments", "Credit Cards", "Lending", "SaaS",
    "AI", "Automation", "API Integrations", "Stakeholder Management", "Agile", "Scrum", "Jira", "Figma",
    "Data Analytics", "SQL", "Python", "JavaScript", "TypeScript", "Risk", "Underwriting", "KYC", "AML"
  ];
  for (const s of skillBank) if (joined.toLowerCase().includes(s.toLowerCase())) skills.push(s);
  return {
    name,
    email,
    applicationEmail: email,
    phone,
    linkedin,
    summary: "Product-focused operator with experience shipping customer-facing workflows, managing stakeholders, and driving measurable product outcomes.",
    resumeText: joined.slice(0, 50000),
    resumeFileName: filename,
    skills: [...new Set(skills)].slice(0, 60)
  };
}

function pseudoPdfText(buffer, filename) {
  // Safe fallback: extracts visible ASCII-ish strings. It is not perfect PDF parsing,
  // but it prevents upload from failing on Vercel when native PDF tooling is unavailable.
  const raw = buffer.toString("latin1");
  const strings = raw.match(/[A-Za-z0-9@.,:;()&+/#'’\- ]{4,}/g) || [];
  const text = strings.join("\n").replace(/\s{2,}/g, " ").slice(0, 60000);
  return text || `Uploaded resume file: ${filename}`;
}

async function uploadResume(req, res) {
  try {
    const contentType = req.headers["content-type"] || "";
    const body = await readBody(req);
    const parts = parseMultipart(body, contentType);
    const file = parts.find((p) => p.filename) || parts.find((p) => p.name === "resume");
    if (!file || !file.data || !file.data.length) return json(res, 400, { ok: false, error: "No resume file found in upload" });

    const userKey = getUserKey(req);
    const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "resume.pdf";
    const storagePath = `${userKey}/${Date.now()}-${safeName}`;

    const up = await supabaseFetch(`/storage/v1/object/resumes/${encodeURIComponent(storagePath).replace(/%2F/g, "/")}`, {
      method: "POST",
      headers: {
        "content-type": file.contentType || "application/octet-stream",
        "x-upsert": "true"
      },
      body: file.data
    });
    if (!up.ok) {
      const t = await up.text().catch(() => "");
      return json(res, 500, { ok: false, error: `Supabase upload failed: ${up.status}`, detail: t.slice(0, 1000) });
    }

    let resumeText = "";
    const lower = safeName.toLowerCase();
    if (lower.endsWith(".txt")) resumeText = file.data.toString("utf8");
    else if (lower.endsWith(".pdf")) resumeText = pseudoPdfText(file.data, safeName);
    else if (lower.endsWith(".doc") || lower.endsWith(".docx")) resumeText = pseudoPdfText(file.data, safeName);
    else resumeText = pseudoPdfText(file.data, safeName);

    const extracted = basicResumeProfileFromText(resumeText, safeName);
    const current = await getSavedState(userKey);
    const next = {
      ...current,
      onboarding: { step: Math.max(current.onboarding?.step || 0, 1), done: false },
      profile: {
        ...current.profile,
        ...Object.fromEntries(Object.entries(extracted).filter(([, v]) => Array.isArray(v) ? v.length : Boolean(v))),
        resumeText,
        resumeFileName: safeName,
        resumeFilePath: storagePath
      },
      logs: [
        ...(current.logs || []),
        { at: new Date().toISOString(), type: "resume_upload", message: `Uploaded ${safeName}` }
      ].slice(-100)
    };
    await saveState(userKey, next);
    return json(res, 200, { ok: true, resumeFileName: safeName, resumeFilePath: storagePath, profile: next.profile, state: next });
  } catch (err) {
    return json(res, err.statusCode || 500, { ok: false, error: err.message || "Resume upload failed" });
  }
}

async function handler(req, res) {
  const path = getPath(req);
  try {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (path === "debug/env" && req.method === "GET") {
      const e = env();
      return json(res, 200, {
        ok: true,
        nodeEnv: e.nodeEnv || null,
        appUrl: e.appUrl || null,
        supabaseUrl: Boolean(e.supabaseUrl),
        anonKey: Boolean(e.anonKey),
        serviceRole: Boolean(e.serviceRole),
        bucketExpected: "resumes",
        routes: ["GET /api/state", "POST /api/state", "POST /api/resume", "POST /api/upload-resume", "POST /api/upload"]
      });
    }
    if (path === "state" && req.method === "GET") {
      const state = await getSavedState(getUserKey(req));
      return json(res, 200, state);
    }
    if (path === "state" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = body.length ? JSON.parse(body.toString("utf8")) : {};
      const current = await getSavedState(getUserKey(req));
      const next = { ...current, ...incoming };
      await saveState(getUserKey(req), next);
      return json(res, 200, { ok: true, state: next });
    }
    if (["resume", "upload-resume", "upload", "parse-resume"].includes(path) && req.method === "POST") {
      return uploadResume(req, res);
    }
    return json(res, 404, { ok: false, error: `Unknown API route: /api/${path}` });
  } catch (err) {
    return json(res, err.statusCode || 500, { ok: false, error: err.message || "API crashed" });
  }
}

module.exports = handler;
