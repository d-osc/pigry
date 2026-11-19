import { demoAppState, demoHistory, demoTree, demoFileContent, demoStats, demoCommitDetail } from '../../src/lib/demoWorkspace.ts';

/** Test-only IPC boundary. No test hook or fake backend is shipped in the app. */
export async function installBackend(page, { entries, incoming = [] } = {}) {
  const state = structuredClone(demoAppState);
  state.activePath = '/fixtures/workspace';
  state.recent = [state.activePath];
  state.repository.localPath = state.activePath;
  state.repository.files = [{ id: 'fixture.txt:unstaged', path: 'fixture.txt', name: 'fixture.txt', directory: '', status: 'M', additions: 1, deletions: 1, staged: false, untracked: false }];
  const detail = demoCommitDetail(demoHistory.commits[0].oid);
  await page.addInitScript(({ state, history, tree, content, stats, detail, incoming }) => {
    let opened = false;
    let incomingCommits = [];
    const callbacks = new Map();
    let callbackId = 0;
    const control = { failures: {}, calls: [], settled: [], delay: {}, commitFails: false };
    window.testBackend = control;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback: (fn) => { callbacks.set(++callbackId, fn); return callbackId; },
      unregisterCallback: id => callbacks.delete(id),
      convertFileSrc: path => path,
      invoke: async (cmd, args = {}) => {
        control.calls.push({ cmd, args });
        const delay = control.delay[`${cmd}:${args.number}`] ?? control.delay[cmd];
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        control.settled.push({ cmd, args });
        if (control.failures[cmd]) throw control.failures[cmd];
        if (cmd.startsWith('plugin:')) return 1;
        switch (cmd) {
          case 'pty_create_ssh': return { id: 271, label: `SSH · ${args.host}`, shellName: 'ssh' };
          case 'pty_kill': return null;
          case 'get_app_state': return opened ? state : { ...state, repository: null, activePath: null };
          case 'get_launch_folder': return null;
          case 'open_repository': case 'pick_repository': opened = true; return state;
          case 'refresh': return structuredClone(state);
          case 'stage_paths':
            state.repository.files = state.repository.files.map(file => ({ ...file, id: `${file.path}:staged`, staged: true }));
            return structuredClone(state);
          case 'commit':
            if (control.commitFails) throw 'Pre-commit hook rejected the commit';
            state.repository.files = [];
            return { oid: '1234567890', state: structuredClone(state) };
          case 'git_cli_status': return { found: true, version: 'git test' };
          case 'get_commit_history': case 'get_branch_commits': return history;
          case 'get_commit_detail': return { ...detail, oid: args.oid };
          case 'get_file_tree': return tree;
          case 'read_worktree_file': return { ...content, path: args.path };
          case 'get_repo_stats': return stats;
          case 'get_commit_file_diff': case 'get_file_diff': return { original: 'before\n', modified: 'after\n', binary: false, tooLarge: false, language: 'plaintext' };
          case 'verify_commit_sig': return 'unsigned';
          case 'gh_auth_status': return { loggedIn: true, account: 'validation' };
          case 'gh_account_list': return [];
          case 'gh_pr_list': return [{ number: 42, title: 'Private repository pull request', state: 'OPEN', draft: false, branch: 'feature', baseRef: 'main', author: 'validation', updatedAt: '2026-11-15T00:00:00Z', url: '', review: 'APPROVED', checksTotal: 1, checksOk: 1, comments: 0, labels: [] }];
          case 'gh_pr_detail': return { number: args.number, title: 'Private repository pull request', body: [
            `Reviewable private PR body ${args.number}`,
            '',
            '**Bumps** [example/action](https://github.com/example/action).',
            '',
            '<details>',
            '<summary>Release notes</summary>',
            '<ul><li>Update <code>action</code>.</li></ul>',
            '</details>',
            '',
            '[Unsafe link](javascript:alert%281%29)',
          ].join('\n'), state: 'OPEN', draft: false, author: 'validation', baseRef: 'main', headRef: 'feature', updatedAt: '2026-11-15T00:00:00Z', url: '', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', labels: [], reviews: [], comments: [], files: [{ path: 'feature.txt', additions: 1, deletions: 1 }, { path: 'notes.txt', additions: 1, deletions: 0 }], commits: [{ oid: '1234567890123456789012345678901234567890', message: 'Update feature files' }], checks: [] };
          case 'gh_pr_diff':
          case 'gh_pr_commit_diff': return [
            'diff --git a/feature.txt b/feature.txt',
            '--- a/feature.txt',
            '+++ b/feature.txt',
            '@@ -1 +1 @@',
            '-old feature',
            '+new feature',
            'diff --git a/notes.txt b/notes.txt',
            '--- /dev/null',
            '+++ b/notes.txt',
            '@@ -0,0 +1 @@',
            '+release notes',
          ].join('\n');
          case 'gh_workflow_list': return [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }];
          case 'gh_run_list': return { total: 1, runs: [{ id: 7, number: 7, title: 'Successful CI run', workflowName: 'CI', workflowId: 1, event: 'push', branch: 'main', sha: 'abc1234', status: 'completed', conclusion: 'success', actor: 'validation', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:01:00Z', startedAt: '2026-11-15T00:00:00Z', url: '' }] };
          case 'gh_run_view': return { id: 7, number: 7, title: 'Successful CI run', workflowId: 1, workflowName: 'CI', event: 'push', branch: 'main', sha: 'abc1234', status: 'completed', conclusion: 'success', actor: 'validation', createdAt: '', updatedAt: '', startedAt: '', url: '', jobs: [] };
          case 'gh_run_logs': return 'CI completed successfully\n';
          case 'push_preview': return { commits: [], total: 0, canPublish: true, hasUpstream: false, branch: 'main', remote: 'origin' };
          case 'pull_preview': return incomingCommits;
          case 'git_fetch':
            incomingCommits = incoming;
            state.repository.upstream.behind = incoming.length;
            return { summary: 'Fetched' };
          case 'git_pull':
            incomingCommits = [];
            state.repository.upstream.behind = 0;
            return { summary: 'Pulled' };
          case 'read_file_at_commit':
            return { ...content, content: args.oid === incoming[0]?.oid ? 'after\n' : 'before\n' };
          case 'wiki_check': return { supported: false, hasWiki: false, url: '', cached: false };
          case 'cli_detect': return { claude: false, codex: false };
          case 'detect_zcode_glm': return null;
          case 'validation_ready': return null;
          default: return [];
        }
      },
    };
  }, { state, history: demoHistory, tree: entries ? { ...demoTree, entries } : demoTree, content: demoFileContent, stats: demoStats, detail, incoming });
}

export async function openFixture(page) {
  await page.goto('/');
  await page.locator('.home__recent-item').first().click();
}
