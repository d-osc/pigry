/** The multi-track timeline: ruler, playhead, track headers, draggable/trimmable clips with snapping. */
import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Eye, EyeOff, Film, Lock, Music, Sticker, Type, Unlock, Volume2, VolumeX, Shapes, Diamond, ArrowRightFromLine } from 'lucide-react';
import { clipEnd, findAsset, projectDuration, type Clip, type Op, type Project, type Track } from './video';

export const LABEL_W = 132;
const ROW_H = 46;

export interface TimeStore { get: () => number; set: (t: number) => void; subscribe: (fn: () => void) => () => void }
export function createTimeStore(): TimeStore {
  let t = 0;
  const subs = new Set<() => void>();
  return { get: () => t, set: (v) => { t = v; subs.forEach((f) => f()); }, subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; } };
}
export const useTime = (store: TimeStore): number => useSyncExternalStore(store.subscribe, store.get);

export const fmtTime = (t: number): string => { const m = Math.floor(t / 60); const s = t - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`; };

const isSoundKind = (k: Clip['kind']): boolean => k === 'audio' || k === 'synth';
const KIND_ICON = { video: Film, image: Film, audio: Music, synth: Music, text: Type, shape: Shapes, sticker: Sticker } as const;

interface DragState { mode: 'move' | 'l' | 'r'; id: string; x0: number; start: number; end: number; trackId: string; moved: boolean; minFrom: number; maxTo: number }

export interface TimelineProps {
  project: Project; selected: string | null; zoom: number; snap: boolean; store: TimeStore;
  onSelect: (id: string | null) => void; onSeek: (t: number) => void;
  beginDrag: () => void; previewOps: (ops: Op[]) => void; endDrag: (label: string, keep: boolean) => void;
  run: (ops: Op[], label: string) => void;
}

function Playhead({ store, zoom, onScrub }: { store: TimeStore; zoom: number; onScrub: (e: ReactPointerEvent<HTMLDivElement>) => void }) {
  const t = useTime(store);
  return (
    <div className="ve-playhead" style={{ left: LABEL_W + t * zoom }} data-testid="playhead">
      <div className="ve-playhead__cap" onPointerDown={onScrub} />
    </div>
  );
}

const ClipView = memo(function ClipView({ clip, track, project, zoom, selected, onDown }: { clip: Clip; track: Track; project: Project; zoom: number; selected: boolean; onDown: (e: ReactPointerEvent<HTMLElement>, clip: Clip, track: Track, mode: DragState['mode']) => void }) {
  const Icon = KIND_ICON[clip.kind];
  const label = clip.text?.text.replace(/\n/g, ' ') || clip.name || (clip.asset ? findAsset(project, clip.asset)?.name : '') || clip.sticker || clip.synth?.preset || clip.shape?.shape || clip.kind;
  const keyCount = Object.values(clip.keyframes).reduce((n, f) => n + (f?.length ?? 0), 0);
  return (
    <div
      role="button" tabIndex={0} aria-label={`${clip.kind} clip ${clip.id}: ${label}`} aria-pressed={selected} data-clip={clip.id}
      className={`ve-clip ve-clip--${clip.kind}${selected ? ' ve-clip--on' : ''}${track.locked ? ' ve-clip--locked' : ''}`}
      style={{ left: clip.start * zoom, width: Math.max(6, clip.duration * zoom) }}
      onPointerDown={(e) => onDown(e, clip, track, 'move')}
      title={`${label} · ${clip.start.toFixed(1)}s → ${clipEnd(clip).toFixed(1)}s`}
    >
      <span className="ve-clip__handle ve-clip__handle--l" data-handle="l" onPointerDown={(e) => onDown(e, clip, track, 'l')} />
      <span className="ve-clip__label"><Icon size={11} /> {label}{clip.speed !== 1 && <em> ×{clip.speed}</em>}</span>
      {clip.transitionIn && <span className="ve-clip__badge" title={`Transition: ${clip.transitionIn.type}`}><ArrowRightFromLine size={10} /></span>}
      {keyCount > 0 && <span className="ve-clip__keys" title={`${keyCount} keyframes`}><Diamond size={8} /> {keyCount}</span>}
      <span className="ve-clip__handle ve-clip__handle--r" data-handle="r" onPointerDown={(e) => onDown(e, clip, track, 'r')} />
    </div>
  );
});

export function Timeline({ project, selected, zoom, snap, store, onSelect, onSeek, beginDrag, previewOps, endDrag, run }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const scrub = useRef(false);
  const dur = Math.max(projectDuration(project), 5);
  const width = (dur + 6) * zoom;
  const rows = [...project.tracks.filter((t) => t.kind === 'video').reverse(), ...project.tracks.filter((t) => t.kind === 'audio')];

  // keep the playhead in view while it moves
  useEffect(() => store.subscribe(() => {
    const box = scrollRef.current;
    if (!box) return;
    const x = LABEL_W + store.get() * zoom;
    if (x > box.scrollLeft + box.clientWidth - 40) box.scrollLeft = x - box.clientWidth + 120;
    else if (x < box.scrollLeft + LABEL_W) box.scrollLeft = Math.max(0, x - LABEL_W - 40);
  }), [store, zoom]);

  const timeAt = (clientX: number): number => {
    const rect = innerRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - LABEL_W) / zoom);
  };
  const snapTime = (t: number, skip: string): number => {
    if (!snap) return Math.round(t * 100) / 100;
    const thr = 8 / zoom;
    const cands = [0, store.get(), ...project.markers.map((m) => m.t)];
    for (const tr of project.tracks) for (const c of tr.clips) if (c.id !== skip) cands.push(c.start, clipEnd(c));
    let best = t, bd = thr;
    for (const c of cands) { const d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } }
    return Math.round(best * 100) / 100;
  };

  const scrubStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    scrub.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(timeAt(e.clientX));
  };
  const scrubMove = (e: ReactPointerEvent<HTMLDivElement>): void => { if (scrub.current) onSeek(timeAt(e.clientX)); };
  const scrubEnd = (): void => { scrub.current = false; };

  const onClipDown = (e: ReactPointerEvent<HTMLElement>, clip: Clip, track: Track, mode: DragState['mode']): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(clip.id);
    if (track.locked) return;
    const asset = clip.asset ? findAsset(project, clip.asset) : undefined;
    const limited = (clip.kind === 'video' || clip.kind === 'audio') && asset && asset.duration > 0;
    drag.current = {
      mode, id: clip.id, x0: e.clientX, start: clip.start, end: clipEnd(clip), trackId: track.id, moved: false,
      minFrom: limited ? clip.start - clip.offset / clip.speed : -Infinity, maxTo: limited ? clip.start + (asset!.duration - clip.offset) / clip.speed : Infinity,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginDrag();
  };
  const onClipMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3 && d.mode !== 'move') { /* still a click */ }
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const dx = (e.clientX - d.x0) / zoom;
    if (d.mode === 'move') {
      const len = d.end - d.start;
      let s = Math.max(0, d.start + dx);
      const a = snapTime(s, d.id), b = snapTime(s + len, d.id) - len;
      s = Math.abs(a - s) <= Math.abs(b - s) ? a : b;
      s = Math.max(0, Math.round(s * 100) / 100);
      const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-track]');
      const target = lane ? project.tracks.find((t) => t.id === lane.dataset.track) : undefined;
      const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.id);
      const ok = target && clip && !target.locked && (target.kind === 'audio') === isSoundKind(clip.kind) && target.id !== d.trackId;
      previewOps([{ op: 'clip_move', clip: d.id, start: s, ...(ok ? { track: target!.id } : {}) }]);
    } else if (d.mode === 'l') {
      const from = Math.min(d.end - 0.1, Math.max(d.minFrom, snapTime(d.start + dx, d.id), 0));
      previewOps([{ op: 'clip_trim', clip: d.id, from, to: d.end }]);
    } else {
      const to = Math.max(d.start + 0.1, Math.min(d.maxTo, snapTime(d.end + dx, d.id)));
      previewOps([{ op: 'clip_trim', clip: d.id, from: d.start, to }]);
    }
  };
  const onClipUp = (): void => {
    const d = drag.current;
    drag.current = null;
    if (d) endDrag(d.mode === 'move' ? 'Move clip' : 'Trim clip', d.moved);
  };

  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s * zoom >= 64) ?? 120;
  const ticks: number[] = [];
  for (let t = 0; t <= dur + 6; t += step) ticks.push(Math.round(t * 100) / 100);

  const toggle = (track: Track, key: 'hidden' | 'muted' | 'locked'): void => run([{ op: 'track_set', track: track.id, [key]: !track[key] }], `Track ${key}`);

  return (
    <div className="ve-tl" ref={scrollRef} aria-label="Timeline" data-testid="timeline">
      <div className="ve-tl__inner" ref={innerRef} style={{ width: LABEL_W + width, minHeight: 24 + rows.length * ROW_H }} onPointerMove={(e) => { scrubMove(e); onClipMove(e); }} onPointerUp={() => { scrubEnd(); onClipUp(); }} onPointerCancel={() => { scrubEnd(); onClipUp(); }}>
        <div className="ve-tl__ruler" onPointerDown={scrubStart} aria-label="Ruler">
          <div className="ve-tl__corner" />
          {ticks.map((t) => <span key={t} className="ve-tick" style={{ left: LABEL_W + t * zoom }}>{step < 1 ? t.toFixed(1) : fmtTime(t).slice(0, 5)}</span>)}
          {project.markers.map((m, i) => <button key={`${m.t}-${i}`} type="button" className="ve-marker" style={{ left: LABEL_W + m.t * zoom }} title={`${m.label || 'marker'} ${m.t}s`} aria-label={`Marker ${m.label || m.t}`} onPointerDown={(e) => { e.stopPropagation(); onSeek(m.t); }} />)}
        </div>
        {rows.map((track) => (
          <div key={track.id} className={`ve-tl__row ve-tl__row--${track.kind}`} style={{ height: ROW_H }}>
            <div className="ve-tl__label">
              <span className="ve-tl__name" title={track.name}>{track.name}</span>
              <span className="ve-tl__tools">
                {track.kind === 'video'
                  ? <button type="button" className="ve-icon ve-icon--tiny" aria-label={`${track.hidden ? 'Show' : 'Hide'} track ${track.name}`} aria-pressed={track.hidden} onClick={() => toggle(track, 'hidden')}>{track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                  : null}
                <button type="button" className="ve-icon ve-icon--tiny" aria-label={`${track.muted ? 'Unmute' : 'Mute'} track ${track.name}`} aria-pressed={track.muted} onClick={() => toggle(track, 'muted')}>{track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>
                <button type="button" className="ve-icon ve-icon--tiny" aria-label={`${track.locked ? 'Unlock' : 'Lock'} track ${track.name}`} aria-pressed={track.locked} onClick={() => toggle(track, 'locked')}>{track.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
              </span>
            </div>
            <div className={`ve-tl__lane${track.hidden ? ' ve-tl__lane--off' : ''}`} data-track={track.id} onPointerDown={(e) => { onSelect(null); scrubStart(e); }}>
              {track.clips.map((clip) => <ClipView key={clip.id} clip={clip} track={track} project={project} zoom={zoom} selected={clip.id === selected} onDown={onClipDown} />)}
            </div>
          </div>
        ))}
        <Playhead store={store} zoom={zoom} onScrub={scrubStart} />
      </div>
    </div>
  );
}
