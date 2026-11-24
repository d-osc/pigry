/** Sample data for the guide screenshots: answers for the commands the test backend leaves empty, so every menu
 * shows a realistic, populated screen instead of an empty state. Keyed by Tauri command name. */
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const secondsAgo = (days) => Math.floor((Date.now() - days * DAY) / 1000);
const sha = (n) => String(n).repeat(40).slice(0, 40);

const commit = (n, summary, author, days, files) => ({
  oid: sha(n), shortOid: sha(n).slice(0, 7), summary, body: '', authorName: author, timeSeconds: secondsAgo(days), parentOid: sha(n + 1), files,
});

const PUSH_COMMITS = [
  commit(3, 'feat: add keyboard-first command palette', 'Maya Chen', 0.1, [
    { path: 'src/components/command-menu.tsx', status: 'A', additions: 84, deletions: 0 },
    { path: 'src/lib/commands.ts', status: 'M', additions: 12, deletions: 3 },
  ]),
  commit(4, 'fix: preserve scroll position on refresh', 'Alex Liu', 0.4, [
    { path: 'src/app/shell.tsx', status: 'M', additions: 9, deletions: 4 },
  ]),
];

const INCOMING = [
  commit(5, 'feat: highlight matching commits in graph', 'Sam Rivera', 0.2, [
    { path: 'src/graph/lanes.ts', status: 'M', additions: 31, deletions: 7 },
    { path: 'src/graph/search.ts', status: 'A', additions: 58, deletions: 0 },
  ]),
  commit(6, 'chore: update dependencies', 'Jordan Lee', 0.8, [
    { path: 'package.json', status: 'M', additions: 4, deletions: 4 },
  ]),
];

const run = (number, workflowName, workflowId, title, event, branch, shortSha, status, conclusion, daysAgo, minutes) => ({
  id: number, number, title, workflowName, workflowId, event, branch, sha: shortSha.padEnd(40, '0'), status, conclusion,
  createdAt: ago(daysAgo), startedAt: ago(daysAgo), updatedAt: new Date(Date.now() - daysAgo * DAY + minutes * 60000).toISOString(), url: '', attempt: 1,
});
const step = (number, name, duration) => ({ name, number, status: 'completed', conclusion: 'success', duration });

const people = [
  { name: 'Alex Liu', commits: 42, additions: 3120, deletions: 980 },
  { name: 'Maya Chen', commits: 31, additions: 2290, deletions: 640 },
  { name: 'Sam Rivera', commits: 18, additions: 1105, deletions: 312 },
  { name: 'Jordan Lee', commits: 9, additions: 420, deletions: 233 },
];

const week = (i) => ({
  startSeconds: secondsAgo((12 - i) * 7), endSeconds: secondsAgo((11 - i) * 7),
  commits: [6, 9, 4, 12, 15, 8, 11, 17, 9, 13, 19, 16][i], additions: 300 + i * 90, deletions: 120 + i * 25,
});

export const GH_MOCKS = {
  gh_workflow_list: [
    { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
    { id: 2, name: 'Release', path: '.github/workflows/release.yml', state: 'active' },
    { id: 3, name: 'CodeQL', path: '.github/workflows/codeql.yml', state: 'active' },
    { id: 4, name: 'Nightly', path: '.github/workflows/nightly.yml', state: 'disabled_manually' },
  ],
  gh_run_list: {
    total: 128,
    runs: [
      run(7, 'CI', 1, 'fix: preserve scroll position on refresh', 'push', 'main', 'e7d38b4', 'completed', 'success', 0.1, 4.2),
      run(6, 'CI', 1, 'feat: add keyboard-first command palette', 'pull_request', 'feat/command-menu', 'a8f2c91', 'completed', 'failure', 0.3, 5.5),
      run(5, 'CodeQL', 3, 'feat: add keyboard-first command palette', 'pull_request', 'feat/command-menu', 'a8f2c91', 'in_progress', '', 0.01, 0),
      run(4, 'Release', 2, 'Release v1.4.0', 'push', 'main', 'c4b82e6', 'completed', 'success', 2, 38),
      run(3, 'CI', 1, 'chore: update dependencies', 'push', 'main', '9d1f6a2', 'completed', 'success', 3, 4.8),
      run(2, 'CI', 1, 'fix: crash when opening a bare repository', 'workflow_dispatch', 'fix/bare-repo', 'b6a4f20', 'completed', 'cancelled', 4, 1.2),
      run(1, 'CodeQL', 3, 'chore: update dependencies', 'schedule', 'main', '9d1f6a2', 'completed', 'success', 6, 9.5),
    ],
  },
  gh_run_view: {
    id: 7, number: 7, title: 'fix: preserve scroll position on refresh', workflowId: 1, workflowName: 'CI', event: 'push', branch: 'main', sha: sha(7),
    status: 'completed', conclusion: 'success', attempt: 1, createdAt: ago(0.1), startedAt: ago(0.1), updatedAt: new Date(Date.now() - 0.1 * DAY + 4.2 * 60000).toISOString(), url: '',
    jobs: [
      { id: 71, name: 'lint', status: 'completed', conclusion: 'success', duration: '48s', url: '', steps: [step(1, 'Set up job', '2s'), step(2, 'Run actions/checkout', '3s'), step(3, 'npm ci', '22s'), step(4, 'npm run lint', '19s')] },
      { id: 72, name: 'test', status: 'completed', conclusion: 'success', duration: '3m 12s', url: '', steps: [step(1, 'Set up job', '2s'), step(2, 'npm ci', '21s'), step(3, 'npm test', '2m 41s'), step(4, 'Upload coverage', '8s')] },
      { id: 73, name: 'build', status: 'completed', conclusion: 'success', duration: '1m 05s', url: '', steps: [step(1, 'Set up job', '2s'), step(2, 'npm run build', '59s')] },
    ],
  },
  gh_run_logs: [
    'test\tnpm test\t2026-11-23T09:12:01.000Z > vitest run',
    'test\tnpm test\t2026-11-23T09:12:03.000Z ✓ src/lib/reports.test.ts (3 tests)',
    'test\tnpm test\t2026-11-23T09:12:09.000Z ✓ src/lib/toolBatch.test.ts (5 tests)',
    'test\tnpm test\t2026-11-23T09:12:41.000Z Test Files  24 passed (24)',
    'test\tnpm test\t2026-11-23T09:12:41.000Z      Tests  95 passed (95)',
  ].join('\n'),
  gh_run_artifacts: [
    { id: 1, name: 'coverage-report', size: 482_000, expired: false, expiresAt: ago(-80), createdAt: ago(0.1) },
    { id: 2, name: 'build-output', size: 12_400_000, expired: false, expiresAt: ago(-80), createdAt: ago(0.1) },
  ],

  push_preview: { branch: 'main', upstream: 'origin/main', ahead: PUSH_COMMITS.length, commits: PUSH_COMMITS },
  pull_preview: INCOMING,

  compare_branches: {
    baseOid: sha(1), compareOid: sha(2), baseOnly: 1, compareOnly: 3,
    files: [
      { path: 'src/components/command-menu.tsx', status: 'A', additions: 84, deletions: 0 },
      { path: 'src/lib/commands.ts', status: 'M', additions: 12, deletions: 3 },
      { path: 'README.md', status: 'M', additions: 6, deletions: 1 },
      { path: 'src/legacy/menu.ts', status: 'D', additions: 0, deletions: 40 },
    ],
  },

  merge_status: { inProgress: false, conflicted: [] },
  merge_preview: {
    upToDate: false,
    commits: [...PUSH_COMMITS],
    files: [
      { path: 'src/components/command-menu.tsx', status: 'A', additions: 84, deletions: 0, commits: [{ shortOid: sha(3).slice(0, 7), summary: 'feat: add keyboard-first command palette' }] },
      { path: 'src/lib/commands.ts', status: 'M', additions: 12, deletions: 3, commits: [{ shortOid: sha(3).slice(0, 7), summary: 'feat: add keyboard-first command palette' }] },
      { path: 'src/app/shell.tsx', status: 'M', additions: 9, deletions: 4, commits: [{ shortOid: sha(4).slice(0, 7), summary: 'fix: preserve scroll position on refresh' }] },
    ],
  },

  gh_issue_list: [
    { number: 142, title: 'Command palette does not close on Escape', state: 'OPEN', author: 'maya', updatedAt: ago(0.2), url: '', comments: 4, labels: ['bug', 'ui'], assignees: ['alex'], milestone: 'v1.4' },
    { number: 139, title: 'Add dark theme to the commit graph', state: 'OPEN', author: 'sam', updatedAt: ago(1), url: '', comments: 2, labels: ['enhancement'], assignees: [], milestone: 'v1.4' },
    { number: 137, title: 'Slow startup on repositories with 50k files', state: 'OPEN', author: 'jordan', updatedAt: ago(2), url: '', comments: 9, labels: ['performance'], assignees: ['maya'], milestone: '' },
    { number: 131, title: 'Document the keyboard shortcuts', state: 'OPEN', author: 'alex', updatedAt: ago(4), url: '', comments: 0, labels: ['documentation', 'good first issue'], assignees: [], milestone: '' },
    { number: 128, title: 'Crash when opening a bare repository', state: 'CLOSED', author: 'sam', updatedAt: ago(6), url: '', comments: 5, labels: ['bug'], assignees: ['alex'], milestone: 'v1.3' },
  ],
  gh_issue_view: {
    number: 142, title: 'Command palette does not close on Escape', state: 'OPEN', stateReason: '', author: 'maya', createdAt: ago(1), updatedAt: ago(0.2), url: '',
    body: 'Opening the palette with **Ctrl+K** and pressing **Escape** leaves it open when the search box is empty.\n\n### Steps to reproduce\n\n1. Press Ctrl+K\n2. Press Escape\n\n### Expected\n\nThe palette closes.',
    labels: ['bug', 'ui'], assignees: ['alex'], milestone: 'v1.4',
    comments: [
      { author: 'alex', body: 'Reproduced. The key handler is registered twice.', createdAt: ago(0.5) },
      { author: 'maya', body: 'Thanks! I will add a regression test.', createdAt: ago(0.2) },
    ],
  },

  gh_release_list: [
    { tagName: 'v1.4.0', name: 'PIGRY v1.4.0', publishedAt: ago(2), isLatest: true, isDraft: false, isPrerelease: false },
    { tagName: 'v1.5.0-beta.1', name: 'PIGRY v1.5.0 beta 1', publishedAt: ago(1), isLatest: false, isDraft: false, isPrerelease: true },
    { tagName: 'v1.4.1', name: 'PIGRY v1.4.1', publishedAt: ago(0), isLatest: false, isDraft: true, isPrerelease: false },
    { tagName: 'v1.3.2', name: 'PIGRY v1.3.2', publishedAt: ago(30), isLatest: false, isDraft: false, isPrerelease: false },
  ],
  gh_release_view: {
    tagName: 'v1.4.0', name: 'PIGRY v1.4.0', publishedAt: ago(2), createdAt: ago(2), isLatest: true, isDraft: false, isPrerelease: false, author: 'alex', url: '',
    body: '## Added\n\n- Keyboard-first command palette\n- Reports menu for agent-written reports\n\n## Fixed\n\n- Scroll position is kept on refresh\n- Crash when opening a bare repository',
    assets: [
      { name: 'pigry-1.4.0-windows-x64.msi', size: 48_200_000, downloadCount: 312, url: '' },
      { name: 'pigry-1.4.0-macos-arm64.dmg', size: 52_800_000, downloadCount: 204, url: '' },
      { name: 'pigry-1.4.0-linux-x86_64.AppImage', size: 61_400_000, downloadCount: 97, url: '' },
    ],
  },

  gh_project_list: [{ number: 3, title: 'Roadmap', shortDescription: 'Planning for the next releases', owner: 'acme-inc', closed: false, updatedAt: ago(0.3), url: '' }],
  gh_project_item_list: [
    { itemId: 'i1', kind: 'issue', number: 142, title: 'Command palette does not close on Escape', repository: 'acme-inc/platform', state: 'OPEN', assignees: ['alex'], labels: ['bug'], status: 'In progress', iteration: { title: 'Sprint 12', startDate: '2026-11-16', endDate: '2026-11-29' }, isArchived: false, updatedAt: ago(0.2), url: '' },
    { itemId: 'i2', kind: 'issue', number: 139, title: 'Add dark theme to the commit graph', repository: 'acme-inc/platform', state: 'OPEN', assignees: [], labels: ['enhancement'], status: 'Todo', iteration: { title: 'Sprint 12', startDate: '2026-11-16', endDate: '2026-11-29' }, isArchived: false, updatedAt: ago(1), url: '' },
    { itemId: 'i3', kind: 'pr', number: 156, title: 'Keyboard-first command palette', repository: 'acme-inc/platform', state: 'OPEN', assignees: ['maya'], labels: ['feature'], status: 'In review', iteration: { title: 'Sprint 12', startDate: '2026-11-16', endDate: '2026-11-29' }, isArchived: false, updatedAt: ago(0.1), url: '' },
    { itemId: 'i4', kind: 'issue', number: 137, title: 'Slow startup on large repositories', repository: 'acme-inc/platform', state: 'OPEN', assignees: ['maya'], labels: ['performance'], status: 'Todo', iteration: { title: 'Sprint 13', startDate: '2026-11-30', endDate: '2026-12-13' }, isArchived: false, updatedAt: ago(2), url: '' },
    { itemId: 'i5', kind: 'issue', number: 128, title: 'Crash when opening a bare repository', repository: 'acme-inc/platform', state: 'CLOSED', assignees: ['alex'], labels: ['bug'], status: 'Done', iteration: { title: 'Sprint 11', startDate: '2026-11-02', endDate: '2026-11-15' }, isArchived: false, updatedAt: ago(6), url: '' },
    { itemId: 'i6', kind: 'pr', number: 150, title: 'Update dependencies', repository: 'acme-inc/platform', state: 'MERGED', assignees: ['jordan'], labels: ['chore'], status: 'Done', iteration: null, isArchived: false, updatedAt: ago(3), url: '' },
  ],

  gh_code_scanning_alerts: [
    { number: 11, state: 'open', severity: 'high', ruleId: 'js/path-injection', ruleDescription: 'Uncontrolled data used in path expression', ruleTags: ['security', 'external/cwe/cwe-022'], tool: 'CodeQL', path: 'src/files/open.ts', startLine: 48, endLine: 48, createdAt: ago(5), htmlUrl: '' },
    { number: 12, state: 'open', severity: 'medium', ruleId: 'js/insecure-randomness', ruleDescription: 'Insecure randomness', ruleTags: ['security'], tool: 'CodeQL', path: 'src/lib/ids.ts', startLine: 12, endLine: 12, createdAt: ago(9), htmlUrl: '' },
    { number: 14, state: 'open', severity: 'low', ruleId: 'js/unused-local-variable', ruleDescription: 'Unused variable', ruleTags: ['maintainability'], tool: 'CodeQL', path: 'src/app/shell.tsx', startLine: 210, endLine: 210, createdAt: ago(12), htmlUrl: '' },
  ],
  gh_dependabot_alerts: [
    { number: 7, state: 'open', severity: 'critical', summary: 'Prototype pollution in lodash', package: 'lodash', ecosystem: 'npm', scope: 'runtime', manifestPath: 'package.json', vulnerableRange: '< 4.17.21', patchedVersion: '4.17.21', createdAt: ago(3), htmlUrl: '' },
    { number: 8, state: 'open', severity: 'medium', summary: 'Denial of service in semver', package: 'semver', ecosystem: 'npm', scope: 'development', manifestPath: 'package-lock.json', vulnerableRange: '< 7.5.2', patchedVersion: '7.5.2', createdAt: ago(8), htmlUrl: '' },
  ],
  gh_secret_scanning_alerts: [{ number: 2, state: 'open', secretType: 'GitHub Personal Access Token', createdAt: ago(2), htmlUrl: '' }],
  gh_branch_check_runs: [
    { name: 'CodeQL', status: 'completed', conclusion: 'success', startedAt: ago(0.3), jobs: [] },
    { name: 'Lint', status: 'completed', conclusion: 'success', startedAt: ago(0.3), jobs: [] },
  ],

  wiki_check: { supported: true, hasWiki: true, url: 'https://github.com/acme-inc/platform/wiki', cached: true },
  wiki_sync: null,
  wiki_list: [{ file: 'Home.md', title: 'Home' }, { file: 'Architecture.md', title: 'Architecture' }, { file: 'Getting-Started.md', title: 'Getting Started' }, { file: 'Release-Process.md', title: 'Release Process' }],
  wiki_read: {
    file: 'Architecture.md', title: 'Architecture', author: 'Alex Liu', updatedAt: ago(3), commitMessage: 'Describe the data flow',
    content: '# Architecture\n\nThe app has three layers.\n\n## Frontend\n\nReact screens talk to the backend through typed commands.\n\n## Backend\n\nA Rust core runs git and GitHub operations.\n\n## Data flow\n\n1. A screen calls a command\n2. The backend runs git\n3. The result comes back as typed data',
  },
  wiki_page_history: [{ oid: sha(7), author: 'Alex Liu', date: ago(3), message: 'Describe the data flow' }],

  get_insights: {
    headBranch: 'main', nowSeconds: Math.floor(Date.now() / 1000), periodDays: 84, commits: 100, prevCommits: 82, contributors: 4, prevContributors: 3,
    additions: 6935, deletions: 2165,
    weekly: Array.from({ length: 12 }, (_, i) => week(i)), prevWeekly: Array.from({ length: 12 }, (_, i) => week(i)),
    days: Array.from({ length: 84 }, (_, i) => ({ daySeconds: secondsAgo(83 - i), commits: [0, 2, 1, 3, 0, 4, 1][i % 7] })),
    people,
    recent: [
      { oid: sha(3), summary: 'feat: add keyboard-first command palette', author: 'Maya Chen', timeSeconds: secondsAgo(0.1), isMerge: false },
      { oid: sha(4), summary: 'fix: preserve scroll position on refresh', author: 'Alex Liu', timeSeconds: secondsAgo(0.4), isMerge: false },
      { oid: sha(5), summary: 'feat: highlight matching commits in graph', author: 'Sam Rivera', timeSeconds: secondsAgo(0.9), isMerge: false },
    ],
    lineCommitsScanned: 100, lineCommitsTotal: 100,
  },
  gh_delivery_stats: {
    available: true, prOpened: 34, prMerged: 29, prClosedUnmerged: 3, prOpenNow: 4, prMergedPrev: 24, issueOpened: 41, issueClosed: 37, issueOpenNow: 12,
    medianMergeSeconds: 14_400, medianMergeSecondsPrev: 21_600,
  },
};
