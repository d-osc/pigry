/**
 * Author → profile picture URL candidates, best first. Pure helpers shared by
 * `AuthorAvatar` (and unit-tested on their own).
 *
 * Order of preference:
 *  1. an `avatarUrl` the backend already resolved (gh GraphQL / REST);
 *  2. the repo's email → avatar map from `commit_avatars` (gh api);
 *  3. a GitHub noreply email (`123+login@users.noreply.github.com`) — the id
 *     or login is part of the address itself, so nothing new is revealed;
 *  4. a GitHub login (PR / issue / release authors) → `github.com/<login>.png`;
 *  5. Gravatar by SHA-256 hash of the email (`d=404`, so a missing picture
 *     fails and the caller falls back to initials). Only the hash leaves the
 *     app, never the address.
 */

const NOREPLY_ID = /^(\d+)\+([^@\s]+)@users\.noreply\.github\.com$/i;
const NOREPLY_LOGIN = /^([^@+\s]+)@users\.noreply\.github\.com$/i;
/** GitHub logins: alphanumerics and dashes; bots carry a `[bot]` suffix. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/;

/** `github.com/<login>.png` for a valid login ("app/dependabot" → dependabot). */
export function githubLoginAvatar(login: string | undefined, size = 40): string {
  const clean = (login ?? '').trim().replace(/^app\//, '');
  if (!LOGIN.test(clean)) return '';
  return `https://github.com/${encodeURIComponent(clean)}.png?size=${size}`;
}

/** Avatar URL straight from a GitHub noreply commit email, or ''. */
export function noreplyAvatar(email: string | undefined, size = 40): string {
  const value = (email ?? '').trim();
  const byId = NOREPLY_ID.exec(value);
  if (byId) return `https://avatars.githubusercontent.com/u/${byId[1]}?s=${size}&v=4`;
  const byLogin = NOREPLY_LOGIN.exec(value);
  return byLogin ? githubLoginAvatar(byLogin[1], size) : '';
}

/** Gravatar image for an email (hash only — the address never leaves). */
export function gravatarUrl(email: string | undefined, size = 40): string {
  const value = (email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(value) || /@users\.noreply\.github\.com$/.test(value)) return '';
  return `https://www.gravatar.com/avatar/${sha256Hex(value)}?s=${size * 2}&d=404`;
}

export interface AvatarSource {
  email?: string;
  login?: string;
  avatarUrl?: string;
  avatarMap?: Record<string, string>;
  size?: number;
}

const isHttpUrl = (url: string | undefined): url is string => !!url && /^https:\/\//i.test(url);

/** Every picture URL worth trying for one author, best first, de-duplicated. */
export function avatarCandidates({ email, login, avatarUrl, avatarMap, size = 40 }: AvatarSource): string[] {
  const mapped = email ? avatarMap?.[email] : undefined;
  const list = [
    isHttpUrl(avatarUrl) ? avatarUrl : '',
    isHttpUrl(mapped) ? mapped : '',
    noreplyAvatar(email, size),
    githubLoginAvatar(login, size),
    gravatarUrl(email, size),
  ];
  return [...new Set(list.filter(Boolean))];
}

// ---- SHA-256 (synchronous, so the URL is known during render) -------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const hashCache = new Map<string, string>();

/** Lower-case hex SHA-256 of a UTF-8 string (memoized). */
export function sha256Hex(text: string): string {
  const hit = hashCache.get(text);
  if (hit) return hit;
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const hex = Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('');
  hashCache.set(text, hex);
  return hex;
}
