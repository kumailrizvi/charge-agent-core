(async function(){
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const api=async(p,o={})=>{try{return await (await fetch('http://localhost:8787'+p,{headers:{'content-type':'application/json'},...o})).json()}catch{return null}};
  const claim=await api('/api/extension/claim?url='+encodeURIComponent(location.href));
  if(!claim||!claim.application) return;
  const app=claim.application, profile=claim.profile||{}, packet=app.packet||{};
  const lower=s=>String(s||'').toLowerCase();
  const val=(meta)=>{ const m=lower(meta); const names=(profile.name||'').split(' '); if(m.includes('first'))return names[0]||''; if(m.includes('last')||m.includes('surname'))return names.slice(1).join(' ')||''; if(m.includes('full')&&m.includes('name'))return profile.name||''; if(m.includes('email'))return profile.email||''; if(m.includes('phone')||m.includes('mobile'))return profile.phone||''; if(m.includes('linkedin'))return profile.linkedin||''; if(m.includes('location')||m.includes('city'))return profile.location||''; if(m.includes('salary'))return profile.defaults?.salary||'Open to market range'; if(m.includes('why')||m.includes('interest'))return packet.answers?.why||''; if(m.includes('cover'))return packet.coverLetter||''; return ''; };
  let filled=0;
  for(const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea')){
    const type=lower(el.type); if(['checkbox','radio','file'].includes(type)||el.value) continue;
    const label=(el.labels&&el.labels[0]?.innerText)||el.getAttribute('aria-label')||el.placeholder||el.name||el.id||el.parentElement?.innerText||'';
    const v=val(label); if(v){ el.focus(); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); filled++; await sleep(80); }
  }
  for(const lab of document.querySelectorAll('label')){ const t=lower(lab.innerText); if((t.includes('authorized')||t.includes('eligible'))&&t.includes('yes')) lab.click(); if(t.includes('sponsor')&&(t.includes('no')||t.includes('not require'))) lab.click(); }
  await api('/api/extension/update',{method:'POST',body:JSON.stringify({applicationId:app.id,status:'needs_review',statusLabel:'Needs you',message:`Extension filled ${filled} fields. Review file upload/final submit.`})});
})();
