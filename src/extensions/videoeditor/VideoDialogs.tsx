/** Dialogs of the Video Editor: a modal shell, new project and export. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, Image as ImageIcon, X } from 'lucide-react';
import { ASPECTS, projectDuration, type Project } from './video';

interface ModalProps { title: string; children: ReactNode; onClose: () => void; onOk?: () => void; okLabel?: string; okDisabled?: boolean }

export function Modal({ title, children, onClose, onOk, okLabel = 'OK', okDisabled }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input, select, button')?.focus(); }, []);
  return (
    <div className="ve-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref} className="ve-modal" role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && onOk && !okDisabled && (e.target as HTMLElement).tagName === 'INPUT') onOk(); }}
      >
        <header className="ve-modal__head"><h2>{title}</h2><button type="button" className="ve-icon" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="ve-modal__body">{children}</div>
        {onOk && <footer className="ve-modal__foot"><button type="button" className="ve-btn" onClick={onClose}>Cancel</button><button type="button" className="ve-btn ve-btn--primary" disabled={okDisabled} onClick={onOk}>{okLabel}</button></footer>}
      </div>
    </div>
  );
}

export type NewKind = 'blank' | 'promo' | 'title';
const KINDS: Array<{ id: NewKind; label: string; hint: string }> = [
  { id: 'blank', label: 'Blank', hint: 'An empty timeline with Main, Overlay, Text and Audio tracks.' },
  { id: 'promo', label: 'Motion promo', hint: 'A 12 s vertical clip with gradient scenes, transitions, stickers, text animations and a generated beat.' },
  { id: 'title', label: 'Title card', hint: 'A 6 s widescreen title with a typewriter subtitle and a soft pad.' },
];

export function NewVideoDialog({ onCreate, onClose }: { onCreate: (name: string, kind: NewKind, aspect: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<NewKind>('promo');
  const [aspect, setAspect] = useState('9:16');
  return (
    <Modal title="New video" okLabel="Create" onClose={onClose} onOk={() => onCreate(name, kind, aspect)}>
      <label className="ve-field">Name<input className="ve-input" aria-label="Video name" value={name} placeholder="my-video" onChange={(e) => setName(e.target.value)} /></label>
      <div className="ve-chips" role="radiogroup" aria-label="Starting point">
        {KINDS.map((k) => <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`ve-chip${kind === k.id ? ' ve-chip--on' : ''}`} onClick={() => { setKind(k.id); setAspect(k.id === 'title' ? '16:9' : '9:16'); }}>{k.label}</button>)}
      </div>
      <p className="ve-note">{KINDS.find((k) => k.id === kind)?.hint}</p>
      <label className="ve-field">Aspect ratio
        <select className="ve-select" aria-label="Aspect ratio" value={aspect} onChange={(e) => setAspect(e.target.value)}>
          {Object.entries(ASPECTS).map(([k, a]) => <option key={k} value={k}>{k} — {a.label} ({a.w}×{a.h})</option>)}
        </select>
      </label>
    </Modal>
  );
}

export interface ExportState { busy: boolean; progress: number; message: string }
export function ExportDialog({ project, state, onWebm, onFrame, onClose }: { project: Project; state: ExportState; onWebm: (download: boolean) => void; onFrame: (download: boolean) => void; onClose: () => void }) {
  const dur = projectDuration(project);
  return (
    <Modal title="Export" onClose={() => { if (!state.busy) onClose(); }}>
      <p className="ve-note">{project.width}×{project.height} · {project.fps} fps · {dur.toFixed(1)} s. The video plays once at normal speed while the browser records it, so exporting takes as long as the video itself (about {Math.ceil(dur)} s). Keep this window open.</p>
      <div className="ve-export">
        <button type="button" className="ve-btn ve-btn--primary" disabled={state.busy || dur <= 0} onClick={() => onWebm(true)}><Download size={13} /> Export video (WebM) &amp; download</button>
        <button type="button" className="ve-btn" disabled={state.busy || dur <= 0} onClick={() => onWebm(false)}>Save video to the workspace only</button>
        <button type="button" className="ve-btn" disabled={state.busy || dur <= 0} onClick={() => onFrame(true)}><ImageIcon size={13} /> Current frame (PNG)</button>
      </div>
      {state.busy && <div className="ve-progress" role="progressbar" aria-label="Export progress" aria-valuenow={Math.round(state.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.round(state.progress * 100)}%` }} /></div>}
      {state.message && <p className="ve-note" role="status">{state.message}</p>}
      <p className="ve-note">Output is WebM (VP9 video + Opus audio), which plays in browsers, Chrome, VLC and most editors. For an MP4 run <code>ffmpeg -i video.webm -c:v libx264 -crf 18 -c:a aac video.mp4</code>.</p>
    </Modal>
  );
}
