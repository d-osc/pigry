/** Track panel and timeline of the Audio Editor: ruler, track controls, clips with waveform / spectrogram, envelope points,
 * selection, playhead, labels track and VU meters. */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Lock, LockOpen, Volume2, VolumeX, X } from 'lucide-react';
import { clipEnd, dbToLin, envelopeAt, linToDb, projectDuration, type Clip, type Op, type Project, type Selection, type Track } from './audio';
import { drawSpectrogram, drawWaveform, type AudioEngine } from './audioEngine';

/* ---------------------------------------------------------------- tiny external stores (playhead and meter update 60×/s) */

export interface Store<T> { get: () => T; set: (v: T) => void; subscribe: (fn: () => void) => () => void }
export function createStore<T>(initial: T): Store<T> {
  let value = initial; const subs = new Set<() => void>();
  return { get: () => value, set: (v) => { value = v; subs.forEach((f) => f()); }, subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; } };
}
export const useStore = <T,>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.get);

export const fmtTime = (s: number): string => { const m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };

export type Tool = 'select' | 'envelope' | 'zoom' | 'shift';
export const TRACK_H: Record<Track['view'], (kind: Track['kind']) => number> = { wave: (k) => (k === 'mono' ? 124 : 136), spectrogram: () => 124, both: (k) => (k === 'mono' ? 168 : 200) };

/* ---------------------------------------------------------------- meter */

const dbPos = (lin: number): number => Math.max(0, Math.min(1, (linToDb(lin) + 60) / 60));
export function Meter({ store, label }: { store: Store<{ l: number; r: number }>; label: string }) {
  const v = useStore(store);
  return (
    <div className="au-meter" role="img" aria-label={`${label}: left ${linToDb(v.l) > -90 ? linToDb(v.l).toFixed(0) : '−∞'} dB, right ${linToDb(v.r) > -90 ? linToDb(v.r).toFixed(0) : '−∞'} dB`}>
      {[v.l, v.r].map((x, i) => <div key={i} className="au-meter__bar"><span className={x >= 0.999 ? 'au-meter__fill au-meter__fill--clip' : 'au-meter__fill'} style={{ width: `${dbPos(x) * 100}%` }} /></div>)}
    </div>
  );
}

/* ---------------------------------------------------------------- one clip */

interface ClipViewProps { project: Project; track: Track; clip: Clip; engine: AudioEngine; rev: number; pps: number; selected: boolean; tool: Tool; showClipping: boolean; height: number }
function ClipView({ project, track, clip, engine, rev, pps, selected, tool, showClipping, height }: ClipViewProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const width = Math.max(2, Math.round(clip.duration * pps));
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const cw = Math.min(width, 4096), ctx = canvas.getContext('2d'); if (!ctx) return;
    canvas.width = cw; canvas.height = height;
    ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, cw, height);
    const ch = engine.clipView(track, clip, project.sampleRate);
    if (track.view === 'spectrogram') drawSpectrogram(ctx, ch[0], project.sampleRate, cw, height);
    else if (track.view === 'both') {
      const wh = Math.round(height * 0.55);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, cw, wh); ctx.clip(); drawWaveform(ctx, ch, cw, wh, '#4fb3ff', undefined, showClipping); ctx.restore();
      ctx.save(); ctx.translate(0, wh); ctx.beginPath(); ctx.rect(0, 0, cw, height - wh); ctx.clip(); drawSpectrogram(ctx, ch[0], project.sampleRate, cw, height - wh); ctx.restore();
    } else drawWaveform(ctx, ch, cw, height, '#4fb3ff', undefined, showClipping);
  }, [project.sampleRate, track, clip, engine, rev, width, height, showClipping]);
  const env = clip.envelope;
  const showEnv = tool === 'envelope' || env.length > 0;
  const wavH = track.view === 'both' ? Math.round(height * 0.55) : track.view === 'spectrogram' ? 0 : height;
  const pointsN = Math.min(200, Math.max(2, Math.round(width / 4)));
  const envPath = showEnv && wavH > 0 ? Array.from({ length: pointsN }, (_unused, i) => { const t = (i / (pointsN - 1)) * clip.duration; return `${i ? 'L' : 'M'}${((t / clip.duration) * width).toFixed(1)},${(wavH - (Math.min(2, envelopeAt(env, t)) / 2) * wavH).toFixed(1)}`; }).join(' ') : '';
  return (
    <div
      className={`au-clip${selected ? ' au-clip--on' : ''}${clip.muted ? ' au-clip--muted' : ''}`}
      style={{ left: clip.start * pps, width, height }}
      data-clip={clip.id} role="button" tabIndex={-1} aria-label={`Clip ${clip.id}: ${clip.name || 'audio'}`} aria-pressed={selected}
    >
      <canvas ref={ref} className="au-clip__wave" aria-hidden />
      <span className="au-clip__name">{clip.name || clip.id}{clip.fx.length > 0 && <i title={clip.fx.map((f) => f.type).join(' → ')}> · fx {clip.fx.length}</i>}{clip.reverse && <i> · reversed</i>}</span>
      {showEnv && wavH > 0 && (
        <svg className="au-clip__env" width={width} height={wavH} aria-hidden>
          {envPath && <path d={envPath} />}
          {env.map((p, i) => <circle key={i} cx={(p.t / clip.duration) * width} cy={wavH - (Math.min(2, p.v) / 2) * wavH} r={4} />)}
        </svg>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- timeline */

export interface TimelineProps {
  project: Project; engine: AudioEngine; rev: number; pps: number; tool: Tool; showClipping: boolean;
  selection: Selection | null; clipId: string | null; trackId: string | null; timeStore: Store<number>;
  onSeek: (t: number) => void; onSelection: (s: Selection | null) => void; onClip: (id: string | null) => void; onTrack: (id: string) => void;
  beginDrag: () => void; previewOps: (ops: Op[]) => void; endDrag: (label: string, keep: boolean) => void; run: (ops: Op[], label: string, merge?: string) => void;
  onZoom: (dir: 1 | -1, t: number) => void; onLabel: (id: string) => void;
}

function Ruler({ pps, width, onSeek }: { pps: number; width: number; onSeek: (t: number) => void }) {
  const step = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 70) ?? 600;
  const ticks: number[] = []; for (let t = 0; t * pps < width; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return (
    <div className="au-ruler" style={{ width }} onPointerDown={(e) => onSeek((e.clientX - e.currentTarget.getBoundingClientRect().left) / pps)} data-testid="ruler">
      {ticks.map((t) => <span key={t} style={{ left: t * pps }}>{step < 1 ? t.toFixed(2) : t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : t}</span>)}
    </div>
  );
}

function Playhead({ store, pps }: { store: Store<number>; pps: number }) {
  const t = useStore(store);
  return <div className="au-playhead" style={{ left: t * pps }} aria-hidden />;
}

export function Timeline(p: TimelineProps) {
  const { project, pps, tool } = p;
  const dur = projectDuration(project);
  const width = Math.max(900, (dur + 8) * pps);
  const drag = useRef<null | { kind: 'select'; track: string; t0: number } | { kind: 'shift'; clip: string; t0: number; start: number; moved: boolean; lane: HTMLElement } | { kind: 'env'; clip: string }>(null);

  const timeAt = (e: ReactPointerEvent, lane: HTMLElement): number => Math.max(0, Math.round(((e.clientX - lane.getBoundingClientRect().left) / pps) * 1000) / 1000);

  const downLane = (track: Track) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const lane = e.currentTarget, t = timeAt(e, lane), target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>('[data-clip]');
    const clip = clipEl ? track.clips.find((c) => c.id === clipEl.dataset.clip) ?? null : null;
    p.onTrack(track.id);
    if (tool === 'zoom') { p.onZoom(e.shiftKey ? -1 : 1, t); return; }
    if (tool === 'shift' && clip) {
      if (track.locked) return;
      p.onClip(clip.id); p.beginDrag();
      drag.current = { kind: 'shift', clip: clip.id, t0: t, start: clip.start, moved: false, lane };
      lane.setPointerCapture(e.pointerId); return;
    }
    if (tool === 'envelope' && clip && !track.locked) {
      const rect = (clipEl as HTMLElement).getBoundingClientRect();
      const local = Math.max(0, Math.min(clip.duration, t - clip.start));
      const wavH = track.view === 'both' ? Math.round(TRACK_H.both(track.kind) * 0.55) : TRACK_H[track.view](track.kind);
      const v = Math.round(Math.max(0, Math.min(2, (1 - (e.clientY - rect.top) / wavH) * 2)) * 100) / 100;
      const pts = clip.envelope.length ? clip.envelope : [{ t: 0, v: 1 }, { t: clip.duration, v: 1 }];
      const near = pts.findIndex((q) => Math.abs(q.t - local) * pps < 7);
      const next = near >= 0 ? pts.map((q, i) => (i === near ? { t: q.t, v } : q)) : [...pts, { t: Math.round(local * 1000) / 1000, v }].sort((a, b) => a.t - b.t);
      p.onClip(clip.id);
      p.run([{ op: 'envelope_set', clip: clip.id, points: next }], 'Envelope point');
      return;
    }
    p.onClip(clip ? clip.id : null);
    drag.current = { kind: 'select', track: track.id, t0: t };
    p.onSelection({ start: t, end: t, tracks: [track.id] });
    lane.setPointerCapture(e.pointerId);
  };
  const moveLane = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current; if (!d) return;
    const t = timeAt(e, e.currentTarget);
    if (d.kind === 'select') p.onSelection({ start: Math.min(d.t0, t), end: Math.max(d.t0, t), tracks: [d.track] });
    else if (d.kind === 'shift') {
      if (!d.moved && Math.abs(t - d.t0) * pps < 3) return;
      d.moved = true;
      const under = document.elementsFromPoint(e.clientX, e.clientY).map((el) => (el as HTMLElement).dataset?.track).find(Boolean);
      p.previewOps([{ op: 'clip_move', clip: d.clip, start: Math.max(0, Math.round((d.start + t - d.t0) * 1000) / 1000), ...(under ? { track: under } : {}) }]);
    }
  };
  const upLane = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current; drag.current = null; if (!d) return;
    const t = timeAt(e, e.currentTarget);
    if (d.kind === 'select') { if (Math.abs(t - d.t0) * pps < 3) { p.onSelection(null); p.onSeek(d.t0); } else p.onSeek(Math.min(d.t0, t)); }
    else if (d.kind === 'shift') p.endDrag('Time shift', d.moved);
  };
  const dblClip = (track: Track) => (e: React.MouseEvent<HTMLDivElement>): void => {
    if (tool !== 'envelope' || track.locked) return;
    const clipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-clip]'); if (!clipEl) return;
    const clip = track.clips.find((c) => c.id === clipEl.dataset.clip); if (!clip || clip.envelope.length === 0) return;
    const local = (e.clientX - clipEl.getBoundingClientRect().left) / pps;
    const near = clip.envelope.findIndex((q) => Math.abs(q.t - local) * pps < 9);
    if (near >= 0) p.run([{ op: 'envelope_set', clip: clip.id, points: clip.envelope.filter((_, i) => i !== near) }], 'Remove envelope point');
  };

  const sel = p.selection;
  return (
    <div className="au-tl" data-testid="timeline" aria-label="Tracks">
      <div className="au-tl__row au-tl__row--ruler">
        <div className="au-ctrl au-ctrl--corner" />
        <Ruler pps={pps} width={width} onSeek={p.onSeek} />
      </div>
      {project.tracks.map((track) => {
        const h = TRACK_H[track.view](track.kind);
        return (
          <div key={track.id} className={`au-tl__row${track.id === p.trackId ? ' au-tl__row--on' : ''}`} data-testid={`track-${track.id}`}>
            <TrackControls project={project} track={track} on={track.id === p.trackId} height={h} onTrack={p.onTrack} run={p.run} />
            <div className={`au-lane au-lane--${tool}${track.locked ? ' au-lane--locked' : ''}`} data-track={track.id} style={{ width, height: h }} onPointerDown={downLane(track)} onPointerMove={moveLane} onPointerUp={upLane} onPointerCancel={upLane} onDoubleClick={dblClip(track)}>
              {sel && sel.end > sel.start && (sel.tracks.length === 0 || sel.tracks.includes(track.id)) && <div className="au-selection" style={{ left: sel.start * pps, width: (sel.end - sel.start) * pps }} data-testid="selection" aria-hidden />}
              {track.clips.map((c) => <ClipView key={c.id} project={project} track={track} clip={c} engine={p.engine} rev={p.rev} pps={pps} selected={c.id === p.clipId} tool={tool} showClipping={p.showClipping} height={h} />)}
              {track.view !== 'spectrogram' && <div className="au-lane__mid" aria-hidden />}
              <Playhead store={p.timeStore} pps={pps} />
            </div>
          </div>
        );
      })}
      <div className="au-tl__row au-tl__row--labels">
        <div className="au-ctrl au-ctrl--labels">Labels</div>
        <div className="au-lane au-lane--labels" style={{ width, height: 34 }} aria-label="Label track">
          {project.labels.map((l) => (
            <button key={l.id} type="button" className={`au-label${l.end > l.start ? ' au-label--range' : ''}`} style={{ left: l.start * pps, width: l.end > l.start ? Math.max(6, (l.end - l.start) * pps) : undefined }}
              onClick={() => p.onLabel(l.id)} title={`${l.text || 'label'} · ${fmtTime(l.start)}`}>
              <span>{l.text || '·'}</span>
            </button>
          ))}
          <Playhead store={p.timeStore} pps={pps} />
        </div>
      </div>
      <div className="au-tl__fill" aria-hidden />
    </div>
  );
}

function TrackControls({ project, track, on, height, onTrack, run }: { project: Project; track: Track; on: boolean; height: number; onTrack: (id: string) => void; run: (ops: Op[], label: string, merge?: string) => void }) {
  const set = (patch: Record<string, unknown>, label: string, merge?: string): void => run([{ op: 'track_set', track: track.id, ...patch }], label, merge);
  const db = Math.round(linToDb(track.gain));
  return (
    <div className={`au-ctrl${on ? ' au-ctrl--on' : ''}`} style={{ height }} onPointerDown={() => onTrack(track.id)} role="group" aria-label={`Track ${track.name}`}>
      <div className="au-ctrl__top">
        <input className="au-ctrl__name" aria-label={`Name of ${track.id}`} value={track.name} onChange={(e) => set({ name: e.target.value }, 'Rename track', `name-${track.id}`)} />
        <button type="button" className="au-icon au-icon--tiny" aria-label={`Remove track ${track.name}`} title="Remove track" disabled={project.tracks.length <= 1} onClick={() => run([{ op: 'track_remove', track: track.id }], 'Remove track')}><X size={11} /></button>
      </div>
      <div className="au-ctrl__meta">{track.kind === 'mono' ? 'Mono' : 'Stereo'}, {project.sampleRate / 1000} kHz, 32-bit float</div>
      <div className="au-ctrl__btns">
        <button type="button" className={`au-mini${track.mute ? ' au-mini--mute' : ''}`} aria-pressed={track.mute} aria-label={`Mute ${track.name}`} onClick={() => set({ mute: !track.mute }, 'Mute')}>{track.mute ? <VolumeX size={11} /> : <Volume2 size={11} />} Mute</button>
        <button type="button" className={`au-mini${track.solo ? ' au-mini--solo' : ''}`} aria-pressed={track.solo} aria-label={`Solo ${track.name}`} onClick={() => set({ solo: !track.solo }, 'Solo')}>Solo</button>
        <button type="button" className="au-icon au-icon--tiny" aria-pressed={track.locked} aria-label={`${track.locked ? 'Unlock' : 'Lock'} ${track.name}`} title={track.locked ? 'Unlock' : 'Lock (protect from edits)'} onClick={() => set({ locked: !track.locked }, 'Lock track')}>{track.locked ? <Lock size={11} /> : <LockOpen size={11} />}</button>
      </div>
      <label className="au-ctrl__slider" title={`Gain ${db > 0 ? '+' : ''}${db} dB`}><span>Gain</span>
        <input type="range" min={-36} max={12} step={1} value={Math.max(-36, Math.min(12, db))} aria-label={`Gain of ${track.name}`} onChange={(e) => set({ gain: Math.round(dbToLin(Number(e.target.value)) * 1000) / 1000 }, 'Track gain', `gain-${track.id}`)} /><em>{db > 0 ? '+' : ''}{db}</em></label>
      <label className="au-ctrl__slider" title={`Pan ${track.pan}`}><span>Pan</span>
        <input type="range" min={-1} max={1} step={0.05} value={track.pan} aria-label={`Pan of ${track.name}`} onChange={(e) => set({ pan: Number(e.target.value) }, 'Track pan', `pan-${track.id}`)} /><em>{track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`}</em></label>
      {height > 100 && (
        <select className="au-select" aria-label={`View of ${track.name}`} value={track.view} onChange={(e) => set({ view: e.target.value }, 'Track view')}>
          <option value="wave">Waveform</option><option value="spectrogram">Spectrogram</option><option value="both">Waveform + spectrogram</option>
        </select>
      )}
    </div>
  );
}

export const clipAtTime = (track: Track, t: number): Clip | undefined => track.clips.find((c) => c.start <= t && clipEnd(c) > t);
