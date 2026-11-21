// Dev helper: extract the two SEED_TEST_KEYS literals straight from
// src/lib/aiProviders.ts and print their exact length + SHA-256 digest.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/lib/aiProviders.ts', 'utf8');
const re = /^\s*'([^']*)',?\s*$/;
const lines = src.split(/\r?\n/);
const inBlock = lines.findIndex((l) => l.includes('SEED_TEST_KEYS = ['));
if (inBlock < 0) throw new Error('SEED_TEST_KEYS not found');
const keys = [];
for (const line of lines.slice(inBlock + 1, inBlock + 10)) {
  if (line.includes('];')) break;
  const m = re.exec(line);
  if (m) keys.push(m[1]);
}
console.log(`found ${keys.length} literals`);
for (const key of keys) {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  console.log(`${key.length} chars  ${digest}`);
}
