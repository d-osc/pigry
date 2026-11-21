// One-shot WH-01 patch for src/lib/aiProviders.ts:
//   SEED_TEST_KEYS literals  ->  SHA-256 digests (SEED_TEST_KEY_SHA256)
//   plaintext comparison     ->  isSeedTestKey() digest comparison
// Adds a small synchronous SHA-256 so loadProviders() stays sync (handoff
// option B). Contains no secrets. Verify with git diff afterwards.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/lib/aiProviders.ts';
const src = readFileSync(path, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(/\r?\n/);

const declIdx = lines.findIndex((l) => l.includes('const SEED_TEST_KEYS = ['));
if (declIdx < 0) throw new Error('SEED_TEST_KEYS declaration not found (already patched?)');

// Walk back over the doc comment above the declaration.
let startIdx = declIdx;
while (startIdx > 0 && /^\s*(\/\*\*|\*|\*\/)/.test(lines[startIdx - 1])) startIdx -= 1;

let endIdx = -1;
let literals = 0;
for (let i = declIdx + 1; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t === '];') { endIdx = i; break; }
  if (/^'[^']*',$/.test(t)) literals++;
}
if (endIdx < 0 || literals !== 2) throw new Error(`unexpected block shape (end=${endIdx}, literals=${literals})`);

const block = [
  '/** SHA-256 digests (hex) of API keys that old builds baked in for throwaway',
  ' * test providers. Stored entries still holding one are dropped on load (a',
  ' * customized key survives). Digests only — never the keys themselves. */',
  'export const SEED_TEST_KEY_SHA256: string[] = [',
  '  // qwen-cloud first-run seed',
  "  '377780b23dc0aac24909205656a6bd40bc08cbd990d7fa07c6280cc278761e5a',",
  '  // zai-test',
  "  'c0661305f17fe7e67fd1046698d5957e8bb94d2eef0fc5ace659b7a3f1054e35',",
  '];',
  '',
  '/** SHA-256 round constants (FIPS 180-4). */',
  'const SHA256_K = new Uint32Array([',
  '  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,',
  '  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,',
  '  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,',
  '  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,',
  '  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,',
  '  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,',
  '  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,',
  '  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,',
  ']);',
  '',
  '/** Minimal synchronous SHA-256 → lowercase hex. `crypto.subtle` is async and',
  ' * would force `loadProviders()` async, so this small implementation keeps the',
  ' * load path synchronous without a new dependency. */',
  'export function sha256Hex(input: string): string {',
  '  const data = new TextEncoder().encode(input);',
  '  const len = data.length;',
  '  const padded = ((len + 9 + 63) >> 6) << 6; // message + 0x80 + zeros + 8-byte length',
  '  const buf = new Uint8Array(padded);',
  '  buf.set(data);',
  '  buf[len] = 0x80;',
  '  const view = new DataView(buf.buffer);',
  '  const bitLen = len * 8;',
  '  view.setUint32(padded - 8, Math.floor(bitLen / 0x100000000));',
  '  view.setUint32(padded - 4, bitLen >>> 0);',
  '  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;',
  '  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;',
  '  const w = new Uint32Array(64);',
  '  for (let off = 0; off < padded; off += 64) {',
  '    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);',
  '    for (let i = 16; i < 64; i += 1) {',
  '      const x = w[i - 15];',
  '      const y = w[i - 2];',
  '      const s0 = (rotr(x, 7) ^ rotr(x, 18)) ^ (x >>> 3);',
  '      const s1 = (rotr(y, 17) ^ rotr(y, 19)) ^ (y >>> 10);',
  '      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;',
  '    }',
  '    let a = h0;',
  '    let b = h1;',
  '    let c = h2;',
  '    let d = h3;',
  '    let e = h4;',
  '    let f = h5;',
  '    let g = h6;',
  '    let h = h7;',
  '    for (let i = 0; i < 64; i += 1) {',
  '      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);',
  '      const ch = (e & f) ^ (~e & g);',
  '      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;',
  '      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);',
  '      const maj = (a & b) ^ (a & c) ^ (b & c);',
  '      const t2 = (S0 + maj) >>> 0;',
  '      h = g;',
  '      g = f;',
  '      f = e;',
  '      e = (d + t1) >>> 0;',
  '      d = c;',
  '      c = b;',
  '      b = a;',
  '      a = (t1 + t2) >>> 0;',
  '    }',
  '    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;',
  '    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;',
  '  }',
  "  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');",
  '}',
  '',
  'function rotr(x: number, n: number): number {',
  '  return (x >>> n) | (x << (32 - n));',
  '}',
  '',
  '/** True when a stored key is one of the old seeded test keys (by digest). */',
  'function isSeedTestKey(apiKey: string): boolean {',
  "  return apiKey !== '' && SEED_TEST_KEY_SHA256.includes(sha256Hex(apiKey));",
  '}',
  '',
];

lines.splice(startIdx, endIdx - startIdx + 1, ...block);
let out = lines.join(eol);

const needle = 'SEED_TEST_KEYS.includes(entry.apiKey)';
const count = out.split(needle).length - 1;
if (count !== 1) throw new Error(`comparison needle occurs ${count}x, expected 1`);
out = out.replace(needle, 'isSeedTestKey(entry.apiKey)');

const fnNeedle = 'function dropTestProviders(list: AiProviderEntry[]): AiProviderEntry[] {';
if (!out.includes(fnNeedle)) throw new Error('dropTestProviders signature not found');
out = out.replace(fnNeedle, 'export function dropTestProviders(list: AiProviderEntry[]): AiProviderEntry[] {');

if (out.includes('SEED_TEST_KEYS')) throw new Error('old identifier still present');
writeFileSync(path, out);
console.log('patched src/lib/aiProviders.ts');
