// Unit tests: ytIdOf (UTILS in app.html), the parser behind the dressing room
// video field (show.bgVideo). Whatever the operator pastes, only an
// 11-character id may come out, never a URL, host or parameter.
// Run: node tests/unit/youtube-id.test.js
const fs = require('fs'), assert = require('assert');
const html = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '../../app.html'), 'utf8');
const a = html.indexOf('function ytIdOf(');
assert(a > 0, 'ytIdOf not found in app.html');
const ytIdOf = new Function(html.slice(a, html.indexOf('\n}\n', a) + 3) + '\nreturn ytIdOf;')();

const ID = 'dQw4w9WgXcQ';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const eq = (raw, want) => assert.strictEqual(ytIdOf(raw), want, JSON.stringify(raw));

t('bare id, with whitespace', () => { eq(ID, ID); eq(`  ${ID}\n`, ID); eq('a-b_c-d_e-f', 'a-b_c-d_e-f'); });
t('watch links (www, m, music, no scheme, extra params)', () => {
  eq(`https://www.youtube.com/watch?v=${ID}`, ID);
  eq(`https://youtube.com/watch?v=${ID}&t=42s&list=PL123`, ID);
  eq(`https://www.youtube.com/watch?feature=share&v=${ID}`, ID);
  eq(`https://m.youtube.com/watch?v=${ID}`, ID);
  eq(`https://music.youtube.com/watch?v=${ID}&si=abc`, ID);
  eq(`www.youtube.com/watch?v=${ID}`, ID);
  eq(`http://youtube.com/watch?v=${ID}`, ID);
  eq(`HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`, ID);
});
t('short links, shorts, embed, live, nocookie', () => {
  eq(`https://youtu.be/${ID}`, ID);
  eq(`https://youtu.be/${ID}?si=Xy12&t=3`, ID);
  eq(`youtu.be/${ID}`, ID);
  eq(`https://www.youtube.com/shorts/${ID}`, ID);
  eq(`https://youtube.com/shorts/${ID}?feature=share`, ID);
  eq(`https://www.youtube.com/embed/${ID}?start=10`, ID);
  eq(`https://www.youtube-nocookie.com/embed/${ID}`, ID);
  eq(`https://www.youtube.com/live/${ID}?si=1`, ID);
  eq(`https://www.youtube.com/v/${ID}`, ID);
});
t('not a video: empty', () => {
  for (const v of ['', null, undefined, 42, {}, 'hello', 'dQw4w9WgXc', 'dQw4w9WgXcQQ', 'dQw4w9WgX!Q',
    `https://vimeo.com/${ID}`, `https://evil.example/watch?v=${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`, 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@channel',
    `https://www.youtube.com/playlist?list=${ID}`, `javascript:alert(1)//${ID}`, `ftp://youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}"><script>`, 'https://youtu.be/', 'https://www.youtube.com/watch']) eq(v, '');
});
console.log(`youtube-id: ${n} groups passed`);
