import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('AI panel lint completes within a bounded heap', { timeout: 45_000 }, () => {
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=768',
    'node_modules/eslint/bin/eslint.js',
    'src/screens/explorer/AiAgentPanel.tsx',
    '--max-warnings=0',
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    timeout: 40_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
