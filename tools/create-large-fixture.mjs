import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const commits = Number(process.argv[2] ?? 10000);
const files = Number(process.argv[3] ?? 20000);
if (!Number.isInteger(commits) || commits < 1 || !Number.isInteger(files) || files < 1) throw new Error('Positive commit/file counts required');
const root = mkdtempSync(join(tmpdir(), 'pigry-large-'));
const repo = join(root, 'workspace');
mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' });
git('init', '-b', 'main');
let stream = 'blob\nmark :1\ndata 19\nvalidation fixture\n\n';
for (let i = 0; i < commits; i++) {
  const message = `Validation commit ${i}`;
  stream += `commit refs/heads/main\ncommitter Validation <validation@example.invalid> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
  if (i === 0) for (let f = 0; f < files; f++) stream += `M 100644 :1 files/file-${f}.txt\n`;
  stream += '\n';
}
execFileSync('git', ['-C', repo, 'fast-import', '--quiet'], { input: stream, windowsHide: true });
git('reset', '--hard', 'main');
for (let i = 0; i < Math.min(200, files); i++) writeFileSync(join(repo, `files/file-${i}.txt`), 'changed fixture\n');
for (let i = 0; i < 200; i++) writeFileSync(join(repo, `untracked-${i}.txt`), 'untracked fixture\n');
writeFileSync(join(root, 'fixture.json'), JSON.stringify({ repo, commits, files, changed: Math.min(200, files) + 200 }, null, 2));
console.log(JSON.stringify({ root, repo, commits, files }));
