/* AI on the phone: his API keys copied from the computer once, by a QR code, so the phone can ask an AI itself
   (Kitchen photos, kitchen-photo.js) without a computer being on. Never synced: the code goes from the
   computer's screen to the phone's camera, and the phone keeps the keys in the AiKeys plugin (AiKeysPlugin.java,
   encrypted with a key in the Android Keystore). Only API keys move: Claude through his subscription needs the
   Claude app on the computer, so on the phone Claude needs an Anthropic API key.
   - Computer, Settings → Agent → "Use these on your phone": pick which keys, show the code (main/phone-ai-code.js
     makes it). It hides after 2 minutes, since anyone who scans it gets the keys.
   - Phone, the same place: scan it, see which AIs it has, or forget them.
   The pure part (the code's format, one call to each AI) is above the DOM code, for test/phone-ai.test.js and
   main/phone-ai-code.js. */
'use strict';

const PHONE_AI_PREFIX='tasks-ai:1:';
const PHONE_AI_IDS=['claude','gemini','openai','openrouter'];
const PHONE_AI_NAMES={claude:'Claude',gemini:'Gemini',openai:'ChatGPT',openrouter:'OpenRouter'};
// the only addresses the phone sends keys to (AiKeysPlugin.java checks the same list)
const PHONE_AI_HOSTS=['api.anthropic.com','generativelanguage.googleapis.com','api.openai.com','openrouter.ai'];

// [{id, key, model, zdr}] → the ones that are well formed, in order, one per AI
function phoneAiClean(list){
  const seen={};
  return (Array.isArray(list)?list:[]).map(function(x){
    if(!x||PHONE_AI_IDS.indexOf(x.id)<0||seen[x.id])return null;
    const key=String(x.key||'').trim(), model=String(x.model||'').trim();
    if(!/^[\x21-\x7e]{8,300}$/.test(key)||(model&&!/^[\w.:\/@-]{1,100}$/.test(model)))return null;
    seen[x.id]=true;
    const o={id:x.id,key:key,model:model};
    if(x.id==='openrouter')o.zdr=!!x.zdr;
    return o;
  }).filter(Boolean);
}
const phoneAiB64=function(s){
  if(typeof Buffer!=='undefined')return Buffer.from(s,'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const phoneAiUnB64=function(s){
  const t=String(s).replace(/-/g,'+').replace(/_/g,'/');
  if(typeof Buffer!=='undefined')return Buffer.from(t,'base64').toString('utf8');
  return decodeURIComponent(escape(atob(t)));
};
function phoneAiPack(list){ return PHONE_AI_PREFIX+phoneAiB64(JSON.stringify({v:1,s:phoneAiClean(list)})); }
// a scanned code → [{id, key, model, zdr}], or null when it isn't one of these codes
function phoneAiUnpack(text){
  const t=String(text||'').trim();
  if(t.indexOf(PHONE_AI_PREFIX)!==0)return null;
  let o; try{ o=JSON.parse(phoneAiUnB64(t.slice(PHONE_AI_PREFIX.length))); }catch(e){ return null; }
  const s=phoneAiClean(o&&o.s);
  return s.length?s:null;
}

/* one question to one AI → {url, headers, body} (body is a string). image: {mime, b64} or null */
function phoneAiRequest(step,text,image){
  const json={'Content-Type':'application/json'};
  if(step.id==='claude'){
    const content=(image?[{type:'image',source:{type:'base64',media_type:image.mime,data:image.b64}}]:[]).concat({type:'text',text:text});
    return {url:'https://api.anthropic.com/v1/messages',headers:Object.assign({'x-api-key':step.key,'anthropic-version':'2023-06-01'},json),
      body:JSON.stringify({model:step.model||'claude-sonnet-5-5',max_tokens:2000,messages:[{role:'user',content:content}]})};
  }
  if(step.id==='gemini'){
    const parts=(image?[{inline_data:{mime_type:image.mime,data:image.b64}}]:[]).concat({text:text});
    return {url:'https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(step.model||'gemini-flash-latest')+':generateContent',
      headers:Object.assign({'x-goog-api-key':step.key},json),body:JSON.stringify({contents:[{role:'user',parts:parts}]})};
  }
  if(step.id==='openai'){
    const content=[{type:'input_text',text:text}].concat(image?[{type:'input_image',image_url:'data:'+image.mime+';base64,'+image.b64}]:[]);
    return {url:'https://api.openai.com/v1/responses',headers:Object.assign({Authorization:'Bearer '+step.key},json),
      body:JSON.stringify({model:step.model||'gpt-5-mini',store:false,input:[{role:'user',content:content}]})}; // store: false, OpenAI doesn't keep it
  }
  const content=[{type:'text',text:text}].concat(image?[{type:'image_url',image_url:{url:'data:'+image.mime+';base64,'+image.b64}}]:[]);
  return {url:'https://openrouter.ai/api/v1/chat/completions',headers:Object.assign({Authorization:'Bearer '+step.key},json),
    body:JSON.stringify({model:step.model||'openrouter/auto',max_tokens:2000,messages:[{role:'user',content:image?content:text}],
      provider:step.zdr?{data_collection:'deny',zdr:true}:{data_collection:'deny'}})}; // only providers that don't collect what's sent
}
// an AI's JSON answer → its text
function phoneAiText(step,j){
  if(!j||typeof j!=='object')return '';
  if(step.id==='claude')return (j.content||[]).filter(function(c){ return c.type==='text'; }).map(function(c){ return c.text; }).join('\n');
  if(step.id==='gemini'){ const c=j.candidates&&j.candidates[0]; return ((c&&c.content&&c.content.parts)||[]).map(function(p){ return p.text||''; }).join(''); }
  if(step.id==='openai'){
    if(j.output_text)return j.output_text;
    return (j.output||[]).reduce(function(a,o){ return a.concat(o.content||[]); },[]).filter(function(c){ return c.type==='output_text'; }).map(function(c){ return c.text; }).join('');
  }
  const m=j.choices&&j.choices[0]&&j.choices[0].message; return (m&&m.content)||'';
}
/* each AI in turn until one answers → {text, via} or {why}. post(url, headers, body) → {status, body} */
async function phoneAiAsk(steps,text,image,post){
  const tried=[];
  for(const st of phoneAiClean(steps)){
    const name=PHONE_AI_NAMES[st.id];
    try{
      const q=phoneAiRequest(st,text,image), r=await post(q.url,q.headers,q.body);
      let j=null; try{ j=JSON.parse(r.body); }catch(e){}
      if(!(r.status>=200&&r.status<300)){
        const e=j&&(j.error||j.message);
        tried.push(name+': '+String((e&&(typeof e==='string'?e:e.message))||'HTTP '+r.status).slice(0,120)); continue;
      }
      const out=String(phoneAiText(st,j)||'').trim();
      if(out)return {text:out,via:name};
      tried.push(name+': empty answer');
    }catch(e){ tried.push(name+': '+String(e&&(e.message||e.errorMessage)||e).slice(0,120)); }
  }
  return {why:tried.length?'No answer. '+tried.join(' · '):'No AI keys on this phone.'};
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={PHONE_AI_PREFIX:PHONE_AI_PREFIX,PHONE_AI_HOSTS:PHONE_AI_HOSTS,phoneAiClean:phoneAiClean,phoneAiPack:phoneAiPack,phoneAiUnpack:phoneAiUnpack,
    phoneAiRequest:phoneAiRequest,phoneAiText:phoneAiText,phoneAiAsk:phoneAiAsk};
}

/* ══ the page ══ */
if(typeof document!=='undefined'){

const paCap=window.Capacitor;
const paPlugin=!!(paCap&&typeof paCap.nativePromise==='function'&&paCap.isPluginAvailable&&paCap.isPluginAvailable('AiKeys'));
const paCall=function(m,o){ return paCap.nativePromise('AiKeys',m,o||{}); };
const paState={steps:[],loaded:false,why:'',codeTimer:null};

// the phone: what's kept, and asking with it (kitchen-photo.js)
async function paLoad(){
  if(!paPlugin)return;
  try{ const r=await paCall('load'); paState.steps=phoneAiClean(r&&r.data?JSON.parse(r.data):[]); }catch(e){ paState.steps=[]; }
  paState.loaded=true; paDraw();
}
window.phoneAi={
  ready:function(){ return paPlugin&&paState.steps.length>0; },
  names:function(){ return paState.steps.map(function(s){ return PHONE_AI_NAMES[s.id]; }); },
  ask:function(text,image){
    return phoneAiAsk(paState.steps,text,image,function(url,headers,body){ return paCall('post',{url:url,headers:headers,body:body}); });
  },
};
async function paScan(){
  paState.why='';
  let text;
  try{ text=(await paCall('scan')).text; }
  catch(e){ if(!(e&&e.code==='CANCELLED'))paState.why='The scanner didn’t start: '+(e&&(e.message||e.errorMessage)||e); paDraw(); return; }
  const steps=phoneAiUnpack(text);
  if(!steps){ paState.why='That isn’t the AI keys code. On the computer: Settings, Agent, Use these on your phone, Show the code.'; paDraw(); return; }
  try{ await paCall('save',{data:JSON.stringify(steps)}); paState.steps=steps; voiceToast('This phone can now ask '+window.phoneAi.names().join(', ')); }
  catch(e){ paState.why='Couldn’t keep them on this phone: '+(e&&(e.message||e.errorMessage)||e); }
  paDraw();
}
async function paForget(){
  try{ await paCall('forget'); }catch(e){}
  paState.steps=[]; voiceToast('AI keys removed from this phone'); paDraw();
}

// the computer: pick keys, show the code for 2 minutes
async function paShowCode(ids,box,btn){
  clearTimeout(paState.codeTimer);
  let r; try{ r=await window.desktop.aiPhoneCode(ids); }catch(e){ r={why:String(e&&e.message||e)}; }
  if(!r||!r.svg){ paState.why=(r&&r.why)||'Couldn’t make the code.'; paDraw(); return; }
  box.innerHTML=r.svg; box.hidden=false; btn.textContent='Hide the code';
  paState.codeTimer=setTimeout(function(){ box.innerHTML=''; box.hidden=true; btn.textContent='Show the code'; },120000);
}

function paDraw(){
  const sec=$('aiPhoneSection'); if(!sec)return;
  const desk=!!(window.desktop&&window.desktop.aiPhoneChoices);
  if(!desk&&!paPlugin){ sec.hidden=true; return; }
  sec.hidden=false; sec.innerHTML='';
  sec.appendChild(el('h3','settings-subhead',desk?'Use these on your phone':'AI on this phone'));
  if(paPlugin){
    sec.appendChild(el('p','settings-hint',paState.steps.length
      ?'This phone asks '+window.phoneAi.names().join(', then ')+' itself, for Kitchen photos. The keys stay on this phone and aren’t synced.'
      :'Scan the code from your computer (Settings, Agent, Use these on your phone) so this phone can read Kitchen photos itself. Without it, a computer with Romulus open reads them.'));
    const row=el('div','settings-row');
    const scan=el('button','ghost mono',paState.steps.length?'Scan again':'Scan the code'); scan.addEventListener('click',paScan);
    row.appendChild(scan);
    if(paState.steps.length){ const f=el('button','ghost mono','Forget them'); f.addEventListener('click',paForget); row.appendChild(f); }
    sec.appendChild(row);
  } else {
    sec.appendChild(el('p','settings-hint','Copies the keys you pick to your phone with a QR code, once, so the phone can read Kitchen photos without this computer on. They aren’t synced: scan again after you change a key. Claude needs an Anthropic API key for this (your Claude sign-in only works on this computer). Anyone who scans the code gets the keys, so only show it to your own phone. It hides after 2 minutes.'));
    const list=el('div'), box=el('div','fin-qr'); box.hidden=true;
    const btn=el('button','ghost mono','Show the code');
    window.desktop.aiPhoneChoices().then(function(cs){
      const picks={};
      (cs||[]).forEach(function(c){
        const r=el('label','settings-row'); r.style.gap='8px';
        const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=c.can; cb.disabled=!c.can; picks[c.id]=c.can;
        cb.addEventListener('change',function(){ picks[c.id]=cb.checked; });
        r.appendChild(cb); r.appendChild(el('span',null,c.name+(c.can?'':': '+c.why)));
        list.appendChild(r);
      });
      btn.disabled=!(cs||[]).some(function(c){ return c.can; });
      btn.addEventListener('click',function(){
        if(!box.hidden){ clearTimeout(paState.codeTimer); box.innerHTML=''; box.hidden=true; btn.textContent='Show the code'; return; }
        const ids=Object.keys(picks).filter(function(k){ return picks[k]; });
        if(!ids.length){ paState.why='Tick at least one.'; paDraw(); return; }
        paShowCode(ids,box,btn);
      });
    }).catch(function(){});
    sec.appendChild(list); sec.appendChild(btn); sec.appendChild(box);
  }
  if(paState.why)sec.appendChild(el('p','settings-hint',paState.why));
}
window.addEventListener('DOMContentLoaded',function(){ paDraw(); paLoad(); });
if(document.readyState!=='loading'){ paDraw(); paLoad(); }

}
