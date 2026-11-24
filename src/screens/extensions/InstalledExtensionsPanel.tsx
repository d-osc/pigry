/** Settings › Extensions: manage what is already installed (built-in menus and packs) and upload an extension from a
 * file. Finding new extensions is the job of the Extension Store menu. */
import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, FileUp, Puzzle, Store, Terminal, Trash2, Wand2 } from 'lucide-react';
import { workspaceNav } from '../../app/navigation';
import { useDisabledMenus } from '../../hooks/useExtensions';
import { GO_SCREEN_EVENT, setMenuEnabled } from '../../lib/builtinExtensions';
import { MENU_GUIDES } from '../../lib/menuGuides';
import type { InstalledExtension } from '../../lib/extensionManifest';
import {
  EXTENSION_OPEN, EXTENSIONS_CHANGED, listExtensions, setExtensionEnabled, takePendingOpenExtension, uninstallExtension,
} from '../../lib/extensions';
import { useExtensionInstall } from './useExtensionInstall';
import './ExtensionsPanel.css';

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function Contents({ extension }: { extension: InstalledExtension }) {
  return (
    <div className="ext-contents">
      {extension.agentNames.length > 0 && (
        <p><Bot size={12} strokeWidth={1.5} /> <strong>Agents</strong> {extension.agentNames.join(', ')}</p>
      )}
      {extension.skills.length > 0 && (
        <p><Wand2 size={12} strokeWidth={1.5} /> <strong>Skills</strong> {extension.skills.map((skill) => `#${skill.id}`).join(', ')}</p>
      )}
      {extension.hookCommands.length > 0 && (
        <p><Terminal size={12} strokeWidth={1.5} /> <strong>Hooks</strong> {extension.hookCommands.map((command) => <code key={command}>{command}</code>)}</p>
      )}
      {extension.mcpNames.length > 0 && (
        <p><Terminal size={12} strokeWidth={1.5} /> <strong>MCP servers</strong> {extension.mcpNames.join(', ')}</p>
      )}
    </div>
  );
}

export function InstalledExtensionsPanel() {
  const [installed, setInstalled] = useState<InstalledExtension[]>(() => listExtensions());
  // An extension picked in the side bar before Settings was open is waiting for us.
  const [selectedId, setSelectedId] = useState<string | null>(() => takePendingOpenExtension());
  const [open, setOpen] = useState<Set<string>>(() => (selectedId ? new Set([selectedId]) : new Set()));
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const disabledMenus = useDisabledMenus();
  const builtinMenus = workspaceNav.filter(({ group }) => group === 'extension');

  const { startReview, feedback, dialog, clearFeedback } = useExtensionInstall((extension) => {
    setPasting(false);
    setPasted('');
    setOpen((current) => new Set(current).add(extension.id));
  });

  useEffect(() => {
    const refresh = () => setInstalled(listExtensions());
    const onOpen = (event: Event) => {
      takePendingOpenExtension();
      const id = String((event as CustomEvent<string>).detail ?? '') || null;
      setSelectedId(id);
      if (id) setOpen((current) => new Set(current).add(id));
    };
    window.addEventListener(EXTENSIONS_CHANGED, refresh);
    window.addEventListener(EXTENSION_OPEN, onOpen);
    return () => {
      window.removeEventListener(EXTENSIONS_CHANGED, refresh);
      window.removeEventListener(EXTENSION_OPEN, onOpen);
    };
  }, []);

  useEffect(() => {
    if (selectedId) document.getElementById(`ext-${selectedId}`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, installed.length]);

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    clearFeedback();
    if (file.size > 400_000) {
      setFileError('The file is larger than 400 KB.');
      return;
    }
    setFileError('');
    await startReview(await file.text(), 'file');
  };

  const toggleOpen = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="ext-panel">
      {feedback}
      {fileError && <div className="ext-errors" role="alert">{fileError}</div>}

      <section className="ext-block" aria-label="Upload an extension">
        <h3 className="ext-block__title">Upload an extension</h3>
        <p className="ext-hint">Install an extension from your computer: one JSON file that adds agents, skills, hooks or MCP servers. You review what it adds before anything is installed.</p>
        <div className="ext-actions">
          <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="Extension file" onChange={(event) => { void chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
          <button type="button" className="ext-btn ext-btn--primary" onClick={() => fileRef.current?.click()}><FileUp size={13} strokeWidth={1.5} /> Upload file…</button>
          <button type="button" className="ext-btn" onClick={() => setPasting((on) => !on)}>Paste JSON…</button>
        </div>
        {pasting && (
          <div className="ext-paste">
            <textarea aria-label="Extension JSON" placeholder='{ "pigryExtension": 1, "id": "acme.my-pack", "name": "My pack", ... }' value={pasted} spellCheck={false} onChange={(event) => setPasted(event.target.value)} />
            <button type="button" className="ext-btn ext-btn--primary" disabled={!pasted.trim()} onClick={() => { clearFeedback(); void startReview(pasted, 'paste'); }}>Review…</button>
          </div>
        )}
      </section>

      <section className="ext-block" aria-label="Built-in extensions">
        <h3 className="ext-block__title">Built-in <span className="ext-count">{builtinMenus.length}</span></h3>
        <p className="ext-hint">Menus that come with Pigry. Switch one off to hide it from the side bar and the command palette; its files and agents stay.</p>
        {builtinMenus.map(({ id, label, icon: Icon }) => {
          const enabled = !disabledMenus.has(id);
          return (
            <article key={id} className={`ext-card${enabled ? '' : ' ext-card--off'}`}>
              <div className="ext-card__head">
                <Icon size={15} strokeWidth={1.5} className="ext-card__icon" />
                <div className="ext-card__main">
                  <strong>{label}</strong>
                  <span className="ext-card__meta">Built-in · menu</span>
                </div>
                {enabled && (
                  <button type="button" className="ext-btn" aria-label={`Open ${label}`} onClick={() => window.dispatchEvent(new CustomEvent(GO_SCREEN_EVENT, { detail: id }))}>Open</button>
                )}
                <button
                  type="button" role="switch" aria-checked={enabled} aria-label={`Enable ${label}`}
                  className={`ext-switch${enabled ? ' ext-switch--on' : ''}`}
                  onClick={() => setMenuEnabled(id, !enabled)}
                ><span /></button>
              </div>
              <p className="ext-card__desc">{MENU_GUIDES[id].summary}</p>
            </article>
          );
        })}
      </section>

      <section className="ext-block" aria-label="Installed extensions">
        <h3 className="ext-block__title">Installed <span className="ext-count">{installed.length}</span></h3>
        {installed.length === 0 && (
          <div className="ext-empty">
            <p>No extensions installed yet.</p>
            <button type="button" className="ext-btn" onClick={() => window.dispatchEvent(new CustomEvent(GO_SCREEN_EVENT, { detail: 'extensions' }))}>
              <Store size={13} strokeWidth={1.5} /> Find extensions in the Extension Store
            </button>
          </div>
        )}
        {installed.map((extension) => {
          const expanded = open.has(extension.id);
          return (
            <article key={extension.id} id={`ext-${extension.id}`} className={`ext-card${selectedId === extension.id ? ' ext-card--selected' : ''}${extension.enabled ? '' : ' ext-card--off'}`}>
              <div className="ext-card__head">
                <button type="button" className="ext-card__toggle-open" aria-expanded={expanded} aria-label={`Details of ${extension.name}`} onClick={() => toggleOpen(extension.id)}>
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <Puzzle size={15} strokeWidth={1.5} className="ext-card__icon" />
                <div className="ext-card__main">
                  <strong>{extension.name}</strong>
                  <span className="ext-card__meta">v{extension.version}{extension.author ? ` · ${extension.author}` : ''} · {extension.source === 'catalog' ? 'from the store' : 'uploaded'}</span>
                </div>
                <button
                  type="button" role="switch" aria-checked={extension.enabled} aria-label={`Enable ${extension.name}`}
                  className={`ext-switch${extension.enabled ? ' ext-switch--on' : ''}`}
                  onClick={() => setExtensionEnabled(extension.id, !extension.enabled)}
                ><span /></button>
              </div>
              {extension.description && <p className="ext-card__desc">{extension.description}</p>}
              <p className="ext-chips">
                {extension.agentNames.length > 0 && <span>{count(extension.agentNames.length, 'agent')}</span>}
                {extension.skills.length > 0 && <span>{count(extension.skills.length, 'skill')}</span>}
                {extension.hookCommands.length > 0 && <span>{count(extension.hookCommands.length, 'hook')}</span>}
                {extension.mcpNames.length > 0 && <span>{count(extension.mcpNames.length, 'MCP server')}</span>}
                {!extension.enabled && <span className="ext-chips__off">off</span>}
              </p>
              {expanded && (
                <>
                  <Contents extension={extension} />
                  <div className="ext-card__actions">
                    {confirmRemove === extension.id ? (
                      <>
                        <span>Remove {extension.name} and everything it added?</span>
                        <button type="button" className="ext-btn ext-btn--danger" onClick={() => { uninstallExtension(extension.id); setConfirmRemove(null); }}>Yes, remove</button>
                        <button type="button" className="ext-btn" onClick={() => setConfirmRemove(null)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" className="ext-btn ext-btn--danger" onClick={() => setConfirmRemove(extension.id)}><Trash2 size={12} strokeWidth={1.5} /> Remove</button>
                    )}
                  </div>
                </>
              )}
            </article>
          );
        })}
      </section>

      {dialog}
    </div>
  );
}
