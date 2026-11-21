// Repo-wide probe for WH-01 key fragments (no full secrets in this file).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const probes = ['MEQCIEy6iulOjWXOLgPw', 'kN4JqIlzCGV9mdkx', 'sk-sp-H.DIMED', 'c466230fbad7'];
const SKIP = new Set(['.git', 'node_modules', 'dist', 'target', 'playwright-report', 'test-results']);
let hits = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const f = join(dir, name);
    let st;
    try { st = statSync(f); } catch { continue; }
    if (st.isDirectory()) { walk(f); continue; }
    let t;
    try { t = readFileSync(f, 'utf8'); } catch { continue; }
    for (const pr of probes) {
      const c = t.split(pr).length - 1;
      if (c > 0) { hits += c; console.log(`${f}  x${c}  ${pr.slice(0, 8)}…`); }
    }
  }
})('.');
console.log(hits === 0 ? 'CLEAN: no fragments found' : `TOTAL fragments: ${hits}`);
