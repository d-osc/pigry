/**
 * Demo workspace — mirrors the acme-inc/platform fixture from the Figma design
 * file (417miudvyh3Kdz8eN4eILm). Used only when the UI runs in a plain browser
 * (`npm run dev`) so the design can be previewed without the Tauri shell.
 * Inside the desktop app all data comes from the Rust backend.
 */
import type {
  AppStatePayload,
  BlameLine,
  CodeSearchHit,
  CommitDetail,
  CommitHistory,
  CommitRow,
  FileCommitEntry,
  FileTree,
  RepoStats,
  WorktreeFileContent,
} from '../types/repository';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const now = Math.floor(Date.now() / 1000);

export const demoAppState: AppStatePayload = {
  activePath: '~/Projects/acme/platform',
  recent: ['~/Projects/acme/platform', '~/Projects/acme/pigry-site'],
  repository: {
    organization: 'acme-inc',
    name: 'platform',
    visibility: 'Private',
    localPath: '~/Projects/acme/platform',
    currentBranch: 'main',
    upstream: { name: 'origin/main', ahead: 0, behind: 0 },
    account: { initials: 'AL', name: 'Alex Liu', email: 'alex@acme.dev' },
    files: [],
    branches: [
      { name: 'main', isHead: true },
      { name: 'feat/command-menu', isHead: false },
      { name: 'feat/graph-search', isHead: false },
      { name: 'fix/lane-rendering', isHead: false },
    ],
    remotes: [{ remote: 'origin', branches: ['main', 'feat/graph-search'] }],
    tags: [
      { name: 'v0.18.0', commitOid: '7f3e1b9', timeSeconds: now - 5 * HOUR },
      { name: 'v0.17.2', commitOid: '2f90c41', timeSeconds: now - 9 * 24 * HOUR },
    ],
    tagTotal: 18,
    stashes: [{ index: 0, message: 'WIP: graph minimap' }],
    headOid: 'a8f2c91e4d7b6a3f5c8e2d1b9a7f6e5d4c3b2a19',
    rebaseInProgress: false,
    submodules: [],
    worktrees: [],
  },
};

interface DemoRow {
  oid: string;
  summary: string;
  author: [string, string];
  ago: number;
  lane: number;
  parents: number[];
  before: number[];
  after: number[];
  refs?: string[];
  merge?: boolean;
}

const ROWS: DemoRow[] = [
  { oid: 'a8f2c91e4d7b6a3f5c8e2d1b9a7f6e5d4c3b2a19', summary: "Merge branch 'feat/command-menu' into main", author: ['Alex Liu', 'AL'], ago: 12 * MINUTE, lane: 0, parents: [0, 1], before: [0, 1], after: [0], refs: ['main', 'origin/main'], merge: true },
  { oid: 'e7d38b4c9f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c', summary: 'feat: add keyboard-first command palette', author: ['Maya Chen', 'MC'], ago: 28 * MINUTE, lane: 1, parents: [1], before: [0, 1, 2], after: [0, 1], refs: ['feat/command-menu'] },
  { oid: 'c4b82e6d5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c', summary: 'feat: highlight matching commits in graph', author: ['Sam Rivera', 'SR'], ago: 46 * MINUTE, lane: 2, parents: [2], before: [0, 1, 2], after: [0, 1, 2], refs: ['feat/graph-search'] },
  { oid: '9d1f6a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f', summary: 'fix: preserve scroll position on refresh', author: ['Alex Liu', 'AL'], ago: HOUR, lane: 0, parents: [0], before: [0, 1, 2], after: [0, 1, 2] },
  { oid: 'b6a4f20c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a', summary: 'feat: index repository commands for fuzzy search', author: ['Maya Chen', 'MC'], ago: HOUR + 18 * MINUTE, lane: 1, parents: [1], before: [0, 1, 2], after: [0, 1, 2] },
  { oid: 'f0e918c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9', summary: 'feat: scaffold command menu and shortcuts', author: ['Maya Chen', 'MC'], ago: 2 * HOUR, lane: 1, parents: [1], before: [0, 1, 2], after: [0, 1, 2] },
  { oid: '2c8d5a1e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c', summary: 'feat: filter commit history by file path', author: ['Sam Rivera', 'SR'], ago: 2 * HOUR + 22 * MINUTE, lane: 2, parents: [2], before: [0, 2], after: [0, 2] },
  { oid: 'd3f7b92a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e', summary: "Merge branch 'fix/lane-rendering' into main", author: ['Alex Liu', 'AL'], ago: 3 * HOUR, lane: 0, parents: [0, 3], before: [0, 3], after: [0], merge: true },
  { oid: '6e2a4d8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d', summary: 'chore: update dependencies and lockfile', author: ['Jordan Lee', 'JL'], ago: 3 * HOUR + 34 * MINUTE, lane: 0, parents: [0], before: [0, 3], after: [0, 3] },
  { oid: '81b9e3f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1', summary: 'fix: prevent lane crossings on octopus merges', author: ['Jordan Lee', 'JL'], ago: 4 * HOUR, lane: 3, parents: [3], before: [0, 3], after: [0, 3], refs: ['fix/lane-rendering'] },
  { oid: '4a6c0d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c', summary: 'test: cover parallel branch and merge layouts', author: ['Jordan Lee', 'JL'], ago: 4 * HOUR + 41 * MINUTE, lane: 3, parents: [3], before: [0, 3], after: [0, 3] },
  { oid: '7f3e1b9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e', summary: 'release: v0.18.0', author: ['Alex Liu', 'AL'], ago: 5 * HOUR, lane: 0, parents: [0], before: [0], after: [0], refs: ['v0.18.0'] },
];

export const demoHistory: CommitHistory = {
  total: 1284,
  truncated: false,
  commits: ROWS.map<CommitRow>((row) => ({
    oid: row.oid,
    shortOid: row.oid.slice(0, 7),
    summary: row.summary,
    authorName: row.author[0],
    authorInitials: row.author[1],
    timeSeconds: now - row.ago,
    lane: row.lane,
    parentLanes: row.parents,
    activeBefore: row.before,
    activeAfter: row.after,
    isHead: row.oid.startsWith('a8f2c91'),
    isMerge: row.merge ?? false,
    pushed: !row.oid.startsWith('c7d9e12') && !row.oid.startsWith('f2a8b41'),
    refs: row.refs ?? [],
  })),
};

export const demoStats: RepoStats = {
  totalCommits: 1284,
  contributors: [
    { name: 'Alex Liu', initials: 'AL', commits: 486 },
    { name: 'Maya Chen', initials: 'MC', commits: 342 },
    { name: 'Sam Rivera', initials: 'SR', commits: 271 },
    { name: 'Jordan Lee', initials: 'JL', commits: 185 },
  ],
  languages: [
    { language: 'TypeScript', files: 96 },
    { language: 'Rust', files: 41 },
    { language: 'CSS', files: 34 },
  ],
};

export const demoTree: FileTree = {
  entries: [
    'package.json',
    'README.md',
    'src/app/AppShell.tsx',
    'src/app/NavSidebar.tsx',
    'src/components/command-menu.tsx',
    'src/components/commit-graph.tsx',
    'src/hooks/use-commands.ts',
    'src/hooks/use-graph-search.ts',
    'src/lib/keyboard.ts',
    'src/lib/search.ts',
    'src-tauri/src/commands.rs',
    'src-tauri/src/git_state.rs',
    'src-tauri/src/ops/mod.rs',
    'tests/graph-search.test.ts',
  ],
  changed: [],
  unpushedPaths: [],
};

export const demoFileContent: WorktreeFileContent = {
  content: [
    'export function isCommandShortcut(event: KeyboardEvent) {',
    '  const modifier = isMac() ? event.metaKey : event.ctrlKey;',
    '  return modifier && event.key.toLowerCase() === "k";',
    '}',
    '',
    'export function isEditingTarget(target: EventTarget | null) {',
    '  const el = target as HTMLElement | null;',
    '  if (!el) return false;',
    '  return (',
    '    el.matches("input, textarea") || el.isContentEditable',
    '  );',
    '}',
  ].join('\n'),
  binary: false,
  tooLarge: false,
  language: 'TypeScript',
};

const nowSec = Math.floor(Date.now() / 1000);


/** Browser-preview code search: matches the query inside the demo corpus. */
export function demoSearchCode(query: string): CodeSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const corpus: Record<string, string[]> = {
    'src/lib/keyboard.ts': demoFileContent.content.split('\n'),
    'src/components/command-menu.tsx': [
      'export function CommandMenu({ open, onOpenChange }: CommandMenuProps) {',
      '  const commands = useCommands(query);',
      "  const filtered = commands.filter((cmd) => matchCommand(cmd, query));",
      '  return <Item onSelect={cmd.run} />;',
      '}',
      '',
      'function matchCommand(command: Command, query: string) {',
      '  return command.label.toLowerCase().includes(query.trim().toLowerCase());',
      '}',
    ],
    'src/hooks/use-commands.ts': [
      'const matches = fuzzySearch(registry, query.trim());',
      'return matches.filter((cmd) => cmd.isAvailable(repo));',
      '',
      'export function useCommands(query: string) {',
      '  return useMemo(() => fuzzySearch(registry, query), [query]);',
      '}',
    ],
  };
  const hits: CodeSearchHit[] = [];
  for (const [path, lines] of Object.entries(corpus)) {
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 4; i += 1) {
      const at = lines[i].toLowerCase().indexOf(q);
      if (at >= 0) {
        hits.push({ path, line: i + 1, column: at + 1, text: lines[i].trim().slice(0, 200) });
        perFile += 1;
      }
    }
  }
  return hits.slice(0, 30);
}

/** Blame fixture covering the demo file (3 commits + uncommitted tail). */
export const demoBlame: BlameLine[] = (() => {
  const totalLines = 11;
  const commits = [
    {
      until: 3,
      shortOid: '3f3a91',
      oid: '3f3a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6',
      authorName: 'Maya Chen',
      authorEmail: 'maya@acme.dev',
      authorInitials: 'MC',
      timeSeconds: nowSec - 2 * 60 * 60,
      summary: 'Fix command matching when query starts with a slash',
      message:
        'Fix command matching when query starts with a slash\n\nA leading "/" was treated as a path filter, hiding every repository action. Trim the query before matching and keep path filtering behind an explicit prefix.',
    },
    {
      until: 8,
      shortOid: '7d1d04',
      oid: '7d1d04a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3',
      authorName: 'Noah Kim',
      authorEmail: 'noah@acme.dev',
      authorInitials: 'NK',
      timeSeconds: nowSec - 26 * 60 * 60,
      summary: 'Add CommandMenuProps and improve empty-state copy',
      message:
        'Add CommandMenuProps and improve empty-state copy\n\nType the component props, guide users toward the command registry when a search returns nothing, and add tests for the empty state.',
    },
  ];
  const lines: BlameLine[] = [];
  for (let line = 1; line <= totalLines; line += 1) {
    const commit = commits.find((c) => line <= c.until);
    if (commit) {
      lines.push({
        line,
        shortOid: commit.shortOid,
        oid: commit.oid,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        authorInitials: commit.authorInitials,
        timeSeconds: commit.timeSeconds,
        summary: commit.summary,
        message: commit.message,
        uncommitted: false,
      });
    } else {
      lines.push({
        line,
        shortOid: '———',
        oid: '',
        authorName: 'Uncommitted',
        authorEmail: '',
        authorInitials: '—',
        timeSeconds: 0,
        summary: '',
        message: '',
        uncommitted: true,
      });
    }
  }
  return lines;
})();

/** Per-file history fixture (design: 3 commits on the selected file). */
export const demoFileHistory: FileCommitEntry[] = [
  {
    oid: '3f3a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6',
    shortOid: '3f3a91',
    summary: 'Fix command matching when query starts with a slash',
    authorName: 'Maya Chen',
    authorInitials: 'MC',
    timeSeconds: nowSec - 2 * 60 * 60,
  },
  {
    oid: '7d1d04a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3',
    shortOid: '7d1d04',
    summary: 'Add CommandMenuProps and improve empty-state copy',
    authorName: 'Noah Kim',
    authorInitials: 'NK',
    timeSeconds: nowSec - 24 * 60 * 60,
  },
  {
    oid: '9a4c88f0e1d2c3b4a5968776655443322110a9b8',
    shortOid: '9a4c88',
    summary: 'Extract CommandMenu and move it into components/ui',
    authorName: 'Priya Shah',
    authorInitials: 'PS',
    timeSeconds: nowSec - 3 * 24 * 60 * 60,
  },
];

/** Commit detail fixture for the browser preview (design: merge commit). */
export function demoCommitDetail(oid: string): CommitDetail {
  const index = demoHistory.commits.findIndex((commit) => commit.oid === oid);
  const row = index >= 0 ? demoHistory.commits[index] : demoHistory.commits[0];
  const rowIndex = index >= 0 ? index : 0;
  const isMergeRow = row.oid.startsWith('a8f2c91');
  const prev = demoHistory.commits[rowIndex + 1];
  return {
    oid: row.oid,
    shortOid: row.shortOid,
    summary: row.summary,
    message: isMergeRow
      ? 'Add a keyboard-first command palette with fuzzy search and repository actions.'
      : row.summary,
    authorName: row.authorName,
    authorInitials: row.authorInitials,
    timeSeconds: row.timeSeconds,
    isMerge: row.isMerge,
    parents: isMergeRow
      ? ['9d1f6a2', 'e7d30b4']
      : prev
        ? [prev.shortOid]
        : [],
    files: isMergeRow
      ? [
          { path: 'src/components/command-menu.tsx', name: 'command-menu.tsx', directory: 'src/components', status: 'A', additions: 214, deletions: 12 },
          { path: 'src/hooks/use-commands.ts', name: 'use-commands.ts', directory: 'src/hooks', status: 'A', additions: 42, deletions: 6 },
          { path: 'src/lib/keyboard.ts', name: 'keyboard.ts', directory: 'src/lib', status: 'M', additions: 24, deletions: 4 },
          { path: 'src/app.tsx', name: 'app.tsx', directory: 'src', status: 'M', additions: 6, deletions: 2 },
        ]
      : [
          { path: 'src-tauri/src/git_state.rs', name: 'git_state.rs', directory: 'src-tauri/src', status: 'M', additions: 158, deletions: 8 },
          { path: 'src-tauri/src/git_state/tests.rs', name: 'tests.rs', directory: 'src-tauri/src/git_state', status: 'M', additions: 87, deletions: 6 },
          { path: 'src/app/AppShell.tsx', name: 'AppShell.tsx', directory: 'src/app', status: 'M', additions: 66, deletions: 8 },
          { path: 'src/app/NavSidebar.css', name: 'NavSidebar.css', directory: 'src/app', status: 'M', additions: 24, deletions: 1 },
          { path: 'src/app/NavSidebar.tsx', name: 'NavSidebar.tsx', directory: 'src/app', status: 'M', additions: 45, deletions: 6 },
          { path: 'src/app/ShortcutSheet.tsx', name: 'ShortcutSheet.tsx', directory: 'src/app', status: 'M', additions: 27, deletions: 0 },
        ],
  };
}
