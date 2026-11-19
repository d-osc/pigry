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
    description: 'Find, read, save and preview repository files.',
    content: [
      '# File navigation',
      '',
      '- Use list_files for paths, search_code for a symbol or literal, and read_file for the surrounding code.',
      '- Open files with Ctrl/Cmd+P in Explorer and save with Ctrl/Cmd+S. Dirty dots mark unsaved edits.',
      '- Use read_image for supported images, read_pdf for PDFs, read_word for DOCX and read_excel for XLSX.',
      '- Use git_status and read_diff to inspect saved worktree changes.',
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
      '- read_history returns commit rows, and read_commit shows a commit’s files or compares a file with its first parent',
      '- Pass ref to read_history for a branch or first_parent=true to follow the main line of that branch.',
      '- Explain which parent and branch are relevant when reviewing merge commits.',
    ].join('\n'),
  },
  {
    id: 'merge-conflict',
    name: 'Merge conflicts',
    description: 'Merge from the Merge branch menu; resolve conflicts inline.',
    content: [
      '# Merge workflow',
      '',
      '- Use git_status to identify the checked-out branch and preview_merge with the source branch to inspect incoming commits and files.',
      '- Choose fast-forward, merge commit or squash based on the intended history.',
      '- For conflicts, review both sides in Working changes, resolve and stage the result, then complete the merge.',
      '- Use Abort merge to restore the pre-merge state when the merge should be cancelled.',
    ].join('\n'),
  },
  {
    id: 'push-review',
    name: 'Push review',
    description: 'Review unpushed commits before pushing upstream.',
    content: [
      '# Push review',
      '',
      '- Use git_status to check the upstream and ahead/behind counts.',
      '- Call preview_sync_commits with direction=push to inspect outgoing commits, then read_commit for a selected file.',
      '- Review unintended files, test coverage and the intended destination before using Push or Publish branch.',
    ].join('\n'),
  },
  {
    id: 'pull-review',
    name: 'Pull review',
    description: 'Review fetched commits and check whether a fast-forward pull can proceed.',
    content: [
      '# Pull review',
      '',
      '- Use git_status to check the current branch, its upstream and ahead/behind counts.',
      '- Call preview_sync_commits with direction=pull to read commits from the locally fetched upstream. Use Fetch in Pull commit to refresh that upstream.',
      '- Open a commit and file in Pull commit or use read_commit with the commit SHA and path. Summarize changes that affect tests, configuration or migrations.',
      '- Use the fast-forward pull action when the local branch is behind without local-only commits. For diverged branches, review both histories before choosing a reconciliation strategy.',
    ].join('\n'),
  },
  {
    id: 'branch-comparison',
    name: 'Branch comparison',
    description: 'Compare branch tips and explain changes by commit and file.',
    content: [
      '# Branch comparison',
      '',
      '- Use git_status to find the Base and Compare refs. Pass full refs such as refs/heads/main and refs/remotes/origin/feature to compare_branches.',
      '- Interpret additions and deletions in the direction from Base to Compare. Report the commit count unique to each side.',
      '- Pass path to compare_branches for the code versions of a changed file. In Compare branch, open the file and choose Split or Unified.',
      '- Focus the review on behavior changes, affected files and tests to run.',
    ].join('\n'),
  },
  {
    id: 'stash-management',
    name: 'Stash management',
    description: 'Stash, apply, pop and drop — keep or discard entries deliberately.',
    content: [
      '# Stash workflow',
      '',
      '- Call preview_stash to list entries and pass index to inspect one entry and its changed files.',
      '- Save a stash with a descriptive message. Check the active branch and working changes before restoring one.',
      '- Apply retains the stash entry. A successful Pop applies and removes it.',
      '- Resolve any conflicts in Working changes. Confirm the intended entry before dropping it.',
    ].join('\n'),
  },
  {
    id: 'cherry-pick-flow',
    name: 'Cherry pick',
    description: 'Pick a commit onto the current branch; conflicts stage for commit.',
    content: [
      '# Cherry-pick flow',
      '',
      '- Use git_status to confirm the checked-out destination, then read_commit to review the selected commit and related changes.',
      '- In Cherry Pick, apply the selected commit to stage its changes on the current branch.',
      '- Resolve conflicts if Git reports them, stage the resolution, and commit the result in Working changes.',
    ].join('\n'),
  },
  {
    id: 'duplicate-commit',
    name: 'Duplicate commit',
    description: 'Check whether a commit can be copied from one local branch to another.',
    content: [
      '# Duplicate commit',
      '',
      '- Identify the local source and destination branches with git_status. Use read_history for the source and read_commit for the selected commit and its file changes.',
      '- Call check_duplicate_commit with source_branch, destination_branch and the full oid. Git includes both exact SHA matches and equivalent changes when checking eligibility.',
      '- An eligible commit shows a green copy icon in Duplicate commit. Use the menu to copy it to the chosen destination while staying on the current branch.',
      '- If Git reports a conflict, inspect the overlapping changes. The destination ref advances only after Git can apply the commit successfully.',
    ].join('\n'),
  },
  {
    id: 'edit-commit',
    name: 'Edit commit',
    description: 'Amend the selected commit and replay the commits that follow it.',
    content: [
      '# Edit commit',
      '',
      '- Use git_status and read_history with first_parent=true to verify the checked-out local branch and find the commit.',
      '- Start with a clean working tree. Choose the commit in Edit commit and select Start editing.',
      '- Save files in Explorer, stage the intended edits in Working changes, and review them with read_diff using staged=true.',
      '- Use Save and continue to amend the selected commit and replay later commits. This rewrites their history. Resolve and stage conflicts before Continue rebase, or use Abort edit to restore the original branch.',
    ].join('\n'),
  },
  {
    id: 'rebase-plan',
    name: 'Rebase plan',
    description: 'Review the target base, replay order and conflict resolution.',
    content: [
      '# Rebase plan',
      '',
      '- Use git_status to confirm the current branch and working changes, and read_history for the branch and proposed base.',
      '- Review the plan in Rebase Branch. Git replays steps from oldest to newest. Keep dependencies before their callers and check what each squash or drop removes.',
      '- If Git pauses on a conflict, inspect and stage the resolution in Working changes, then continue the rebase from the terminal.',
      '- Rebase rewrites the selected history. Use Abort rebase to restore the original branch if the operation should be cancelled.',
    ].join('\n'),
  },
  {
    id: 'working-changes-review',
    name: 'Working changes review',
    description: 'Separate staged and unstaged edits and verify the intended commit.',
    content: [
      '# Working changes review',
      '',
      '- Use git_status to find changed files and distinguish staged, unstaged and untracked entries.',
      '- Use read_diff with staged=true for the index and staged=false for saved working-tree changes.',
      '- Stage only the files, hunks or lines the user wants to include. Recheck the staged diff and note the relevant tests.',
      '- During an active Edit commit session, use Save and continue to complete the amendment.',
    ].join('\n'),
  },
  {
    id: 'branch-ops',
    name: 'Branch operations',
    description: 'Create, checkout and clean up branches; local vs remote symbols.',
    content: [
      '# Branch operations',
      '',
      '- Use git_status to distinguish local refs, remote-tracking refs and the active upstream.',
      '- Read a branch’s history with read_history and compare refs using compare_branches.',
      '- Check the current branch and working changes before creating or checking out a branch in the Branches menu.',
    ].join('\n'),
  },
  {
    id: 'pr-review',
    name: 'Pull request review',
    description: 'Review a PR using its commits, changed files and checks.',
    content: [
      '# Pull request review',
      '',
      '- Call github_pull_requests with action=view and the PR number to inspect the branches, reviewers and checks.',
      '- Use action=file_patches for targeted files and action=commit_diff with a full commit oid for a per-commit diff.',
      '- In the Pull requests screen, expand a file or commit for an inline diff. Use Show more to load the next page.',
      '- Report actionable findings with file or line references, explain the impact and note test gaps. Use github_actions for failed check logs.',
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
      '- Reference related issues with their actual numbers and summarize relevant check results.',
      '- Use github_pull_requests with action=list to check for an existing PR. Submit the reviewed draft in Pull requests.',
    ].join('\n'),
  },
  {
    id: 'issue-triage',
    name: 'Issue triage',
    description: 'Triage and draft issues: reproduce, expected vs actual, labels.',
    content: [
      '# Issue triage',
      '',
      '- Use github_issues with action=list or action=view to find related issues and read their comments.',
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
      '- Use github_actions with action=list to find the run, then action=view and run_id to identify the first failing job.',
      '- Use action=logs with run_id and the relevant job_id. Quote the smallest useful error excerpt and name a check that would confirm the cause.',
      '- Use action=artifacts to check build outputs. Rerun workflows from Actions when appropriate.',
    ].join('\n'),
  },
  {
    id: 'project-board',
    name: 'Project boards',
    description: 'Review project board items, status and blockers.',
    content: [
      '# Project boards',
      '',
      '- Use github_projects with action=list to find the board, then action=items with its number.',
      '- Check linked issues and PRs to identify dependencies, blockers and status mismatches. Suggest a concrete next action for each item.',
    ].join('\n'),
  },
  {
    id: 'repo-insights',
    name: 'Repo insights',
    description: 'Read activity, stats and contributor data.',
    content: [
      '# Repo insights',
      '',
      '- Use repo_insights with metric=activity for commit and contributor counts, metric=delivery for PR and issue metrics, or metric=traffic for views and clones.',
      '- State the date range, branch and any differences in coverage before comparing periods.',
      '- Identify missing or partial metrics and base conclusions on the returned data.',
    ].join('\n'),
  },
  {
    id: 'web-research',
    name: 'Web research',
    description: 'web_search first, then playwright to read the best result.',
    content: [
      '# Web research',
      '',
      '- Use web_search to find sources, then open the relevant pages with an available browser tool.',
      '- For a page the user is viewing, use browser_panel to read it. Use playwright for rendered page text when available.',
      '- Cite the pages you used and distinguish observations from inferences.',
    ].join('\n'),
  },
  {
    id: 'workspace-tool-use',
    name: 'Workspace tool use',
    description: 'Choose the available tool that matches the current menu and task.',
    content: [
      '# Workspace tool use',
      '',
      '- Use git_status to identify the repository state and list_files or search_code to find relevant code.',
      '- Prefer tools for the task, such as read_commit for commit content, compare_branches for branch differences, and github_pull_requests for PR details.',
      '- Use agent_contacts to find the menu’s specialist and agent_lookup to check their role.',
      '- Review tool errors, missing permissions or truncated output before drawing conclusions. State what the available data verifies.',
    ].join('\n'),
  },
  {
    id: 'run-tests',
    name: 'Run tests',
    description: 'Find and run the tests relevant to the current repository.',
    content: [
      '# Run tests',
      '',
      '- Read the current repository’s manifests, scripts and contributor instructions to find its test commands.',
      '- Start with the smallest test that exercises the change, then run the relevant build, lint or wider suite.',
      '- Report the commands run, their results and any validation blocked by missing dependencies.',
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
      '- Use github_security with alert_type=code, dependencies or secrets to inspect repository alerts.',
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
      '- Verify commands and paths against the current repository.',
      '- One idea per paragraph; examples beat abstract description',
      '- Keep the existing document voice and formatting',
    ].join('\n'),
  },
  {
    id: 'wiki-workflow',
    name: 'Wiki workflow',
    description: 'Review GitHub Wiki pages, links and change history.',
    content: [
      '# Wiki workflow',
      '',
      '- Use github_wiki with action=list to find a page, then action=view or history with its file path.',
      '- Sync from the Wiki menu when the local wiki is stale. Check related pages and links before proposing changes.',
      '- Preserve page terminology and links. Use the Wiki editor to save the reviewed update with a descriptive message.',
    ].join('\n'),
  },
  {
    id: 'release-notes',
    name: 'Release notes',
    description: 'Group by Features/Fixes/Internal; one user-visible line per change.',
    content: [
      '# Release notes format',
      '',
      '- Use github_releases with action=list or view to verify tags, release notes and assets. Check linked PRs and commits for changes in scope.',
      '- Group by: Features / Fixes / Internal',
      '- Each bullet: one user-visible change (what + why it matters)',
      '- Reference PR or commit ids in parentheses',
      '- Breaking changes first, clearly marked',
    ].join('\n'),
  },
];

const builtinById = new Map(BUILTIN_SKILLS.map(skill => [skill.id, skill]));

async function projectSkillPaths(): Promise<Map<string, string>> {
  try {
    const tree = await getFileTree();
    return new Map(tree.entries
      .filter(path => path.startsWith(SKILLS_DIR) && path.endsWith('.md'))
      .map(path => [path.slice(SKILLS_DIR.length, -3), path]));
  } catch {
    return new Map();
  }
}

async function readProjectSkill(path: string): Promise<string | undefined> {
  try {
    const file = await readWorktreeFile(path);
    return file.binary || file.tooLarge ? undefined : file.content;
  } catch {
    return undefined;
  }
}

/** Resolve a turn's explicit tags and assigned skills once, with project overrides. */
export async function buildSkillContext(text: string, assigned: string[]): Promise<string> {
  const paths = await projectSkillPaths();
  const tokens = new Set([...text.matchAll(/(?:^|\s)#([\w-]+)/g)].map(match => match[1].toLowerCase()));
  const idsByToken = new Map([...builtinById.keys(), ...paths.keys()].map(id => [id.toLowerCase(), id]));
  const projectReads = new Map<string, Promise<string | undefined>>();
  const read = (id: string, path: string) => {
    const existing = projectReads.get(id) ?? readProjectSkill(path);
    projectReads.set(id, existing);
    return existing;
  };

  // The picker inserts IDs. A typed single-token name also works.
  for (const skill of BUILTIN_SKILLS) {
    const token = skill.name.toLowerCase();
    if (!paths.has(skill.id) && tokens.has(token) && !idsByToken.has(token)) idsByToken.set(token, skill.id);
  }
  if ([...tokens].some(token => !idsByToken.has(token))) {
    for (const [id, path] of paths) {
      const markdown = await read(id, path);
      if (markdown === undefined) continue;
      const name = parseSkillMeta(id, markdown).name.toLowerCase();
      if (tokens.has(name) && !idsByToken.has(name)) idsByToken.set(name, id);
    }
  }

  const tagged = new Set([...tokens].flatMap(token => {
    const id = idsByToken.get(token);
    return id ? [id] : [];
  }));
  const selected = new Set([...tagged, ...assigned]);
  const sections: string[] = [];
  for (const id of selected) {
    const path = paths.get(id);
    const markdown = (path ? await read(id, path) : undefined) ?? builtinById.get(id)?.content;
    if (markdown?.trim()) {
      sections.push(`\n\n[Skill: ${id}]\n${markdown.trim().slice(0, tagged.has(id) ? 4000 : 2000)}`);
    }
  }

  // Project skills already selected above have their own section in the turn.
  const project: string[] = [];
  for (const [id, path] of [...paths].slice(0, 8)) {
    if (selected.has(id)) continue;
    const markdown = await read(id, path);
    if (markdown?.trim()) project.push(markdown.trim().slice(0, 1200));
  }
  if (project.length > 0) sections.push(`\n\n[Project skills]\n${project.join('\n\n').slice(0, 4000)}`);
  return sections.join('');
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
  for (const [id, path] of await projectSkillPaths()) {
    const markdown = await readProjectSkill(path);
    if (markdown !== undefined) {
      merged.set(id, { ...parseSkillMeta(id, markdown), builtIn: false });
    } else if (!merged.has(id)) {
      merged.set(id, { id, name: id, description: '', builtIn: false });
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.builtIn === b.builtIn ? a.id.localeCompare(b.id) : a.builtIn ? -1 : 1,
  );
}


