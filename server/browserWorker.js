const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function chromePath() {
  if (process.env.CHARGE_CHROME_PATH) return process.env.CHARGE_CHROME_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  return undefined;
}

function openUrl(url) {
  // Debug-only helper. Charge should not open user-visible tabs during normal auto-apply.
  const platform = process.platform;
  if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function valueFor(label, profile, packet) {
  const s = String(label || '').toLowerCase();
  const first = (profile.name || '').split(' ')[0] || '';
  const last = (profile.name || '').split(' ').slice(1).join(' ') || '';
  if (s.includes('first')) return first;
  if (s.includes('last') || s.includes('surname')) return last;
  if (s.includes('full') && s.includes('name')) return profile.name || '';
  if (s.includes('preferred') && s.includes('name')) return first || profile.name || '';
  if (s.includes('email')) return profile.applicationEmail || profile.email || '';
  if (s.includes('phone') || s.includes('mobile')) return profile.phone || '';
  if (s.includes('linkedin')) return profile.linkedin || '';
  if (s.includes('website') || s.includes('portfolio')) return profile.linkedin || '';
  if (s.includes('location') || s.includes('city') || s.includes('address')) return profile.location || '';
  if (s.includes('salary') || s.includes('compensation')) return profile.defaults?.salary || 'Open to market range';
  if (s.includes('authorized') || s.includes('eligible')) return profile.defaults?.workAuthorization || 'Yes';
  if (s.includes('sponsor')) return profile.defaults?.sponsorship || 'No';
  if (s.includes('why') || s.includes('interest')) return packet.answers?.why || '';
  if (s.includes('cover')) return packet.coverLetter || '';
  return '';
}

async function runBrowserApply({ application, job, profile, packet, forceSubmit=false, onLog, onUpdate, onFormFields }) {
  const logs = [];
  const log = (m) => { logs.push({ at: new Date().toISOString(), message: m }); if (onLog) onLog(m); };
  if (!job.applyUrl && !job.url) {
    await onUpdate('needs_review', 'No external apply URL found.');
    return { status: 'needs_review', logs };
  }
  const url = job.applyUrl || job.url;
  let pw;
  try { pw = require('playwright-core'); } catch (e) {
    log('playwright-core is not installed, so Charge cannot run the background auto-apply worker.');
    await onUpdate('failed', 'Auto-apply worker dependency missing. Run npm install inside the project folder.');
    return { status: 'failed', logs };
  }
  let browser;
  try {
    const visible = process.env.CHARGE_SHOW_BROWSER === '1' || process.env.CHARGE_KEEP_BROWSER_OPEN === '1';
    log(visible ? 'Opening visible browser worker for debugging.' : 'Running hidden background auto-apply worker.');
    browser = await pw.chromium.launch({
      headless: !visible,
      executablePath: chromePath(),
      args: ['--disable-blink-features=AutomationControlled']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);

    const title = await page.title().catch(() => '');
    log(`Loaded application page in background: ${title || url}`);
    const lower = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).toLowerCase();
    if (lower.includes('captcha') || lower.includes('recaptcha') || lower.includes('verify you are human')) {
      await onUpdate('needs_review', 'CAPTCHA or human verification detected.');
      log('Paused: CAPTCHA/human verification detected.');
      if (!process.env.CHARGE_KEEP_BROWSER_OPEN) await browser.close();
      return { status: 'needs_review', logs };
    }

    const formSchema = await page.locator('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select').evaluateAll(nodes => nodes.slice(0,120).map(el => {
      const id = el.id;
      const label = id ? document.querySelector(`label[for=\"${CSS.escape(id)}\"]`) : null;
      const parentText = (label?.innerText || el.closest('label')?.innerText || el.parentElement?.innerText || '').trim().slice(0,220);
      return { kind: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', id: id || '', label: parentText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '', required: !!el.required, value: el.value || '' };
    })).catch(()=>[]);
    if (onFormFields) onFormFields(formSchema);
    log(`Detected ${formSchema.length} fields on application page.`);

    const fields = await page.locator('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea').all();
    for (const field of fields) {
      try {
        const type = (await field.getAttribute('type')) || '';
        if (['checkbox','radio','file'].includes(type.toLowerCase())) continue;
        const val = await field.inputValue().catch(() => '');
        if (val) continue;
        const meta = [await field.getAttribute('name'), await field.getAttribute('id'), await field.getAttribute('aria-label'), await field.getAttribute('placeholder')].filter(Boolean).join(' ');
        const labelText = await field.evaluate(el => {
          const id = el.id;
          const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          return (label?.innerText || el.closest('label')?.innerText || el.parentElement?.innerText || '').slice(0,200);
        }).catch(() => '');
        const v = valueFor(`${meta} ${labelText}`, profile, packet);
        if (v) { await field.fill(String(v).slice(0, 4000), { timeout: 2500 }); log(`Filled ${meta || labelText.slice(0,40)}`); }
      } catch {}
    }

    // choose Yes/No radios where obvious
    const labels = await page.locator('label').all();
    for (const label of labels.slice(0, 100)) {
      try {
        const t = (await label.innerText()).toLowerCase();
        if ((t.includes('authorized') || t.includes('eligible')) && t.includes('yes')) { await label.click({ timeout: 500 }); log('Selected work authorization Yes.'); }
        if (t.includes('sponsor') && (t.includes('no') || t.includes('not require'))) { await label.click({ timeout: 500 }); log('Selected sponsorship No.'); }
      } catch {}
    }

    const fileInputs = await page.locator('input[type=file]').all();
    if (fileInputs.length && profile.resumeFilePath && fs.existsSync(profile.resumeFilePath)) {
      await fileInputs[0].setInputFiles(profile.resumeFilePath);
      log('Attached resume file.');
    } else if (fileInputs.length) {
      await onUpdate('needs_review', 'Resume upload required, but no usable file is saved.');
      log('Paused: resume upload required but no resume file path is available.');
      if (!process.env.CHARGE_KEEP_BROWSER_OPEN) await browser.close();
      return { status: 'needs_review', logs };
    }

    const trusted = ['greenhouse','lever','ashby','smartrecruiters','workable','recruitee','bamboohr','teamtailor'].includes(String(job.ats || '').toLowerCase());
    if (!trusted || (!profile.defaults?.autoSubmit && !forceSubmit)) {
      await onUpdate('needs_review', trusted ? 'Application prepared. Auto-submit is off in Settings. Click Approve to submit.' : 'Application prepared. This ATS is not trusted for auto-submit yet.');
      log('Prepared application but paused before final submit.');
      if (!process.env.CHARGE_KEEP_BROWSER_OPEN) await browser.close();
      return { status: 'needs_review', logs };
    }

    const submit = page.locator('button:has-text("Submit"), button:has-text("Apply"), input[type=submit], button:has-text("Send")').first();
    if (await submit.count()) {
      await submit.click({ timeout: 5000 });
      log('Clicked submit/apply button.');
      await page.waitForTimeout(2500);
      const body = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).toLowerCase();
      if (body.includes('thank') || body.includes('submitted') || body.includes('received')) {
        await onUpdate('submitted', 'Application submitted by browser worker.');
        log('Submission confirmation detected.');
      } else {
        await onUpdate('needs_review', 'Submit clicked, confirmation not detected. Review browser/page.');
        log('Submit clicked, but no confirmation detected.');
      }
    } else {
      await onUpdate('needs_review', 'Could not find submit button after filling form.');
      log('Submit button not found.');
    }
    if (!process.env.CHARGE_KEEP_BROWSER_OPEN) await browser.close();
    return { status: 'done', logs };
  } catch (e) {
    log(`Worker failed: ${e.message}`);
    await onUpdate('failed', e.message);
    try { if (browser && !process.env.CHARGE_KEEP_BROWSER_OPEN) await browser.close(); } catch {}
    return { status: 'failed', logs };
  }
}

module.exports = { runBrowserApply, openUrl };
