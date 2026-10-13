#!/usr/bin/env node
// Regenerate the booth / Stage View baseline FROM THE PRE-IMPROVEMENT CODE.
//
//   npm run test:update-baseline            # baseline from 845eb0d (default)
//   BASELINE_REF=<sha> npm run test:update-baseline -- --project=booth-chromium
//
// Steps: `git worktree add --detach <tmp> <ref>` -> serve that tree as BASE_ROOT
// -> run the booth projects with --update-snapshots=all -> remove the worktree.
// The harness (mocks, fonts, node_modules, specs) always comes from this
// checkout; only the served site comes from <ref>. Commit the resulting
// tests/booth/__screenshots__ afterwards.
//
// Only regenerate when the baseline itself must change (new scenario, new
// viewport, Playwright/browser upgrade). Never to make a failing comparison
// against changed app code pass: that is exactly what the suite must catch.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ref = process.env.BASELINE_REF || '845eb0d';
const dir = path.join(os.tmpdir(), `stagetimer-baseline-${ref}-${process.pid}`);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'inherit' });

const extra = process.argv.slice(2);
const projects = extra.some((a) => a.startsWith('--project')) ? [] : ['--project=booth-chromium', '--project=booth-webkit'];

console.log(`[baseline] exporting ${ref} to ${dir}`);
git('worktree', 'add', '--detach', dir, ref);
let status = 1;
try {
  if (!fs.existsSync(path.join(dir, 'app.html'))) throw new Error(`no app.html in ${ref}`);
  const r = spawnSync('npx', ['playwright', 'test', ...projects, '--update-snapshots=all', ...extra], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, BASE_ROOT: dir },
  });
  status = r.status ?? 1;
} finally {
  try { git('worktree', 'remove', '--force', dir); } catch (e) { console.warn(`[baseline] could not remove worktree ${dir}: ${e.message}`); }
}
console.log(status === 0
  ? `[baseline] done. Review and commit tests/booth/__screenshots__ (generated from ${ref}).`
  : `[baseline] playwright exited with ${status}`);
process.exit(status);
