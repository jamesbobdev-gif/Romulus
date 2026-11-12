/* The mini PC's browser over Supabase, so no device has to reach the mini PC (no Tailscale, no SSH).
   agent/live-view.js 'live:relay' says which side this computer is and hands over the channel:
   - 'publish' (the mini PC, the worker): while someone watches, it streams its browser (CDP screencast,
     a few pictures a second) on a Realtime broadcast channel, lists its tabs, and replays the clicks and
     keys that come back. Nobody watching for 12 s: it stops.
   - 'watch' (his other computers): agent-live-view.js shows the pictures and sends his input back.
   The channel's name is a hash of the agent list's sync key, and every message is sealed with AES-GCM
   under a key made from it, so a message that doesn't open is dropped: only his devices can watch or click. */
const liveRelay=(function(){
  const LEASE_MS=12000, PING_MS=4000, FRAME_GAP_MS=350, MAX_MSG=230*1024, STALE_MS=30000;
  const INPUT=['Input.dispatchMouseEvent','Input.dispatchKeyEvent','Input.insertText'];
  let info=null, infoAt=0, key=null, sock=null, joined=false, ref=0, hb=null, retry=null, tries=0, lastMsg=0;

  /* ── sealing ── */
  function b64(bytes){ let s=''; for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000)); return btoa(s); }
  function unb64(s){ const bin=atob(s), out=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i); return out; }
  async function seal(obj){
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(JSON.stringify(Object.assign({at:Date.now()},obj)))));
    return {iv:b64(iv),ct:b64(ct)};
  }
  async function open(p){
    if(!p||typeof p.iv!=='string'||typeof p.ct!=='string')return null;
    let msg=null;
    try{ msg=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(p.iv)},key,unb64(p.ct)))); }
    catch(e){ return null; } // not sealed with his key: ignored
    if(!msg||typeof msg.at!=='number'||Math.abs(Date.now()-msg.at)>STALE_MS)return null; // a message kept and sent again later: ignored
    return msg;
  }

  /* ── the channel (Phoenix, like sync.js's live updates) ── */
  async function refreshInfo(){
    if(info&&Date.now()-infoAt<60000)return info;
    if(!window.desktop||!window.desktop.liveRelay)return null;
    let r=null; try{ r=await window.desktop.liveRelay(); }catch(e){}
    infoAt=Date.now();
    const changed=!r||!info||r.role!==info.role||r.topic!==info.topic||r.url!==info.url;
    info=r&&r.role?r:null;
    if(changed){
      key=null; close();
      if(info){
        const raw=new Uint8Array(info.secret.match(/../g).map(function(h){ return parseInt(h,16); }));
        key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
      }
    }
    return info;
  }
  function close(){
    clearInterval(hb); clearTimeout(retry); retry=null; joined=false;
    if(sock){ const s=sock; sock=null; try{ s.close(); }catch(e){} }
  }
  function connect(){
    // retry: a try is already waiting its turn. tick() calls this every second, and without the wait a refused
    // socket (a key that wasn't accepted, no network) was opened again about every three seconds, all day
    if(!info||sock||retry||typeof WebSocket!=='function')return;
    const s=new WebSocket(info.url.replace(/^http/,'ws')+'/realtime/v1/websocket?apikey='+encodeURIComponent(info.key)+'&vsn=1.0.0');
    sock=s; joined=false; lastMsg=Date.now();
    // never opened, or the join was never answered: start over rather than sit on a socket that carries nothing
    setTimeout(function(){ if(sock===s&&!joined){ try{ s.close(); }catch(e){} } },15000);
    s.onopen=function(){
      ref++; s.send(JSON.stringify({topic:'realtime:'+info.topic,event:'phx_join',ref:String(ref),join_ref:String(ref),
        payload:{config:{broadcast:{self:false,ack:false},presence:{key:''},postgres_changes:[],private:false}}}));
      hb=setInterval(function(){
        if(Date.now()-lastMsg>60000){ try{ s.close(); }catch(e){} return; }
        ref++; try{ s.send(JSON.stringify({topic:'phoenix',event:'heartbeat',payload:{},ref:String(ref)})); }catch(e){}
      },25000);
    };
    s.onmessage=async function(ev){
      lastMsg=Date.now();
      let m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.event==='phx_reply'&&m.topic==='realtime:'+info.topic&&m.payload&&m.payload.status==='ok'){ joined=true; tries=0; return; }
      // the join was refused (too many at once, a server restart): the socket stayed open and nothing ever arrived
      if(m.event==='phx_reply'&&m.topic==='realtime:'+info.topic&&!joined&&m.payload&&m.payload.status==='error'){ try{ s.close(); }catch(e){} return; }
      if(m.event==='broadcast'&&m.payload&&m.payload.event==='m'){ const msg=await open(m.payload.payload); if(msg)onMessage(msg); }
      else if(m.event==='phx_error'||m.event==='phx_close'){ try{ s.close(); }catch(e){} }
    };
    s.onclose=function(){
      clearInterval(hb);
      if(sock!==s)return; // closed on purpose
      sock=null; joined=false;
      retry=setTimeout(function(){ retry=null; connect(); },Math.min(60000,1000*Math.pow(2,tries++))); // 1s, 2s, 4s … up to a minute
    };
  }
  // one at a time, in order: sealing is async, and a mouse-up that overtakes its mouse-down is no click
  let sending=Promise.resolve(true);
  function send(obj){ sending=sending.then(function(){ return sendNow(obj); },function(){ return sendNow(obj); }); return sending; }
  async function sendNow(obj){
    if(!sock||!joined||!key)return false;
    const p=await seal(obj);
    if(p.ct.length>MAX_MSG)return false; // over Realtime's message size: skipped (the next picture is smaller or not)
    ref++; try{ sock.send(JSON.stringify({topic:'realtime:'+info.topic,event:'broadcast',payload:{type:'broadcast',event:'m',payload:p},ref:String(ref)})); }catch(e){ return false; }
    return true;
  }

  /* ── the mini PC: stream while watched ── */
  // last: the latest picture, sent again to a viewer who just opened it (a page sitting still sends no new ones)
  const pub={until:0, want:null, cdp:null, page:null, lastFrame:0, last:null, trail:null, size:0, pagesAt:0, nextId:1};
  // picture sizes, best first: a busy page (a course page full of text) can come out over Realtime's
  // message size, and a picture that's dropped and never followed by another leaves the viewer on "Connecting…"
  const SIZES=[{q:45,w:1100},{q:35,w:900},{q:25,w:720},{q:20,w:560}];
  function cdpSend(method,params){ if(pub.cdp&&pub.cdp.readyState===1)pub.cdp.send(JSON.stringify({id:pub.nextId++,method:method,params:params||{}})); }
  function startCast(){ const s=SIZES[pub.size]; cdpSend('Page.startScreencast',{format:'jpeg',quality:s.q,maxWidth:s.w,maxHeight:s.w,everyNthFrame:1}); }
  function stopCast(){ pub.last=null; clearTimeout(pub.trail); pub.trail=null; if(pub.cdp){ const c=pub.cdp; pub.cdp=null; pub.page=null; try{ c.close(); }catch(e){} } }
  function cast(page){
    stopCast();
    pub.size=0; pub.lastFrame=0; // a new tab's first picture always goes, whatever the last tab just sent
    const c=new WebSocket(page.ws); pub.cdp=c; pub.page=page;
    c.onopen=function(){ cdpSend('Page.bringToFront'); cdpSend('Page.enable'); startCast(); };
    c.onmessage=function(ev){
      let m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.method!=='Page.screencastFrame')return;
      cdpSend('Page.screencastFrameAck',{sessionId:m.params.sessionId});
      // sealed, a picture grows by about a third: too big to send → the same page smaller
      if(m.params.data.length>MAX_MSG*0.72&&pub.size<SIZES.length-1){ pub.size++; cdpSend('Page.stopScreencast'); startCast(); return; }
      pub.last={t:'frame',id:page.id,data:m.params.data,meta:m.params.metadata};
      // a few a second is plenty, and Realtime counts messages; the latest one still goes once the gap is up,
      // so a page that stops changing right after a burst isn't left showing nothing
      const wait=FRAME_GAP_MS-(Date.now()-pub.lastFrame);
      if(wait>0){ if(!pub.trail)pub.trail=setTimeout(function(){ pub.trail=null; if(pub.cdp===c&&pub.last){ pub.lastFrame=Date.now(); send(pub.last); } },wait); return; }
      pub.lastFrame=Date.now();
      send(pub.last);
    };
    c.onclose=function(){ if(pub.cdp===c){ pub.cdp=null; pub.page=null; } };
  }
  async function pubTick(){
    if(Date.now()>pub.until){ stopCast(); return; }
    if(Date.now()-pub.pagesAt<2000)return;
    pub.pagesAt=Date.now();
    let r; try{ r=await window.desktop.livePages(undefined,'lupa'); }catch(e){ r={up:false,pages:[]}; }
    const pages=(r.pages||[]).map(function(p){ return {id:p.id,title:p.title,url:p.url,ws:p.ws}; });
    send({t:'pages',up:!!r.up,pages:pages.map(function(p){ return {id:p.id,title:p.title,url:p.url}; })});
    if(!r.up){ stopCast(); return; }
    const want=pages.find(function(p){ return p.id===pub.want; })||(pub.page&&pages.find(function(p){ return p.id===pub.page.id; }))||pages[0];
    if(want&&(!pub.cdp||!pub.page||pub.page.id!==want.id))cast(want);
  }
  /* ── his other computers: what the mini PC said last ── */
  const view={pages:null, pagesAt:0, watchers:[], pingAt:0, wantId:null};

  function onMessage(msg){
    if(info.role==='publish'){
      if(msg.t==='watch'){
        const was=Date.now()<=pub.until; pub.until=Date.now()+LEASE_MS;
        const switched=msg.id&&msg.id!==pub.want; if(msg.id)pub.want=msg.id;
        if(!was||switched){ pub.pagesAt=0; pubTick(); } // a tab he picked: switch now, not at the next tick
        if(msg.fresh&&pub.last&&pub.last.id===msg.id)send(pub.last);
        else if(msg.fresh&&pub.page&&pub.page.id===msg.id){ // nothing kept yet: starting again draws one
          cdpSend('Page.stopScreencast'); startCast();
        }
      }
      else if(msg.t==='input'&&INPUT.indexOf(msg.method)>=0&&pub.page&&msg.id===pub.page.id)cdpSend(msg.method,msg.params);
      else if(msg.t==='start'&&window.desktop.liveStart)window.desktop.liveStart('lupa');
    } else {
      if(msg.t==='pages'){ view.pages={up:!!msg.up,pages:Array.isArray(msg.pages)?msg.pages:[]}; view.pagesAt=Date.now(); }
      else if(msg.t==='frame')view.watchers.forEach(function(w){ if(w.id===msg.id&&w.onFrame)w.onFrame(msg); });
    }
  }
  function ping(){
    if(Date.now()-view.pingAt<PING_MS)return;
    view.pingAt=Date.now();
    send({t:'watch',id:view.wantId});
  }

  // keep the channel up and, on the mini PC, stream while someone watches
  async function tick(){
    const r=await refreshInfo();
    if(!r)return;
    connect();
    if(r.role==='publish')pubTick();
    else if(view.watchers.length)ping();
  }
  setTimeout(tick,4000); setInterval(tick,1000);

  return {
    // this computer watches the mini PC through Supabase (and not over SSH)?
    watching: async function(){ const r=await refreshInfo(); return !!(r&&r.role==='watch'); },
    // its tabs as the mini PC last listed them → {up, pages, quiet} (quiet: nothing heard from it lately)
    pages: function(){
      ping();
      if(!joined)return {up:false,pages:[],quiet:true,connecting:true};
      if(!view.pages||Date.now()-view.pagesAt>8000)return {up:false,pages:[],quiet:true};
      return {up:view.pages.up,pages:view.pages.pages.map(function(p){ return {id:p.id,title:p.title,url:p.url,ws:'relay:'+p.id}; })};
    },
    // a stand-in for the page's socket, for agent-live-view.js liveConnect: frames in, his input out
    socket: function(page){
      const w={id:page.id,readyState:0,onopen:null,onmessage:null,onclose:null,onFrame:null};
      w.onFrame=function(msg){ if(w.onmessage)w.onmessage({data:JSON.stringify({method:'Page.screencastFrame',params:{sessionId:0,data:msg.data,metadata:msg.meta}})}); };
      w.send=function(s){
        let m; try{ m=JSON.parse(s); }catch(e){ return; }
        if(INPUT.indexOf(m.method)>=0)send({t:'input',id:page.id,method:m.method,params:m.params});
      };
      w.again=function(){ send({t:'watch',id:page.id,fresh:true}); }; // no picture yet: ask for one again
      w.close=function(){ w.readyState=3; view.watchers=view.watchers.filter(function(x){ return x!==w; }); };
      view.watchers.push(w); view.wantId=page.id; view.pingAt=Date.now();
      send({t:'watch',id:page.id,fresh:true}); // fresh: send me the picture you have
      setTimeout(function(){ if(w.readyState===0){ w.readyState=1; if(w.onopen)w.onopen(); } },0);
      return w;
    },
    start: function(){ send({t:'start'}); },
  };
})();
