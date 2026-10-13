// Unit tests for the pure 3-way merge block in app.html (between
// "// ── 3-way merge (pure" and "// ── end 3-way merge").
// Run: node tests/unit/sync-merge.test.js
const fs=require('fs'),assert=require('assert');
const html=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'../../app.html'),'utf8');
const a=html.indexOf('// ── 3-way merge (pure'),b=html.indexOf('// ── end 3-way merge');
assert(a>0&&b>a);
const M=new Function(html.slice(a,b)+'\nreturn{_mergeData,_eq,_sameContent,_STRIP_PX,_idList};')();
const {_mergeData}=M;
const S=(id,o={})=>({id,stage:'st1',day:'d1',artist:'A'+id,start:'20:00:00',end:'21:00:00',...o});
const base=()=>({stages:[{id:'st1',name:'Main'},{id:'st2',name:'Tent'}],days:[{id:'d1',name:'Day 1'},{id:'d2',name:'Day 2'}],shows:[S('a'),S('b'),S('c')],fohNotes:{a:[{id:'n1',text:'x'}]},activeStage:'st1',activeDay:'d1',timerMode:'live',_rev:'r0'});
const C=o=>JSON.parse(JSON.stringify(o));
const it=()=>({shows:new Set(),days:new Set(),stages:new Set()});
const ids=d=>d.shows.map(s=>s.id).sort().join(',');
let n=0;const t=(name,fn)=>{fn();n++;console.log('ok',name);};

t('empty local over populated server is refused',()=>{
  const B=base(),S0=base();const L={stages:[],shows:[],days:[{id:'x',name:'Day 1'}],fohNotes:{}};
  const r=_mergeData(B,L,S0,{intentional:it()});assert(r.refused);
  const r2=_mergeData(null,L,S0,{intentional:it()});assert(r2.refused,'also without base');
});
t('empty local allowed when everything was deleted on purpose',()=>{
  const S0=base();const i=it();['a','b','c'].forEach(x=>i.shows.add(x));i.stages.add('st1');i.stages.add('st2');
  const r=_mergeData(base(),{stages:[],shows:[],days:base().days},S0,{intentional:i});assert(!r.refused);assert.equal(r.data.shows.length,0);
});
t('intentional delete honoured',()=>{
  const L=base();L.shows=L.shows.filter(s=>s.id!=='b');const i=it();i.shows.add('b');
  const r=_mergeData(base(),L,base(),{intentional:i});assert.equal(ids(r.data),'a,c');assert.equal(r.restored.length,0);
});
t('unregistered missing show restored (staleness)',()=>{
  const L=base();L.shows=L.shows.filter(s=>s.id!=='b');
  const r=_mergeData(base(),L,base(),{intentional:it()});assert.equal(ids(r.data),'a,b,c');assert.deepEqual(r.restored,[{kind:'shows',id:'b'}]);
});
t('stale tab: server additions kept, local edit applied, remote delete stays',()=>{
  const B=base();const Sv=base();Sv.shows=Sv.shows.filter(s=>s.id!=='c');Sv.shows.push(S('d'));
  const L=base();L.shows.find(s=>s.id==='a').artist='EDITED';
  const r=_mergeData(B,L,Sv,{intentional:it()});
  assert.equal(ids(r.data),'a,b,d');assert.equal(r.data.shows.find(s=>s.id==='a').artist,'EDITED');
});
t('remote delete + local edit = kept',()=>{
  const Sv=base();Sv.shows=Sv.shows.filter(s=>s.id!=='c');const L=base();L.shows.find(s=>s.id==='c').note='hi';
  const r=_mergeData(base(),L,Sv,{intentional:it()});assert.equal(ids(r.data),'a,b,c');
});
t('two devices edit different shows / fields of same show',()=>{
  const Sv=base();Sv.shows.find(s=>s.id==='a').artist='REMOTE';Sv.shows.find(s=>s.id==='b').arrived=true;
  const L=base();L.shows.find(s=>s.id==='b').note='local note';L.shows.find(s=>s.id==='c').start='22:00:00';
  const r=_mergeData(base(),L,Sv,{intentional:it()});
  const g=id=>r.data.shows.find(s=>s.id===id);
  assert.equal(g('a').artist,'REMOTE');assert.equal(g('b').arrived,true);assert.equal(g('b').note,'local note');assert.equal(g('c').start,'22:00:00');
});
t('true conflict on same field: local wins',()=>{
  const Sv=base();Sv.shows[0].artist='R';const L=base();L.shows[0].artist='L';
  assert.equal(_mergeData(base(),L,Sv,{intentional:it()}).data.shows[0].artist,'L');
});
t('selection keys always from server unless shared',()=>{
  const L=base();L.activeDay='d2';L.activeStage='st2';L.timerMode='manual';const Sv=base();
  let r=_mergeData(base(),L,Sv,{intentional:it()});assert.equal(r.data.activeDay,'d1');assert.equal(r.data.activeStage,'st1');assert.equal(r.data.timerMode,'live');
  r=_mergeData(base(),L,Sv,{intentional:it(),shared:{activeDay:'d2'}});assert.equal(r.data.activeDay,'d2');assert.equal(r.data.activeStage,'st1');
  assert(M._sameContent(_mergeData(base(),L,Sv,{intentional:it()}).data,Sv,true),'selection-only change = nothing to write');
});
t('stage removal honoured with base, restored without base',()=>{
  const L=base();L.stages=L.stages.filter(s=>s.id!=='st2');
  assert.equal(_mergeData(base(),L,base(),{intentional:it()}).data.stages.length,1);
  assert.equal(_mergeData(null,L,base(),{intentional:it()}).data.stages.length,2);
});
t('day removal needs intent',()=>{
  const L=base();L.days=L.days.filter(d=>d.id!=='d2');
  assert.equal(_mergeData(base(),L,base(),{intentional:it()}).data.days.length,2);
  const i=it();i.days.add('d2');assert.equal(_mergeData(base(),L,base(),{intentional:i}).data.days.length,1);
});
t('fohNotes nested lists merge',()=>{
  const Sv=base();Sv.fohNotes.a.push({id:'n2',text:'remote'});const L=base();L.fohNotes.b=[{id:'n3',text:'local'}];L.fohNotes.a[0].text='edited';
  const r=_mergeData(base(),L,Sv,{intentional:it()});
  assert.equal(r.data.fohNotes.a.length,2);assert.equal(r.data.fohNotes.a[0].text,'edited');assert.equal(r.data.fohNotes.b[0].text,'local');
});
t('stripped photo placeholder never overwrites server photo',()=>{
  const B=base();B.shows[0].photo=M._STRIP_PX;const L=C(B);const Sv=base();Sv.shows[0].photo='data:image/jpeg;base64,REAL';
  assert.equal(_mergeData(B,L,Sv,{intentional:it()}).data.shows[0].photo,'data:image/jpeg;base64,REAL');
  const L2=C(B);L2.shows[0].artist='x';const B2=base();B2.shows[0].photo='data:image/jpeg;base64,REAL';
  const r2=_mergeData(B2,L2,B2,{intentional:it()}).data.shows[0];
  assert.equal(r2.photo,'data:image/jpeg;base64,REAL');assert.equal(r2.artist,'x');
  const L3=base();L3.shows.push(S('new',{photo:M._STRIP_PX}));
  assert(!('photo' in _mergeData(base(),L3,base(),{intentional:it()}).data.shows.find(s=>s.id==='new')),'placeholder without server value dropped');
});
t('key order from JSONB does not count as a change',()=>{
  const Sv=base();Sv.shows=Sv.shows.map(s=>Object.fromEntries(Object.entries(s).reverse()));
  assert(M._eq(base().shows,Sv.shows));
});
t('local key deletion honoured',()=>{
  const B=base();B.cue={text:'x'};const L=C(B);delete L.cue;assert(!('cue' in _mergeData(B,L,C(B),{intentional:it()}).data));
});
t('server-only new top-level key kept, local new key kept',()=>{
  const Sv=base();Sv.svModes={st1:'clock'};const L=base();L.blackout=true;
  const r=_mergeData(base(),L,Sv,{intentional:it()});assert.equal(r.data.svModes.st1,'clock');assert.equal(r.data.blackout,true);
});
t('base unknown: local wins changed fields, server-only shows kept',()=>{
  const Sv=base();Sv.shows.push(S('z'));const L=base();L.shows[0].artist='L';L.shows.push(S('y'));
  const r=_mergeData(null,L,Sv,{intentional:it()});assert.equal(ids(r.data),'a,b,c,y,z');assert.equal(r.data.shows[0].artist,'L');
});
t('duplicate ids fall back without throwing',()=>{
  const L=base();L.shows.push(S('a'));const r=_mergeData(base(),L,base(),{intentional:it()});assert(!r.refused);
});
t('order: server order kept unless locally reordered',()=>{
  const Sv=base();Sv.stages.reverse();const L=base();L.stages.push({id:'st3',name:'New'});
  assert.deepEqual(_mergeData(base(),L,Sv,{intentional:it()}).data.stages.map(s=>s.id),['st2','st1','st3']);
  const L2=base();L2.stages.reverse();assert.deepEqual(_mergeData(base(),L2,base(),{intentional:it()}).data.stages.map(s=>s.id),['st2','st1']);
});
t('_rev never merged from local',()=>{const L=base();L._rev='old';assert(!('_rev' in _mergeData(base(),L,base(),{}).data));});
console.log(n,'tests passed');
