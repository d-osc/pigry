/** The dockers of the Drawing editor: colour, brushes, palette, layers and history. */
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Layers as LayersIcon, Link2, Lock, LockOpen, Plus, Shield, Trash2, Merge, Undo2 } from 'lucide-react';
import { BLEND_MODES, BRUSHES, type BrushPreset, type BrushSettings } from './drawing';
import type { DrawingSession } from './drawingEngine';
import { hexOf, hsvToRgb, parseColor, rgbToHsv, type RGBA } from './drawingPixels';

export function Slider({ label, value, min, max, step = 1, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="dr-slider">
      <span className="dr-slider__label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="dr-slider__value">{Number.isInteger(step) ? Math.round(value) : value.toFixed(2)}{suffix}</span>
    </label>
  );
}

/* ---------- colour ---------- */

interface ColorProps { fg: RGBA; bg: RGBA; onFg: (c: RGBA) => void; onBg: (c: RGBA) => void; onSwap: () => void; onReset: () => void }

export function ColorPanel({ fg, bg, onFg, onBg, onSwap, onReset }: ColorProps) {
  const [editBg, setEditBg] = useState(false);
  const [hueMemory, setHue] = useState(() => rgbToHsv(fg.r, fg.g, fg.b).h);
  const [draft, setDraft] = useState<string | null>(null);
  const target = editBg ? bg : fg;
  const setTarget = editBg ? onBg : onFg;
  const hsv = rgbToHsv(target.r, target.g, target.b);
  // A grey has no hue of its own, so keep the one the user last chose.
  const hue = hsv.s > 0.02 && hsv.v > 0.02 ? hsv.h : hueMemory;
  const svRef = useRef<HTMLDivElement | null>(null);

  const pick = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = svRef.current!.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), v = 1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setTarget({ ...hsvToRgb(hue, s, v), a: target.a });
  };
  const hex = draft ?? hexOf({ ...target, a: 255 });
  const commitHex = (): void => {
    const c = draft === null ? null : parseColor(draft.startsWith('#') ? draft : `#${draft}`);
    if (c) setTarget({ ...c, a: target.a });
    setDraft(null);
  };

  return (
    <div className="dr-color">
      <div
        ref={svRef} className="dr-sv" role="slider" aria-label="Saturation and brightness" aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`} tabIndex={0}
        style={{ backgroundImage: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hue}, 100%, 50%))` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }}
        onPointerMove={(e) => { if (e.buttons) pick(e); }}
      >
        <span className="dr-sv__dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <input
        type="range" className="dr-hue" min={0} max={360} step={1} value={Math.round(hue)} aria-label="Hue"
        onChange={(e) => { const h = Number(e.target.value); setHue(h); setTarget({ ...hsvToRgb(h, Math.max(hsv.s, 0.001), Math.max(hsv.v, 0.001)), a: target.a }); }}
      />
      <label className="dr-slider">
        <span className="dr-slider__label">Alpha</span>
        <input type="range" min={0} max={255} value={target.a} aria-label="Colour alpha" onChange={(e) => setTarget({ ...target, a: Number(e.target.value) })} />
        <span className="dr-slider__value">{Math.round((target.a / 255) * 100)}%</span>
      </label>
      <div className="dr-color__row">
        <div className="dr-swatches" aria-label="Foreground and background colour">
          <button type="button" className={`dr-swatch dr-swatch--bg${editBg ? ' dr-swatch--on' : ''}`} aria-label="Background colour" aria-pressed={editBg} style={{ background: hexOf(bg) }} onClick={() => setEditBg(true)} />
          <button type="button" className={`dr-swatch dr-swatch--fg${editBg ? '' : ' dr-swatch--on'}`} aria-label="Foreground colour" aria-pressed={!editBg} style={{ background: hexOf(fg) }} onClick={() => setEditBg(false)} />
        </div>
        <button type="button" className="dr-mini" title="Swap colours (X)" aria-label="Swap colours" onClick={onSwap}>⇄</button>
        <button type="button" className="dr-mini" title="Black and white (D)" aria-label="Reset colours" onClick={onReset}>◩</button>
        <input
          className="dr-input dr-hex" aria-label="Hex colour" spellCheck={false} value={hex}
          onChange={(e) => setDraft(e.target.value)} onBlur={commitHex} onKeyDown={(e) => { if (e.key === 'Enter') commitHex(); e.stopPropagation(); }}
        />
      </div>
    </div>
  );
}

export const PALETTE = [
  '#000000', '#3a3a3a', '#7a7a7a', '#b9b9b9', '#ffffff', '#7b3f1d', '#b5651d', '#e0a96d',
  '#8b0000', '#e53935', '#ff7043', '#ffb300', '#ffee58', '#c0ca33', '#43a047', '#00695c',
  '#00acc1', '#1e88e5', '#283593', '#5e35b1', '#8e24aa', '#d81b60', '#f48fb1', '#ffe0b2',
];

export function PalettePanel({ recent, onPick }: { recent: string[]; onPick: (hex: string, asBg: boolean) => void }) {
  const cell = (hex: string, key: string) => (
    <button
      key={key} type="button" className="dr-cell" style={{ background: hex }} title={`${hex} — click: foreground, Shift+click or right-click: background`} aria-label={`Colour ${hex}`}
      onClick={(e) => onPick(hex, e.shiftKey)} onContextMenu={(e) => { e.preventDefault(); onPick(hex, true); }}
    />
  );
  return (
    <div className="dr-palette">
      <div className="dr-palette__grid" aria-label="Palette">{PALETTE.map((hex) => cell(hex, hex))}</div>
      {recent.length > 0 && <><span className="dr-palette__label">Recent</span><div className="dr-palette__grid" aria-label="Recent colours">{recent.map((hex) => cell(hex, `r${hex}`))}</div></>}
    </div>
  );
}

/* ---------- brushes ---------- */

interface BrushProps { presetId: string; brush: BrushSettings; onPreset: (preset: BrushPreset) => void; onChange: (patch: Partial<BrushSettings>) => void }

export function BrushPanel({ presetId, brush, onPreset, onChange }: BrushProps) {
  return (
    <div className="dr-brush">
      <div className="dr-presets" role="radiogroup" aria-label="Brush presets">
        {BRUSHES.map((preset) => (
          <button key={preset.id} type="button" role="radio" aria-checked={presetId === preset.id} className={`dr-preset${presetId === preset.id ? ' dr-preset--on' : ''}`} title={preset.name} onClick={() => onPreset(preset)}>
            <span className="dr-preset__dot" style={{ width: 6 + preset.hardness * 6, height: 6 + preset.hardness * 6, opacity: 0.35 + preset.opacity * 0.65, filter: preset.hardness < 0.4 ? 'blur(1.5px)' : undefined }} />
            <span>{preset.name}</span>
          </button>
        ))}
      </div>
      <Slider label="Size" value={brush.size} min={1} max={400} suffix=" px" onChange={(size) => onChange({ size })} />
      <Slider label="Opacity" value={Math.round(brush.opacity * 100)} min={1} max={100} suffix="%" onChange={(v) => onChange({ opacity: v / 100 })} />
      <Slider label="Flow" value={Math.round(brush.flow * 100)} min={1} max={100} suffix="%" onChange={(v) => onChange({ flow: v / 100 })} />
      <Slider label="Hardness" value={Math.round(brush.hardness * 100)} min={0} max={100} suffix="%" onChange={(v) => onChange({ hardness: v / 100 })} />
      <Slider label="Spacing" value={Math.round(brush.spacing * 100)} min={2} max={200} suffix="%" onChange={(v) => onChange({ spacing: v / 100 })} />
      <Slider label="Smoothing" value={Math.round(brush.smoothing * 100)} min={0} max={95} suffix="%" onChange={(v) => onChange({ smoothing: v / 100 })} />
      <Slider label="Scatter" value={Math.round(brush.scatter * 100)} min={0} max={100} suffix="%" onChange={(v) => onChange({ scatter: v / 100 })} />
      <label className="dr-check"><input type="checkbox" checked={brush.sizePressure} onChange={(e) => onChange({ sizePressure: e.target.checked })} /> Pressure changes size</label>
      <label className="dr-check"><input type="checkbox" checked={brush.opacityPressure} onChange={(e) => onChange({ opacityPressure: e.target.checked })} /> Pressure changes opacity</label>
    </div>
  );
}

/* ---------- layers ---------- */

function LayerThumb({ session, id, tick }: { session: DrawingSession; id: string; tick: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current, layer = session.layers.find((l) => l.meta.id === id);
    if (!canvas || !layer) return;
    const c = canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, canvas.width, canvas.height);
    const k = Math.min(canvas.width / layer.canvas.width, canvas.height / layer.canvas.height);
    const w = layer.canvas.width * k, h = layer.canvas.height * k;
    c.drawImage(layer.canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }, [session, id, tick]);
  return <canvas ref={ref} className="dr-thumb" width={36} height={28} aria-hidden="true" />;
}

export function LayersPanel({ session, tick }: { session: DrawingSession; tick: string }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const active = session.active;
  const rows = [...session.layers].reverse();

  const drop = (e: DragEvent<HTMLLIElement>, targetId: string): void => {
    e.preventDefault();
    if (dragId && dragId !== targetId) session.moveLayer(dragId, session.layers.findIndex((l) => l.meta.id === targetId));
    setDragId(null);
  };

  return (
    <div className="dr-layers">
      {active && (
        <div className="dr-layers__props">
          <label className="dr-field">
            <span>Blend</span>
            <select className="dr-input" aria-label="Blend mode" value={active.meta.blend} onChange={(e) => session.editLayer(active.meta.id, { blend: e.target.value }, 'Blend mode')}>
              {BLEND_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <Slider label="Opacity" value={Math.round(active.meta.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => session.editLayer(active.meta.id, { opacity: v / 100 }, 'Layer opacity')} />
        </div>
      )}
      <ul className="dr-layers__list" aria-label="Layers">
        {rows.map((layer) => {
          const m = layer.meta, on = m.id === session.activeId;
          return (
            <li
              key={m.id} className={`dr-layer${on ? ' dr-layer--on' : ''}${m.visible ? '' : ' dr-layer--hidden'}${m.clip ? ' dr-layer--clip' : ''}`} draggable
              aria-label={`Layer ${m.name}`} aria-current={on ? 'true' : undefined}
              onDragStart={() => setDragId(m.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, m.id)} onDragEnd={() => setDragId(null)}
              onClick={() => session.setActive(m.id)}
            >
              <button type="button" className="dr-icon" aria-label={m.visible ? `Hide ${m.name}` : `Show ${m.name}`} aria-pressed={m.visible} onClick={(e) => { e.stopPropagation(); session.editLayer(m.id, { visible: !m.visible }, m.visible ? 'Hide layer' : 'Show layer'); }}>
                {m.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <LayerThumb session={session} id={m.id} tick={tick} />
              {renaming === m.id ? (
                <input
                  className="dr-input dr-layer__input" autoFocus defaultValue={m.name} aria-label="Layer name"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { session.editLayer(m.id, { name: e.target.value }, 'Rename layer'); setRenaming(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
                />
              ) : (
                <span className="dr-layer__name" onDoubleClick={() => setRenaming(m.id)} title="Double-click to rename">{m.name}</span>
              )}
              <button type="button" className={`dr-icon${m.clip ? ' dr-icon--on' : ''}`} title="Clip to the layer below (inherit alpha)" aria-label={`Clip ${m.name} to the layer below`} aria-pressed={m.clip} onClick={(e) => { e.stopPropagation(); session.editLayer(m.id, { clip: !m.clip }, 'Clip layer'); }}><Link2 size={12} /></button>
              <button type="button" className={`dr-icon${m.alphaLock ? ' dr-icon--on' : ''}`} title="Lock alpha: paint only where the layer has pixels" aria-label={`Lock alpha of ${m.name}`} aria-pressed={m.alphaLock} onClick={(e) => { e.stopPropagation(); session.editLayer(m.id, { alphaLock: !m.alphaLock }, 'Lock alpha'); }}><Shield size={12} /></button>
              <button type="button" className={`dr-icon${m.locked ? ' dr-icon--on' : ''}`} title="Lock the layer" aria-label={`${m.locked ? 'Unlock' : 'Lock'} ${m.name}`} aria-pressed={m.locked} onClick={(e) => { e.stopPropagation(); session.editLayer(m.id, { locked: !m.locked }, m.locked ? 'Unlock layer' : 'Lock layer'); }}>
                {m.locked ? <Lock size={12} /> : <LockOpen size={12} />}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="dr-layers__bar" role="toolbar" aria-label="Layer actions">
        <button type="button" className="dr-icon" aria-label="Add layer" title="New layer (Ctrl+Shift+N)" onClick={() => { try { session.addLayer(); } catch { /* layer limit */ } }}><Plus size={14} /></button>
        <button type="button" className="dr-icon" aria-label="Duplicate layer" title="Duplicate layer (Ctrl+J)" disabled={!active} onClick={() => active && session.duplicateLayer(active.meta.id)}><Copy size={13} /></button>
        <button type="button" className="dr-icon" aria-label="Merge layer down" title="Merge down (Ctrl+E)" disabled={!active || session.layers.indexOf(active) === 0} onClick={() => active && session.mergeDown(active.meta.id)}><Merge size={13} /></button>
        <button type="button" className="dr-icon" aria-label="Move layer up" disabled={!active || session.layers.indexOf(active) === session.layers.length - 1} onClick={() => active && session.moveLayer(active.meta.id, session.layers.indexOf(active) + 1)}><ArrowUp size={13} /></button>
        <button type="button" className="dr-icon" aria-label="Move layer down" disabled={!active || session.layers.indexOf(active) === 0} onClick={() => active && session.moveLayer(active.meta.id, session.layers.indexOf(active) - 1)}><ArrowDown size={13} /></button>
        <span className="dr-grow" />
        <button type="button" className="dr-icon dr-icon--danger" aria-label="Delete layer" title="Delete layer" disabled={!active} onClick={() => active && session.deleteLayer(active.meta.id)}><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

/* ---------- history ---------- */

export function HistoryPanel({ session, onJump }: { session: DrawingSession; tick: string; onJump: (steps: number) => void }) {
  const { undo, redo } = session.historyLabels;
  return (
    <ol className="dr-history" aria-label="History">
      <li className="dr-history__item dr-history__item--base"><LayersIcon size={11} /> Open</li>
      {undo.map((label, i) => (
        <li key={`u${i}`}>
          <button type="button" className={`dr-history__item${i === undo.length - 1 ? ' dr-history__item--now' : ''}`} onClick={() => onJump(-(undo.length - 1 - i))}>{label}</button>
        </li>
      ))}
      {redo.map((label, i) => (
        <li key={`r${i}`}>
          <button type="button" className="dr-history__item dr-history__item--redo" onClick={() => onJump(i + 1)}><Undo2 size={10} style={{ transform: 'scaleX(-1)' }} /> {label}</button>
        </li>
      ))}
    </ol>
  );
}
