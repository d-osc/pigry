/** Re-captures the screenshots of the in-app guides into public/help/ (see tests/ui/help-screenshots.spec.mjs). */
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['playwright', 'test', 'tests/ui/help-screenshots.spec.mjs'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, HELP_CAPTURE: '1' },
});
process.exit(result.status ?? 1);
