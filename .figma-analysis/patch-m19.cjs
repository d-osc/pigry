const fs = require('fs');

// 1) CommitDetailPanel: add Revert button in the header
let s = fs.readFileSync('src/screens/commit-graph/CommitDetailPanel.tsx', 'utf8');
if (!s.includes('revertCommit')) {
  s = s.replace(
    "import { X } from 'lucide-react';",
    "import { Undo2, X } from 'lucide-react';\nimport { useRepository } from '../../hooks/useRepository';"
  );
  s = s.replace(
    "export function CommitDetailPanel({ oid, onClose }: CommitDetailPanelProps) {",
    "export function CommitDetailPanel({ oid, onClose }: CommitDetailPanelProps) {\n  const { revertCommit, busy } = useRepository();"
  );
  s = s.replace(
    "          <button\n            type=\"button\"\n            className=\"commit-detail__close\"\n            onClick={onClose}\n            aria-label=\"Close commit details\"\n          >\n            <X size={13} />\n          </button>",
    `          <button
            type="button"
            className="commit-detail__revert"
            title="Revert this commit"
            onClick={() => void revertCommit(oid)}
            disabled={busy}
          >
            <Undo2 size={12} />
            Revert
          </button>
          <button
            type="button"
            className="commit-detail__close"
            onClick={onClose}
            aria-label="Close commit details"
          >
            <X size={13} />
          </button>`
  );
  fs.writeFileSync('src/screens/commit-graph/CommitDetailPanel.tsx', s);
  console.log('CommitDetailPanel patched');
}

// 2) commands.ts: add Revert / Cherry-pick commands
let c = fs.readFileSync('src/app/commands.ts', 'utf8');
if (!c.includes('revertCommit')) {
  c = c.replace(
    "import type { RepositoryContextValue } from '../hooks/useRepository';",
    "import type { RepositoryContextValue } from '../hooks/useRepository';"
  );
  // Add revert + cherry-pick commands before syncCommands
  const syncMarker = "  const syncCommands: Command[] = [";
  const opBlock = `  const opCommands: Command[] = (repo?.branches ?? [])
    .filter((branch) => !branch.isHead)
    .map((branch) => ({
      id: \`branch:merge:\${branch.name}\`,
      title: \`Merge branch \${branch.name}\`,
      section: "Sync" as const,
      icon: GitBranchPlus,
      enabled: true,
      run: () => void repository.mergeBranch(branch.name),
    }));

  const syncCommands: Command[] = [`;
  if (!c.includes(syncMarker)) { console.error('sync marker NOT FOUND in commands.ts'); process.exit(1); }
  c = c.replace(syncMarker, opBlock);
  c = c.replace(
    "  return [...navigation, ...repoCommands, createCommand, ...branchCommands, ...deleteCommands, ...tagCommands, ...stashCommands, ...syncCommands];",
    "  return [...navigation, ...repoCommands, createCommand, ...branchCommands, ...deleteCommands, ...tagCommands, ...stashCommands, ...opCommands, ...syncCommands];"
  );
  fs.writeFileSync('src/app/commands.ts', c);
  console.log('commands.ts patched');
}

// 3) CSS for revert button
let css = fs.readFileSync('src/screens/commit-graph/CommitDetailPanel.css', 'utf8');
if (!css.includes('commit-detail__revert')) {
  css = css.replace(
    '.commit-detail__close {',
    `.commit-detail__revert {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  background: var(--accent-tint-1);
  color: var(--accent);
  font-size: var(--fs-2xs);
  font-weight: 600;
}

.commit-detail__revert:hover:not(:disabled) {
  background: var(--accent-tint-2);
}

.commit-detail__revert:disabled {
  opacity: 0.5;
}

.commit-detail__close {`
  );
  fs.writeFileSync('src/screens/commit-graph/CommitDetailPanel.css', css);
  console.log('CSS added');
}
