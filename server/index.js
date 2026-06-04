
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env manually so local Supabase keys work without extra setup.
function loadEnvFile(){
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) { console.warn('Could not load .env:', e.message); }
}
loadEnvFile();
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  }
} catch (e) {
  console.warn('Supabase client not installed yet. Run npm install. Continuing with local storage.');
}
async function bestEffortSupabaseResumeSave({ state, fileName, fileBuffer, text }) {
  if (!supabase || !fileName || !fileBuffer) return { enabled:false, saved:false, reason:'Supabase not configured' };
  const email = state.profile?.email || state.profile?.applicationEmail || state.user?.email || 'local-user@charge.local';
  const safe = String(fileName).replace(/[^a-zA-Z0-9._-]/g,'_');
  const storagePath = `${email.replace(/[^a-zA-Z0-9._-]/g,'_')}/${Date.now()}-${safe}`;
  try {
    const upload = await supabase.storage.from('resumes').upload(storagePath, fileBuffer, { contentType: 'application/octet-stream', upsert: true });
    if (upload.error) throw upload.error;
    const profilePayload = {
      email,
      full_name: state.profile?.name || state.user?.name || '',
      phone: state.profile?.phone || '',
      linkedin: state.profile?.linkedin || '',
      location: state.profile?.location || '',
      application_email: state.profile?.applicationEmail || email,
      resume_file_path: storagePath,
      resume_file_name: safe,
      resume_text: text || state.profile?.resumeText || '',
      structured_profile: state.profile || {},
      updated_at: new Date().toISOString()
    };
    const upsert = await supabase.from('profiles').upsert(profilePayload, { onConflict: 'email' });
    if (upsert.error) throw upsert.error;
    return { enabled:true, saved:true, path:storagePath };
  } catch (e) {
    console.warn('Supabase resume save failed:', e.message || e);
    return { enabled:true, saved:false, reason:e.message || String(e) };
  }
}

const { execFile } = require('child_process');
const { runBrowserApply } = require('./browserWorker');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data', 'state.json');
const UPLOADS = path.join(ROOT, 'uploads');
const PORT = process.env.PORT || 8787;
const TRUSTED = ['greenhouse','lever','ashby','smartrecruiters','workable','recruitee','bamboohr','teamtailor','remoteok'];
const sourceIndex = [
  ['Stripe','greenhouse','stripe'], ['Affirm','greenhouse','affirm'], ['Brex','greenhouse','brex'], ['Robinhood','greenhouse','robinhood'],
  ['Coinbase','lever','coinbase'], ['Ramp','ashby','ramp'], ['Mercury','ashby','mercury'], ['Rippling','lever','rippling'],
  ['Wealthsimple','greenhouse','wealthsimple'], ['Koho','ashby','koho'], ['Jobber','greenhouse','jobber'], ['Float','greenhouse','float'],
  ['Nubank','greenhouse','nubank'], ['Wise','greenhouse','wise'], ['Klarna','lever','klarna'], ['Plaid','lever','plaid'],
  ['Shopify','smartrecruiters','Shopify'], ['Canva','greenhouse','canva'], ['Datadog','greenhouse','datadog'], ['Notion','greenhouse','notion'],
  ['OpenAI','ashby','openai'], ['Anthropic','greenhouse','anthropic'], ['Cursor','ashby','anysphere'], ['Linear','ashby','linear'],
  ['RemoteOK','remoteok','remoteok']
];
const emptyState = { user:null, onboarding:{step:0,done:false}, profile:{name:'',email:'',applicationEmail:'',phone:'',linkedin:'',location:'',address:'',city:'',state:'',country:'',postalCode:'',summary:'',resumeText:'',resumeFileName:'',resumeFilePath:'',experiences:[],education:[],skills:[],projects:[],defaults:{workAuthorization:'',sponsorship:'',salary:'Open to market range',relocate:'No',remote:'Yes',start:'Immediately',dei:'Prefer not to answer',autoSubmit:false,tailoring:'light',coverMode:'light',applicationPassword:''}}, target:{roles:[],countries:[],cities:[],workplace:'remote',industries:['fintech','payments','lending','saas']}, jobs:[], applications:[], sources:[], messages:[], atsAccounts:[], logs:[], credits:25 };
function readState(){ try { return {...structuredClone(emptyState), ...JSON.parse(fs.readFileSync(DATA,'utf8'))}; } catch { return structuredClone(emptyState); } }
function writeState(s){ fs.mkdirSync(path.dirname(DATA),{recursive:true}); fs.writeFileSync(DATA, JSON.stringify(s,null,2)); }
function publicState(s){ const copy=JSON.parse(JSON.stringify(s)); copy.jobsCount=(s.jobs||[]).length; copy.jobs=[]; return copy; }
function send(res, code, body, type='application/json'){ res.writeHead(code, {'content-type': type, 'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'}); res.end(type==='application/json'?JSON.stringify(body):body); }
function parseBody(req){ return new Promise(resolve=>{ let b=''; req.on('data',d=>{ b+=d; if(b.length>120e6) { console.warn('Large request body received:', b.length); } }); req.on('end',()=>{ try{ resolve(b?JSON.parse(b):{}); } catch{ resolve({ raw:b }); } }); }); }
function id(prefix='id'){ return prefix+'_'+crypto.randomBytes(6).toString('hex'); }
function decodeEntities(str=''){ return String(str).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'\"').replace(/&#039;|&apos;/g,"'").replace(/&nbsp;/g,' '); }
function textClean(s){ return decodeEntities(String(s||'')).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function tokenise(s){ return [...new Set(textClean(s).toLowerCase().split(/[^a-z0-9+#.]+/).filter(w=>w.length>2 && !['and','the','with','for','you','are','from','this','that','your','our','will','have','has'].includes(w)))]; }
function roughPdfText(file){ try { const raw=fs.readFileSync(file,'latin1'); const chunks=[]; const re=/\(([^()]|\\.|\n|\r){3,}\)/g; let m; while((m=re.exec(raw)) && chunks.length<6000){ let t=m[1].replace(/\\n/g,' ').replace(/\\r/g,' ').replace(/\\t/g,' ').replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\'); if(/[A-Za-z]{3}/.test(t)) chunks.push(t); } return chunks.join(' ').replace(/\s+/g,' ').trim(); } catch { return ''; } }
function extractPdf(file){ return new Promise(resolve=>{ execFile('pdftotext',['-layout',file,'-'],{timeout:20000,maxBuffer:8*1024*1024},(err,out)=>{ const text=String(out||'').trim(); if(text) return resolve(text); resolve(roughPdfText(file)); }); }); }
function parseResume(text, existing={}){
  const clean = String(text||'').replace(/\r/g,''); const lines=clean.split('\n').map(x=>x.trim()).filter(Boolean); const joined=lines.join('\n');
  const email=(joined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[])[0]||existing.email||'';
  const phone=(joined.match(/(?:\+?\d[\d\s().-]{8,}\d)/)||[])[0]?.replace(/\s+/g,' ')||existing.phone||'';
  const linkedin=(joined.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i)||[])[0]||existing.linkedin||'';
  const name = existing.name || (lines[0] && !lines[0].includes('@') && lines[0].length<60 ? lines[0] : '');
  const upper = lines.map((l,i)=>({l,i,u:l.toUpperCase()}));
  function section(names){ const start=upper.find(x=>names.some(n=>x.u.includes(n)))?.i; if(start==null) return ''; const end=upper.find(x=>x.i>start && ['EXPERIENCE','WORK EXPERIENCE','PROFESSIONAL EXPERIENCE','EDUCATION','SKILLS','PROJECTS','CERTIFICATIONS','SUMMARY'].some(n=>x.u===n || x.u.includes(n)))?.i || lines.length; return lines.slice(start+1,end).join('\n'); }
  const skillsText = section(['SKILLS','TECHNICAL SKILLS']); const skills = [...new Set((skillsText||'').split(/[,•|;\n]/).map(s=>s.trim()).filter(s=>s.length>1 && s.length<40))].slice(0,80);
  const eduText = section(['EDUCATION']); const education=[]; const eduLines=eduText.split('\n').filter(Boolean); for(let i=0;i<eduLines.length;i++){ if(/university|college|school|institute/i.test(eduLines[i])) education.push({school:eduLines[i], degree:eduLines[i+1]||'', start:'', end:''}); }
  const expText = section(['WORK EXPERIENCE','PROFESSIONAL EXPERIENCE','EXPERIENCE']); const experiences=[]; const expLines=expText.split('\n').filter(Boolean); let current=null;
  for(const l of expLines){ if((/\b(manager|product|analyst|consultant|engineer|founder|lead|owner|director|investor)\b/i.test(l) && l.length<140) || /\|/.test(l)){ if(current) experiences.push(current); const parts=l.split('|').map(x=>x.trim()); current={title:parts[1]||parts[0]||'Role', company:parts[0]&&parts[1]?parts[0]:'', start:'', end:'', location:'', description:''}; } else if(current){ current.description += (current.description?'\n':'')+l; } }
  if(current) experiences.push(current);
  const projectsText=section(['PROJECTS']); const projects=projectsText?[{name:'Project',description:projectsText.slice(0,1200)}]:[];
  return { name,email,phone,linkedin, resumeText:clean, skills:skills.length?skills:(existing.skills||[]), education:education.length?education:(existing.education||[]), experiences:experiences.length?experiences:(existing.experiences||[]), projects:projects.length?projects:(existing.projects||[]), summary: existing.summary || 'Product-focused operator with experience shipping customer-facing workflows, managing stakeholders, and driving measurable product outcomes.' };
}
function normalizeJob(raw){
  const title=raw.title||raw.text||raw.name||raw.jobTitle||'Untitled role'; const company=raw.company||raw.companyName||raw.org||raw.sourceCompany||'Unknown company';
  const location=raw.location||raw.locationName||raw.categories?.location||raw.workplace||'Remote'; const url=raw.absolute_url||raw.hostedUrl||raw.applyUrl||raw.url||raw.apply_url||raw.jobUrl||'';
  const desc=raw.content||raw.description||raw.descriptionPlain||raw.descriptionHtml||''; const ats=raw.ats||'custom';
  return { id: raw.id ? `${ats}_${String(raw.id).replace(/[^a-zA-Z0-9]/g,'')}` : id('job'), title, company, location, ats, url, applyUrl:url, description:textClean(desc).slice(0,12000), createdAt: raw.updated_at||raw.created_at||raw.createdAt||new Date().toISOString(), sourceSlug:raw.sourceSlug||'' };
}
async function crawlSource([company, ats, slug]){ const jobs=[]; try{
  if(ats==='greenhouse'){ const r=await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`); if(!r.ok)return[]; const j=await r.json(); for(const x of j.jobs||[]) jobs.push(normalizeJob({...x,company,ats,sourceSlug:slug,location:x.location?.name})); }
  else if(ats==='lever'){ const r=await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`); if(!r.ok)return[]; const arr=await r.json(); for(const x of arr||[]) jobs.push(normalizeJob({...x,company,ats,sourceSlug:slug,location:x.categories?.location,url:x.hostedUrl})); }
  else if(ats==='ashby'){ const r=await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`); if(!r.ok)return[]; const j=await r.json(); for(const x of j.jobs||[]) jobs.push(normalizeJob({...x,company,ats,sourceSlug:slug,location:x.location||'Remote',url:x.jobUrl||x.applyUrl})); }
  else if(ats==='smartrecruiters'){ const r=await fetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`); if(!r.ok)return[]; const j=await r.json(); for(const x of j.content||[]) jobs.push(normalizeJob({...x,company,ats,sourceSlug:slug,title:x.name,location:x.location?.city||x.location?.country||'Remote',url:x.ref})); }
  else if(ats==='remoteok'){ const r=await fetch('https://remoteok.com/api',{headers:{'user-agent':'ChargeBot/0.1'}}); if(!r.ok)return[]; const arr=await r.json(); for(const x of arr.slice(1,120)||[]) jobs.push(normalizeJob({...x,company:x.company||'RemoteOK',ats:'remoteok',sourceSlug:'remoteok',title:x.position,location:x.location||'Remote',url:x.url,description:x.description})); }
} catch(e) { return []; } return jobs; }
function scoreJob(job,state){ const target=state.target||{}, profile=state.profile||{}; const hay=tokenise(`${job.title} ${job.company} ${job.location} ${job.description}`); const resume=tokenise(`${profile.resumeText} ${(profile.skills||[]).join(' ')} ${(profile.experiences||[]).map(e=>JSON.stringify(e)).join(' ')}`); const roles=(target.roles||[]).flatMap(tokenise); const industries=(target.industries||[]).flatMap(tokenise); const countries=(target.countries||[]).map(x=>String(x).toLowerCase()); let score=32,reasons=[]; const roleHits=roles.filter(t=>hay.includes(t)); if(roleHits.length){score+=Math.min(28,roleHits.length*9);reasons.push(`role match: ${roleHits.slice(0,3).join(', ')}`)} const ind=industries.filter(t=>hay.includes(t)); if(ind.length){score+=Math.min(15,ind.length*5);reasons.push(`${ind.length} industry keywords`)} const resumeHits=resume.filter(t=>hay.includes(t)).slice(0,9); if(resumeHits.length){score+=Math.min(18,resumeHits.length*2);reasons.push(`${resumeHits.length} resume overlaps`)} const loc=String(job.location).toLowerCase(); if(countries.some(c=>loc.includes(c))||((target.workplace||'').includes('remote')&&loc.includes('remote'))){score+=14;reasons.push('location/workplace fit')} if(/intern|student|co[- ]?op/i.test(job.title)&&!roles.includes('intern')){score-=20;reasons.push('may be junior/internship')} return {score:Math.max(1,Math.min(95,Math.round(score))),reasons:reasons.length?reasons:['broad profile fit']}; }
function resumeDoc(profile, job){ const exp=(profile.experiences||[]).map(e=>`${e.company||''}${e.company?' | ':''}${e.title||''} ${e.start||''}${e.end?' - '+e.end:''}\n${e.description||''}`).join('\n\n'); const edu=(profile.education||[]).map(e=>`${e.school||''}\n${e.degree||''}`).join('\n'); return `${profile.name||'Applicant'}\n${profile.location||''} | ${profile.email||''} | ${profile.phone||''} | ${profile.linkedin||''}\n\nPROFESSIONAL SUMMARY\n${profile.summary||''}\n\nSKILLS\n${(profile.skills||[]).join(', ')}\n\nWORK EXPERIENCE\n${exp||'No structured experience added yet.'}\n\nEDUCATION\n${edu||'No education added yet.'}`; }
function generatePacket(job,state){ const p=state.profile||{}; const why=`${job.company} aligns with my target role and background. I can bring relevant experience across product execution, automation, stakeholder management, and customer-facing workflows.`; const resume=resumeDoc(p,job); const coverLetter=`Dear Hiring Manager,\n\nI am interested in the ${job.title} role at ${job.company}. Based on my background and the role requirements, I can bring relevant experience in product execution, workflow automation, cross-functional delivery, and customer-focused problem solving.\n\nI would be excited to contribute to ${job.company} and help the team ship high-impact work.\n\nSincerely,\n${p.name||'Applicant'}`; return {id:id('packet'),jobId:job.id,generatedAt:new Date().toISOString(),resumeText:resume,resumeFileName:p.resumeFileName||'',coverLetter,answers:{why,salary:p.defaults?.salary||'Open to market range',authorization:p.defaults?.workAuthorization||'',sponsorship:p.defaults?.sponsorship||'',start:p.defaults?.start||'Immediately',relocate:p.defaults?.relocate||'No'},profileSnapshot:p}; }
function categorizeMessage({subject='',body=''}){ const s=`${subject} ${body}`.toLowerCase(); const otp=(body.match(/\b\d{4,8}\b/)||[])[0]||''; let category='message'; if(/thank you for applying|application received|received your application/i.test(s)) category='confirmation'; else if(/verify|code|security/i.test(s)) category='verification'; else if(/interview|schedule/i.test(s)) category='interview'; else if(/unfortunately|not moving|rejection/i.test(s)) category='rejection'; else if(/offer/i.test(s)) category='offer'; return {category, otp}; }
async function runAutoCrawler(reason='auto'){ const state=readState(); state.logs.unshift({at:new Date().toISOString(),type:'crawler',message:`Crawler started (${reason})`}); const existing=new Map((state.jobs||[]).map(j=>[j.url||j.id,j])); let added=0; for(const src of sourceIndex){ const got=await crawlSource(src); if(got.length&&!state.sources.find(s=>s.ats===src[1]&&s.slug===src[2])) state.sources.push({id:id('src'),company:src[0],ats:src[1],slug:src[2],foundAt:new Date().toISOString()}); for(const job of got){const key=job.url||job.id; if(key&&!existing.has(key)){existing.set(key,job); added++;}} } state.jobs=[...existing.values()].slice(0,7000); state.logs.unshift({at:new Date().toISOString(),type:'crawler',message:`Crawler finished. Added ${added}. Total ${state.jobs.length}.`}); writeState(state); }
let crawling=false; async function ensureCrawler(reason){ if(crawling) return; crawling=true; try{await runAutoCrawler(reason);}finally{crawling=false;} }
function filterJobs(state,q){ let arr=(state.jobs||[]).map(j=>({...j,match:scoreJob(j,state)})); const search=String(q.search||'').toLowerCase(); if(search) arr=arr.filter(j=>`${j.title} ${j.company} ${j.location} ${j.ats}`.toLowerCase().includes(search)); if(q.role) arr=arr.filter(j=>String(j.title).toLowerCase().includes(String(q.role).toLowerCase())); if(q.location) arr=arr.filter(j=>String(j.location).toLowerCase().includes(String(q.location).toLowerCase())); if(q.ats) arr=arr.filter(j=>j.ats===q.ats); if(q.workplace==='remote') arr=arr.filter(j=>String(j.location).toLowerCase().includes('remote')); arr.sort((a,b)=>b.match.score-a.match.score); return arr; }
function runApplicationWorker(appId, opts={}){ let state=readState(); const app=(state.applications||[]).find(a=>a.id===appId); if(!app) return null; const job=(state.jobs||[]).find(j=>j.id===app.jobId)||{...app,title:app.role,company:app.company,applyUrl:app.url}; app.status='in_flight'; app.statusLabel='Applying'; app.logs=app.logs||[]; app.logs.unshift({at:new Date().toISOString(),message:'Background auto-apply worker started.'}); writeState(state); runBrowserApply({ application:app, job, profile:state.profile, packet:app.packet, forceSubmit:!!opts.forceSubmit, onLog:(m)=>{ const s=readState(); const a=s.applications.find(x=>x.id===appId); if(a){a.logs=a.logs||[];a.logs.unshift({at:new Date().toISOString(),message:m});writeState(s);} }, onFormFields:(fields)=>{ const s=readState(); const a=s.applications.find(x=>x.id===appId); if(a){a.formFields=fields;writeState(s);} }, onUpdate:async(status,reason)=>{ const s=readState(); const a=s.applications.find(x=>x.id===appId); if(a){ a.status=status; a.statusLabel=status==='submitted'?'Submitted':status==='needs_review'?'Needs you':status==='failed'?'Failed':'Applying'; a.reason=reason; a.updatedAt=new Date().toISOString(); a.logs=a.logs||[]; a.logs.unshift({at:new Date().toISOString(),message:reason}); writeState(s);} } }); return app; }
async function handle(req,res){ const url=new URL(req.url,`http://${req.headers.host}`); if(req.method==='OPTIONS') return send(res,204,{}); if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/webhooks/')){ let state=readState();
  if(req.method==='GET'&&url.pathname==='/api/state') return send(res,200,publicState(state));
  if(req.method==='GET'&&url.pathname==='/api/debug/env') return send(res,200,{ok:true,supabaseUrl:!!process.env.SUPABASE_URL,serviceRole:!!process.env.SUPABASE_SERVICE_ROLE_KEY,supabaseClient:!!supabase,bucket:'resumes'});
  if(req.method==='POST'&&url.pathname==='/api/logout'){ writeState(structuredClone(emptyState)); return send(res,200,{ok:true}); }
  if(req.method==='POST'&&url.pathname==='/api/signup'){ const b=await parseBody(req); state.user={id:id('user'),name:b.name||'',email:b.email||''}; state.profile={...state.profile,name:b.name||state.profile.name,email:b.email||state.profile.email,applicationEmail:b.applicationEmail||b.email||state.profile.applicationEmail}; state.target={...state.target,roles:b.roles||state.target.roles,countries:b.countries||state.target.countries,cities:b.cities||state.target.cities}; state.onboarding={step:b.step||0,done:!!b.done}; writeState(state); ensureCrawler('signup'); return send(res,200,{ok:true,state:publicState(state)}); }
  if(req.method==='POST'&&url.pathname==='/api/profile'){ const b=await parseBody(req); state.profile={...state.profile,...b.profile}; state.target={...state.target,...(b.target||{})}; writeState(state); return send(res,200,{ok:true,profile:state.profile,target:state.target}); }
  if(req.method==='POST'&&url.pathname==='/api/resume'){
    const b=await parseBody(req);
    fs.mkdirSync(UPLOADS,{recursive:true});
    let extracted=b.text||'';
    let storedPath='';
    let safe='';
    if(b.fileBase64&&b.fileName){
      safe=b.fileName.replace(/[^a-zA-Z0-9._-]/g,'_');
      storedPath=path.join(UPLOADS,`${Date.now()}-${safe}`);
      fs.writeFileSync(storedPath,Buffer.from(String(b.fileBase64).split(',').pop(),'base64'));
      state.profile.resumeFileName=safe;
      state.profile.resumeFilePath=storedPath;
      // IMPORTANT: return fast. Do not block onboarding on pdftotext/poppler.
      // Try a very quick best-effort extraction only; never hang upload.
      if(!extracted && /\.pdf$/i.test(safe)) extracted=roughPdfText(storedPath).slice(0,50000);
    }
    if(extracted){
      const parsed=parseResume(extracted,state.profile);
      state.profile={...state.profile,...parsed,resumeText:extracted};
    }
    state.profile.resumeUploadedAt=new Date().toISOString();
    state.logs=state.logs||[];
    state.logs.unshift({at:new Date().toISOString(),message:`Resume stored${extracted?' and parsed with quick extractor':''}: ${state.profile.resumeFileName||'text'}`});
    writeState(state);
    // Best-effort Supabase save happens after local state is committed. It must not block onboarding.
    try {
      const fileBuffer = storedPath ? fs.readFileSync(storedPath) : null;
      bestEffortSupabaseResumeSave({state,fileName:safe,fileBuffer,text:extracted}).then(result=>{
        const latest=readState();
        latest.profile.supabaseResume=result;
        if(result.saved) latest.profile.resumeFilePath=result.path;
        latest.logs=latest.logs||[];
        latest.logs.unshift({at:new Date().toISOString(),message:result.saved?`Resume also saved to Supabase: ${result.path}`:`Supabase save skipped/failed: ${result.reason||'not configured'}`});
        writeState(latest);
      }).catch(()=>{});
    } catch {}
    return send(res,200,{ok:true,profile:state.profile,extracted:!!extracted,stored:!!state.profile.resumeFileName,fileName:state.profile.resumeFileName,supabaseConfigured:!!supabase,message: extracted?'Stored and parsed.':'Stored instantly. Supabase save runs in background.'});
  }
  if(req.method==='GET'&&url.pathname==='/api/jobs'){ const page=Number(url.searchParams.get('page')||1), limit=Math.min(Number(url.searchParams.get('limit')||25),50); const arr=filterJobs(state,Object.fromEntries(url.searchParams)); const start=(page-1)*limit; return send(res,200,{items:arr.slice(start,start+limit),total:arr.length,page,limit}); }
  if(req.method==='POST'&&url.pathname==='/api/crawl'){ ensureCrawler('manual'); return send(res,200,{ok:true,message:'crawler started'}); }
  if(req.method==='GET'&&url.pathname==='/api/applications') return send(res,200,{items:state.applications||[]});
  if(req.method==='GET'&&url.pathname.startsWith('/api/applications/')){ const app=state.applications.find(a=>a.id===url.pathname.split('/').pop()); return send(res,app?200:404,app||{error:'not found'}); }
  if(req.method==='POST'&&url.pathname==='/api/apply'){ const b=await parseBody(req); state=readState(); const job=state.jobs.find(j=>j.id===b.jobId)||normalizeJob({...b.job,ats:b.job?.ats||'custom'}); const packet=generatePacket(job,state); const app={id:id('app'),jobId:job.id,company:job.company,role:job.title,ats:job.ats,url:job.url,jobDescription:job.description||'',status:'in_flight',statusLabel:'Applying',appliedAt:new Date().toISOString(),packet,logs:[{at:new Date().toISOString(),message:'Application queued.'}],formFields:[]}; if(!state.jobs.find(j=>j.id===job.id)) state.jobs.unshift(job); state.applications.unshift(app); state.credits=Math.max(0,(state.credits||0)-1); writeState(state); runApplicationWorker(app.id); return send(res,200,{ok:true,application:app}); }
  if(req.method==='POST'&&/^\/api\/applications\/[^/]+\/packet$/.test(url.pathname)){ const appId=url.pathname.split('/')[3]; const b=await parseBody(req); const a=state.applications.find(x=>x.id===appId); if(!a) return send(res,404,{error:'not found'}); a.packet={...(a.packet||{}),...(b.resumeText?{resumeText:b.resumeText}:{}),...(b.coverLetter?{coverLetter:b.coverLetter}:{}),...(b.profileSnapshot?{profileSnapshot:b.profileSnapshot}:{}),...(b.answers?{answers:{...(a.packet?.answers||{}),...b.answers}}:{})}; if(Array.isArray(b.formFields)) a.formFields=b.formFields; a.logs=a.logs||[]; a.logs.unshift({at:new Date().toISOString(),message:'User saved application packet edits.'}); a.updatedAt=new Date().toISOString(); writeState(state); return send(res,200,{ok:true,application:a}); }
  if(req.method==='POST'&&/^\/api\/applications\/[^/]+\/approve$/.test(url.pathname)){ const appId=url.pathname.split('/')[3]; const app=runApplicationWorker(appId,{forceSubmit:true}); return send(res,app?200:404,app?{ok:true,application:app}:{error:'not found'}); }
  if(req.method==='POST'&&url.pathname.includes('/mark-submitted')){ const appId=url.pathname.split('/')[3]; const a=state.applications.find(x=>x.id===appId); if(a){a.status='submitted';a.statusLabel='Submitted';a.reason='Manually marked submitted.';a.updatedAt=new Date().toISOString();} writeState(state); return send(res,200,{ok:true,application:a}); }
  if(req.method==='POST'&&url.pathname==='/api/accounts'){ const b=await parseBody(req); const acct={id:id('acct'),ats:b.ats||'',company:b.company||'',email:b.email||state.profile.applicationEmail||state.profile.email||'',username:b.username||'',password:b.password||state.profile.defaults.applicationPassword||'',status:b.status||'saved',createdAt:new Date().toISOString()}; state.atsAccounts=state.atsAccounts||[]; state.atsAccounts.unshift(acct); writeState(state); return send(res,200,{ok:true,account:acct}); }
  if(req.method==='POST'&&(url.pathname==='/api/messages'||url.pathname==='/webhooks/email'||url.pathname==='/webhooks/sendgrid'||url.pathname==='/webhooks/mailgun')){ const b=await parseBody(req); const from=b.from||b.sender||b.From||''; const subject=b.subject||b.Subject||''; const body=b.body||b.text||b['body-plain']||b.raw||''; const meta=categorizeMessage({subject,body}); const msg={id:id('msg'),from,subject,body:textClean(body).slice(0,2000),snippet:textClean(body).slice(0,240),receivedAt:new Date().toISOString(),...meta}; state.messages.unshift(msg); const hit=(state.applications||[]).find(a=>subject.toLowerCase().includes(String(a.company||'').toLowerCase())||body.toLowerCase().includes(String(a.company||'').toLowerCase())); if(hit){ hit.messages=hit.messages||[]; hit.messages.unshift(msg.id); hit.logs=hit.logs||[]; hit.logs.unshift({at:new Date().toISOString(),message:`Email captured: ${meta.category}${meta.otp?' with OTP '+meta.otp:''}`}); if(meta.category==='confirmation'){hit.status='submitted';hit.statusLabel='Submitted';hit.reason='Confirmation email received.';} } writeState(state); return send(res,200,{ok:true,message:msg}); }
  if(req.method==='POST'&&(url.pathname==='/api/channel/imessage'||url.pathname==='/webhooks/twilio/whatsapp')){ const b=await parseBody(req); const text=(b.text||b.Body||'').trim().toLowerCase(); let reply='Send JOBS, STATUS, or APPLY 1.'; if(text==='jobs'){ const jobs=filterJobs(state,{}).slice(0,5); reply=jobs.map((j,i)=>`${i+1}. ${j.title} at ${j.company} (${j.match.score}%)`).join('\n'); } else if(text.startsWith('apply')){ const n=Number(text.split(/\s+/)[1]||1)-1; const jobs=filterJobs(state,{}); if(jobs[n]) { const job=jobs[n]; const packet=generatePacket(job,state); const app={id:id('app'),jobId:job.id,company:job.company,role:job.title,ats:job.ats,url:job.url,jobDescription:job.description||'',status:'in_flight',statusLabel:'Applying',appliedAt:new Date().toISOString(),packet,logs:[{at:new Date().toISOString(),message:'Queued from channel.'}],formFields:[]}; state.applications.unshift(app); state.credits=Math.max(0,(state.credits||0)-1); writeState(state); runApplicationWorker(app.id); reply=`Queued ${job.title} at ${job.company}. Charge is applying in the background.`; } } else if(text==='status'){ reply=(state.applications||[]).slice(0,5).map(a=>`${a.company} — ${a.statusLabel}`).join('\n')||'No applications yet.';} return send(res,200,{ok:true,reply}); }
  if(req.method==='GET'&&url.pathname==='/api/mcp/manifest') return send(res,200,{name:'Charge',commands:['jobs','apply','status','profile']});
  if(req.method==='POST'&&url.pathname==='/api/mcp/command') return send(res,200,{ok:true,result:'MCP command received'});
  return send(res,404,{error:'not found'});
}
let p=url.pathname==='/'?'/index.html':url.pathname; p=path.join(PUBLIC,p); if(!p.startsWith(PUBLIC)) return send(res,403,'forbidden','text/plain'); fs.readFile(p,(e,d)=>{ if(e) return send(res,404,'not found','text/plain'); const ext=path.extname(p); const type=ext==='.js'?'application/javascript':ext==='.css'?'text/css':'text/html'; send(res,200,d,type); }); }
http.createServer(handle).listen(PORT,()=>{ console.log(`Charge running on http://localhost:${PORT}`); setTimeout(()=>ensureCrawler('startup'),800); setInterval(()=>ensureCrawler('interval'),1000*60*30); });
