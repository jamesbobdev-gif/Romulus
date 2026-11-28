/* Settings > Tabs: switch off the tabs you don't use and they leave the tab bar.
   The same on every device he syncs (shared-settings.js), unless this one is set to keep its own: a phone may
   want fewer tabs than the computer.
   A fresh install starts with To do, Agent and Notes; the rest wait in Settings > Tabs.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const TABS_OFF_KEY='tabsOff';
const TAB_PICK=[['tabList','list','To do'],['tabAgent','agent','Agent'],['tabSchool','school','School'],['tabWork','work','Work'],
  ['tabCal','calendar','Calendar'],['tabIdeas','ideas','Notes'],['tabHours','hours','Hours'],['tabKitchen','kitchen','Kitchen'],['tabFinance','finance','Finance'],['tabHealth','health','Health'],['tabFamily','family','Group']];
// how Settings > Tabs sorts them; a tab missing here isn't shown in the picker, so add new tabs to a group
const TAB_GROUPS=[['Everyday',['list','agent','calendar','ideas']],['School and work',['school','work','hours']],['Home',['kitchen','health','finance','family']]];
// what a new install shows; everything else, Finance and Group included, waits in Settings > Tabs
const TABS_START_ON=['list','agent','ideas'];
const TABS_TOUCHED_KEY='tabsTouched'; // tabs the person switched by hand: the app never switches those back on for them
// true when this launch wrote the three-tab default: init.js undoes it if the tasks file turns out to hold an older install's work
let tabsDefaulted=false;

function tabsOffLoad(){ try{ const l=JSON.parse(localStorage.getItem(TABS_OFF_KEY)||'[]'); return Array.isArray(l)?l:[]; }catch(e){ return []; } }
// first launch on this device (nothing saved here yet): switch off every pickable tab but the starting ones
function tabsOffDefault(){
  try{
    if(localStorage.getItem(TABS_OFF_KEY)!==null||localStorage.getItem('tasks.welcomed.v1'))return; // welcome.js WELCOME_KEY: this device has been through the welcome card
    if(localStorage.getItem('tasks.settingsAdvanced.v1')||localStorage.getItem('tasks.themeMode.v1'))return; // an older install that never saw the card
    const off=TAB_PICK.map(function(p){ return p[1]; }).filter(function(t){ return TABS_START_ON.indexOf(t)===-1; });
    tabsOffStore(off); tabsDefaulted=true;
  }catch(e){}
}
function tabsTouchedLoad(){ try{ const l=JSON.parse(localStorage.getItem(TABS_TOUCHED_KEY)||'[]'); return Array.isArray(l)?l:[]; }catch(e){ return []; } }
function tabsTouch(name){ try{ const l=tabsTouchedLoad(); if(l.indexOf(name)===-1){ l.push(name); localStorage.setItem(TABS_TOUCHED_KEY,JSON.stringify(l)); } }catch(e){} }
// the app switches a tab on when its feature gets set up (joining a group shows Group), unless the person switched that tab themselves
function tabSwitchOn(name){
  const off=tabsOffLoad(); if(off.indexOf(name)===-1||tabsTouchedLoad().indexOf(name)!==-1)return;
  tabsOffStore(off.filter(function(t){ return t!==name; })); applyTabsOff(); drawTabPicker();
}
// init.js, once the tasks are in: an install with work in it isn't new, whatever its localStorage says
function tabsKeepAllIfExisting(hasWork){
  if(!tabsDefaulted||!hasWork)return;
  tabsDefaulted=false; tabsOffStore([]); applyTabsOff(); drawTabPicker();
}
function tabsOffStore(list){ try{ if(list.length)localStorage.setItem(TABS_OFF_KEY,JSON.stringify(list)); else localStorage.removeItem(TABS_OFF_KEY); }catch(e){} }
// a tab the app itself keeps hidden (Finance without its storage) isn't offered
function tabAvailable(p){ return !$(p[0]).hidden; }

function applyTabsOff(atStart){
  const off=tabsOffLoad();
  TAB_PICK.forEach(function(p){ $(p[0]).classList.toggle('tab-off',off.indexOf(p[1])!==-1); });
  // the open tab is switched off: go to the first one still showing
  if(off.indexOf(state.activeTab)!==-1){
    const next=TAB_PICK.filter(function(p){ return tabAvailable(p)&&off.indexOf(p[1])===-1; })[0];
    if(!next)return;
    if(atStart)state.activeTab=next[1]; // init.js opens it once the tasks are loaded
    else switchTab(next[1]);
  }
}

function drawTabPicker(){
  const box=$('tabPicker'); if(!box)return;
  box.textContent='';
  const off=tabsOffLoad();
  const avail=TAB_PICK.filter(tabAvailable);
  const onCount=avail.filter(function(p){ return off.indexOf(p[1])===-1; }).length;
  TAB_GROUPS.forEach(function(g){
    const inGroup=avail.filter(function(p){ return g[1].indexOf(p[1])!==-1; });
    if(!inGroup.length)return;
    const sec=el('div','tab-pick-group');
    const head=el('div','tab-pick-head'); head.textContent=g[0]; sec.appendChild(head);
    const row=el('div','tab-pick-row'); sec.appendChild(row);
    inGroup.forEach(function(p){ row.appendChild(tabPickSwitch(p,off,onCount)); });
    box.appendChild(sec);
  });
  // with sync on, the choice above follows him to his other devices; this device can opt out
  if(typeof sharedTabsOwn==='function'&&typeof syncState!=='undefined'&&syncState.cfg&&syncState.cfg.personal){
    const lab=el('label','switch'); lab.style.marginTop='12px';
    const inp=document.createElement('input'); inp.type='checkbox'; inp.checked=!sharedTabsOwn();
    inp.addEventListener('change',function(){ sharedSetTabsOwn(!inp.checked); });
    const track=el('span','track'); track.setAttribute('aria-hidden','true');
    const name=document.createElement('span'); name.textContent='Show the same tabs on all my devices';
    lab.appendChild(inp); lab.appendChild(track); lab.appendChild(name);
    box.appendChild(lab);
  }
}
function tabPickSwitch(p,off,onCount){
    const lab=el('label','switch');
    const inp=document.createElement('input'); inp.type='checkbox'; inp.checked=off.indexOf(p[1])===-1;
    // the last tab showing can't be switched off
    if(inp.checked&&onCount<=1){ inp.disabled=true; lab.title='At least one tab has to stay'; }
    inp.addEventListener('change',function(){
      let list=tabsOffLoad().filter(function(t){ return t!==p[1]; });
      if(!inp.checked)list.push(p[1]);
      tabsOffStore(list); tabsTouch(p[1]);
      applyTabsOff(); drawTabPicker();
    });
    const track=el('span','track'); track.setAttribute('aria-hidden','true');
    // the tab bar's own label, so a renamed tab reads the same here
    const name=document.createElement('span'); name.textContent=($(p[0]).textContent||'').trim()||p[2];
    lab.appendChild(inp); lab.appendChild(track); lab.appendChild(name);
    return lab;
}

tabsOffDefault();
applyTabsOff(true);
drawTabPicker();
