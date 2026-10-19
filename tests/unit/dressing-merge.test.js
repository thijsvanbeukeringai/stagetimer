// Unit tests: the dressing room fields show.bgVideo / show.bgImage through the
// pure 3-way merge in app.html (_mergeData). saveShow deletes the key when
// the field is emptied, so "cleared here" means the key is missing locally.
// Run: node tests/unit/dressing-merge.test.js
const fs = require('fs'), assert = require('assert');
const html = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '../../app.html'), 'utf8');
const a = html.indexOf('// ── 3-way merge (pure'), b = html.indexOf('// ── end 3-way merge');
assert(a > 0 && b > a);
const { _mergeData } = new Function(html.slice(a, b) + '\nreturn{_mergeData};')();

const S = (id, o = {}) => ({ id, stage: 'st1', day: 'd1', artist: 'A' + id, start: '20:00:00', end: '21:00:00', ...o });
const proj = (shows) => ({ stages: [{ id: 'st1', name: 'Main' }], days: [{ id: 'd1', name: 'Day 1' }], shows, activeStage: 'st1', activeDay: 'd1', timerMode: 'live' });
const it = () => ({ shows: new Set(), days: new Set(), stages: new Set() });
// One show 'a': base / local / server extra fields (undefined = key absent).
function merge(bO, lO, sO) {
  const mk = (o) => proj([S('a', o || {}), S('b')]);
  const r = _mergeData(mk(bO), mk(lO), mk(sO), { intentional: it() });
  assert(!r.refused);
  return r.data.shows.find((s) => s.id === 'a');
}
const V1 = 'dQw4w9WgXcQ', V2 = 'aaaaaaaaaaa', IMG = 'https://x.supabase.co/storage/v1/object/public/project-media/p/1.jpg';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('video set here, nothing elsewhere: kept', () => { assert.strictEqual(merge({}, { bgVideo: V1 }, {}).bgVideo, V1); });
t('video cleared here (key deleted), untouched elsewhere: gone', () => {
  assert(!('bgVideo' in merge({ bgVideo: V1 }, {}, { bgVideo: V1 })));
});
t('video changed elsewhere, untouched here: server value', () => {
  assert.strictEqual(merge({ bgVideo: V1 }, { bgVideo: V1 }, { bgVideo: V2 }).bgVideo, V2);
});
t('video cleared elsewhere, untouched here: stays cleared', () => {
  assert(!('bgVideo' in merge({ bgVideo: V1 }, { bgVideo: V1 }, {})));
});
t('video here, photo elsewhere on the same show: both kept (per field)', () => {
  const s = merge({}, { bgVideo: V1 }, { bgImage: IMG });
  assert.deepStrictEqual([s.bgVideo, s.bgImage], [V1, IMG]);
});
t('background photo cleared here while the note changed elsewhere: both apply', () => {
  const s = merge({ bgImage: IMG, note: 'x' }, { note: 'x' }, { bgImage: IMG, note: 'y' });
  assert(!('bgImage' in s));
  assert.strictEqual(s.note, 'y');
});
t('both sides changed the video: ours wins', () => {
  assert.strictEqual(merge({ bgVideo: V1 }, { bgVideo: V2 }, { bgVideo: 'bbbbbbbbbbb' }).bgVideo, V2);
});
console.log(`dressing-merge: ${n} cases passed`);
