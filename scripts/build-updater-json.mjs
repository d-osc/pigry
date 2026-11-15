// Builds updater latest.json from the release's signed bundles.
// Scopes: Windows NSIS zip (x86_64), Linux AppImage (x86_64 + arm64).
// Usage: node scripts/build-updater-json.mjs
// Env: TAG (e.g. v0.3.0) — reads ./updater/* artifacts.
import fs from 'node:fs';

const tag = process.env.TAG || '';
const version = tag.replace(/^v/, '');
const repo = process.env.GITHUB_REPOSITORY || 'd-osc/pigry';
const base = `https://github.com/${repo}/releases/download/${tag}`;

const readSig = (artifact) => {
  const sig = fs.readFileSync(`${artifact}.sig`, 'utf8').trim();
  return sig;
};

const platforms = {};

// Windows — NSIS installers (v2 updater signs the plain -setup.exe, no zip)
for (const exe of fs.readdirSync('updater').filter((f) => f.endsWith('-setup.exe'))) {
  const key = exe.includes('_arm64-setup') ? 'windows-aarch64' : 'windows-x86_64';
  platforms[key] = {
    signature: readSig(`updater/${exe}`),
    url: `${base}/${exe}`,
  };
}

// Linux — AppImage x64 + arm64
for (const arch of ['amd64', 'aarch64']) {
  const app = fs.readdirSync('updater').find((f) => f.endsWith(`_${arch}.AppImage`));
  if (app) {
    // file suffix (amd64/aarch64) → updater target key (x86_64/aarch64)
    const key = arch === 'amd64' ? 'linux-x86_64' : 'linux-aarch64';
    platforms[key] = {
      signature: readSig(`updater/${app}`),
      url: `${base}/${app}`,
    };
  }
}

if (Object.keys(platforms).length === 0) {
  console.error('no updater artifacts found');
  process.exit(1);
}

const latest = {
  version,
  notes: `PIGRY ${tag} — Windows / Linux installers (x86_64 + arm64).`,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.mkdirSync('updater', { recursive: true });
fs.writeFileSync('updater/latest.json', JSON.stringify(latest, null, 2));
console.log('latest.json written:', JSON.stringify({ platforms: Object.keys(platforms) }));
