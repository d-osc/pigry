/** Dialogs of the Game Engine editor: add a node, new game, new scene, attach a script and project settings. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { NODE_CATEGORIES, NODE_TYPES, inherits, type Game, type GameOp } from './game';
import type { TemplateKind as TemplateKindLike } from './gameTemplates';
import { NodeIcon } from './GamePanels';

interface ModalProps { title: string; children: ReactNode; onClose: () => void; onOk?: () => void; okLabel?: string; okDisabled?: boolean; wide?: boolean }

export function Modal({ title, children, onClose, onOk, okLabel = 'OK', okDisabled, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input, select, button')?.focus(); }, []);
  return (
    <div className="gm-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref} className={`gm-modal${wide ? ' gm-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && onOk && !okDisabled && (e.target as HTMLElement).tagName === 'INPUT') onOk(); }}
      >
        <header className="gm-modal__head"><h2>{title}</h2><button type="button" className="gm-icon" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="gm-modal__body">{children}</div>
        {onOk && <footer className="gm-modal__foot"><button type="button" className="gm-btn" onClick={onClose}>Cancel</button><button type="button" className="gm-btn gm-btn--primary" disabled={okDisabled} onClick={onOk}>{okLabel}</button></footer>}
      </div>
    </div>
  );
}

/* ---------- create a new node ---------- */

export function AddNodeDialog({ onAdd, onClose, parentType }: { onAdd: (type: string) => void; onClose: () => void; parentType: string }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState('Node3D');
  const q = query.trim().toLowerCase();
  const types = Object.entries(NODE_TYPES).filter(([name, spec]) => !q || name.toLowerCase().includes(q) || spec.description.toLowerCase().includes(q));
  return (
    <Modal title="Create new node" okLabel="Create" wide onClose={onClose} onOk={() => onAdd(picked)} okDisabled={!NODE_TYPES[picked]}>
      <input className="gm-input" placeholder="Search nodes…" aria-label="Search nodes" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="gm-addnode" role="listbox" aria-label="Node types">
        {NODE_CATEGORIES.map((cat) => {
          const list = types.filter(([, s]) => s.category === cat);
          if (!list.length) return null;
          return (
            <div key={cat}>
              <div className="gm-addnode__cat">{cat === 'Physics' ? 'Physics & collision' : cat}</div>
              {list.map(([name]) => {
                return (
                  <button key={name} type="button" role="option" aria-selected={picked === name} className={`gm-addnode__item${picked === name ? ' gm-addnode__item--on' : ''}`} onClick={() => setPicked(name)} onDoubleClick={() => onAdd(name)}>
                    <NodeIcon type={name} size={13} /><span>{name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="gm-note">{NODE_TYPES[picked]?.description}</p>
      {parentType && !inherits(parentType, 'Node') && <p className="gm-note">Parent: {parentType}</p>}
    </Modal>
  );
}

/* ---------- new game / scene / script ---------- */

export function NewGameDialog({ onCreate, onClose }: { onCreate: (name: string, template: TemplateKindLike) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TemplateKindLike>('3d');
  const options: Array<{ id: TemplateKindLike; label: string; hint: string }> = [
    { id: '3d', label: '3D playground', hint: 'A third-person character, ground, walls, crates and a ball.' },
    { id: '2d', label: '2D platformer', hint: 'A jumping character with coyote time, platforms, coins and a score.' },
    { id: 'empty', label: 'Empty project', hint: 'One empty 3D scene.' },
  ];
  return (
    <Modal title="New game" okLabel="Create" onClose={onClose} onOk={() => onCreate(name, template)}>
      <label className="gm-field"><span>Name</span><input className="gm-input" aria-label="Game name" placeholder="My game" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="gm-templates" role="radiogroup" aria-label="Template">
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={template === o.id} className={`gm-template${template === o.id ? ' gm-template--on' : ''}`} onClick={() => setTemplate(o.id)}>
            <strong>{o.label}</strong><span>{o.hint}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function NameDialog({ title, label, initial, placeholder, onOk, onClose, rootTypes }: { title: string; label: string; initial?: string; placeholder?: string; onOk: (name: string, extra?: string) => void; onClose: () => void; rootTypes?: string[] }) {
  const [name, setName] = useState(initial ?? '');
  const [type, setType] = useState(rootTypes?.[0] ?? '');
  return (
    <Modal title={title} okLabel="Create" okDisabled={!name.trim()} onClose={onClose} onOk={() => onOk(name.trim(), type)}>
      <label className="gm-field"><span>{label}</span><input className="gm-input" aria-label={label} placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} /></label>
      {rootTypes && (
        <label className="gm-field"><span>Root node</span><select className="gm-input" aria-label="Root node type" value={type} onChange={(e) => setType(e.target.value)}>{rootTypes.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      )}
    </Modal>
  );
}

export function PickSceneDialog({ game, exclude, onPick, onClose }: { game: Game; exclude: string; onPick: (scene: string) => void; onClose: () => void }) {
  const names = Object.keys(game.scenes).filter((n) => n !== exclude);
  return (
    <Modal title="Instance child scene" onClose={onClose}>
      {names.length === 0 && <p className="gm-note">There is no other scene to instance. Create one first (File system › New scene).</p>}
      <div className="gm-addnode" role="listbox" aria-label="Scenes">
        {names.map((n) => <button key={n} type="button" role="option" aria-selected={false} className="gm-addnode__item" onClick={() => onPick(n)}><span>{n}</span></button>)}
      </div>
    </Modal>
  );
}

export function AttachScriptDialog({ game, nodeType, onPick, onNew, onClose }: { game: Game; nodeType: string; onPick: (path: string) => void; onNew: (path: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [lang, setLang] = useState<'ts' | 'js'>('ts');
  const path = `scripts/${name.trim().replace(/[^A-Za-z0-9_\-/]/g, '_')}.${lang}`;
  return (
    <Modal title={`Attach script to a ${nodeType}`} okLabel="Create and attach" okDisabled={!name.trim() || !!game.scripts[path]} onClose={onClose} onOk={() => onNew(path)}>
      <label className="gm-field"><span>New script</span><input className="gm-input" aria-label="Script name" placeholder="player" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="gm-chips" role="radiogroup" aria-label="Language">
        {(['ts', 'js'] as const).map((l) => <button key={l} type="button" role="radio" aria-checked={lang === l} className={`gm-chip${lang === l ? ' gm-chip--on' : ''}`} onClick={() => setLang(l)}>{l === 'ts' ? 'TypeScript' : 'JavaScript'}</button>)}
      </div>
      {name.trim() && <p className="gm-note">Creates {path} with a class that extends {nodeType}.</p>}
      {Object.keys(game.scripts).length > 0 && (
        <>
          <p className="gm-note">Or use an existing script (its class must extend {nodeType}):</p>
          <div className="gm-addnode" role="listbox" aria-label="Existing scripts">
            {Object.keys(game.scripts).map((p) => <button key={p} type="button" role="option" aria-selected={false} className="gm-addnode__item" onClick={() => onPick(p)}><span>{p}</span></button>)}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------- project settings ---------- */

export function SettingsDialog({ game, run, onClose }: { game: Game; run: (op: GameOp, label: string) => void; onClose: () => void }) {
  const s = game.settings;
  const [action, setAction] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [autoName, setAutoName] = useState('');
  const [autoScript, setAutoScript] = useState(Object.keys(game.scripts)[0] ?? '');
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { setCapturing(null); return; }
      const keys = s.inputMap[capturing] ?? [];
      if (!keys.includes(e.code)) run({ op: 'input_action', name: capturing, keys: [...keys, e.code] }, 'Add key');
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, s.inputMap, run]);
  const setting = (patch: Record<string, unknown>): void => run({ op: 'settings', ...patch }, 'Project settings');
  return (
    <Modal title="Project settings" wide onClose={onClose}>
      <section className="gm-set">
        <h3>Application</h3>
        <label className="gm-field"><span>Title</span><input className="gm-input" aria-label="Project title" value={game.title} onChange={(e) => setting({ title: e.target.value })} /></label>
        <div className="gm-set-row">
          <label className="gm-field"><span>Width</span><input className="gm-input" type="number" aria-label="Window width" value={s.width} onChange={(e) => setting({ width: Number(e.target.value) })} /></label>
          <label className="gm-field"><span>Height</span><input className="gm-input" type="number" aria-label="Window height" value={s.height} onChange={(e) => setting({ height: Number(e.target.value) })} /></label>
          <label className="gm-field"><span>Background</span><input type="color" className="gm-color" aria-label="Default background" value={s.background} onChange={(e) => setting({ background: e.target.value })} /></label>
        </div>
        <label className="gm-field"><span>Main scene</span>
          <select className="gm-input" aria-label="Main scene" value={s.mainScene} onChange={(e) => run({ op: 'set_main_scene', name: e.target.value }, 'Main scene')}>{Object.keys(game.scenes).map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
      </section>
      <section className="gm-set">
        <h3>Physics</h3>
        <div className="gm-set-row">
          <label className="gm-field"><span>3D gravity (m/s²)</span><input className="gm-input" type="number" step="0.1" aria-label="3D gravity" value={s.gravity3d} onChange={(e) => setting({ gravity3d: Number(e.target.value) })} /></label>
          <label className="gm-field"><span>2D gravity (px/s²)</span><input className="gm-input" type="number" step="10" aria-label="2D gravity" value={s.gravity2d} onChange={(e) => setting({ gravity2d: Number(e.target.value) })} /></label>
        </div>
      </section>
      <section className="gm-set" aria-label="Input map">
        <h3>Input map</h3>
        <ul className="gm-actions">
          {Object.entries(s.inputMap).map(([name, keys]) => (
            <li key={name}>
              <strong>{name}</strong>
              <span className="gm-tags">
                {keys.map((k) => <span key={k} className="gm-tag">{k}<button type="button" aria-label={`Remove ${k} from ${name}`} onClick={() => run({ op: 'input_action', name, keys: keys.filter((x) => x !== k) }, 'Remove key')}><X size={9} /></button></span>)}
                <button type="button" className="gm-btn" aria-label={`Add key to ${name}`} onClick={() => setCapturing(name)}>{capturing === name ? 'Press a key…' : '+ key'}</button>
              </span>
              <button type="button" className="gm-icon" aria-label={`Delete action ${name}`} onClick={() => run({ op: 'remove_action', name }, 'Delete action')}><X size={12} /></button>
            </li>
          ))}
        </ul>
        <div className="gm-set-row">
          <input className="gm-input" placeholder="new action (shoot)" aria-label="New action name" value={action} onChange={(e) => setAction(e.target.value)} />
          <button type="button" className="gm-btn" disabled={!/^[A-Za-z0-9_]{1,40}$/.test(action)} onClick={() => { run({ op: 'input_action', name: action, keys: [] }, 'Add action'); setAction(''); }}><Plus size={12} /> Add action</button>
        </div>
      </section>
      <section className="gm-set" aria-label="Autoloads">
        <h3>Autoload (global scripts)</h3>
        <ul className="gm-actions">
          {s.autoloads.map((a) => <li key={a.name}><strong>{a.name}</strong><span>{a.script}</span><button type="button" className="gm-icon" aria-label={`Remove autoload ${a.name}`} onClick={() => run({ op: 'remove_autoload', name: a.name }, 'Remove autoload')}><X size={12} /></button></li>)}
          {s.autoloads.length === 0 && <li className="gm-note">None. An autoload is a script that runs for the whole game, like a singleton.</li>}
        </ul>
        <div className="gm-set-row">
          <input className="gm-input" placeholder="Name (Game)" aria-label="Autoload name" value={autoName} onChange={(e) => setAutoName(e.target.value)} />
          <select className="gm-input" aria-label="Autoload script" value={autoScript} onChange={(e) => setAutoScript(e.target.value)}>{Object.keys(game.scripts).map((p) => <option key={p} value={p}>{p}</option>)}</select>
          <button type="button" className="gm-btn" disabled={!autoName.trim() || !autoScript} onClick={() => { run({ op: 'autoload', name: autoName.trim(), script: autoScript }, 'Add autoload'); setAutoName(''); }}>Add</button>
        </div>
      </section>
    </Modal>
  );
}
