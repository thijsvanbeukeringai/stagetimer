// Node harness: evaluates the APP STATE .. setupRealtime region of app.html
// (plus _friendlyError and the check-in write path) with a fake Supabase REST
// backend, fake localStorage and fake realtime channel. No network: fetch is
// an in-memory stub. Run: node tests/unit/sync-engine.test.js
// Covers save retries (500 / network / timeout / 401), wipe guard, intentional
// deletes vs staleness, two-device merges, single flight, echoes, quota,
// per-device selection and both public check-in branches (RPC / fallback).
const fs=require('fs'),assert=require('assert');
const html=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'../../app.html'),'utf8');
const a=html.indexOf('// ══ APP STATE (multi-project)'),b=html.indexOf('// ── Overnight day boundary');
const fe=html.indexOf('function _friendlyError(');const friendly=html.slice(fe,html.indexOf('\n}\n',fe)+3);
const ca=html.indexOf('// In-flight tracker so the 1s poll'),cb=html.indexOf('function copyLink(btn,url){');
const region=friendly+html.slice(a,b)+html.slice(ca,cb);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SPEED=50; // backoff 1s -> 20ms

function makeEnv(server,opts={}){
  const store=new Map();let quota=opts.quota||Infinity;
  const localStorage={getItem:k=>store.has(k)?store.get(k):null,removeItem:k=>store.delete(k),
    setItem:(k,v)=>{v=String(v);if(v.length>quota){const e=new Error('quota');e.name='QuotaExceededError';throw e;}store.set(k,v);}};
  const listeners={};
  const window={addEventListener:(t,f)=>{(listeners[t]=listeners[t]||[]).push(f);},dispatchEvent:()=>{},PUBLIC_MODE:opts.publicMode||null};
  const dot={className:'',title:''};
  const document={getElementById:id=>id==='sync-dot'?dot:{classList:{contains:()=>false}},addEventListener:(t,f)=>{(listeners['doc:'+t]=listeners['doc:'+t]||[]).push(f);},visibilityState:'visible'};
  const log=[];
  const fetch=async(url,init={})=>{
    const m=init.method||'GET';log.push(m+' '+url.replace(/^.*rest\/v1\//,''));
    if(init.signal&&server.hang){await new Promise((_,rej)=>init.signal.addEventListener('abort',()=>{const e=new Error('aborted');e.name='AbortError';rej(e);}));}
    if(server.delay)await new Promise(r=>setTimeout(r,server.delay));
    if(m==='PATCH'){server.inPatch=(server.inPatch||0)+1;server.maxInPatch=Math.max(server.maxInPatch||0,server.inPatch);}
    try{return await handle(url,init,m);}finally{if(m==='PATCH')server.inPatch--;}
  };
  const handle=async(url,init,m)=>{
    const f=server.failNext.shift();
    if(f==='net')throw new TypeError('Failed to fetch');
    const auth=(init.headers||{}).Authorization;
    if(f&&f.status)return resp(f.status,f.body||'{"message":"boom"}');
    if(server.requireToken&&auth!=='Bearer '+server.requireToken)return resp(401,'{"message":"JWT expired"}');
    const u=new URL(url);
    if(m==='GET'){
      if(u.searchParams.get('id'))return resp(200,JSON.stringify([{id:server.row.id,name:server.row.name,data:server.row.data}]));
      return resp(200,JSON.stringify([{...server.row}]));
    }
    if(m==='PATCH'){
      const body=JSON.parse(init.body);server.row.data=body.data;server.writes.push(JSON.parse(init.body));
      server.onWrite&&server.onWrite(body);
      return resp(200,JSON.stringify([{id:server.row.id}]));
    }
    return resp(404,'');
  };
  function resp(status,txt){return{ok:status>=200&&status<300,status,text:async()=>txt,json:async()=>JSON.parse(txt)};}
  let rtHandler=null,rtStatus=null;
  const chan={on(ev,filt,fn){if(filt.table==='projects'&&filt.event==='*')rtHandler=fn;this.filters=(this.filters||[]).concat([filt]);return this;},subscribe(cb){rtStatus=cb;setTimeout(()=>cb('SUBSCRIBED'),0);return this;}};
  const supa={channel:()=>chan,removeChannel:()=>{}};
  const renders={all:0};
  const g={localStorage,window,document,fetch,supa,
    setTimeout:(f,ms)=>setTimeout(f,(ms||0)/SPEED),clearTimeout,setInterval:()=>0,
    navigator:{onLine:true},CustomEvent:function(){},
    SUPA_URL:'https://x.supabase.co',SUPA_KEY:'anon',
    _jwt:()=>server.token||'anon',setSyncDot:s=>{dot.className=s;},
    supabase:null,uid:()=>Math.random().toString(36).slice(2,9),fmtDateLabel:d=>d,festivalDayStr:()=>opts.today||'2026-10-13',
    renderAll:()=>{renders.all++;},refreshLogo:()=>{},renderFOH(){},renderBS(){},renderTL(){},renderCI(){},renderWV(){},renderDash(){},renderAdmin(){},renderOV(){},renderSV(){},
    CURRENT_USER:{id:'u1',companyId:'co1',role:'operator'},isAdmin:()=>false,PUBLIC_PID:opts.publicMode?'p1':null,PUBLIC_SID:null,PUBLIC_MODE:opts.publicMode||null,
    _refreshAuthToken:opts.refresh||undefined,renderSched(){},alert:m=>{server.alerts=(server.alerts||[]).concat([m]);},
    _rpc:async(fn,args)=>{server.rpcCalls=(server.rpcCalls||0)+1;if(!server.rpcExists){const e=new Error('HTTP 404 - {"code":"PGRST202","message":"Could not find the function public.set_show_arrived"}');e.status=404;throw e;}
      const t=server.row.data.shows.find(x=>x.id===args.p_show_id);t.arrived=args.p_arrived;t.arrivedAt=args.p_arrived_at;return JSON.parse(JSON.stringify(server.row.data));},AbortController,URL,JSON,Promise,Map,Set,Date,Math,console:opts.verbose?console:{log(){},warn(){},error(){}},
  };
  const names=Object.keys(g);
  const fn=new Function(...names,region+`
    return {get APP(){return APP},set APP(v){APP=v},get G(){return G},set G(v){G=v},
      loadAPPCache,loadAPPRemote,loadG,save,setupRealtime,_pendingPush,_sync,_base,_markIntentionalRemoval,
      getSaveState,_selChanged,_whenSaved,_cacheAPP,humanError,ciToggleArrived};`);
  const app=fn(...names.map(k=>g[k]));
  return{app,g,dot,log,store,fire:(t)=>(listeners[t]||[]).forEach(f=>f()),rt:p=>rtHandler&&rtHandler(p),rtStatus:s=>rtStatus&&rtStatus(s),renders};
}
const S=(id,o={})=>({id,stage:'st1',day:'d1',artist:'A'+id,start:'20:00:00',end:'21:00:00',...o});
function newServer(){return{row:{id:'p1',name:'Fest',company_id:'co1',created_at:1,data:{stages:[{id:'st1',name:'Main'}],days:[{id:'d1',name:'Day 1',date:'2026-10-13'},{id:'d2',name:'Day 2',date:'2026-10-14'}],shows:[S('a'),S('b'),S('c'),S('d'),S('e'),S('f')],fohNotes:{},activeStage:'st1',activeDay:'d1',timerMode:'live'}},failNext:[],writes:[]};}
async function boot(server,opts){
  const e=makeEnv(server,opts);
  e.store.set('st_active_proj','p1');
  e.app.loadAPPCache();await e.app.loadAPPRemote();e.app.APP.activeProjectId='p1';e.app.loadG();e.app.setupRealtime();
  await sleep(5);
  return e;
}
const settle=async(e,ms=400)=>{const t=Date.now();while(Date.now()-t<ms){if(!Object.values(e.app._pendingPush).some(Boolean)&&!Object.values(e.app._sync).some(s=>s.inflight))return;await sleep(5);}};
let n=0;const T=async(name,fn)=>{await fn();n++;console.log('ok',name);};

(async()=>{
await T('normal save: PATCH sends merged blob with _rev, state saved',async()=>{
  const sv=newServer();const e=await boot(sv);
  e.app.G.shows[0].artist='X';e.app.save();await settle(e);
  assert.equal(sv.row.data.shows[0].artist,'X');assert(sv.row.data._rev);assert.equal(e.app.getSaveState().state,'saved');assert.equal(e.dot.className,'ok');
  assert.deepEqual(Object.keys(sv.writes[0]),['data'],'only data column is written');
});
await T('realtime payload without data -> refetch, lineup intact, next save keeps shows',async()=>{
  const sv=newServer();const e=await boot(sv);
  e.log.length=0;e.rt({eventType:'UPDATE',new:{id:'p1',name:'Fest'}});await sleep(20);
  assert.equal(e.app.G.shows.length,6);assert(e.log.some(l=>l.startsWith('GET projects?id=eq.p1')),'refetched');
  e.app.save();await settle(e);assert.equal(sv.row.data.shows.length,6);
});
await T('empty local over populated server refused, state unsaved',async()=>{
  const sv=newServer();const e=await boot(sv);
  e.app.APP.projects[0].data={};e.app.loadG();e.app.save();await settle(e);
  assert.equal(sv.writes.length,0);assert.equal(e.app.G.shows.length,6);assert.equal(e.app.getSaveState().state,'unsaved');assert.equal(e.dot.className,'err');
});
await T('500 keeps pending + retries with backoff, then saved',async()=>{
  const sv=newServer();const e=await boot(sv);
  sv.failNext.push({status:500},{status:503});
  e.app.G.shows[0].artist='Y';e.app.save({immediate:true});await sleep(5);
  assert.equal(e.app._pendingPush.p1,true);
  await sleep(10);assert.equal(e.app.getSaveState().state,'unsaved');assert(/server had a problem/i.test(e.app.getSaveState().detail));
  await settle(e,1500);
  assert.equal(sv.row.data.shows[0].artist,'Y');assert.equal(e.app._pendingPush.p1,false);assert.equal(e.app.getSaveState().state,'saved');
});
await T('network error then online event retries immediately',async()=>{
  const sv=newServer();const e=await boot(sv);
  sv.failNext.push('net');e.app.G.shows[1].artist='Z';e.app.save({immediate:true});await sleep(10);
  assert.equal(e.app._pendingPush.p1,true);
  e.fire('online');await settle(e);assert.equal(sv.row.data.shows[1].artist,'Z');
});
await T('401 -> _refreshAuthToken -> retry once succeeds',async()=>{
  const sv=newServer();let refreshed=0;
  const e=await boot(sv,{refresh:async()=>{refreshed++;sv.token='fresh';return true;}});
  sv.requireToken='fresh';sv.token='stale';
  e.app.G.shows[2].artist='Q';e.app.save({immediate:true});await settle(e);
  assert.equal(refreshed,1);assert.equal(sv.row.data.shows[2].artist,'Q');assert.equal(e.app.getSaveState().state,'saved');
});
await T('401 without refresh helper -> unsaved session message, still pending',async()=>{
  const sv=newServer();const e=await boot(sv);sv.requireToken='nope';
  e.app.G.shows[2].artist='Q';e.app.save({immediate:true});await sleep(15);
  assert.equal(e.app._pendingPush.p1,true);assert(/session has expired/.test(e.app.getSaveState().detail)&&/retried automatically/.test(e.app.getSaveState().detail));
});
await T('intentional delete is saved, not reverted',async()=>{
  const sv=newServer();const e=await boot(sv);
  e.app._markIntentionalRemoval(['b']);e.app.G.shows=e.app.G.shows.filter(s=>s.id!=='b');e.app.save();await settle(e);
  assert(!sv.row.data.shows.some(s=>s.id==='b'));assert.equal(e.app.getSaveState().state,'saved');
});
await T('stale tab missing shows: merged back, not clobbered, notice shown',async()=>{
  const sv=newServer();const e=await boot(sv);
  e.app.G.shows=e.app.G.shows.filter(s=>!['a','b','c','d','e'].includes(s.id));e.app.G.shows[0].artist='F!';e.app.save();await settle(e);
  assert.equal(sv.row.data.shows.length,6);assert.equal(sv.row.data.shows.find(s=>s.id==='f').artist,'F!');
  assert.equal(e.app.G.shows.length,6,'local copy repaired');assert.equal(e.app.getSaveState().state,'unsaved');assert(/Check the lineup/.test(e.app.getSaveState().detail));
});
await T('two devices editing different shows both survive',async()=>{
  const sv=newServer();const A=await boot(sv),B=await boot(sv);
  A.app.G.shows[0].artist='fromA';B.app.G.shows[1].artist='fromB';B.app.G.shows.push(S('g'));
  A.app.save();B.app.save();await settle(A);await settle(B);
  const g=id=>sv.row.data.shows.find(s=>s.id===id);
  assert.equal(g('a').artist,'fromA');assert.equal(g('b').artist,'fromB');assert(g('g'));
  // A sees B's changes after its realtime event
  A.rt({eventType:'UPDATE',new:{id:'p1',name:'Fest',data:JSON.parse(JSON.stringify(sv.row.data))}});
  assert.equal(A.app.G.shows.find(s=>s.id==='b').artist,'fromB');
});
await T('single flight: saves during a push coalesce, no concurrent PATCH',async()=>{
  const sv=newServer();const e=await boot(sv);sv.delay=15;
  for(let i=0;i<5;i++){e.app.G.shows[0].artist='v'+i;e.app.save({immediate:true});await sleep(4);}
  await settle(e,800);
  assert.equal(sv.row.data.shows[0].artist,'v4');assert(sv.writes.length<=3,'coalesced: '+sv.writes.length);assert.equal(sv.maxInPatch,1,'never two PATCHes at once');
});
await T('own echo ignored; stale echo triggers refetch instead of rollback',async()=>{
  const sv=newServer();const e=await boot(sv);
  e.app.G.shows[0].artist='one';e.app.save({immediate:true});await settle(e);const v1=JSON.parse(JSON.stringify(sv.row.data));
  e.app.G.shows[0].artist='two';e.app.save({immediate:true});await settle(e);const v2=JSON.parse(JSON.stringify(sv.row.data));
  const r0=e.renders.all;e.log.length=0;
  e.rt({eventType:'UPDATE',new:{id:'p1',data:v2}});assert.equal(e.renders.all,r0,'own latest echo: no re-render');
  e.rt({eventType:'UPDATE',new:{id:'p1',data:v1}});await sleep(20);
  assert.equal(e.app.G.shows[0].artist,'two','no rollback');assert(e.log.some(l=>l.startsWith('GET')),'verified via refetch');
});
await T('foreign realtime update while local edits pending is merged, not dropped',async()=>{
  const sv=newServer();const e=await boot(sv);
  e.app.G.shows[3].artist='mine';e.app.save(); // debounced, not yet sent
  const other=JSON.parse(JSON.stringify(sv.row.data));other.shows[4].artist='theirs';sv.row.data=other;
  e.rt({eventType:'UPDATE',new:{id:'p1',data:JSON.parse(JSON.stringify(other))}});
  assert.equal(e.app.G.shows[4].artist,'theirs');assert.equal(e.app.G.shows[3].artist,'mine');
  await settle(e);assert.equal(sv.row.data.shows[3].artist,'mine');assert.equal(sv.row.data.shows[4].artist,'theirs');
});
await T('quota exceeded: cache falls back to photo-stripped copy, push still happens',async()=>{
  const sv=newServer();sv.row.data.shows[0].photo='data:image/jpeg;base64,'+'A'.repeat(5000);
  const e=await boot(sv,{quota:4000});
  e.app.G.shows[1].artist='q';e.app.save();await settle(e);
  assert.equal(sv.row.data.shows[1].artist,'q');assert(sv.row.data.shows[0].photo.length>5000,'server photo intact');
  const cached=JSON.parse(e.store.get('st_app_v1'));assert(cached.projects[0].data.shows[0].photo.startsWith('data:image/gif'),'stripped cache');
});
await T('stripped cache + offline start never pushes a photo removal',async()=>{
  const sv=newServer();sv.row.data.shows[0].photo='data:image/jpeg;base64,'+'A'.repeat(5000);
  const e=makeEnv(sv,{quota:4000});
  // previous session wrote a stripped cache
  const PX='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const d=JSON.parse(JSON.stringify(sv.row.data));d.shows[0].photo=PX;
  e.store.set('st_app_v1',JSON.stringify({companies:[],users:[],projects:[{id:'p1',name:'Fest',data:d}],activeProjectId:'p1'}));
  e.app.loadAPPCache();e.app.APP.activeProjectId='p1';e.app.loadG(); // offline: no loadAPPRemote
  e.app.G.shows[0].artist='edited offline';e.app.save();await settle(e);
  assert(sv.row.data.shows[0].photo.startsWith('data:image/jpeg'));assert.equal(sv.row.data.shows[0].artist,'edited offline');
});
await T('per-device selection: no blob write, stored per device, does not leak',async()=>{
  const sv=newServer();sv.row.data.days[1].date='2026-10-20';
  const A=await boot(sv,{today:'2026-10-13'}),B=await boot(sv,{today:'2026-10-13'});
  A.app.G.activeDay='d2';A.app._selChanged('day');await settle(A);
  assert.equal(sv.writes.length,0,'browsing to another day does not save');
  assert.equal(JSON.parse(A.store.get('st_sel_p1')).activeDay,'d2');
  A.app.G.shows[0].artist='x';A.app.save();await settle(A);
  assert.equal(sv.row.data.activeDay,'d1','selection did not leak with another edit');
  B.rt({eventType:'UPDATE',new:{id:'p1',data:JSON.parse(JSON.stringify(sv.row.data))}});assert.equal(B.app.G.activeDay,'d1');
  A.app.loadG();assert.equal(A.app.G.activeDay,'d2','own selection survives reload of G');
  A.app.G.activeDay='d1';A.app._selChanged('day');await settle(A); // today: already the blob value -> no write
  assert.equal(sv.writes.length,1);
  A.app.G.timerMode='manual';A.app._selChanged('mode');await settle(A);assert.equal(sv.row.data.timerMode,'live');
});
await T('legacy: no day dated today -> selected day is still shared (old public screens)',async()=>{
  const sv=newServer();sv.row.data.days.forEach(d=>delete d.date);const A=await boot(sv);
  A.app.G.activeDay='d2';A.app._selChanged('day');await settle(A);assert.equal(sv.row.data.activeDay,'d2');
});
await T('timeout keeps unsaved and retries',async()=>{
  const sv=newServer();const e=await boot(sv);sv.hang=true;
  // _sbFetch uses a 10s/15s ceiling; harness setTimeout is /50 -> 200-300ms
  e.app.G.shows[0].artist='slow';e.app.save({immediate:true});await sleep(260);
  assert.equal(e.app._pendingPush.p1,true);assert(/timed out/.test(e.app.getSaveState().detail));
  sv.hang=false;await settle(e,1500);assert.equal(sv.row.data.shows[0].artist,'slow');
});
await T('humanError mapping',async()=>{
  const e=makeEnv(newServer());const h=e.app.humanError;
  assert(/permission/.test(h({status:403})));assert(/too large/.test(h({status:413})));assert(/conflicts/.test(h(new Error('HTTP 409 - x'))));
  const q=new Error('x');q.name='QuotaExceededError';assert(/storage/.test(h(q)));assert(/no connection/.test(h(new TypeError('Failed to fetch'))));
});
await T('public mode: save() never writes',async()=>{
  const sv=newServer();const e=makeEnv(sv,{publicMode:'checkin'});
  e.app.APP={companies:[],users:[],projects:[{id:'p1',name:'F',data:JSON.parse(JSON.stringify(sv.row.data))}],activeProjectId:'p1'};e.app.loadG();
  e.app.G.shows=[];e.app.save({immediate:true});await sleep(20);assert.equal(sv.writes.length,0);assert(!e.store.has('st_app_v1'));
});
for(const rpcExists of [true,false])await T('public check-in '+(rpcExists?'via RPC':'fallback (RPC missing): fresh read, one show, remembered'),async()=>{
  const sv=newServer();sv.rpcExists=rpcExists;const e=makeEnv(sv,{publicMode:'checkin'});
  e.app.APP={companies:[],users:[],projects:[{id:'p1',name:'F',data:JSON.parse(JSON.stringify(sv.row.data))}],activeProjectId:'p1'};e.app.loadG();
  // operator edits land on the server after this screen loaded
  sv.row.data.shows[1].artist='operator edit';sv.row.data.shows.push(S('new'));
  const p=e.app.ciToggleArrived('a');e.app.ciToggleArrived('a'); // double tap
  await p;
  assert.equal(sv.row.data.shows[0].arrived,true,'arrived saved');assert.equal(sv.row.data.shows[1].artist,'operator edit','no stale clobber');
  assert(sv.row.data.shows.some(s=>s.id==='new'));assert.equal(sv.writes.length,rpcExists?0:1,'one write for a double tap');
  assert.equal(e.app.G.shows[0].arrived,true);assert(!sv.alerts);
  await e.app.ciToggleArrived('b');assert.equal(sv.rpcCalls,rpcExists?2:1,'missing RPC remembered for the session');
});
await T('operator check-in: merged per field, taps blocked until saved',async()=>{
  const sv=newServer();sv.delay=10;const e=await boot(sv);
  sv.row.data.shows[0].note='set elsewhere';
  e.app.ciToggleArrived('a');e.app.ciToggleArrived('a');await settle(e);
  assert.equal(sv.row.data.shows[0].arrived,true);assert.equal(sv.row.data.shows[0].note,'set elsewhere');
});
console.log(n,'e2e tests passed');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
