// Charge Vercel API crash fix
// Self-contained serverless API. Does NOT import server/index.js, so /api/state and /api/debug/env cannot crash from Express boot issues.

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

function send(res, status, data, extraHeaders = {}) {
  res.statusCode = status;
  Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  }).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
    });
    req.on("error", reject);
  });
}

function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) reject(new Error("Request body too large; max 25MB"));
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getCookie(req, key) {
  const cookie = req.headers.cookie || "";
  const found = cookie.split(";").map(x => x.trim()).find(x => x.startsWith(`${key}=`));
  return found ? decodeURIComponent(found.split("=").slice(1).join("=")) : "";
}

function getUserKey(req, body = {}) {
  return body.userKey || body.userId || getCookie(req, "charge_user") || "demo-user";
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function supabaseHeaders(service = true) {
  const key = service ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

async function supabaseFetch(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel env vars");
  const response = await fetch(`${url}${path}`, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Supabase ${response.status}: ${message}`);
  }
  return data;
}

async function loadState(userKey) {
  try {
    const rows = await supabaseFetch(`/rest/v1/charge_state?user_key=eq.${encodeURIComponent(userKey)}&select=state&limit=1`, {
      headers: supabaseHeaders(true)
    });
    if (Array.isArray(rows) && rows[0] && rows[0].state) return rows[0].state;
  } catch (err) {
    const s = cloneDefault();
    s.logs.push({ level: "warn", message: `State fallback: ${err.message}`, ts: new Date().toISOString() });
    return s;
  }
  return cloneDefault();
}

async function saveState(userKey, state) {
  try {
    await supabaseFetch(`/rest/v1/charge_state`, {
      method: "POST",
      headers: { ...supabaseHeaders(true), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_key: userKey, state, updated_at: new Date().toISOString() })
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("Missing multipart boundary");
  const boundary = `--${match[1] || match[2]}`;
  const raw = buffer.toString("binary");
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];

  for (const part of parts) {
    const cleaned = part.replace(/^\r\n/, "");
    const idx = cleaned.indexOf("\r\n\r\n");
    if (idx === -1) continue;
    const header = cleaned.slice(0, idx);
    let body = cleaned.slice(idx + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);

    const nameMatch = /name="([^"]+)"/i.exec(header);
    if (!nameMatch) continue;
    const filenameMatch = /filename="([^"]*)"/i.exec(header);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header);
    const name = nameMatch[1];

    if (filenameMatch && filenameMatch[1]) {
      files.push({
        field: name,
        filename: filenameMatch[1],
        contentType: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
        buffer: Buffer.from(body, "binary")
      });
    } else {
      fields[name] = Buffer.from(body, "binary").toString("utf8");
    }
  }
  return { fields, files };
}

function cleanName(filename) {
  return String(filename || "resume.bin").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extractBasicProfile(text, filename) {
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0];
  const phone = (text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/) || [""])[0];
  const linkedin = (text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[^\s)]+/i) || [""])[0];
  const firstUsefulLine = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean).find(line => line.length < 60 && !line.includes("@")) || "";
  const commonSkills = ["Product Strategy", "Roadmapping", "Payments", "Lending", "Credit Cards", "Fintech", "SaaS", "User Research", "API Integrations", "Data Analytics", "SQL", "Python", "Jira", "Figma"];
  const lower = text.toLowerCase();
  const skills = commonSkills.filter(skill => lower.includes(skill.toLowerCase()));
  return { name: firstUsefulLine, email, applicationEmail: email, phone, linkedin, skills, resumeFileName: filename };
}

async function uploadToSupabaseStorage(userKey, file) {
  const safe = cleanName(file.filename);
  const path = `${userKey}/${Date.now()}-${safe}`;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars on Vercel");

  const response = await fetch(`${url}/storage/v1/object/resumes/${path}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": file.contentType || "application/octet-stream",
      "x-upsert": "true"
    },
    body: file.buffer
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase Storage ${response.status}: ${text}`);
  return path;
}

async function handleUpload(req, res) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return send(res, 400, { ok: false, error: "Expected multipart/form-data upload" });
  }
  const buffer = await readBuffer(req);
  const { fields, files } = parseMultipart(buffer, contentType);
  const file = files[0];
  if (!file) return send(res, 400, { ok: false, error: "No resume file received" });
  if (file.buffer.length > 25 * 1024 * 1024) return send(res, 413, { ok: false, error: "Resume must be under 25MB" });

  const userKey = getUserKey(req, fields);
  const state = await loadState(userKey);
  const storagePath = await uploadToSupabaseStorage(userKey, file);

  let resumeText = "";
  const lowerName = file.filename.toLowerCase();
  if (lowerName.endsWith(".txt")) {
    resumeText = file.buffer.toString("utf8");
  } else {
    // Keep the upload working on Vercel without native PDF tools.
    // Real PDF/DOC parsing can be added later with a parser service or Supabase Edge worker.
    resumeText = state.profile.resumeText || "";
  }

  const parsed = extractBasicProfile(resumeText, file.filename);
  state.profile = {
    ...state.profile,
    ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => Array.isArray(v) ? v.length : Boolean(v))),
    resumeText,
    resumeFileName: file.filename,
    resumeFilePath: storagePath
  };
  state.onboarding.step = Math.max(state.onboarding.step || 0, 1);
  state.logs = state.logs || [];
  state.logs.unshift({ level: "info", message: `Resume uploaded: ${file.filename}`, ts: new Date().toISOString() });

  const saved = await saveState(userKey, state);
  return send(res, 200, { ok: true, saved, userKey, profile: state.profile, onboarding: state.onboarding, path: storagePath });
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const route = url.pathname.replace(/^\/api\/?/, "");

    if (req.method === "GET" && route === "debug/env") {
      return send(res, 200, {
        ok: true,
        nodeEnv: process.env.NODE_ENV || null,
        appUrl: process.env.APP_URL || null,
        supabaseUrl: Boolean(process.env.SUPABASE_URL),
        anonKey: Boolean(process.env.SUPABASE_ANON_KEY),
        serviceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        bucketExpected: "resumes"
      });
    }

    if (req.method === "GET" && route === "state") {
      const userKey = getUserKey(req);
      const state = await loadState(userKey);
      return send(res, 200, state, { "Set-Cookie": `charge_user=${encodeURIComponent(userKey)}; Path=/; SameSite=Lax; Secure` });
    }

    if (req.method === "POST" && route === "state") {
      const body = await readJson(req);
      const userKey = getUserKey(req, body);
      const state = { ...cloneDefault(), ...(body.state || body) };
      const saved = await saveState(userKey, state);
      return send(res, saved.ok ? 200 : 500, { ok: saved.ok, saved, state });
    }

    if (req.method === "POST" && ["upload", "upload-resume", "resume/upload", "profile/upload", "onboarding/upload"].includes(route)) {
      return await handleUpload(req, res);
    }

    if (req.method === "POST" && ["auth/signup", "signup", "auth/login", "login"].includes(route)) {
      const body = await readJson(req);
      const email = body.email || body.user?.email || "";
      const name = body.name || body.fullName || body.user?.name || "";
      const userKey = email || `demo-user`;
      const state = await loadState(userKey);
      state.user = { email, name, createdAt: new Date().toISOString() };
      state.profile.email = state.profile.email || email;
      state.profile.applicationEmail = state.profile.applicationEmail || email;
      state.profile.name = state.profile.name || name;
      await saveState(userKey, state);
      return send(res, 200, { ok: true, user: state.user, state }, { "Set-Cookie": `charge_user=${encodeURIComponent(userKey)}; Path=/; SameSite=Lax; Secure` });
    }

    return send(res, 404, { ok: false, error: `Unknown API route: /api/${route}` });
  } catch (err) {
    console.error("Charge API error", err);
    return send(res, 500, { ok: false, error: err.message || "Serverless function crashed" });
  }
};
