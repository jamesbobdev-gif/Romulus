/* What changed in each version, told once after an update. The list below is the record: newest first, plain
   English for someone who has never seen the code, one line per change worth telling. A change made between
   releases goes under the top entry, version 'next'; npm run release puts the version in (scripts/whats-new.js)
   and refuses to release a version with no lines, since the point is that every update says what it is.
   The first open of a new version shows a card at the top of the list, "What’s new in Romulus 1.3.23", with
   the lines of every version since the one this device last ran (an update can skip a few); Got it puts it
   away. The version last run is kept in localStorage (WHATS_NEW_SEEN_KEY). With none kept yet, an install
   that has been through the welcome card is an update and gets this version's lines; a fresh install gets
   nothing. The computer learns its version from main/updater.js (update:version), the phone from
   window.ROMULUS_VERSION (mobile/prepare-www.js); a plain browser has neither and shows nothing.
   Settings → Updates has "What changed in this version" to read the lines again any time.
   The pure part is above the page code, for test/whats-new.test.js and scripts/whats-new.js.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';
const WHATS_NEW_SEEN_KEY='tasks.version.seen';

const WHATS_NEW=[
  {version:'next',notes:[
    'After an update, this card says what changed.',
    'Lists: tasks sort themselves (overdue, today, then by date), and the Tag menu and search share one row.',
    'Hours: turning hours in can email the time sheet to an address.',
    'First launch: Gmail and Google Calendar are offered before anything else.',
    'Agent tab: after you connect a calendar or mailbox it suggests standing jobs, "every weekday at 9" in a task offers a repeat, and Claude Desktop can add tasks.',
    'Legion: a second, smaller wave of questions on what the first answers left open; without a local model the first cloud AI leads.',
    'Text my phone: a text when the Agent finishes or has a question while you are away from the computer (Settings → Voice and alerts).',
    'Android: Romulus can be the phone’s assistant app, opened by the assistant gesture from inside any app.',
    'Settings → About you: a switch lets the Agent’s cloud AIs read the Locked profile for forms (off to start).',
    'Security: fixes from a review of the app and its server.',
    'Kitchen: a pantry or shopping-list photo that can’t be read asks for a retake, and one that shows only part of it asks for another picture of the rest, which joins the same list.'
  ]},
  {version:'1.3.22',notes:[
    'Kitchen: pantry items from your orders show the right picture, and each card has a camera button for a photo of your own.'
  ]},
  {version:'1.3.21',notes:[
    'Health tab: workouts, heart rate, calories, distance, weight and food from the phone, with the last 7 days against the 7 before and 30/60-day trends.'
  ]},
  {version:'1.3.20',notes:[
    'The phone reads Kitchen photos itself once the AI keys are copied over by QR code (Settings → Agent & AI on the computer).'
  ]}
];

// 1.0.10 is newer than 1.0.9 (the same as update-sync.js; here too so this file loads on its own in a test and in scripts/whats-new.js)
function whatsNewNewer(candidate,current){
  const a=String(candidate||'').replace(/^v/i,'').split('.').map(Number), b=String(current||'').replace(/^v/i,'').split('.').map(Number);
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const x=a[i]||0, y=b[i]||0;
    if(isNaN(x)||isNaN(y))return false;
    if(x!==y)return x>y;
  }
  return false;
}
// the versions to tell about, newest first, as [{version, notes}]: every one after lastSeen up to current, or with
// no lastSeen just current. 'next' is the version being built, so it counts as current; an entry newer than
// current (a file ahead of package.json) is left out. Entries that come to the same version are joined.
function whatsNewSince(entries,lastSeen,current){
  if(!current)return [];
  const out=[];
  (entries||[]).forEach(function(e){
    if(!e||!Array.isArray(e.notes)||!e.notes.length)return;
    const v=e.version==='next'?current:String(e.version||'');
    if(whatsNewNewer(v,current))return;
    if(lastSeen?!whatsNewNewer(v,lastSeen):v!==current)return;
    const have=out.find(function(o){ return o.version===v; });
    if(have)have.notes=have.notes.concat(e.notes); else out.push({version:v,notes:e.notes.slice()});
  });
  return out;
}

if(typeof module!=='undefined'&&module.exports)module.exports={WHATS_NEW,WHATS_NEW_SEEN_KEY,whatsNewSince,whatsNewNewer};

if(typeof document!=='undefined'){
  // this device's version: the computer asks main/updater.js, the phone has it baked in, a plain browser has none
  function whatsNewVersion(){
    if(window.ROMULUS_VERSION)return Promise.resolve(String(window.ROMULUS_VERSION));
    if(window.desktop&&window.desktop.updateVersion)return window.desktop.updateVersion().then(function(v){ return v?String(v):null; }).catch(function(){ return null; });
    return Promise.resolve(null);
  }
  // the lines into a list; a second version gets a line of its own above its lines
  function whatsNewFill(list,shown){
    list.textContent='';
    shown.forEach(function(e,i){
      if(i){ const h=document.createElement('li'); h.className='whats-new-ver'; h.textContent='And in '+e.version; list.appendChild(h); }
      e.notes.forEach(function(n){ const li=document.createElement('li'); li.textContent=n; list.appendChild(li); });
    });
  }
  whatsNewVersion().then(function(current){
    if(!current)return;
    let seen=null, welcomed=false;
    try{ seen=localStorage.getItem(WHATS_NEW_SEEN_KEY); welcomed=!!localStorage.getItem(WELCOME_KEY); }catch(e){}
    try{ localStorage.setItem(WHATS_NEW_SEEN_KEY,current); }catch(e){}
    // Settings → Updates: this version's lines, any time
    const mine=whatsNewSince(WHATS_NEW,null,current);
    const btn=$('updateNotes'), again=$('updateNotesList');
    if(btn&&again&&mine.length){
      btn.hidden=false; btn.textContent='What changed in '+current;
      btn.addEventListener('click',function(){ whatsNewFill(again,mine); again.hidden=!again.hidden; });
    }
    // the card, once per version
    const card=$('whatsNewCard'); if(!card||seen===current)return;
    const shown=seen?whatsNewSince(WHATS_NEW,seen,current):(welcomed?mine:[]);
    if(!shown.length)return;
    $('whatsNewTitle').textContent='What’s new in Romulus '+current;
    whatsNewFill($('whatsNewList'),shown);
    card.hidden=false;
    $('whatsNewOk').addEventListener('click',function(){ card.hidden=true; });
  });
}
