import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { AGENT_LABEL, type AgentId, type ImportItem, type ItemStatus } from '../../lib/agentImport';
import { IMPORT_AGENTS, importAgent, loadSyncRecords, previewAgent, syncImports, type Preview } from '../../lib/agentImportIo';

const STATUS_LABEL: Record<ItemStatus, string> = { new: 'new', same: 'already imported', update: 'source changed', conflict: 'differs — kept' };
const KIND_LABEL: Record<ImportItem['kind'], string> = { instructions: 'Instructions', skill: 'Skill', mcp: 'MCP server' };
const itemName = (item: ImportItem): string => (item.kind === 'skill' ? item.id : item.kind === 'mcp' ? item.name : item.title);

/** Settings → Import from other agents: Claude Code, Codex and Antigravity keep instructions, skills and MCP servers in the home folder;
 * this brings them into the current project. Preview first, then import. Credentials are never read. */
export function ImportAgentsPanel() {
  const { notify } = useRepository();
  const [previews, setPreviews] = useState<Partial<Record<AgentId, Preview>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [reports, setReports] = useState<Partial<Record<AgentId, string[]>>>({});
  const [records, setRecords] = useState(loadSyncRecords);

  const fail = (error: unknown): void => notify(error instanceof Error ? error.message : String(error), 'error');

  const preview = async (agent: AgentId): Promise<void> => {
    setBusy(agent);
    try { const p = await previewAgent(agent); setPreviews((s) => ({ ...s, [agent]: p })); } catch (error) { fail(error); } finally { setBusy(null); }
  };
  const run = async (agent: AgentId): Promise<void> => {
    setBusy(agent);
    try {
      const p = previews[agent] ?? await previewAgent(agent);
      const r = await importAgent(agent, replace, p);
      setReports((s) => ({ ...s, [agent]: [`${r.imported} imported, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped} skipped.`, ...r.lines] }));
      setRecords(loadSyncRecords());
      setPreviews((s) => ({ ...s, [agent]: undefined }));
      await preview(agent);
      notify(`${AGENT_LABEL[agent]}: ${r.imported + r.updated} item(s) imported`, 'success');
    } catch (error) { fail(error); } finally { setBusy(null); }
  };
  const sync = async (): Promise<void> => {
    setBusy('sync');
    try {
      const done = await syncImports();
      setRecords(loadSyncRecords());
      const changed = done.filter((d) => d.result);
      notify(done.length === 0 ? 'Nothing has been imported yet, so there is nothing to sync.' : changed.length === 0 ? 'Everything imported is up to date.' : `Synced ${changed.map((d) => AGENT_LABEL[d.agent]).join(', ')}`, 'success');
      setReports((s) => ({ ...s, ...Object.fromEntries(changed.map((d) => [d.agent, [`Sync: ${d.result!.imported} imported, ${d.result!.updated} updated, ${d.result!.skipped} skipped.`, ...d.result!.lines]])) }));
    } catch (error) { fail(error); } finally { setBusy(null); }
  };

  return (
    <div className="imp" data-testid="import-agents">
      <p className="app-settings__lead">
        Bring what you already set up in other coding agents into this project: instructions (CLAUDE.md, AGENTS.md, GEMINI.md, rules), skills and MCP servers.
        Nothing is changed in the other agent. Sign-ins and tokens are never read, and MCP servers arrive switched off.
      </p>
      <div className="imp__bar">
        <label className="imp__check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace items that already exist and differ</label>
        <span className="imp__grow" />
        <button type="button" className="prov-mgr__ghost-btn" disabled={busy !== null || Object.keys(records).length === 0} onClick={() => void sync()} title="Re-import the agents you imported before, if their files changed">
          <RefreshCw size={12} strokeWidth={1.5} className={busy === 'sync' ? 'prov-mgr__spin' : undefined} /> Sync changed sources
        </button>
      </div>
      {IMPORT_AGENTS.map((agent) => {
        const p = previews[agent];
        const record = records[agent];
        const todo = p ? p.statuses.filter((s) => s === 'new' || s === 'update' || (s === 'conflict' && replace)).length : 0;
        return (
          <section key={agent} className="imp__card" aria-label={AGENT_LABEL[agent]}>
            <header className="imp__head">
              <strong>{AGENT_LABEL[agent]}</strong>
              <span className="imp__muted">{p ? p.root : agent === 'claude-code' ? '~/.claude' : agent === 'codex' ? '~/.codex' : '~/.gemini'}</span>
              {record && <span className="imp__muted" title={new Date(record.at).toLocaleString()}>imported {new Date(record.at).toLocaleDateString()}{p?.changedSinceImport ? ' · source changed' : ''}</span>}
              <span className="imp__grow" />
              <button type="button" className="prov-mgr__ghost-btn" disabled={busy !== null} onClick={() => void preview(agent)}>{busy === agent && !p ? 'Reading…' : p ? 'Refresh preview' : 'Preview'}</button>
              <button type="button" className="prov-mgr__add" disabled={busy !== null || !p || todo === 0} onClick={() => void run(agent)}>
                <Download size={12} strokeWidth={1.75} /> Import{p && todo > 0 ? ` ${todo}` : ''}
              </button>
            </header>
            {p && !p.found && <p className="imp__muted" data-testid={`${agent}-missing`}>Not found on this computer.</p>}
            {p && p.found && p.plan.items.length === 0 && <p className="imp__muted">Nothing to import (no instructions, skills or MCP servers found).</p>}
            {p && p.plan.items.length > 0 && (
              <ul className="imp__items" aria-label={`${AGENT_LABEL[agent]} items`}>
                {p.plan.items.map((item, i) => (
                  <li key={item.key}>
                    <span className="imp__kind">{KIND_LABEL[item.kind]}</span>
                    <span className="imp__name" title={item.key}>{itemName(item)}</span>
                    <span className={`imp__status imp__status--${p.statuses[i]}`}>{STATUS_LABEL[p.statuses[i]]}</span>
                  </li>
                ))}
              </ul>
            )}
            {p && p.plan.notes.length > 0 && <ul className="imp__notes">{p.plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            {reports[agent] && <ul className="imp__report" aria-label="Import report">{reports[agent]!.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          </section>
        );
      })}
    </div>
  );
}
