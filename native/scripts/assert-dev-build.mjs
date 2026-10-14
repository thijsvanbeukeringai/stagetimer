#!/usr/bin/env node
// Guard for simulator builds (npm run ios:build-sim): refuse when the web app
// copied into the Xcode project still talks to the production Supabase
// project. A simulator build is for testing, and testing never touches
// production (CLAUDE.md rule 2). Run `npm run sync:dev` first.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = join(NATIVE, 'ios', 'App', 'App', 'public', 'index.html');
if (!existsSync(html)) { console.error('\n[assert-dev-build] no ios/App/App/public/index.html: run `npm run sync:dev` first\n'); process.exit(1); }
const text = readFileSync(html, 'utf8');
if (text.includes('bamjpsquhdzxvsymldpq.supabase.co')) {
  console.error('\n[assert-dev-build] REFUSED: this build contains the PRODUCTION backend.\n' +
    'Simulator builds must use a dev backend: npm run sync:dev [-- --backend http://localhost:<port>]\n');
  process.exit(1);
}
const m = text.match(/const SUPA_URL\s*=\s*['"]([^'"]+)['"]/);
console.log(`[assert-dev-build] ok, backend ${m ? m[1] : '(SUPA_URL not found)'}`);
