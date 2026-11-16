// Copy the built pigry-shell helper into src-tauri/binaries/ so the Windows
// bundler can ship it as a resource. Runs as beforeBundleCommand on every
// platform; non-Windows builds simply find nothing and no-op (the helper is
// only used by the Windows installers — other platforms have real shells).
//
// The binary lives in different target dirs depending on how the build was
// invoked: target/release (default) or target/<triple>/release when the CI
// passes an explicit --target.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcTauri = fileURLToPath(new URL('..', import.meta.url));

if (process.platform !== 'win32') {
  console.log('[prepare-pigry-shell] non-Windows platform — nothing to do');
  process.exit(0);
}

const candidates = [
  join(srcTauri, 'target', 'release', 'pigry-shell.exe'),
  // Explicit --target builds (release CI): target/<triple>/release/
  ...(existsSync(join(srcTauri, 'target'))
    ? readdirSync(join(srcTauri, 'target'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.includes('-pc-windows-msvc'))
        .map((e) => join(srcTauri, 'target', e.name, 'release', 'pigry-shell.exe'))
    : []),
];

const built = candidates.find((p) => existsSync(p));
if (!built) {
  console.error('[prepare-pigry-shell] pigry-shell.exe not found — run the cargo build first');
  process.exit(1);
}

const destDir = join(srcTauri, 'binaries');
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, 'pigry-shell.exe');
copyFileSync(built, dest);
console.log(`[prepare-pigry-shell] copied ${built} -> ${dest}`);
