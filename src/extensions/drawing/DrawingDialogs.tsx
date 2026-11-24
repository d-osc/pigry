/** Small modal dialogs of the Drawing editor: new drawing, sizes, transform, amounts and filters. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, MAX_SIDE } from './drawing';
import type { FilterDef } from './drawingPixels';
import { filterParams } from './drawingPixels';
import { Slider } from './DrawingPanels';

interface ModalProps { title: string; children: ReactNode; onClose: () => void; onOk: () => void; okLabel?: string; okDisabled?: boolean }

export function Modal({ title, children, onClose, onOk, okLabel = 'OK', okDisabled }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input, select, button')?.focus(); }, []);
  return (
    <div className="dr-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref} className="dr-modal" role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && !okDisabled && (e.target as HTMLElement).tagName !== 'BUTTON' && (e.target as HTMLElement).tagName !== 'TEXTAREA') onOk();
        }}
      >
        <header className="dr-modal__head"><h2>{title}</h2><button type="button" className="dr-icon" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="dr-modal__body">{children}</div>
        <footer className="dr-modal__foot">
          <button type="button" className="dr-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="dr-btn dr-btn--primary" disabled={okDisabled} onClick={onOk}>{okLabel}</button>
        </footer>
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="dr-field">
      <span>{label}</span>
      <input className="dr-input" type="number" min={min} max={max} value={Number.isFinite(value) ? value : ''} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

const SIZE_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: 'Default 1024×768', w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT },
  { label: 'HD 1920×1080', w: 1920, h: 1080 },
  { label: 'Square 1024×1024', w: 1024, h: 1024 },
  { label: 'Icon 512×512', w: 512, h: 512 },
  { label: 'A4 portrait 1240×1754', w: 1240, h: 1754 },
  { label: 'Sprite 128×128', w: 128, h: 128 },
];

export interface NewDrawingSpec { name: string; width: number; height: number; background: string | null }

export function NewDrawingDialog({ onCreate, onClose }: { onCreate: (spec: NewDrawingSpec) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [w, setW] = useState(DEFAULT_WIDTH);
  const [h, setH] = useState(DEFAULT_HEIGHT);
  const [bg, setBg] = useState<'white' | 'transparent' | 'custom'>('white');
  const [custom, setCustom] = useState('#fdf6e3');
  const ok = w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE;
  return (
    <Modal title="New drawing" okLabel="Create" okDisabled={!ok} onClose={onClose} onOk={() => onCreate({ name, width: w, height: h, background: bg === 'white' ? '#ffffff' : bg === 'transparent' ? null : custom })}>
      <label className="dr-field"><span>Name</span><input className="dr-input" aria-label="Drawing name" placeholder="My painting" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="dr-chips" role="radiogroup" aria-label="Size presets">
        {SIZE_PRESETS.map((p) => <button key={p.label} type="button" role="radio" aria-checked={w === p.w && h === p.h} className={`dr-chip${w === p.w && h === p.h ? ' dr-chip--on' : ''}`} onClick={() => { setW(p.w); setH(p.h); }}>{p.label}</button>)}
      </div>
      <div className="dr-row"><NumberField label="Width" value={w} min={1} max={MAX_SIDE} onChange={setW} /><NumberField label="Height" value={h} min={1} max={MAX_SIDE} onChange={setH} /></div>
      <div className="dr-chips" role="radiogroup" aria-label="Background">
        {(['white', 'transparent', 'custom'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={bg === k} className={`dr-chip${bg === k ? ' dr-chip--on' : ''}`} onClick={() => setBg(k)}>{k === 'white' ? 'White' : k === 'transparent' ? 'Transparent' : 'Colour'}</button>)}
        {bg === 'custom' && <input type="color" aria-label="Background colour" value={custom} onChange={(e) => setCustom(e.target.value)} />}
      </div>
    </Modal>
  );
}

export function SizeDialog({ title, width, height, scale, onApply, onClose }: { title: string; width: number; height: number; scale: boolean; onApply: (w: number, h: number, anchor: { x: number; y: number }) => void; onClose: () => void }) {
  const [w, setW] = useState(width);
  const [h, setH] = useState(height);
  const [keep, setKeep] = useState(true);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const ok = w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE;
  return (
    <Modal title={title} okDisabled={!ok} onClose={onClose} onOk={() => onApply(w, h, anchor)}>
      <div className="dr-row">
        <NumberField label="Width" value={w} min={1} max={MAX_SIDE} onChange={(v) => { setW(v); if (keep) setH(Math.max(1, Math.round((v * height) / width))); }} />
        <NumberField label="Height" value={h} min={1} max={MAX_SIDE} onChange={(v) => { setH(v); if (keep) setW(Math.max(1, Math.round((v * width) / height))); }} />
      </div>
      <label className="dr-check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep the proportions</label>
      {!scale && (
        <div className="dr-anchor" role="radiogroup" aria-label="Where the picture sits">
          {[0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => (
            <button key={`${x}${y}`} type="button" role="radio" aria-checked={anchor.x === x && anchor.y === y} aria-label={`Anchor ${y === 0 ? 'top' : y === 1 ? 'bottom' : 'middle'} ${x === 0 ? 'left' : x === 1 ? 'right' : 'centre'}`} className={`dr-anchor__cell${anchor.x === x && anchor.y === y ? ' dr-anchor__cell--on' : ''}`} onClick={() => setAnchor({ x, y })} />
          )))}
        </div>
      )}
      <p className="dr-note">{scale ? 'The pixels are resampled to the new size.' : 'The pixels keep their size; the canvas grows or is cut.'}</p>
    </Modal>
  );
}

export function TransformDialog({ onApply, onClose }: { onApply: (scale: number, degrees: number, dx: number, dy: number) => void; onClose: () => void }) {
  const [scale, setScale] = useState(100);
  const [deg, setDeg] = useState(0);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  return (
    <Modal title="Transform layer" onClose={onClose} onOk={() => onApply(scale, deg, dx, dy)}>
      <Slider label="Scale" value={scale} min={10} max={400} suffix="%" onChange={setScale} />
      <Slider label="Rotate" value={deg} min={-180} max={180} suffix="°" onChange={setDeg} />
      <div className="dr-row"><NumberField label="Move X" value={dx} min={-MAX_SIDE} max={MAX_SIDE} onChange={setDx} /><NumberField label="Move Y" value={dy} min={-MAX_SIDE} max={MAX_SIDE} onChange={setDy} /></div>
      <p className="dr-note">The layer is scaled and rotated around the middle of the canvas.</p>
    </Modal>
  );
}

export function AmountDialog({ title, label, value, min, max, onApply, onClose }: { title: string; label: string; value: number; min: number; max: number; onApply: (v: number) => void; onClose: () => void }) {
  const [v, setV] = useState(value);
  return (
    <Modal title={title} onClose={onClose} onOk={() => onApply(v)}>
      <Slider label={label} value={v} min={min} max={max} suffix=" px" onChange={setV} />
    </Modal>
  );
}

/** Filter parameters with a live preview: the parent applies the filter as an undoable step and replaces it on every change. */
export function FilterDialog({ def, onPreview, onApply, onCancel }: { def: FilterDef; onPreview: (params: Record<string, number> | null) => void; onApply: (params: Record<string, number>) => void; onCancel: () => void }) {
  const [params, setParams] = useState<Record<string, number>>(() => filterParams(def));
  const [live, setLive] = useState(true);
  const first = useRef(true);
  useEffect(() => {
    const timer = window.setTimeout(() => { onPreview(live ? params : null); first.current = false; }, first.current ? 0 : 140);
    return () => window.clearTimeout(timer);
  }, [params, live, onPreview]);
  return (
    <Modal title={def.label} okLabel="Apply" onClose={onCancel} onOk={() => onApply(params)}>
      {def.params.length === 0 && <p className="dr-note">This filter has no settings.</p>}
      {def.params.map((p) => <Slider key={p.key} label={p.label} value={params[p.key]} min={p.min} max={p.max} step={p.step} onChange={(v) => setParams((cur) => ({ ...cur, [p.key]: v }))} />)}
      <label className="dr-check"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Preview</label>
      <p className="dr-note">Applies to the active layer — only inside the selection if there is one.</p>
    </Modal>
  );
}
