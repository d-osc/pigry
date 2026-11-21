// One-shot WH-01 scrub: reads the two SEED_TEST_KEYS literals from
// src/lib/aiProviders.ts (pre-patch), then replaces every occurrence in text
// files on disk (the source file itself is rewritten by the follow-up patch).
// Contains no secrets itself; delete after use.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const src = readFileSync('src/lib/aiProviders.ts', 'utf8');
const lines = src.split(/\r?\n/);
const start = lines.findIndex((l) => l.includes('SEED_TEST_KEYS = ['));
if (start < 0) throw new Error('SEED_TEST_KEYS not found (already patched?)');
const keys = [];
for (const line of lines.slice(start + 1, start + 10)) {
  if (line.includes('];')) break;
  const m = /^\s*'([^']*)',?\s*$/.exec(line);
  if (m) keys.push(m[1]);
}
if (keys.length !== 2) throw new Error(`expected 2 seed keys, got ${keys.length}`);

const digest = (s) => createHash('sha256').update(s).digest('hex');
const replacements = keys.map((k, i) => ({
  from: k,
  to: `[redacted-seed-key-${i + 1}:${digest(k).slice(0, 12)}]`,
  probe: k.slice(20, 40),
}));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'target', 'playwright-report', 'test-results']);
const TEXT_EXT = new Set(['.json', '.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.txt', '.html', '.css', '.rs', '.toml', '.yml', '.yaml', '.sh', '.ps1', '.vue']);
let total = 0;
const touched = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    const dot = name.lastIndexOf('.');
    if (dot < 0 || !TEXT_EXT.has(name.slice(dot))) continue;
    const rel = relative('.', p).split(sep).join('/');
    if (rel === 'src/lib/aiProviders.ts') continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    let changed = false;
    for (const r of replacements) {
      if (!text.includes(r.from)) continue;
      const count = text.split(r.from).length - 1;
      text = text.split(r.from).join(r.to);
      changed = true;
      total += count;
      console.log(`${rel}: redacted ${count}x (probe ${r.probe.slice(0, 4)}…)`);
    }
    if (changed) { writeFileSync(p, text); touched.push(rel); }
  }
}
walk('.');
console.log(`files touched: ${touched.length}, total replacements: ${total}`);
