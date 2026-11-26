import { AGENT_TOOLS, type ToolSpec } from './agentTools';
import * as client from './tauriClient';
import { autoChoice, blockContext, choiceFromName, describeBlock, hasConflictMarkers, parseConflicts, resolveText, type Choice } from './conflicts';

type Input = Record<string, unknown>;

const TEXT_LIMIT = 16_000;
const pathField = { type: 'string', description: 'Repo-relative file path' };
const oidField = { type: 'string', description: 'Commit SHA' };
const numberField = { type: 'integer', minimum: 1 };
const limitField = { ...numberField, maximum: 100, description: 'Maximum items to show (default 20)' };
const actions = (...values: string[]) => ({ type: 'string', enum: values });

function registeredTool(
  name: string,
  properties: Record<string, object>,
  required: string[],
  run: ToolSpec['run'],
): ToolSpec {
  const definition = AGENT_TOOLS.find(tool => tool.name === name);
  if (!definition) throw new Error(`Missing tool registration for ${name}`);
  return {
    id: definition.id,
    name,
    description: definition.description,
    input_schema: { type: 'object', properties, required },
    run,
  };
}

function optionalText(input: Input, field: string): string | undefined {
  const value = input[field];
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

function text(input: Input, field: string): string {
  const value = optionalText(input, field);
  if (value === undefined) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function integer(input: Input, field: string, min = 1): number {
  const value = input[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${field} must be an integer of at least ${min}`);
  }
  return value;
}

function limited(value: string, max = TEXT_LIMIT): string {
  return value.length > max ? value.slice(0, max) + '\n[Output truncated]' : value;
}

function json(value: unknown): string {
  return limited(JSON.stringify(value ?? null));
}

function limit(input: Input): number {
  return input.limit === undefined ? 20 : Math.min(integer(input, 'limit'), 100);
}

function list<T>(items: T[], input: Input): string {
  return json({ total: items.length, items: items.slice(0, limit(input)) });
}

function diffText(original: string | null, modified: string | null): string {
  return json({ original: limited(original ?? '', 7000), modified: limited(modified ?? '', 7000) });
}

async function repoState() {
  const { repository } = await client.getAppState();
  if (!repository) throw new Error('Open a repository first');
  return repository;
}

const fileTools: ToolSpec[] = [
  registeredTool('search_code', { query: { type: 'string' }, limit: limitField }, ['query'], async input =>
    list(await client.searchCode(text(input, 'query')), input)),
  registeredTool('read_diff', { path: pathField, staged: { type: 'boolean', description: 'True for the staged diff. Defaults to unstaged.' } }, ['path'], async input => {
    const diff = await client.getFileDiff(text(input, 'path'), input.staged === true);
    return diff.binary || diff.tooLarge ? json({ binary: diff.binary, tooLarge: diff.tooLarge }) : diffText(diff.original, diff.modified);
  }),
  registeredTool('rename_file', { old_path: pathField, new_path: pathField }, ['old_path', 'new_path'], async input => {
    if (!client.isTauri()) throw new Error('Open the desktop app to rename files');
    const oldPath = text(input, 'old_path');
    const newPath = text(input, 'new_path');
    await client.renameWorktreeFile(oldPath, newPath);
    return `Renamed ${oldPath} to ${newPath}`;
  }),
  registeredTool('delete_file', { path: pathField }, ['path'], async input => {
    if (!client.isTauri()) throw new Error('Open the desktop app to delete files');
    const path = text(input, 'path');
    await client.deleteWorktreeFile(path);
    return `Deleted ${path}`;
  }),
];

const gitTools: ToolSpec[] = [
  registeredTool('git_status', { limit: limitField }, [], async input => {
    const { currentBranch, headOid, upstream, branches, remotes, files, rebaseInProgress, commitEdit } = await repoState();
    return json({
      currentBranch, headOid, upstream, branches: branches.slice(0, limit(input)),
      remotes: remotes.map(({ remote, branches }) => ({ remote, branches: branches.slice(0, limit(input)) })).slice(0, limit(input)),
      fileCount: files.length, files: files.slice(0, limit(input)), rebaseInProgress, commitEdit,
    });
  }),
  registeredTool('read_history', {
    ref: { type: 'string', description: 'Optional branch or ref. Omit for all local branches.' },
    first_parent: { type: 'boolean', description: 'Follow first-parent history when a ref is supplied' },
    limit: limitField,
  }, [], async input => {
    const ref = optionalText(input, 'ref');
    const history = ref ? await client.getBranchCommits(ref, input.first_parent === true) : await client.getCommitHistory(false);
    const commits = history.commits.slice(0, limit(input)).map(({ oid, summary, authorName, timeSeconds, isMerge, refs }) => ({
      oid, summary, authorName, timeSeconds, isMerge, refs,
    }));
    return json({ total: history.total, commits });
  }),
  registeredTool('read_commit', { oid: oidField, path: pathField, limit: limitField }, ['oid'], async input => {
    const detail = await client.getCommitDetail(text(input, 'oid'));
    const path = optionalText(input, 'path');
    if (!path) return json({ ...detail, fileCount: detail.files.length, files: detail.files.slice(0, limit(input)) });
    const file = detail.files.find(file => file.path === path);
    if (!file) throw new Error(`${path} is not in this commit's changed files`);
    const diff = await client.getCommitFileDiff(detail.oid, file.path, file.previousPath);
    return diff.binary || diff.tooLarge ? json({ binary: diff.binary, tooLarge: diff.tooLarge }) : diffText(diff.original, diff.modified);
  }),
  registeredTool('compare_branches', {
    base_ref: { type: 'string', description: 'Full base ref, such as refs/heads/main' },
    compare_ref: { type: 'string', description: 'Full local or remote-tracking ref, such as refs/remotes/origin/feature' },
    path: pathField,
    limit: limitField,
  }, ['base_ref', 'compare_ref'], async input => {
    const diff = await client.compareBranches(text(input, 'base_ref'), text(input, 'compare_ref'));
    const path = optionalText(input, 'path');
    if (!path) return json({ ...diff, fileCount: diff.files.length, files: diff.files.slice(0, limit(input)) });
    const file = diff.files.find(file => file.path === path);
    if (!file) throw new Error(`${path} is not changed between these branch tips`);
    const [original, modified] = await Promise.all([
      file.status === 'A' ? null : client.readFileAtCommit(path, diff.baseOid),
      file.status === 'D' ? null : client.readFileAtCommit(path, diff.compareOid),
    ]);
    const binary = Boolean(original?.binary || modified?.binary);
    const tooLarge = Boolean(original?.tooLarge || modified?.tooLarge);
    return binary || tooLarge ? json({ binary, tooLarge }) : diffText(original?.content ?? null, modified?.content ?? null);
  }),
  registeredTool('preview_sync_commits', { direction: actions('pull', 'push'), limit: limitField }, ['direction'], async input => {
    const direction = text(input, 'direction');
    if (direction === 'pull') {
      const incoming = await client.pullPreview();
      return list([...incoming].reverse(), input);
    }
    if (direction === 'push') {
      const preview = await client.pushPreview();
      return json({ ...preview, commits: [...preview.commits].reverse().slice(0, limit(input)) });
    }
    throw new Error('direction must be pull or push');
  }),
  registeredTool('conflict_list', {}, [], async () => {
    const state = await client.conflictState();
    return json({
      operation: state.operation, branch: state.branch, current: state.currentLabel, incoming: state.incomingLabel, incomingCommit: state.incomingCommit, step: state.step,
      conflicted: state.conflicted,
      next: state.conflicted.length
        ? 'Read each file with conflict_read, then resolve it with conflict_resolve (stage: true when no markers are left).'
        : state.operation ? 'No conflicted files are left: the user can finish the operation in the Merge conflicts menu.' : 'There are no conflicts.',
    });
  }),
  registeredTool('conflict_read', { path: pathField }, ['path'], async input => {
    const path = text(input, 'path');
    const file = await client.readWorktreeFile(path);
    if (file.binary || file.tooLarge) throw new Error(`${path} is ${file.binary ? 'binary' : 'too large'}; it has to be resolved as a whole file`);
    const parsed = parseConflicts(file.content);
    const state = await client.conflictState().catch(() => null);
    return json({
      path, operation: state?.operation ?? null, current: state?.currentLabel, incoming: state?.incomingLabel, malformed: parsed.malformed,
      conflicts: parsed.blocks.map(block => ({
        conflict: block.index + 1, line: block.startLine, currentLabel: block.currentLabel, incomingLabel: block.incomingLabel,
        summary: describeBlock(block), current: block.current.join('\n'), incoming: block.incoming.join('\n'), ancestor: block.base?.join('\n') ?? null,
        suggestion: autoChoice(block) ? { take: autoChoice(block)!.choice.kind === 'both' ? 'both' : autoChoice(block)!.choice.kind, reason: autoChoice(block)!.reason } : null,
        ...blockContext(parsed, block.index, 3),
      })),
    });
  }),
  registeredTool('conflict_resolve', {
    path: pathField,
    resolutions: {
      type: 'array',
      description: 'One entry per conflict to resolve (numbers from conflict_read). take: current | incoming | both | both-incoming-first | base | custom (custom needs text).',
      items: { type: 'object', properties: { conflict: { type: 'integer', minimum: 1 }, take: { type: 'string' }, text: { type: 'string' } }, required: ['conflict', 'take'] },
    },
    stage: { type: 'boolean', description: 'Stage the file (mark it resolved) when no conflict markers are left. Default false.' },
  }, ['path', 'resolutions'], async input => {
    const path = text(input, 'path');
    const file = await client.readWorktreeFile(path);
    if (file.binary || file.tooLarge) throw new Error(`${path} is ${file.binary ? 'binary' : 'too large'}`);
    const parsed = parseConflicts(file.content);
    if (parsed.malformed) throw new Error(`the markers in ${path} are broken (${parsed.malformed}); fix the file with write_file instead`);
    const list = Array.isArray(input.resolutions) ? input.resolutions as Array<Record<string, unknown>> : [];
    if (!list.length) throw new Error('resolutions must list at least one conflict');
    const choices: Record<number, Choice> = {};
    for (const item of list) {
      const n = Number(item.conflict);
      const block = parsed.blocks[n - 1];
      if (!block) throw new Error(`conflict ${String(item.conflict)} does not exist (the file has ${parsed.blocks.length})`);
      const choice = choiceFromName(String(item.take ?? ''), typeof item.text === 'string' ? item.text : undefined);
      if (!choice) throw new Error(`conflict ${n}: take must be current, incoming, both, both-incoming-first, base or custom (with text)`);
      if (choice.kind === 'base' && !block.base) throw new Error(`conflict ${n} has no common ancestor in the file; use current, incoming, both or custom`);
      choices[block.index] = choice;
    }
    const result = resolveText(parsed, choices);
    await client.writeWorktreeFile(path, result);
    const left = parsed.blocks.length - Object.keys(choices).length;
    const markers = hasConflictMarkers(result);
    if (input.stage === true && !markers) await client.stagePaths([path]);
    return json({
      path, resolved: Object.keys(choices).length, left,
      staged: input.stage === true && !markers,
      note: markers ? 'Conflict markers are still in the file; resolve the rest before staging.' : input.stage === true ? 'The file is resolved and staged.' : 'The file has no markers left; pass stage: true (or use the Merge conflicts menu) to mark it resolved.',
    });
  }),
  registeredTool('preview_merge', { branch: { type: 'string' }, limit: limitField }, ['branch'], async input => {
    const preview = await client.mergePreview(text(input, 'branch'));
    return json({ upToDate: preview.upToDate, commitCount: preview.commits.length, fileCount: preview.files.length,
      commits: preview.commits.slice(0, limit(input)).map(({ oid, summary }) => ({ oid, summary })),
      files: preview.files.slice(0, limit(input)).map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    });
  }),
  registeredTool('preview_stash', { index: { type: 'integer', minimum: 0 }, limit: limitField }, [], async input => {
    if (input.index === undefined) return list((await repoState()).stashes, input);
    const preview = await client.stashPreview(integer(input, 'index', 0));
    return json({ ...preview, fileCount: preview.files.length, files: preview.files.slice(0, limit(input)) });
  }),
  registeredTool('check_duplicate_commit', {
    source_branch: { type: 'string', description: 'Local source branch name' },
    destination_branch: { type: 'string', description: 'Local destination branch name' },
    oid: { ...oidField, description: 'Full commit SHA from the source branch' },
  }, ['source_branch', 'destination_branch', 'oid'], async input => {
    const source = text(input, 'source_branch');
    const destination = text(input, 'destination_branch');
    if (source === destination) throw new Error('Choose different source and destination branches');
    const oid = text(input, 'oid').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error('oid must be a full 40-character commit SHA');
    const candidates = await client.getDuplicateCommitCandidates(source, destination);
    return json({ oid, eligible: candidates.includes(oid) });
  }),
  registeredTool('repo_insights', {
    metric: actions('activity', 'delivery', 'traffic'),
    days: { ...numberField, maximum: 90, description: 'Period for activity or delivery (default 28 days)' },
    limit: limitField,
  }, ['metric'], async input => {
    const days = input.days === undefined ? 28 : Math.min(integer(input, 'days'), 90);
    switch (input.metric) {
      case 'activity': {
        const insights = await client.getInsights(days);
        return json({ ...insights, people: insights.people.slice(0, limit(input)), recent: insights.recent.slice(0, limit(input)) });
      }
      case 'delivery': return json(await client.ghDeliveryStats(days));
      case 'traffic': return json(await client.ghTraffic());
      default: throw new Error('Unknown insights metric');
    }
  }),
  registeredTool('stage_changes', { action: actions('stage', 'unstage'), paths: { type: 'array', items: pathField, minItems: 1 } }, ['action', 'paths'], async input => {
    const { action, paths } = input;
    if (!Array.isArray(paths) || paths.length === 0 || paths.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('paths must contain at least one repo-relative path');
    }
    if (action === 'stage') await client.stagePaths(paths);
    else if (action === 'unstage') await client.unstagePaths(paths);
    else throw new Error('action must be stage or unstage');
    return json({ action, paths });
  }),
  registeredTool('commit', { title: { type: 'string' }, body: { type: 'string' } }, ['title'], async input => {
    const repo = await repoState();
    if (repo.commitEdit) throw new Error('Use Save and continue in Edit commit to amend the selected commit');
    const outcome = await client.commitChanges(text(input, 'title'), optionalText(input, 'body') ?? '', false);
    return json({ oid: outcome.oid });
  }),
  registeredTool('stash', {
    action: actions('save', 'apply', 'pop'),
    index: { type: 'integer', minimum: 0 },
    message: { type: 'string' },
  }, ['action'], async input => {
    switch (input.action) {
      case 'save': await client.stashChanges(optionalText(input, 'message')); break;
      case 'apply': await client.stashApply(integer(input, 'index', 0)); break;
      case 'pop': await client.stashPop(integer(input, 'index', 0)); break;
      default: throw new Error('action must be save, apply or pop');
    }
    return json({ action: input.action, index: input.index });
  }),
];

const githubTools: ToolSpec[] = [
  registeredTool('github_pull_requests', {
    action: actions('list', 'view', 'file_patches', 'commit_diff'),
    number: numberField, oid: oidField, path: pathField, limit: limitField,
  }, ['action'], async input => {
    switch (input.action) {
      case 'list': return list(await client.ghPrList(), input);
      case 'view': return json(await client.ghPrDetail(integer(input, 'number')));
      case 'file_patches': {
        const files = await client.ghPrFilePatches(integer(input, 'number'));
        const path = optionalText(input, 'path');
        return list(path ? files.filter(file => file.path === path) : files, input);
      }
      case 'commit_diff': return limited(await client.ghPrCommitDiff(text(input, 'oid')));
      default: throw new Error('Unknown pull request action');
    }
  }),
  registeredTool('github_issues', { action: actions('list', 'view'), number: numberField, limit: limitField }, ['action'], async input => {
    if (input.action === 'list') return list(await client.ghIssueList(), input);
    if (input.action === 'view') return json(await client.ghIssueView(integer(input, 'number')));
    throw new Error('Unknown issue action');
  }),
  registeredTool('github_releases', { action: actions('list', 'view'), tag: { type: 'string' }, limit: limitField }, ['action'], async input => {
    if (input.action === 'list') return list(await client.ghReleaseList(), input);
    if (input.action === 'view') {
      const tag = text(input, 'tag');
      if (tag.startsWith('-')) throw new Error('tag must be a release tag');
      return json(await client.ghReleaseView(tag));
    }
    throw new Error('Unknown release action');
  }),
  registeredTool('github_actions', {
    action: actions('list', 'view', 'logs', 'artifacts'), run_id: numberField, job_id: numberField, limit: limitField,
  }, ['action'], async input => {
    switch (input.action) {
      case 'list': return json(await client.ghRunList(limit(input)));
      case 'view': return json(await client.ghRunView(integer(input, 'run_id')));
      case 'logs': return limited(await client.ghRunLogs(integer(input, 'run_id'), input.job_id === undefined ? undefined : integer(input, 'job_id')));
      case 'artifacts': return list(await client.ghRunArtifacts(integer(input, 'run_id')), input);
      default: throw new Error('Unknown workflow action');
    }
  }),
  registeredTool('github_projects', { action: actions('list', 'items'), number: numberField, limit: limitField }, ['action'], async input => {
    if (input.action === 'list') return list(await client.ghProjectList(), input);
    if (input.action === 'items') return list(await client.ghProjectItemList(integer(input, 'number')), input);
    throw new Error('Unknown project action');
  }),
  registeredTool('github_security', { alert_type: actions('code', 'dependencies', 'secrets'), limit: limitField }, ['alert_type'], async input => {
    switch (input.alert_type) {
      case 'code': return list(await client.ghCodeScanningAlerts(), input);
      case 'dependencies': return list(await client.ghDependabotAlerts(), input);
      case 'secrets': return list(await client.ghSecretScanningAlerts(), input);
      default: throw new Error('Unknown alert type');
    }
  }),
  registeredTool('github_wiki', { action: actions('list', 'view', 'history'), file: pathField, limit: limitField }, ['action'], async input => {
    if (input.action === 'list') return list(await client.wikiList(), input);
    if (input.action === 'view') return json(await client.wikiRead(text(input, 'file')));
    if (input.action === 'history') return list(await client.wikiPageHistory(text(input, 'file')), input);
    throw new Error('Unknown wiki action');
  }),
];

export const WORKSPACE_AGENT_TOOLS = [...fileTools, ...gitTools, ...githubTools];
