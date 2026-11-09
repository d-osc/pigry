const fs = require('fs');

// 1) commands.ts: add Clone + Rebase commands
let s = fs.readFileSync('src/app/commands.ts', 'utf8');
if (!s.includes('cloneRepo')) {
  const cloneCmd = [
    "  const cloneCommand: Command = {",
    "    id: 'repo:clone',",
    "    title: 'Clone repository from URL…',",
    "    section: 'Repository' as const,",
    "    icon: FolderOpen,",
    "    enabled: true,",
    "    run: () => {",
    "      const url = window.prompt('Repository URL');",
    "      const target = url ? window.prompt('Target directory') : null;",
    "      if (url && target && target.trim()) void repository.cloneRepo(url, target.trim());",
    "    },",
    "  };",
    "",
    "  const rebaseCommands: Command[] = (repo?.branches ?? [])",
    "    .filter((branch) => !branch.isHead)",
    "    .map((branch) => ({",
    "      id: `branch:rebase:${branch.name}`,",
    "      title: `Rebase onto ${branch.name}`,",
    "      section: 'Repository' as const,",
    "      icon: FolderTree,",
    "      enabled: true,",
    "      run: () => void repository.rebaseOnto(branch.name),",
    "    }));",
  ].join('\n');
  s = s.replace(
    '  const opCommands: Command[] =',
    cloneCmd + '\n\n  const opCommands: Command[] ='
  );
  s = s.replace(
    '  return [...navigation, ...repoCommands, createCommand, ...branchCommands, ...deleteCommands, ...tagCommands, ...stashCommands, ...opCommands, ...syncCommands];',
    '  return [...navigation, ...repoCommands, createCommand, cloneCommand, ...branchCommands, ...deleteCommands, ...tagCommands, ...stashCommands, ...rebaseCommands, ...opCommands, ...syncCommands];'
  );
  fs.writeFileSync('src/app/commands.ts', s);
  console.log('commands.ts patched');
}

// 2) NoRepositoryScreen: Clone UI
let n = fs.readFileSync('src/screens/NoRepositoryScreen.tsx', 'utf8');
if (!n.includes('cloneRepo')) {
  // Add useState import if not present
  if (!n.includes('useState')) {
    n = n.replace(
      "import { FolderOpen, History } from 'lucide-react';",
      "import { useState } from 'react';\nimport { FolderOpen, History } from 'lucide-react';"
    );
  }
  // Add cloneUrl/cloneTarget state
  n = n.replace(
    'export function NoRepositoryScreen() {',
    "export function NoRepositoryScreen() {\n  const [cloneUrl, setCloneUrl] = useState('');\n  const [cloneTarget, setCloneTarget] = useState('');"
  );
  // Add cloneRepo to destructuring
  n = n.replace(
    'const { state, pickRepository, openRepository, busy, error, refresh } = useRepository();',
    'const { state, pickRepository, openRepository, cloneRepo, busy, error, refresh } = useRepository();'
  );
  // Add clone section before the recent list
  n = n.replace(
    '        {state && state.recent.length > 0 && (',
    [
      '        <div className="no-repo__clone">',
      '          <input',
      '            className="no-repo__clone-input"',
      '            placeholder="Repository URL…"',
      '            value={cloneUrl}',
      '            onChange={(e) => setCloneUrl(e.target.value)}',
      '            spellCheck={false}',
      '          />',
      '          <input',
      '            className="no-repo__clone-input"',
      '            placeholder="Target directory…"',
      '            value={cloneTarget}',
      '            onChange={(e) => setCloneTarget(e.target.value)}',
      '            spellCheck={false}',
      '          />',
      '          <button',
      '            type="button"',
      '            className="outline-button"',
      '            onClick={() => {',
      '              if (cloneUrl && cloneTarget) {',
      '                void cloneRepo(cloneUrl, cloneTarget);',
      '              }',
      '            }}',
      '            disabled={busy || !cloneUrl || !cloneTarget}',
      '          >',
      '            Clone',
      '          </button>',
      '        </div>',
      '',
      '        {state && state.recent.length > 0 && (',
    ].join('\n')
  );
  fs.writeFileSync('src/screens/NoRepositoryScreen.tsx', n);
  console.log('NoRepositoryScreen patched');
}

// 3) CSS for clone inputs
let css = fs.readFileSync('src/screens/NoRepositoryScreen.css', 'utf8');
if (!css.includes('no-repo__clone')) {
  css += [
    '',
    '.no-repo__clone {',
    '  width: 100%;',
    '  margin-top: 14px;',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 6px;',
    '}',
    '',
    '.no-repo__clone-input {',
    '  width: 100%;',
    '  height: 28px;',
    '  padding: 0 10px;',
    '  background: var(--bg-input);',
    '  border: 1px solid var(--border);',
    '  border-radius: var(--radius-sm);',
    '  color: var(--text-primary);',
    '  font-size: var(--fs-sm);',
    '  outline: none;',
    '}',
    '',
    '.no-repo__clone-input::placeholder {',
    '  color: var(--text-muted);',
    '}',
    '',
    '.no-repo__clone-input:focus {',
    '  border-color: var(--accent-tint-3);',
    '}',
  ].join('\n');
  fs.writeFileSync('src/screens/NoRepositoryScreen.css', css);
  console.log('CSS added');
}
