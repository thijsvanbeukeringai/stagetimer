// Unit tests: show.rider = {drinks, tech} through the pure 3-way merge in
// app.html (_mergeData). The rider is a nested object, so the merge goes per
// subfield: two operators editing drinks and tech of the same show must not
// overwrite each other. The drawer (_drApplyRider) writes only the fields it
// edited and keeps a cleared rider as {} so these cases hold in the app too.
// Run: node tests/unit/rider-merge.test.js
const fs = require('fs'), assert = require('assert');
const html = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '../../app.html'), 'utf8');
const a = html.indexOf('// ── 3-way merge (pure'), b = html.indexOf('// ── end 3-way merge');
assert(a > 0 && b > a);
const { _mergeData } = new Function(html.slice(a, b) + '\nreturn{_mergeData};')();

const S = (id, o = {}) => ({ id, stage: 'st1', day: 'd1', artist: 'A' + id, start: '20:00:00', end: '21:00:00', ...o });
const proj = (shows) => ({ stages: [{ id: 'st1', name: 'Main' }], days: [{ id: 'd1', name: 'Day 1' }], shows, activeStage: 'st1', activeDay: 'd1', timerMode: 'live' });
const C = (o) => JSON.parse(JSON.stringify(o));
const it = () => ({ shows: new Set(), days: new Set(), stages: new Set() });
// Merge one show: base / local / server rider (undefined = no rider key).
function merge(bR, lR, sR, extra = {}) {
  const mk = (r, o = {}) => proj([S('a', { ...(r === undefined ? {} : { rider: C(r) }), ...o }), S('b')]);
  const r = _mergeData(mk(bR), mk(lR, extra.local), mk(sR, extra.server), { intentional: it() });
  assert(!r.refused);
  return r.data.shows.find((s) => s.id === 'a');
}
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('drinks added here, tech added elsewhere (no rider before): both kept', () => {
  assert.deepStrictEqual(merge(undefined, { drinks: 'Water' }, { tech: '2x CDJ' }).rider, { drinks: 'Water', tech: '2x CDJ' });
});
t('drinks edited here, tech edited elsewhere: both edits kept', () => {
  const B = { drinks: 'Water', tech: 'CDJ' };
  assert.deepStrictEqual(merge(B, { drinks: 'Beer', tech: 'CDJ' }, { drinks: 'Water', tech: 'Turntables' }).rider, { drinks: 'Beer', tech: 'Turntables' });
});
t('same subfield edited on both sides: ours wins, the other subfield untouched', () => {
  const B = { drinks: 'Water', tech: 'CDJ' };
  assert.deepStrictEqual(merge(B, { drinks: 'Beer', tech: 'CDJ' }, { drinks: 'Cola', tech: 'CDJ' }).rider, { drinks: 'Beer', tech: 'CDJ' });
});
t('last field cleared here ({}) while tech was added elsewhere: tech survives', () => {
  assert.deepStrictEqual(merge({ drinks: 'Water' }, {}, { drinks: 'Water', tech: 'CDJ' }).rider, { tech: 'CDJ' });
});
t('a field cleared here, nothing changed elsewhere: it is gone', () => {
  assert.deepStrictEqual(merge({ drinks: 'Water', tech: 'CDJ' }, { tech: 'CDJ' }, { drinks: 'Water', tech: 'CDJ' }).rider, { tech: 'CDJ' });
});
t('rider removed elsewhere, untouched here: stays removed', () => {
  assert(!('rider' in merge({ drinks: 'Water' }, { drinks: 'Water' }, undefined)));
});
t('rider untouched here, edited elsewhere: server value (a stale tab never reverts it)', () => {
  assert.deepStrictEqual(merge({ drinks: 'Water' }, { drinks: 'Water' }, { drinks: 'Water\nIce' }).rider, { drinks: 'Water\nIce' });
});
t('check-in elsewhere + rider edit here on the same show: both kept', () => {
  const s = merge(undefined, { tech: 'Mic' }, undefined, { server: { arrived: true, arrivedAt: 1 } });
  assert.deepStrictEqual(s.rider, { tech: 'Mic' });
  assert.strictEqual(s.arrived, true);
});
t('rider on another show does not touch this one', () => {
  const B = proj([S('a'), S('b')]);
  const L = C(B); L.shows[0].rider = { drinks: 'Water' };
  const Sv = C(B); Sv.shows[1].rider = { tech: 'CDJ' };
  const r = _mergeData(B, L, Sv, { intentional: it() }).data.shows;
  assert.deepStrictEqual([r[0].rider, r[1].rider], [{ drinks: 'Water' }, { tech: 'CDJ' }]);
});
console.log(n, 'tests passed');
