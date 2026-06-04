/* Charge Vercel API catch-all: signup/login/logout/state/resume upload.
   Drop this file into: api/[...path].js
   Requires Vercel env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, APP_URL, NODE_ENV
*/

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const BUCKET = process.env.SUPABASE_RESUME_BUCKET || 'resumes';

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  Object.entries({ 'Content-Type': 'application/json', ...headers }).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body, null, 2));
}

function defaultState() {
  return {
    user: null,
    onboarding: { step: 0, done: false },
    profile: {
      name: '', email: '', applicationEmail: '', phone: '', linkedin: '', location: '', address: '', city: '', state: '', country: '', postalCode: '', summary: '', resumeText: '', resumeFileName: '', resumeFilePath: '',
      experiences: [], education: [], skills: [], projects: [],
      defaults: { workAuthorization: '', sponsorship: '', salary: 'Open to market range', relocate: 'No', remote: 'Yes', start: 'Immediately', dei: 'Prefer not to answer', autoSubmit: false, tailoring: 'light', coverMode: 'light', applicationPassword: '' }
    },
    target: { roles: [], countries: [], cities: [], workplace: 'remote', industries: ['fintech', 'payments', 'lending', 'saas'] },
    jobs: [], applications: [], sources: [], messages: [], atsAccounts: [], logs: [], credits: 25, jobsCount: 0
  };
}

function getPath(req) {
  try { return new URL(req.url, 'https://charge.local').pathname; } catch { return req.url.split('?')[0]; }
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const parts = header.split(';').map(x => x.trim());
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function setSessionCookie(res, sessionId) {
  res.setHeader('Set-Cookie', `charge_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'charge_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType || '');
  if (!match) return { fields: {}, files: [] };
  const boundary = '--' + (match[1] || match[2]);
  const raw = buffer.toString('binary');
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];
  for (const part of parts) {
    const cleaned = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const idx = cleaned.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const headerText = cleaned.slice(0, idx);
    const bodyBinary = cleaned.slice(idx + 4);
    const nameMatch = /name="([^"]+)"/.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const name = nameMatch ? nameMatch[1] : '';
    const body = Buffer.from(bodyBinary, 'binary');
    if (filenameMatch && filenameMatch[1]) {
      files.push({ field: name, filename: filenameMatch[1], contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream', buffer: body });
    } else if (name) {
      fields[name] = body.toString('utf8');
    }
  }
  return { fields, files };
}

function textFromUpload(file) {
  if (!file) return '';
  const lower = file.filename.toLowerCase();
  const raw = file.buffer.toString('utf8');
  if (lower.endsWith('.txt')) return raw;
  // Minimal PDF/DOC fallback. Production parser should use pdf-parse/docx parser in a background worker.
  const ascii = file.buffer.toString('latin1').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
  return ascii.replace(/\s+/g, ' ').slice(0, 20000);
}

function extractProfile(text, fileName) {
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];
  const phone = (text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || [''])[0];
  const linkedin = (text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i) || [''])[0];
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const possibleName = lines.find(l => l.length > 3 && l.length < 60 && !l.includes('@') && !/resume|curriculum|experience|education/i.test(l)) || '';
  const skillsSeed = ['Product Strategy','Roadmapping','Fintech','Payments','Lending','Credit Cards','User Research','Stakeholder Management','API Integrations','AI','SaaS','Analytics'].filter(s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
  return {
    name: possibleName,
    email,
    applicationEmail: email,
    phone,
    linkedin,
    resumeText: text,
    resumeFileName: fileName,
    skills: skillsSeed,
    summary: text ? 'Product-focused operator with experience building customer-facing workflows and measurable product outcomes.' : ''
  };
}

async function sb(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing Supabase env vars');
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function loadState(sessionId) {
  if (!sessionId) return defaultState();
  try {
    const rows = await sb(`/rest/v1/charge_state?session_id=eq.${encodeURIComponent(sessionId)}&select=state&limit=1`);
    if (Array.isArray(rows) && rows[0] && rows[0].state) return rows[0].state;
  } catch (err) {
    console.error('loadState failed', err.message);
  }
  return defaultState();
}

async function saveState(sessionId, state) {
  if (!sessionId) throw new Error('Missing session');
  await sb('/rest/v1/charge_state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ session_id: sessionId, state, updated_at: new Date().toISOString() })
  });
}

async function ensureSession(req, res) {
  let sessionId = getCookie(req, 'charge_session');
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    setSessionCookie(res, sessionId);
  }
  return sessionId;
}

async function handleSignup(req, res) {
  const payload = await readJson(req);
  const email = String(payload.email || payload.user?.email || '').trim();
  const name = String(payload.name || payload.fullName || payload.user?.name || '').trim();
  if (!email) return json(res, 400, { ok: false, error: 'Email is required.' });

  const sessionId = crypto.randomUUID();
  setSessionCookie(res, sessionId);
  const state = defaultState();
  state.user = { id: sessionId, email, name, createdAt: new Date().toISOString() };
  state.profile.email = email;
  state.profile.applicationEmail = email;
  state.profile.name = name;
  state.onboarding.step = 1;
  await saveState(sessionId, state);
  return json(res, 200, { ok: true, user: state.user, state });
}

async function handleLogin(req, res) {
  const payload = await readJson(req);
  const email = String(payload.email || '').trim();
  if (!email) return json(res, 400, { ok: false, error: 'Email is required.' });
  // MVP login: find a matching saved state by user email. Replace with Supabase Auth next.
  const rows = await sb(`/rest/v1/charge_state?select=session_id,state&state->user->>email=eq.${encodeURIComponent(email)}&limit=1`);
  if (!Array.isArray(rows) || !rows[0]) return json(res, 404, { ok: false, error: 'No Charge account found for this email.' });
  setSessionCookie(res, rows[0].session_id);
  return json(res, 200, { ok: true, user: rows[0].state.user, state: rows[0].state });
}

async function handleState(req, res) {
  const sessionId = await ensureSession(req, res);
  const state = await loadState(sessionId);
  return json(res, 200, state);
}

async function handleSaveState(req, res) {
  const sessionId = await ensureSession(req, res);
  const incoming = await readJson(req);
  const current = await loadState(sessionId);
  const merged = { ...current, ...incoming, profile: { ...current.profile, ...(incoming.profile || {}) }, onboarding: { ...current.onboarding, ...(incoming.onboarding || {}) } };
  if (!merged.user && merged.profile?.email) merged.user = { id: sessionId, email: merged.profile.email, name: merged.profile.name || '', createdAt: new Date().toISOString() };
  await saveState(sessionId, merged);
  return json(res, 200, { ok: true, state: merged });
}

async function handleResume(req, res) {
  const sessionId = await ensureSession(req, res);
  const raw = await readBody(req);
  const { fields, files } = parseMultipart(raw, req.headers['content-type']);
  const file = files[0];
  if (!file) return json(res, 400, { ok: false, error: 'No resume file received. Upload a PDF, DOC, DOCX, or TXT.' });

  const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${sessionId}/${Date.now()}-${safeName}`;
  await sb(`/storage/v1/object/${BUCKET}/${encodeURIComponent(storagePath).replace(/%2F/g, '/')}`, {
    method: 'POST',
    headers: { 'Content-Type': file.contentType, 'x-upsert': 'true' },
    body: file.buffer
  });

  const text = textFromUpload(file);
  const extracted = extractProfile(text, file.filename);
  const state = await loadState(sessionId);
  state.profile = { ...state.profile, ...extracted, resumeFilePath: storagePath };
  if (!state.profile.name && fields.name) state.profile.name = fields.name;
  if (!state.user && state.profile.email) state.user = { id: sessionId, email: state.profile.email, name: state.profile.name || '', createdAt: new Date().toISOString() };
  state.onboarding.step = Math.max(state.onboarding.step || 0, 1);
  state.logs = [...(state.logs || []), { at: new Date().toISOString(), type: 'resume_uploaded', fileName: file.filename }];
  await saveState(sessionId, state);

  return json(res, 200, { ok: true, fileName: file.filename, storagePath, extracted, state });
}

async function handleLogout(req, res) {
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}

module.exports = async function handler(req, res) {
  try {
    const path = getPath(req);
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

    if (path === '/api/debug/env') {
      return json(res, 200, {
        ok: true,
        nodeEnv: process.env.NODE_ENV || '',
        appUrl: process.env.APP_URL || '',
        supabaseUrl: Boolean(SUPABASE_URL),
        anonKey: Boolean(SUPABASE_ANON_KEY),
        serviceRole: Boolean(SUPABASE_SERVICE_ROLE_KEY),
        bucketExpected: BUCKET,
        routes: ['GET /api/state', 'POST /api/state', 'POST /api/signup', 'POST /api/login', 'POST /api/logout', 'POST /api/resume', 'POST /api/upload-resume', 'POST /api/upload']
      });
    }
    if (path === '/api/state' && req.method === 'GET') return handleState(req, res);
    if (path === '/api/state' && req.method === 'POST') return handleSaveState(req, res);
    if (path === '/api/signup' && req.method === 'POST') return handleSignup(req, res);
    if (path === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (path === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
    if ((path === '/api/resume' || path === '/api/upload-resume' || path === '/api/upload') && req.method === 'POST') return handleResume(req, res);

    return json(res, 404, { ok: false, error: `Unknown API route: ${path}` });
  } catch (error) {
    console.error('Charge API error:', error && error.stack ? error.stack : error);
    return json(res, 500, { ok: false, error: error.message || 'Server error' });
  }
};
