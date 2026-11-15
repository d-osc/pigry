/** Skill metadata — id/name/description parsed from the markdown files in
 * .pigry/skills/. The id (file slug) is stable; the name and description
 * come from frontmatter or the body headings. */

import { getFileTree, readWorktreeFile } from './tauriClient';
import type { SkillEntry } from './mentions';

export const SKILLS_DIR = '.pigry/skills/';

/** Parses one skill markdown file into { id, name, description }.
 * Supported shapes: frontmatter (`name:` / `description:`) or a leading
 * `# Title` heading followed by a description paragraph. */
export function parseSkillMeta(id: string, markdown: string): SkillEntry {
  const lines = markdown.split('\n');

  // Frontmatter first — explicit beats inferred.
  let name = '';
  let description = '';
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i += 1) {
      const line = lines[i];
      const nameMatch = line.match(/^name:\s*(.+)$/);
      if (nameMatch) name = nameMatch[1].trim();
      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) description = descMatch[1].trim();
    }
  }

  // Fallback: first `# ` heading is the name; the next paragraph is the
  // description.
  if (!name) {
    for (const line of lines) {
      const heading = line.match(/^#\s+(.+)$/);
      if (heading) {
        name = heading[1].trim();
        break;
      }
    }
  }
  if (!description) {
    let pastTitle = false;
    const collecting: string[] = [];
    for (const line of lines) {
      if (!pastTitle) {
        if (line.startsWith('# ')) pastTitle = true;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === '') {
        if (collecting.length > 0) break;
        continue;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('```')) break;
      collecting.push(trimmed);
      if (collecting.join(' ').length >= 160) break;
    }
    description = collecting.join(' ').slice(0, 200);
  }

  return { id, name: name || id, description };
}

/** Lists every skill with its parsed id/name/description. */
/** BASE SKILLS — hard-coded in the app (tier 1), like the default agents.
 * They ship with pigry, work without any files, and cannot be deleted. */
export interface BaseSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

export const BUILTIN_SKILLS: BaseSkill[] = [
  {
    id: 'file-navigation',
    name: 'File navigation',
    description: 'Explorer shortcuts: open, search, save and preview files fast.',
    content: [
      '# File navigation',
      '',
      '- Open file: command palette (Ctrl/Cmd+K) or Open file (Ctrl/Cmd+P)',
      '- Save: Ctrl/Cmd+S — dirty dots mark unsaved files in the tree',
      '- Images/svg preview inline; pdf/docx/xlsx have dedicated viewers',
      '- Binary files (images/pdf/docx/xlsx) are read via read_binary/read tools, never as text',
    ].join('\n'),
  },
  {
    id: 'history-analysis',
    name: 'History analysis',
    description: 'Read the commit graph, lanes and per-commit details.',
    content: [
      '# History analysis',
      '',
      '- Commit graph screen: lanes newest-first, click a commit for its detail panel',
      '- read_history tool returns commit rows; read_diff shows what a commit changed',
      '- Merge commits have 2+ parents — explain branch topology, not a linear story',
      '- Ref labels (main, origin/x) sit on the commit rows',
    ].join('\n'),
  },
  {
    id: 'merge-conflict',
    name: 'Merge conflicts',
    description: 'Merge from the Merge branch menu; resolve conflicts inline.',
    content: [
      '# Merge workflow',
      '',
      '- Merge branch menu: pick source + strategy (ff-only / merge commit / squash)',
      '- Conflicted files open with ours/incoming blocks and accept buttons',
      '- After resolving every file: stage the results, then commit to finish',
      '- Abort restores the branch to its pre-merge state',
    ].join('\n'),
  },
  {
    id: 'push-review',
    name: 'Push review',
    description: 'Review unpushed commits before pushing upstream.',
    content: [
      '# Push review',
      '',
      '- Push Commits screen lists every unpushed commit (the up-arrow counter)',
      '- Check each subject follows conventional commits and one-change-per-commit',
      '- Push publishes to the tracked upstream; fetch first if unsure of remote state',
    ].join('\n'),
  },
  {
    id: 'stash-management',
    name: 'Stash management',
    description: 'Stash, apply, pop and drop — keep or discard entries deliberately.',
    content: [
      '# Stash workflow',
      '',
      '- Stash with a descriptive message; entries survive branch switches',
      '- Apply keeps the entry, Pop removes it after applying',
      '- Drop is permanent — confirm with the user first',
      '- Conflicts from a pop are resolved like merge conflicts',
    ].join('\n'),
  },
  {
    id: 'cherry-pick-flow',
    name: 'Cherry pick',
    description: 'Pick a commit onto the current branch; conflicts stage for commit.',
    content: [
      '# Cherry-pick flow',
      '',
      '- Cherry Pick menu: browse commits, pick one — it lands staged on the current branch',
      '- Conflicts are listed per file; resolve then commit to finish',
      '- Abort restores the branch to its pre-pick state',
    ].join('\n'),
  },
  {
    id: 'branch-ops',
    name: 'Branch operations',
    description: 'Create, checkout and clean up branches; local vs remote symbols.',
    content: [
      '# Branch operations',
      '',
      '- Branches menu: local branches + remote (origin) branches are marked',
      '- The checked-out branch is marked HEAD; create/checkout from here',
      '- Delete only merged branches; remote branches need a push to update',
    ].join('\n'),
  },
  {
    id: 'pr-writing',
    name: 'PR writing',
    description: 'Draft pull requests: imperative title, what/why/testing body.',
    content: [
      '# PR writing',
      '',
      '- Title: imperative mood, at most 72 chars',
      '- Body: what changed + why + how it was tested',
      '- Reference issues as (№ 12); request reviewers explicitly',
      '- Check the PRs counter for open ones before creating a duplicate',
    ].join('\n'),
  },
  {
    id: 'issue-triage',
    name: 'Issue triage',
    description: 'Triage and draft issues: reproduce, expected vs actual, labels.',
    content: [
      '# Issue triage',
      '',
      '- Template: steps to reproduce / expected / actual / environment',
      '- One bug per issue; label by area and severity',
      '- Link commits or PRs that reference the issue number',
    ].join('\n'),
  },
  {
    id: 'ci-debugging',
    name: 'CI debugging',
    description: 'Read workflow runs: failed step, logs, rerun after fix.',
    content: [
      '# CI debugging',
      '',
      '- Actions screen: list runs, open the failed one, read the failing step log',
      '- Reproduce the failing command locally first',
      '- Rerun only after the fix lands; note flaky steps',
    ].join('\n'),
  },
  {
    id: 'project-board',
    name: 'Project boards',
    description: 'Read boards/items and move issues across columns.',
    content: [
      '# Project boards',
      '',
      '- Projects screen: boards with item columns (read via github_projects)',
      '- Keep board status in sync with the issue/PR state',
    ].join('\n'),
  },
  {
    id: 'repo-insights',
    name: 'Repo insights',
    description: 'Read activity, stats and contributor data.',
    content: [
      '# Repo insights',
      '',
      '- Insights screen: activity, stats and contributor breakdown',
      '- Explain trends, do not invent numbers that are not on the page',
    ].join('\n'),
  },
  {
    id: 'web-research',
    name: 'Web research',
    description: 'web_search first, then playwright to read the best result.',
    content: [
      '# Web research',
      '',
      '- web_search returns ranked title/url/snippet lines',
      '- playwright reads ONE chosen result (rendered text, JS executed)',
      '- Cite the URL you read; never invent page content',
    ].join('\n'),
  },
  {
    id: 'run-tests',
    name: 'Run tests',
    description: 'How to run the Rust + frontend test suites for this repo.',
    content: [
      '# Run tests',
      '',
      '## Rust (src-tauri)',
      '- `cd src-tauri && cargo test` — the full suite',
      '- `cargo check` first for fast compile feedback',
      '- Flaky memory tests may need `-- --test-threads=1` on Windows',
      '',
      '## Frontend',
      '- `npm run build` — tsc + vite production build (must pass before commit)',
      '- `npx eslint <files>` — lint changed files',
      '',
      'Never report done with a failing build.',
    ].join('\n'),
  },
  {
    id: 'code-review',
    name: 'Code review',
    description: 'Review checklist: correctness, style, error paths, security.',
    content: [
      '# Code review checklist',
      '',
      '- Correctness first: edge cases, error paths, off-by-one',
      "- Match the file's existing style (naming, comment density, idiom)",
      '- Error handling: no silent catches; user-visible errors are explicit',
      '- Performance: no N+1 loops, no needless clones in Rust',
      '- Security: validate external input; never allow `..` path escapes',
      '- Phrase taste-dependent notes as questions, not demands',
    ].join('\n'),
  },
  {
    id: 'git-commit-style',
    name: 'Git commit style',
    description: 'Conventional commits + deliberate staging for this repo.',
    content: [
      '# Commit style',
      '',
      '- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:` — imperative mood',
      '- Subject at most 72 chars, no trailing period',
      '- Body explains what + why, wrapped around 72 chars',
      '- One logical change per commit; never mix formatting with logic',
      '- Stage deliberately (hunk or line level) and re-read the diff before committing',
    ].join('\n'),
  },
  {
    id: 'bug-triage',
    name: 'Bug triage',
    description: 'Reproduce, locate the true origin, fix the cause, add a regression test.',
    content: [
      '# Bug triage protocol',
      '',
      '1. Reproduce reliably — smallest possible case first',
      '2. Read the error at its true origin, not just the throw site',
      '3. Form ONE hypothesis and verify it with logs or a test before fixing',
      '4. Fix the cause, not the symptom; add a regression test',
      '5. Search for the same pattern elsewhere in the codebase',
    ].join('\n'),
  },
  {
    id: 'refactor-safety',
    name: 'Refactor safety',
    description: 'Behaviour-preserving refactoring in small verified steps.',
    content: [
      '# Refactor safety',
      '',
      '- Behaviour-preserving only: no feature changes mixed into refactors',
      '- Small steps: rename, verify, move, verify',
      '- Keep the public surface stable unless the task says otherwise',
      '- Let existing tests pin behaviour before restructuring',
    ].join('\n'),
  },
  {
    id: 'security-review',
    name: 'Security review',
    description: 'Validate input, protect secrets, least privilege, report with severity.',
    content: [
      '# Security review checklist',
      '',
      '- Validate every external input (paths, URLs, JSON) — no `..` escapes',
      '- Never log or commit secrets/API keys',
      '- Shell commands: quote every argument; no concatenating user data',
      '- Least privilege: tools and agents get the minimum access needed',
      '- Report findings with severity + a concrete fix',
    ].join('\n'),
  },
  {
    id: 'docs-writing',
    name: 'Docs writing',
    description: 'Lead with what, then how; real paths and examples from this repo.',
    content: [
      '# Documentation writing',
      '',
      '- Lead with what it does, then how to use it, then details',
      '- Use real commands and paths from this repo (.pigry/, src-tauri/, src/)',
      '- One idea per paragraph; examples beat abstract description',
      '- Keep the existing document voice and formatting',
    ].join('\n'),
  },
  {
    id: 'release-notes',
    name: 'Release notes',
    description: 'Group by Features/Fixes/Internal; one user-visible line per change.',
    content: [
      '# Release notes format',
      '',
      '- Group by: Features / Fixes / Internal',
      '- Each bullet: one user-visible change (what + why it matters)',
      '- Reference PR or commit ids in parentheses',
      '- Breaking changes first, clearly marked',
    ].join('\n'),
  },
];

/** Full markdown content of a skill by id — base skills resolve in code,
 * extension skills read their file. */
export async function getSkillContent(id: string): Promise<string> {
  const builtin = BUILTIN_SKILLS.find((skill) => skill.id === id);
  if (builtin) return builtin.content;
  return (await readWorktreeFile(SKILLS_DIR + id + '.md')).content;
}

export async function listSkills(): Promise<SkillEntry[]> {
  const merged = new Map<string, SkillEntry>();
  // Base skills first — hard-coded, always present.
  for (const skill of BUILTIN_SKILLS) {
    merged.set(skill.id, {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      builtIn: true,
    });
  }
  // Extension skills from .pigry/skills/ override same-id built-ins
  // (user customisation wins).
  try {
    const tree = await getFileTree();
    const paths = tree.entries.filter(
      (p) => p.startsWith(SKILLS_DIR) && p.endsWith('.md'),
    );
    for (const path of paths) {
      const id = path.slice(SKILLS_DIR.length, -3);
      try {
        const meta = parseSkillMeta(id, (await readWorktreeFile(path)).content);
        merged.set(id, { ...meta, builtIn: false });
      } catch {
        merged.set(id, { id, name: id, description: '', builtIn: false });
      }
    }
  } catch {
    // file tree unavailable — base skills still listed
  }
  return [...merged.values()].sort((a, b) =>
    a.builtIn === b.builtIn ? a.id.localeCompare(b.id) : a.builtIn ? -1 : 1,
  );
}


