/** The docks of the Game Engine editor: scene tree, inspector, node dock (groups and signals), file system and output. */
import { createElement, useState } from 'react';
import {
  Boxes, Box, Camera, Clapperboard, Code2, Component, FileCode2, Globe, Image as ImageIcon, Layers, LayoutGrid, Lightbulb, Link2, Move3d, Plus, Radar, Shield, Square, Star, Sun, Timer,
  Trash2, Type, Weight, X,
} from 'lucide-react';
import {
  NODE_TYPES, countNodes, findNode, inherits, parseExports, propsOf, walkNodes, type Game, type GameNode, type GameOp, type GameScene, type PropSpec,
} from './game';

export type RunOp = (op: GameOp, label: string, merge?: string) => void;

export function nodeIcon(type: string): typeof Box {
  if (type === 'MeshInstance3D') return Box;
  if (type === 'Camera3D' || type === 'Camera2D') return Camera;
  if (type === 'DirectionalLight3D') return Sun;
  if (type.endsWith('Light3D')) return Lightbulb;
  if (type === 'WorldEnvironment') return Globe;
  if (type.startsWith('CollisionShape')) return Shield;
  if (/^Area/.test(type)) return Radar;
  if (/Body[23]D$/.test(type)) return Weight;
  if (type === 'Sprite2D') return ImageIcon;
  if (type === 'CanvasLayer') return Layers;
  if (type === 'Label') return Type;
  if (inherits(type, 'Control')) return LayoutGrid;
  if (type === 'Timer') return Timer;
  if (type === 'AnimationPlayer') return Clapperboard;
  if (inherits(type, 'Node3D')) return Move3d;
  if (inherits(type, 'Node2D')) return Square;
  return Component;
}

/** An icon for a node type (rendered through createElement because the icon component depends on the type). */
export function NodeIcon({ type, size = 12, className }: { type: string; size?: number; className?: string }) {
  return createElement(nodeIcon(type), { size, className });
}

/* ---------- small fields ---------- */

function Num({ label, value, step = 0.1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="gm-input gm-num" type="number" step={step} min={min} max={max} aria-label={label} value={draft ?? String(Math.round(value * 10000) / 10000)}
      onChange={(e) => { setDraft(e.target.value); const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(n); }}
      onBlur={() => setDraft(null)} onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(null); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }}
    />
  );
}

function PropField({ name, spec, value, onChange }: { name: string; spec: PropSpec; value: unknown; onChange: (v: unknown) => void }) {
  const label = spec.label ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  const v = value ?? spec.default;
  let control: React.ReactNode;
  switch (spec.type) {
    case 'number': case 'int': control = <Num label={label} value={Number(v)} step={spec.step ?? (spec.type === 'int' ? 1 : 0.1)} min={spec.min} max={spec.max} onChange={(n) => onChange(spec.type === 'int' ? Math.round(n) : n)} />; break;
    case 'bool': control = <input type="checkbox" aria-label={label} checked={!!v} onChange={(e) => onChange(e.target.checked)} />; break;
    case 'color': control = <input type="color" aria-label={label} className="gm-color" value={String(v)} onChange={(e) => onChange(e.target.value)} />; break;
    case 'enum': control = <select className="gm-input" aria-label={label} value={String(v)} onChange={(e) => onChange(e.target.value)}>{spec.options?.map((o) => <option key={o} value={o}>{o}</option>)}</select>; break;
    case 'string': control = <input className="gm-input" aria-label={label} value={String(v)} onChange={(e) => onChange(e.target.value)} />; break;
    case 'text': control = <textarea className="gm-input gm-area" aria-label={label} rows={name === 'texture' ? 2 : 3} value={String(v)} onChange={(e) => onChange(e.target.value)} />; break;
    case 'vec2': case 'vec3': {
      const arr = Array.isArray(v) ? (v as number[]) : spec.type === 'vec2' ? [0, 0] : [0, 0, 0];
      const axes = spec.type === 'vec2' ? ['X', 'Y'] : ['X', 'Y', 'Z'];
      control = <div className="gm-vec">{axes.map((a, i) => <Num key={a} label={`${label} ${a}`} value={arr[i] ?? 0} step={spec.step ?? 0.1} onChange={(n) => onChange(axes.map((_, j) => (j === i ? n : arr[j] ?? 0)))} />)}</div>;
      break;
    }
    case 'material': {
      const m = { color: '#cccccc', metalness: 0, roughness: 0.6, emissive: '#000000', emissiveIntensity: 0, opacity: 1, flatShading: false, ...(v as object) } as Record<string, number | string | boolean>;
      const set = (k: string, val: unknown): void => onChange({ ...m, [k]: val });
      control = (
        <div className="gm-mat">
          <label>Colour <input type="color" aria-label="Material colour" className="gm-color" value={String(m.color)} onChange={(e) => set('color', e.target.value)} /></label>
          {(['metalness', 'roughness', 'opacity'] as const).map((k) => <label key={k}>{k[0].toUpperCase() + k.slice(1)}<input type="range" min={0} max={1} step={0.01} aria-label={`Material ${k}`} value={Number(m[k])} onChange={(e) => set(k, Number(e.target.value))} /></label>)}
          <label>Emission <input type="color" aria-label="Material emission" className="gm-color" value={String(m.emissive)} onChange={(e) => set('emissive', e.target.value)} /></label>
          <label>Emission strength<input type="range" min={0} max={10} step={0.1} aria-label="Material emission strength" value={Number(m.emissiveIntensity)} onChange={(e) => set('emissiveIntensity', Number(e.target.value))} /></label>
          <label className="gm-check"><input type="checkbox" checked={!!m.flatShading} onChange={(e) => set('flatShading', e.target.checked)} /> Flat shading</label>
        </div>
      );
      break;
    }
    default: control = <span className="gm-note">{JSON.stringify(v).slice(0, 60)}{spec.type === 'json' ? ' (edit with game_edit)' : ''}</span>;
  }
  return <div className={`gm-row${spec.type === 'material' || spec.type === 'text' ? ' gm-row--block' : ''}`}><span className="gm-row__label">{label}</span>{control}</div>;
}

/* ---------- scene tree ---------- */

interface TreeProps { scene: GameScene; game: Game; selected: string | null; onSelect: (path: string) => void; run: RunOp; onAdd: () => void; onInstance: () => void; onAttach: () => void; onSaveBranch?: () => void }

export function SceneTree({ scene, game, selected, onSelect, run, onAdd, onInstance, onAttach }: TreeProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const rows: Array<{ node: GameNode; path: string; depth: number }> = [];
  walkNodes(scene.root, (node, path, depth) => rows.push({ node, path, depth }));
  const sel = selected ? findNode(scene, selected) : null;
  return (
    <div className="gm-tree-wrap">
      <div className="gm-tree-bar" role="toolbar" aria-label="Scene tree actions">
        <button type="button" className="gm-icon" aria-label="Add child node" title="Add child node (Ctrl+A)" onClick={onAdd}><Plus size={13} /></button>
        <button type="button" className="gm-icon" aria-label="Instance child scene" title="Instance a scene as a child" onClick={onInstance}><Link2 size={13} /></button>
        <button type="button" className="gm-icon" aria-label="Attach script" title="Attach or change the script of the selected node" disabled={!sel} onClick={onAttach}><FileCode2 size={13} /></button>
        <button type="button" className="gm-icon" aria-label="Duplicate node" title="Duplicate (Ctrl+D)" disabled={!sel || !sel.parent} onClick={() => selected && run({ op: 'duplicate_node', node: selected }, 'Duplicate node')}><Boxes size={13} /></button>
        <button type="button" className="gm-icon gm-icon--danger" aria-label="Delete node" title="Delete (Delete)" disabled={!sel || !sel.parent} onClick={() => selected && run({ op: 'remove_node', node: selected }, 'Delete node')}><Trash2 size={13} /></button>
        <span className="gm-grow" />
        <span className="gm-count">{countNodes(scene)}</span>
      </div>
      <ul className="gm-tree" role="tree" aria-label="Scene tree">
        {rows.map(({ node, path, depth }) => {
          const on = selected === path;
          return (
            <li key={path} role="treeitem" aria-selected={on} aria-level={depth + 1} aria-label={`Node ${node.name}`}>
              <div
                className={`gm-row-node${on ? ' gm-row-node--on' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} draggable={depth > 0}
                onClick={() => onSelect(path)}
                onDragStart={() => setDrag(path)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (drag && drag !== path && !path.startsWith(`${drag}/`)) run({ op: 'move_node', node: drag, to: path }, 'Reparent node'); setDrag(null); }}
              >
                <NodeIcon type={node.type} size={12} className="gm-row-node__icon" />
                {renaming === path ? (
                  <input
                    className="gm-input gm-row-node__input" autoFocus defaultValue={node.name} aria-label="Node name" onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== node.name) run({ op: 'set', node: path, name }, 'Rename node'); setRenaming(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
                  />
                ) : (
                  <span className="gm-row-node__name" onDoubleClick={() => setRenaming(path)} title={`${node.type} — double-click to rename`}>{node.name}</span>
                )}
                {node.instance && <Link2 size={10} className="gm-row-node__tag" aria-label={`Instance of ${node.instance}`} />}
                {node.script && <button type="button" className="gm-icon gm-icon--tiny" aria-label={`Open script of ${node.name}`} title={node.script} onClick={(e) => { e.stopPropagation(); onSelect(path); window.dispatchEvent(new CustomEvent('pigry:game-open-script', { detail: node.script })); }}><Code2 size={11} /></button>}
              </div>
            </li>
          );
        })}
      </ul>
      {game.scenes[scene.name] === undefined && <p className="gm-note">No scene.</p>}
    </div>
  );
}

/* ---------- inspector ---------- */

interface InspectorProps { game: Game; scene: GameScene; path: string | null; run: RunOp; onOpenScript: (path: string) => void; onAttach: () => void }

export function Inspector({ game, scene, path, run, onOpenScript, onAttach }: InspectorProps) {
  const found = path ? findNode(scene, path) : null;
  const [group, setGroup] = useState('');
  if (!found || !path) return <p className="gm-note gm-pad">Select a node in the scene tree or the viewport.</p>;
  const node = found.node;
  const spec = propsOf(node.type);
  const script = node.script ? game.scripts[node.script] : undefined;
  const exportsSpec = script ? parseExports(script.code) : [];
  const set = (key: string, value: unknown): void => run({ op: 'set', node: path, props: { [key]: value } }, `Change ${key}`, `prop:${scene.name}:${path}:${key}`);
  return (
    <div className="gm-inspector" aria-label={`Inspector for ${node.name}`}>
      <div className="gm-insp-head">
        <NodeIcon type={node.type} size={14} />
        <input className="gm-input" aria-label="Name" value={node.name} onChange={(e) => run({ op: 'set', node: path, name: e.target.value }, 'Rename node', `name:${path}`)} />
        <span className="gm-type" title={NODE_TYPES[node.type]?.description}>{node.type}</span>
      </div>
      {NODE_TYPES[node.type] && <p className="gm-note gm-pad">{NODE_TYPES[node.type].description}</p>}
      {node.instance && <p className="gm-note gm-pad">This node is an instance of the scene “{node.instance}”. Edit that scene to change what it contains.</p>}

      <section className="gm-sec" aria-label="Script">
        <h3>Script</h3>
        {node.script ? (
          <div className="gm-script-row">
            <button type="button" className="gm-btn" onClick={() => onOpenScript(node.script!)}><Code2 size={12} /> {node.script}</button>
            <button type="button" className="gm-icon" aria-label="Detach script" onClick={() => run({ op: 'set', node: path, script: null }, 'Detach script')}><X size={12} /></button>
          </div>
        ) : <button type="button" className="gm-btn" onClick={onAttach}><Plus size={12} /> Attach script…</button>}
        {exportsSpec.map((e) => {
          const cur = node.exports?.[e.name] ?? e.default;
          const setExp = (v: unknown): void => run({ op: 'set', node: path, exports: { [e.name]: v } }, `Change ${e.name}`, `exp:${path}:${e.name}`);
          return (
            <div key={e.name} className="gm-row"><span className="gm-row__label">{e.name}</span>
              {e.type === 'bool' ? <input type="checkbox" aria-label={e.name} checked={!!cur} onChange={(ev) => setExp(ev.target.checked)} />
                : e.type === 'color' ? <input type="color" className="gm-color" aria-label={e.name} value={String(cur)} onChange={(ev) => setExp(ev.target.value)} />
                  : e.type === 'number' || e.type === 'int' ? <Num label={e.name} value={Number(cur)} min={e.min} max={e.max} step={e.type === 'int' ? 1 : 0.1} onChange={setExp} />
                    : e.type === 'vec2' || e.type === 'vec3' ? <div className="gm-vec">{(Array.isArray(cur) ? (cur as number[]) : []).map((n, i) => <Num key={i} label={`${e.name} ${i}`} value={n} onChange={(v) => setExp((cur as number[]).map((x, j) => (j === i ? v : x)))} />)}</div>
                      : <input className="gm-input" aria-label={e.name} value={String(cur)} onChange={(ev) => setExp(ev.target.value)} />}
            </div>
          );
        })}
      </section>

      <section className="gm-sec" aria-label="Groups">
        <h3>Groups</h3>
        <div className="gm-tags">
          {(node.groups ?? []).map((g) => <span key={g} className="gm-tag">{g}<button type="button" aria-label={`Remove group ${g}`} onClick={() => run({ op: 'set', node: path, groups: (node.groups ?? []).filter((x) => x !== g) }, 'Remove group')}><X size={9} /></button></span>)}
          <input className="gm-input gm-tag-input" placeholder="add group…" aria-label="Add group" value={group} onChange={(e) => setGroup(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && group.trim()) { run({ op: 'set', node: path, groups: [...(node.groups ?? []), group.trim()] }, 'Add group'); setGroup(''); } e.stopPropagation(); }} />
        </div>
      </section>

      <section className="gm-sec" aria-label="Properties">
        <h3>{node.type}</h3>
        {Object.entries(spec).map(([key, s]) => <PropField key={key} name={key} spec={s} value={node.props?.[key]} onChange={(v) => set(key, v)} />)}
        {Object.keys(spec).length === 0 && <p className="gm-note">This node type has no properties.</p>}
      </section>
    </div>
  );
}

/* ---------- node dock: signals ---------- */

const SIGNALS: Record<string, string[]> = { Area: ['bodyEntered', 'bodyExited'], Button: ['pressed'], Timer: ['timeout'], AnimationPlayer: ['animationFinished'], RigidBody: ['bodyEntered'] };
const signalSuggestions = (type: string): string[] => Object.entries(SIGNALS).filter(([k]) => type.startsWith(k) || type.includes(k)).flatMap(([, v]) => v);

export function NodeDock({ scene, path, run }: { scene: GameScene; path: string | null; run: RunOp }) {
  const [signal, setSignal] = useState('');
  const [to, setTo] = useState('.');
  const [method, setMethod] = useState('');
  const found = path ? findNode(scene, path) : null;
  if (!found || !path) return <p className="gm-note gm-pad">Select a node to see its signals.</p>;
  const all: string[] = [];
  walkNodes(scene.root, (_n, p) => all.push(p));
  const mine = scene.connections.filter((c) => c.from === path || c.to === path);
  return (
    <div className="gm-signals" aria-label="Signals">
      <p className="gm-note gm-pad">Connect a signal of “{found.node.name}” to a method of another node. The method is called when the signal is emitted.</p>
      <div className="gm-sigform">
        <input className="gm-input" list="gm-signal-names" placeholder="signal (bodyEntered)" aria-label="Signal" value={signal} onChange={(e) => setSignal(e.target.value)} />
        <datalist id="gm-signal-names">{signalSuggestions(found.node.type).map((s) => <option key={s} value={s} />)}</datalist>
        <select className="gm-input" aria-label="Target node" value={to} onChange={(e) => setTo(e.target.value)}>{all.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <input className="gm-input" placeholder="method (onBodyEntered)" aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)} />
        <button type="button" className="gm-btn" disabled={!signal.trim() || !method.trim()} onClick={() => { run({ op: 'connect', from: path, signal: signal.trim(), to, method: method.trim() }, 'Connect signal'); setSignal(''); setMethod(''); }}>Connect</button>
      </div>
      <ul className="gm-conns" aria-label="Connections">
        {mine.map((c) => (
          <li key={`${c.from}.${c.signal}.${c.to}.${c.method}`}>
            <span>{c.from}.{c.signal} → {c.to}.{c.method}()</span>
            <button type="button" className="gm-icon" aria-label={`Disconnect ${c.signal}`} onClick={() => run({ op: 'disconnect', ...c }, 'Disconnect signal')}><X size={11} /></button>
          </li>
        ))}
        {mine.length === 0 && <li className="gm-note">No connections.</li>}
      </ul>
    </div>
  );
}

/* ---------- file system ---------- */

interface FsProps { game: Game; sceneName: string; scriptPath: string | null; onOpenScene: (name: string) => void; onOpenScript: (path: string) => void; run: RunOp; onNewScene: () => void; onNewScript: () => void }

export function FileSystem({ game, sceneName, scriptPath, onOpenScene, onOpenScript, run, onNewScene, onNewScript }: FsProps) {
  return (
    <div className="gm-fs" aria-label="File system">
      <div className="gm-fs-head"><span>res://scenes</span><button type="button" className="gm-icon" aria-label="New scene" title="New scene" onClick={onNewScene}><Plus size={12} /></button></div>
      <ul>
        {Object.keys(game.scenes).map((name) => (
          <li key={name} className={name === sceneName ? 'gm-fs--on' : ''}>
            <button type="button" className="gm-fs-main" onClick={() => onOpenScene(name)}><Clapperboard size={11} /> {name}</button>
            <button type="button" className={`gm-icon gm-icon--tiny${game.settings.mainScene === name ? ' gm-icon--on' : ''}`} aria-label={`Set ${name} as the main scene`} aria-pressed={game.settings.mainScene === name} title="Main scene" onClick={() => run({ op: 'set_main_scene', name }, 'Set main scene')}><Star size={11} /></button>
            <button type="button" className="gm-icon gm-icon--tiny" aria-label={`Delete scene ${name}`} title="Delete scene" disabled={Object.keys(game.scenes).length < 2} onClick={() => run({ op: 'remove_scene', name }, 'Delete scene')}><Trash2 size={11} /></button>
          </li>
        ))}
      </ul>
      <div className="gm-fs-head"><span>res://scripts</span><button type="button" className="gm-icon" aria-label="New script" title="New script" onClick={onNewScript}><Plus size={12} /></button></div>
      <ul>
        {Object.keys(game.scripts).map((path) => (
          <li key={path} className={path === scriptPath ? 'gm-fs--on' : ''}>
            <button type="button" className="gm-fs-main" onClick={() => onOpenScript(path)}><FileCode2 size={11} /> {path.replace(/^scripts\//, '')}</button>
            <button type="button" className="gm-icon gm-icon--tiny" aria-label={`Delete script ${path}`} title="Delete script" onClick={() => run({ op: 'remove_script', path }, 'Delete script')}><Trash2 size={11} /></button>
          </li>
        ))}
        {Object.keys(game.scripts).length === 0 && <li className="gm-note">No scripts yet.</li>}
      </ul>
    </div>
  );
}

/* ---------- output ---------- */

export interface LogLine { level: string; text: string; n: number }

export function Output({ lines, stats, onClear }: { lines: LogLine[]; stats: { fps: number; nodes: number; frame: number } | null; onClear: () => void }) {
  return (
    <div className="gm-output" aria-label="Output">
      <div className="gm-output-head">
        <strong>Output</strong>
        {stats && <span className="gm-stats" role="status" aria-label="Game statistics">{stats.fps} FPS · {stats.nodes} nodes · frame {stats.frame}</span>}
        <span className="gm-grow" />
        <button type="button" className="gm-btn" onClick={onClear}>Clear</button>
      </div>
      <ol className="gm-log">
        {lines.map((l) => <li key={l.n} className={`gm-log--${l.level}`}>{l.text}</li>)}
        {lines.length === 0 && <li className="gm-note">Print messages and errors of the running game appear here.</li>}
      </ol>
    </div>
  );
}

