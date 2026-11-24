/** The outliner and the properties editor of the 3D Model editor. */
import { useState } from 'react';
import { Box, Camera, Circle, Cylinder, Eye, EyeOff, Lightbulb, Lock, LockOpen, Move3d, Plus, Square, Torus, Triangle, X } from 'lucide-react';
import {
  LIGHT_TYPES, PRIMITIVE_PARAMS, PRIMITIVES, childrenOf, descendantsOf, type LightType, type Material, type Model3D, type Modifier, type Obj3D, type ObjectKind, type Vec3,
} from './model3d';

export type Commit = (mutator: (draft: Model3D) => void, label: string, merge?: string) => void;

const ICONS: Record<ObjectKind, typeof Box> = {
  box: Box, sphere: Circle, icosphere: Circle, cylinder: Cylinder, cone: Triangle, torus: Torus, plane: Square, circle: Circle, capsule: Cylinder, empty: Move3d, light: Lightbulb, camera: Camera,
};
export const kindIcon = (kind: ObjectKind): typeof Box => ICONS[kind];

/* ---------- small controls ---------- */

function NumberField({ label, value, step = 0.1, min, max, suffix, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; suffix?: string; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 10000) / 10000);
  return (
    <label className="m3d-field">
      <span>{label}</span>
      <input
        className="m3d-input" type="number" step={step} min={min} max={max} aria-label={label} value={shown}
        onChange={(e) => { setDraft(e.target.value); const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(n); }}
        onBlur={() => setDraft(null)} onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(null); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }}
      />
      {suffix && <em>{suffix}</em>}
    </label>
  );
}

function Vec3Field({ label, value, step = 0.1, suffix, onChange }: { label: string; value: Vec3; step?: number; suffix?: string; onChange: (v: Vec3) => void }) {
  return (
    <div className="m3d-vec" role="group" aria-label={label}>
      <span className="m3d-vec__label">{label}</span>
      {(['X', 'Y', 'Z'] as const).map((axis, i) => (
        <NumberField key={axis} label={`${label} ${axis}`} value={value[i]} step={step} suffix={i === 2 ? suffix : undefined} onChange={(n) => onChange(value.map((v, j) => (j === i ? n : v)) as Vec3)} />
      ))}
    </div>
  );
}

function Range({ label, value, min, max, step = 0.01, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="m3d-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="m3d-slider__value">{Math.round(value * 100) / 100}</span>
    </label>
  );
}

/* ---------- outliner ---------- */

interface OutlinerProps {
  model: Model3D;
  selection: string[];
  onSelect: (id: string, additive: boolean) => void;
  commit: Commit;
}

export function Outliner({ model, selection, onSelect, commit }: OutlinerProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const row = (o: Obj3D, depth: number): React.ReactNode => {
    const Icon = kindIcon(o.kind);
    const on = selection.includes(o.id);
    const kids = childrenOf(model, o.id);
    return (
      <li key={o.id} role="treeitem" aria-selected={on} aria-label={`Object ${o.name}`}>
        <div
          className={`m3d-row${on ? ' m3d-row--on' : ''}${o.visible ? '' : ' m3d-row--hidden'}`} style={{ paddingLeft: 6 + depth * 14 }} draggable
          onClick={(e) => onSelect(o.id, e.shiftKey)}
          onDragStart={() => setDragId(o.id)} onDragOver={(e) => e.preventDefault()} onDragEnd={() => setDragId(null)}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== o.id && !descendantsOf(model, dragId).some((d) => d.id === o.id)) commit((m) => { const d = m.objects.find((x) => x.id === dragId); if (d) d.parent = o.id; }, 'Set parent');
            setDragId(null);
          }}
        >
          <Icon size={12} className="m3d-row__icon" />
          {renaming === o.id ? (
            <input
              className="m3d-input m3d-row__input" autoFocus defaultValue={o.name} aria-label="Object name" onClick={(e) => e.stopPropagation()}
              onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== o.name) commit((m) => { const x = m.objects.find((y) => y.id === o.id); if (x) x.name = name.slice(0, 60); }, 'Rename'); setRenaming(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
            />
          ) : (
            <span className="m3d-row__name" onDoubleClick={() => setRenaming(o.id)} title="Double-click to rename">{o.name}</span>
          )}
          <button type="button" className="m3d-icon" aria-label={o.locked ? `Unlock ${o.name}` : `Lock ${o.name}`} aria-pressed={o.locked} onClick={(e) => { e.stopPropagation(); commit((m) => { const x = m.objects.find((y) => y.id === o.id); if (x) x.locked = !x.locked; }, 'Lock'); }}>
            {o.locked ? <Lock size={11} /> : <LockOpen size={11} />}
          </button>
          <button type="button" className="m3d-icon" aria-label={o.visible ? `Hide ${o.name}` : `Show ${o.name}`} aria-pressed={o.visible} onClick={(e) => { e.stopPropagation(); commit((m) => { const x = m.objects.find((y) => y.id === o.id); if (x) x.visible = !x.visible; }, o.visible ? 'Hide' : 'Show'); }}>
            {o.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </div>
        {kids.length > 0 && <ul role="group">{kids.map((k) => row(k, depth + 1))}</ul>}
      </li>
    );
  };

  const top = model.objects.filter((o) => !o.parent);
  return (
    <div className="m3d-outliner">
      <ul role="tree" aria-label="Outliner" className="m3d-tree" onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragId) commit((m) => { const d = m.objects.find((x) => x.id === dragId); if (d) d.parent = null; }, 'Clear parent'); setDragId(null); }}>
        {top.map((o) => row(o, 0))}
        {top.length === 0 && <li className="m3d-empty">The scene is empty — use the Add menu.</li>}
      </ul>
    </div>
  );
}

/* ---------- properties ---------- */

export type PropTab = 'object' | 'data' | 'material' | 'modifiers' | 'world';

const MATERIAL_PRESETS: Array<{ label: string; patch: Partial<Material> }> = [
  { label: 'Plastic', patch: { metalness: 0, roughness: 0.35 } },
  { label: 'Matte', patch: { metalness: 0, roughness: 0.9 } },
  { label: 'Metal', patch: { metalness: 1, roughness: 0.3 } },
  { label: 'Brushed', patch: { metalness: 1, roughness: 0.55 } },
  { label: 'Gold', patch: { color: '#ffd166', metalness: 1, roughness: 0.25 } },
  { label: 'Rubber', patch: { color: '#2b2b2b', metalness: 0, roughness: 0.95 } },
  { label: 'Glass', patch: { color: '#cfeeff', metalness: 0, roughness: 0.05, opacity: 0.35 } },
  { label: 'Glow', patch: { emissive: '#ffcc66', emissiveIntensity: 2 } },
];

interface PropsProps {
  model: Model3D;
  selection: string[];
  tab: PropTab;
  onTab: (tab: PropTab) => void;
  commit: Commit;
}

export function Properties({ model, selection, tab, onTab, commit }: PropsProps) {
  const o = model.objects.find((x) => x.id === selection[selection.length - 1]);
  const edit = (label: string, mutate: (x: Obj3D) => void, merge?: string): void => commit((m) => { const x = m.objects.find((y) => y.id === o?.id); if (x) mutate(x); }, label, merge ?? `${o?.id}:${label}`);
  const isMesh = !!o && (PRIMITIVES as readonly string[]).includes(o.kind);

  const tabs: Array<{ id: PropTab; label: string; show: boolean }> = [
    { id: 'object', label: 'Object', show: !!o },
    { id: 'data', label: o?.kind === 'light' ? 'Light' : o?.kind === 'camera' ? 'Camera' : 'Shape', show: !!o && o.kind !== 'empty' },
    { id: 'material', label: 'Material', show: isMesh },
    { id: 'modifiers', label: 'Modifiers', show: isMesh },
    { id: 'world', label: 'World', show: true },
  ];
  const active = tabs.find((t) => t.id === tab && t.show) ?? tabs.find((t) => t.show)!;

  return (
    <div className="m3d-props">
      <div className="m3d-tabs" role="tablist" aria-label="Properties">
        {tabs.filter((t) => t.show).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={active.id === t.id} className={`m3d-tab${active.id === t.id ? ' m3d-tab--on' : ''}`} onClick={() => onTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="m3d-props__body" role="tabpanel" aria-label={active.label}>
        {active.id === 'world' && (
          <>
            <label className="m3d-field"><span>Background</span><input type="color" aria-label="Background colour" value={model.world.background} onChange={(e) => commit((m) => { m.world.background = e.target.value; }, 'Background', 'world:bg')} /></label>
            <Range label="Ambient light" value={model.world.ambient} min={0} max={3} onChange={(v) => commit((m) => { m.world.ambient = v; }, 'Ambient light', 'world:ambient')} />
            <label className="m3d-check"><input type="checkbox" checked={model.world.grid} onChange={(e) => commit((m) => { m.world.grid = e.target.checked; }, 'Grid')} /> Show grid</label>
            <label className="m3d-check"><input type="checkbox" checked={model.world.fog} onChange={(e) => commit((m) => { m.world.fog = e.target.checked; }, 'Fog')} /> Distance fog</label>
          </>
        )}
        {o && active.id === 'object' && (
          <>
            <label className="m3d-field m3d-field--wide"><span>Name</span><input className="m3d-input" aria-label="Name" value={o.name} onChange={(e) => edit('Rename', (x) => { x.name = e.target.value.slice(0, 60); })} /></label>
            <Vec3Field label="Location" value={o.position} suffix="m" onChange={(v) => edit('Location', (x) => { x.position = v; })} />
            <Vec3Field label="Rotation" value={o.rotation} step={5} suffix="°" onChange={(v) => edit('Rotation', (x) => { x.rotation = v; })} />
            <Vec3Field label="Scale" value={o.scale} step={0.1} onChange={(v) => edit('Scale', (x) => { x.scale = v; })} />
            <label className="m3d-field m3d-field--wide">
              <span>Parent</span>
              <select className="m3d-input" aria-label="Parent" value={o.parent ?? ''} onChange={(e) => edit('Set parent', (x) => { x.parent = e.target.value || null; })}>
                <option value="">— none —</option>
                {model.objects.filter((p) => p.id !== o.id && !descendantsOf(model, o.id).some((d) => d.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {(o.kind === 'light' || o.kind === 'camera') && <Vec3Field label="Look at" value={o.lookAt ?? [0, 0, 0]} suffix="m" onChange={(v) => edit('Look at', (x) => { x.lookAt = v; })} />}
            {(o.kind === 'light' || o.kind === 'camera') && o.lookAt && <button type="button" className="m3d-btn" onClick={() => edit('Clear aim', (x) => { x.lookAt = undefined; })}>Stop aiming (use rotation)</button>}
          </>
        )}
        {o && active.id === 'data' && isMesh && (
          <>
            {Object.entries(PRIMITIVE_PARAMS[o.kind as keyof typeof PRIMITIVE_PARAMS]).map(([key, def]) => (
              <NumberField key={key} label={key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())} value={o.params[key] ?? def.value} step={Number.isInteger(def.value) ? 1 : 0.1} min={def.min} max={def.max} onChange={(n) => edit('Shape', (x) => { x.params = { ...x.params, [key]: Math.min(def.max, Math.max(def.min, n)) }; })} />
            ))}
            <p className="m3d-note">Sizes are in metres. Use Scale on the Object tab to stretch the shape.</p>
          </>
        )}
        {o && active.id === 'data' && o.kind === 'light' && o.light && (
          <>
            <label className="m3d-field m3d-field--wide">
              <span>Type</span>
              <select className="m3d-input" aria-label="Light type" value={o.light.type} onChange={(e) => edit('Light type', (x) => { if (x.light) x.light.type = e.target.value as LightType; })}>
                {LIGHT_TYPES.map((t) => <option key={t} value={t}>{t === 'sun' ? 'Sun' : t[0].toUpperCase() + t.slice(1)}</option>)}
              </select>
            </label>
            <label className="m3d-field"><span>Colour</span><input type="color" aria-label="Light colour" value={o.light.color} onChange={(e) => edit('Light colour', (x) => { if (x.light) x.light.color = e.target.value; })} /></label>
            <NumberField label="Intensity" value={o.light.intensity} step={o.light.type === 'point' || o.light.type === 'spot' ? 5 : 0.5} min={0} onChange={(n) => edit('Light intensity', (x) => { if (x.light) x.light.intensity = Math.max(0, n); })} />
            {(o.light.type === 'point' || o.light.type === 'spot') && <NumberField label="Distance" value={o.light.distance} min={0} suffix="m" onChange={(n) => edit('Light distance', (x) => { if (x.light) x.light.distance = Math.max(0, n); })} />}
            {o.light.type === 'spot' && <NumberField label="Cone angle" value={o.light.angle} step={5} min={1} max={90} suffix="°" onChange={(n) => edit('Cone angle', (x) => { if (x.light) x.light.angle = Math.min(90, Math.max(1, n)); })} />}
            {o.light.type !== 'ambient' && o.light.type !== 'hemisphere' && <label className="m3d-check"><input type="checkbox" checked={o.light.castShadow} onChange={(e) => edit('Shadows', (x) => { if (x.light) x.light.castShadow = e.target.checked; })} /> Cast shadows</label>}
          </>
        )}
        {o && active.id === 'data' && o.kind === 'camera' && o.camera && (
          <>
            <NumberField label="Field of view" value={o.camera.fov} step={5} min={5} max={150} suffix="°" onChange={(n) => edit('Field of view', (x) => { if (x.camera) x.camera.fov = Math.min(150, Math.max(5, n)); })} />
            <NumberField label="Clip start" value={o.camera.near} step={0.05} min={0.001} suffix="m" onChange={(n) => edit('Clip start', (x) => { if (x.camera) x.camera.near = Math.max(0.001, n); })} />
            <NumberField label="Clip end" value={o.camera.far} step={50} min={1} suffix="m" onChange={(n) => edit('Clip end', (x) => { if (x.camera) x.camera.far = Math.max(1, n); })} />
            <label className="m3d-check"><input type="checkbox" checked={o.camera.ortho} onChange={(e) => edit('Orthographic', (x) => { if (x.camera) x.camera.ortho = e.target.checked; })} /> Orthographic</label>
            {o.camera.ortho && <NumberField label="Ortho size" value={o.camera.orthoSize} step={0.5} min={0.01} suffix="m" onChange={(n) => edit('Ortho size', (x) => { if (x.camera) x.camera.orthoSize = Math.max(0.01, n); })} />}
          </>
        )}
        {o && active.id === 'material' && isMesh && (
          <>
            <div className="m3d-chips" role="group" aria-label="Material presets">
              {MATERIAL_PRESETS.map((p) => <button key={p.label} type="button" className="m3d-chip" onClick={() => edit(`Material: ${p.label}`, (x) => { x.material = { ...x.material, ...p.patch }; }, `mat:${p.label}`)}>{p.label}</button>)}
            </div>
            <label className="m3d-field"><span>Base colour</span><input type="color" aria-label="Base colour" value={o.material.color} onChange={(e) => edit('Base colour', (x) => { x.material.color = e.target.value; })} /></label>
            <Range label="Metallic" value={o.material.metalness} min={0} max={1} onChange={(v) => edit('Metallic', (x) => { x.material.metalness = v; })} />
            <Range label="Roughness" value={o.material.roughness} min={0} max={1} onChange={(v) => edit('Roughness', (x) => { x.material.roughness = v; })} />
            <label className="m3d-field"><span>Emission</span><input type="color" aria-label="Emission colour" value={o.material.emissive} onChange={(e) => edit('Emission colour', (x) => { x.material.emissive = e.target.value; })} /></label>
            <Range label="Emission strength" value={o.material.emissiveIntensity} min={0} max={10} step={0.1} onChange={(v) => edit('Emission strength', (x) => { x.material.emissiveIntensity = v; })} />
            <Range label="Alpha" value={o.material.opacity} min={0} max={1} onChange={(v) => edit('Alpha', (x) => { x.material.opacity = v; })} />
            <label className="m3d-check"><input type="checkbox" checked={o.material.flatShading} onChange={(e) => edit('Flat shading', (x) => { x.material.flatShading = e.target.checked; })} /> Flat shading</label>
            <label className="m3d-check"><input type="checkbox" checked={o.material.wireframe} onChange={(e) => edit('Wireframe', (x) => { x.material.wireframe = e.target.checked; })} /> Wireframe</label>
          </>
        )}
        {o && active.id === 'modifiers' && isMesh && (
          <>
            <div className="m3d-chips">
              <button type="button" className="m3d-btn" onClick={() => edit('Add mirror', (x) => { x.modifiers = [...x.modifiers, { type: 'mirror', axis: 'x' }]; }, `${o.id}:mod`)}><Plus size={11} /> Mirror</button>
              <button type="button" className="m3d-btn" onClick={() => edit('Add array', (x) => { x.modifiers = [...x.modifiers, { type: 'array', count: 3, offset: [1.5, 0, 0] }]; }, `${o.id}:mod`)}><Plus size={11} /> Array</button>
            </div>
            {o.modifiers.length === 0 && <p className="m3d-note">No modifiers. A mirror adds a mirrored copy across the plane through the parent's origin (the scene origin for top-level objects); an array repeats the object with an offset.</p>}
            {o.modifiers.map((mod: Modifier, i) => (
              <fieldset key={i} className="m3d-mod" aria-label={`${mod.type} modifier`}>
                <legend>{mod.type === 'mirror' ? 'Mirror' : 'Array'}</legend>
                <button type="button" className="m3d-icon m3d-mod__remove" aria-label={`Remove ${mod.type} modifier`} onClick={() => edit('Remove modifier', (x) => { x.modifiers = x.modifiers.filter((_, j) => j !== i); }, `${o.id}:mod`)}><X size={12} /></button>
                {mod.type === 'mirror' ? (
                  <div className="m3d-chips" role="radiogroup" aria-label="Mirror axis">
                    {(['x', 'y', 'z'] as const).map((a) => <button key={a} type="button" role="radio" aria-checked={mod.axis === a} className={`m3d-chip${mod.axis === a ? ' m3d-chip--on' : ''}`} onClick={() => edit('Mirror axis', (x) => { x.modifiers[i] = { ...x.modifiers[i], axis: a }; }, `${o.id}:mod`)}>{a.toUpperCase()}</button>)}
                  </div>
                ) : (
                  <>
                    <NumberField label="Count" value={mod.count ?? 2} step={1} min={1} max={100} onChange={(n) => edit('Array count', (x) => { x.modifiers[i] = { ...x.modifiers[i], count: Math.min(100, Math.max(1, Math.round(n))) }; }, `${o.id}:mod`)} />
                    <Vec3Field label="Offset" value={mod.offset ?? [1, 0, 0]} suffix="m" onChange={(v) => edit('Array offset', (x) => { x.modifiers[i] = { ...x.modifiers[i], offset: v }; }, `${o.id}:mod`)} />
                  </>
                )}
              </fieldset>
            ))}
          </>
        )}
        {!o && active.id !== 'world' && <p className="m3d-note">Select an object in the viewport or the outliner.</p>}
      </div>
    </div>
  );
}

