/** Dialogs of the Audio Editor: modal shell, new project, export, effect parameters, generator, analysis result, spectrum plot, history, label. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, Play, Square, X } from 'lucide-react';
import { FX, SAMPLE_RATES, defaultGen, type GenSpec, type Label, type ParamSpec, type Project } from './audio';
import { bandLevels, spectrum } from './audioDsp';

interface ModalProps { title: string; children: ReactNode; onClose: () => void; onOk?: () => void; okLabel?: string; okDisabled?: boolean; extra?: ReactNode; wide?: boolean }
export function Modal({ title, children, onClose, onOk, okLabel = 'OK', okDisabled, extra, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input, select, button')?.focus(); }, []);
  return (
    <div className="au-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`au-modal${wide ? ' au-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && onOk && !okDisabled && (e.target as HTMLElement).tagName === 'INPUT') onOk(); }}>
        <header className="au-modal__head"><h2>{title}</h2><button type="button" className="au-icon" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="au-modal__body">{children}</div>
        {(onOk || extra) && <footer className="au-modal__foot">{extra}<span className="au-grow" /><button type="button" className="au-btn" onClick={onClose}>{onOk ? 'Cancel' : 'Close'}</button>{onOk && <button type="button" className="au-btn au-btn--primary" disabled={okDisabled} onClick={onOk}>{okLabel}</button>}</footer>}
      </div>
    </div>
  );
}

export type NewKind = 'blank' | 'podcast' | 'music';
const KINDS: Array<{ id: NewKind; label: string; hint: string }> = [
  { id: 'blank', label: 'Blank', hint: 'One empty stereo track — record, import or generate sound into it.' },
  { id: 'podcast', label: 'Podcast', hint: 'A mono Voice track, a quieter Music track, an Effects track and a −1 dB master limiter.' },
  { id: 'music', label: 'Music', hint: 'Drums, Bass and Melody tracks with a −1 dB master limiter.' },
];
export function NewAudioDialog({ onCreate, onClose }: { onCreate: (name: string, kind: NewKind, rate: number) => void; onClose: () => void }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState<NewKind>('blank'); const [rate, setRate] = useState(44100);
  return (
    <Modal title="New audio project" okLabel="Create" onClose={onClose} onOk={() => onCreate(name, kind, rate)}>
      <label className="au-field">Name<input className="au-input" aria-label="Project name" value={name} placeholder="my-recording" onChange={(e) => setName(e.target.value)} /></label>
      <div className="au-chips" role="radiogroup" aria-label="Starting point">
        {KINDS.map((k) => <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`au-chip${kind === k.id ? ' au-chip--on' : ''}`} onClick={() => setKind(k.id)}>{k.label}</button>)}
      </div>
      <p className="au-note">{KINDS.find((k) => k.id === kind)?.hint}</p>
      <label className="au-field">Project rate
        <select className="au-select" aria-label="Project rate" value={rate} onChange={(e) => setRate(Number(e.target.value))}>{SAMPLE_RATES.map((r) => <option key={r} value={r}>{r} Hz{r === 44100 ? ' (CD, music)' : r === 48000 ? ' (video, podcasts)' : ''}</option>)}</select>
      </label>
    </Modal>
  );
}

export interface ExportState { busy: boolean; progress: number; message: string }
export type ExportFormat = 'wav16' | 'wav24' | 'wav32' | 'webm';
export function ExportDialog({ project, total, hasSelection, state, onExport, onClose }: { project: Project; total: number; hasSelection: boolean; state: ExportState; onExport: (format: ExportFormat, range: 'all' | 'selection', download: boolean) => void; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('wav16'); const [range, setRange] = useState<'all' | 'selection'>('all');
  return (
    <Modal title="Export audio" onClose={() => { if (!state.busy) onClose(); }}>
      <p className="au-note">{project.sampleRate} Hz · stereo mix of all tracks (mute and solo respected) · {total.toFixed(1)} s, including the master effects.</p>
      <label className="au-field">Format
        <select className="au-select" aria-label="Export format" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
          <option value="wav16">WAV — 16-bit PCM (dithered; CD, most players)</option><option value="wav24">WAV — 24-bit PCM (archive, handing off to mastering)</option><option value="wav32">WAV — 32-bit float (lossless working copy)</option><option value="webm">WebM — Opus, lossy (recorded in real time)</option>
        </select>
      </label>
      <label className="au-field">Range
        <select className="au-select" aria-label="Export range" value={range} onChange={(e) => setRange(e.target.value as 'all' | 'selection')}>
          <option value="all">Whole project</option><option value="selection" disabled={!hasSelection}>Selection only</option>
        </select>
      </label>
      <div className="au-export">
        <button type="button" className="au-btn au-btn--primary" disabled={state.busy || total <= 0} onClick={() => onExport(format, range, true)}><Download size={13} /> Export &amp; download</button>
        <button type="button" className="au-btn" disabled={state.busy || total <= 0} onClick={() => onExport(format, range, false)}>Save to the workspace only</button>
      </div>
      {state.busy && <div className="au-progress" role="progressbar" aria-label="Export progress" aria-valuenow={Math.round(state.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.round(state.progress * 100)}%` }} /></div>}
      {state.message && <p className="au-note" role="status">{state.message}</p>}
      <p className="au-note">Not supported: MP3 and FLAC export (the browser has no encoder for them). Convert the WAV with <code>ffmpeg -i mix.wav -b:a 192k mix.mp3</code> if you need an MP3.</p>
    </Modal>
  );
}

/* ---------------------------------------------------------------- effect dialog (generated from the catalogue) */

function ParamField({ id, spec, value, onChange }: { id: string; spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (typeof spec.def === 'boolean') return <label className="au-check"><input type="checkbox" aria-label={spec.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {spec.label}</label>;
  if (spec.choices) {
    return (
      <label className="au-field">{spec.label}{spec.unit ? ` (${spec.unit})` : ''}
        <select className="au-select" aria-label={spec.label} value={String(value)} onChange={(e) => onChange(typeof spec.choices?.[0] === 'number' ? Number(e.target.value) : e.target.value)}>{spec.choices.map((c) => <option key={String(c)} value={String(c)}>{String(c)}</option>)}</select>
      </label>
    );
  }
  const num = Number(value);
  return (
    <label className="au-field au-field--row" data-param={id}><span>{spec.label}{spec.unit ? ` (${spec.unit})` : ''}</span>
      <input type="range" min={spec.min} max={spec.max} step={spec.step ?? 0.01} value={num} aria-label={`${spec.label} slider`} onChange={(e) => onChange(Number(e.target.value))} />
      <input className="au-input au-num" type="number" min={spec.min} max={spec.max} step={spec.step ?? 0.01} aria-label={spec.label} value={num} onChange={(e) => onChange(e.target.value === '' ? spec.def : Number(e.target.value))} />
    </label>
  );
}

export function EffectDialog({ effect, initial, rangeText, previewing, noiseProfile, onProfile, onPreview, onStop, onApply, onClose }: {
  effect: string; initial: Record<string, unknown>; rangeText: string; previewing: boolean; noiseProfile: { from: number; to: number } | null;
  onProfile: () => void; onPreview: (params: Record<string, unknown>) => void; onStop: () => void; onApply: (params: Record<string, unknown>) => void; onClose: () => void;
}) {
  const spec = FX[effect];
  const [params, setParams] = useState<Record<string, unknown>>(() => ({ ...Object.fromEntries(Object.entries(spec.params).map(([k, s]) => [k, s.def])), ...initial }));
  const fields = Object.entries(spec.params).filter(([k]) => !(effect === 'noisereduce' && k.startsWith('profile')));
  const final = (): Record<string, unknown> => (effect === 'noisereduce' && noiseProfile ? { ...params, profileFrom: noiseProfile.from, profileTo: noiseProfile.to } : params);
  return (
    <Modal title={spec.label} okLabel="Apply" onClose={() => { onStop(); onClose(); }} onOk={() => { onStop(); onApply(final()); }}
      extra={previewing ? <button type="button" className="au-btn" onClick={onStop}><Square size={12} /> Stop preview</button> : <button type="button" className="au-btn" onClick={() => onPreview(final())}><Play size={12} /> Preview</button>}>
      <p className="au-note">{spec.help}</p>
      <p className="au-note" data-testid="effect-range">Applies to {rangeText}.</p>
      {effect === 'noisereduce' && (
        <div className="au-profile">
          <button type="button" className="au-btn" onClick={onProfile}>Get noise profile from the selection</button>
          <span className="au-note">{noiseProfile ? `Profile: ${noiseProfile.from.toFixed(2)}–${noiseProfile.to.toFixed(2)} s` : 'No profile yet — the quietest 0.5 s of each clip is used.'}</span>
        </div>
      )}
      {fields.map(([k, s]) => <ParamField key={k} id={k} spec={s} value={params[k]} onChange={(v) => setParams((o) => ({ ...o, [k]: v }))} />)}
      {fields.length === 0 && <p className="au-note">No settings.</p>}
    </Modal>
  );
}

export function GenerateDialog({ type, duration, onApply, onClose }: { type: GenSpec['type']; duration: number; onApply: (gen: GenSpec, duration: number) => void; onClose: () => void }) {
  const [gen, setGen] = useState<GenSpec>(() => defaultGen(type)); const [dur, setDur] = useState(duration);
  const title = { tone: 'Tone', chirp: 'Chirp', noise: 'Noise', silence: 'Silence', click: 'Click track' }[type];
  const set = (patch: Partial<GenSpec>): void => setGen((g) => ({ ...g, ...patch }));
  return (
    <Modal title={`Generate ${title}`} okLabel="Generate" onClose={onClose} onOk={() => onApply(gen, dur)}>
      {type === 'tone' && <label className="au-field">Waveform<select className="au-select" aria-label="Waveform" value={gen.wave} onChange={(e) => set({ wave: e.target.value as GenSpec['wave'] })}>{['sine', 'square', 'sawtooth', 'triangle'].map((w) => <option key={w}>{w}</option>)}</select></label>}
      {(type === 'tone' || type === 'chirp') && <label className="au-field">{type === 'chirp' ? 'Start frequency (Hz)' : 'Frequency (Hz)'}<input className="au-input" type="number" aria-label="Frequency" min={1} max={20000} value={gen.freq} onChange={(e) => set({ freq: Number(e.target.value) })} /></label>}
      {type === 'chirp' && <label className="au-field">End frequency (Hz)<input className="au-input" type="number" aria-label="End frequency" min={1} max={20000} value={gen.freq2} onChange={(e) => set({ freq2: Number(e.target.value) })} /></label>}
      {type === 'noise' && <label className="au-field">Colour<select className="au-select" aria-label="Noise colour" value={gen.color} onChange={(e) => set({ color: e.target.value as GenSpec['color'] })}>{['white', 'pink', 'brown'].map((w) => <option key={w}>{w}</option>)}</select></label>}
      {type === 'click' && <label className="au-field">Tempo (BPM)<input className="au-input" type="number" aria-label="Tempo" min={20} max={400} value={gen.bpm} onChange={(e) => set({ bpm: Number(e.target.value) })} /></label>}
      {type !== 'silence' && <label className="au-field">Amplitude (0–1)<input className="au-input" type="number" aria-label="Amplitude" min={0} max={1} step={0.05} value={gen.amp} onChange={(e) => set({ amp: Number(e.target.value) })} /></label>}
      <label className="au-field">Duration (s)<input className="au-input" type="number" aria-label="Duration" min={0.01} max={600} step={0.1} value={dur} onChange={(e) => setDur(Number(e.target.value))} /></label>
    </Modal>
  );
}

export function TextDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return <Modal title={title} onClose={onClose} wide><pre className="au-pre" data-testid="analysis">{text}</pre></Modal>;
}

export function SpectrumDialog({ samples, sampleRate, onClose }: { samples: Float32Array; sampleRate: number; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [info, setInfo] = useState('');
  useEffect(() => {
    const c = ref.current, ctx = c?.getContext('2d'); if (!c || !ctx) return;
    const sp = spectrum(samples, sampleRate, 4096), W = c.width, H = c.height, maxHz = Math.min(sampleRate / 2, 20000), minHz = 20;
    ctx.fillStyle = '#0c0f13'; ctx.fillRect(0, 0, W, H); ctx.strokeStyle = '#2a2f38'; ctx.fillStyle = '#8b94a1'; ctx.font = '10px sans-serif';
    const x = (f: number): number => ((Math.log10(f) - Math.log10(minHz)) / (Math.log10(maxHz) - Math.log10(minHz))) * (W - 40) + 36;
    const y = (db: number): number => H - 18 - ((Math.max(-120, Math.min(0, db)) + 120) / 120) * (H - 28);
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { if (f > maxHz) break; ctx.beginPath(); ctx.moveTo(x(f), 6); ctx.lineTo(x(f), H - 18); ctx.stroke(); ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x(f) - 6, H - 5); }
    for (const d of [0, -20, -40, -60, -80, -100]) { ctx.beginPath(); ctx.moveTo(36, y(d)); ctx.lineTo(W - 4, y(d)); ctx.stroke(); ctx.fillText(String(d), 4, y(d) + 3); }
    ctx.strokeStyle = '#4fb3ff'; ctx.beginPath(); let best = 1;
    for (let k = 1; k < sp.db.length; k++) { const f = k * sp.binHz; if (f < minHz || f > maxHz) continue; ctx.lineTo(x(f), y(sp.db[k])); if (sp.db[k] > sp.db[best]) best = k; }
    ctx.stroke();
    const t = window.setTimeout(() => setInfo(`Peak at ${Math.round(best * sp.binHz)} Hz. ${bandLevels(sp, sampleRate).map((b) => `${b.band} ${b.db} dB`).join(' · ')}`), 0);
    return () => window.clearTimeout(t);
  }, [samples, sampleRate]);
  return <Modal title="Plot spectrum" onClose={onClose} wide><canvas ref={ref} width={680} height={300} className="au-spectrum" aria-label="Spectrum plot" /><p className="au-note" role="status">{info}</p></Modal>;
}

export function HistoryDialog({ entries, onJump, onClose }: { entries: string[]; onJump: (index: number) => void; onClose: () => void }) {
  return (
    <Modal title="History" onClose={onClose}>
      {entries.length === 0 ? <p className="au-note">Nothing to undo yet.</p> : (
        <ol className="au-history" aria-label="Undo history">
          {entries.map((label, i) => <li key={i}><button type="button" onClick={() => { onJump(i); onClose(); }}>{label}</button></li>)}
        </ol>
      )}
      <p className="au-note">Click an entry to go back to the state before it (newest at the bottom). Everything after it can be redone.</p>
    </Modal>
  );
}

export function LabelDialog({ label, onSave, onDelete, onSelect, onClose }: { label: Label; onSave: (text: string) => void; onDelete: () => void; onSelect: () => void; onClose: () => void }) {
  const [text, setText] = useState(label.text);
  return (
    <Modal title="Edit label" okLabel="Save" onClose={onClose} onOk={() => onSave(text)}
      extra={<><button type="button" className="au-btn" onClick={onDelete}>Delete label</button><button type="button" className="au-btn" onClick={onSelect}>Select its range</button></>}>
      <label className="au-field">Text<input className="au-input" aria-label="Label text" value={text} onChange={(e) => setText(e.target.value)} /></label>
      <p className="au-note">{label.start.toFixed(3)} s{label.end > label.start ? ` – ${label.end.toFixed(3)} s` : ' (point label)'}</p>
    </Modal>
  );
}
