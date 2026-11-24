import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Check, ChevronDown, ChevronLeft, Clapperboard, Copy, Download, Keyboard, Magnet, Pause, Play, Plus, Redo2, Scissors, SkipBack, SkipForward, Trash2, Undo2, X, ZoomIn, ZoomOut, Maximize2, Film, Flag, Rows3, Volume2, Frame,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import { ASPECTS, VIDEOS_DIR, applyOps, clipEnd, emptyProject, findClip, layersAt, projectDuration, templateProject, type Clip, type Op, type Project, type RenderLayer } from './video';
import { VideoEngine, blobToBase64 } from './videoEngine';
import {
  VIDEO_CHANGED, VIDEO_OPEN, listVideoRefs, loadVideo, registerVideoFlush, removeVideo, saveVideo, setOpenVideo, takePendingOpenVideo, videoPath, type VideoChange, type VideoOpenRequest,
} from './videoStore';
import { Inspector, MediaPanel, type MediaActions, type MediaTab } from './VideoPanels';
import { Timeline, createTimeStore, fmtTime, useTime, type TimeStore } from './VideoTimeline';
import { ExportDialog, NewVideoDialog, type ExportState, type NewKind } from './VideoDialogs';
import './VideoScreen.css';

const LAST_KEY = 'pigry:video-last';
const SAVE_DELAY = 900;
const HISTORY_LIMIT = 80;
const MAX_IMPORT = 400 * 1024 * 1024;

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Playback', items: [{ keys: 'Space', label: 'Play / pause' }, { keys: '← / →', label: 'Step one frame' }, { keys: 'Shift+← / →', label: 'Jump one second' }, { keys: 'Home / End', label: 'Go to the start / end' }] },
  { title: 'Editing', items: [{ keys: 'S', label: 'Split the selected clip at the playhead' }, { keys: 'Delete', label: 'Delete the selected clip' }, { keys: 'Shift+Delete', label: 'Delete and close the gap' }, { keys: 'Ctrl+D', label: 'Duplicate' }, { keys: 'M', label: 'Add a marker at the playhead' }] },
  { title: 'General', items: [{ keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+S', label: 'Save now' }, { keys: '+ / −', label: 'Zoom the timeline' }, { keys: 'Esc', label: 'Deselect / close' }, { keys: '?', label: 'This list' }] },
  { title: 'Preview', items: [{ keys: 'Click', label: 'Select the clip under the pointer' }, { keys: 'Drag', label: 'Move the selected clip on the canvas' }] },
];

interface MenuEntry { label?: string; keys?: string; onSelect?: () => void; disabled?: boolean; separator?: boolean; checked?: boolean }
interface HistoryEntry { project: Project; label: string; merge?: string; t: number }
interface Box { cx: number; cy: number; w: number; h: number; rot: number }

/** The on-canvas rectangle of a layer, in fractions of the canvas (centre offset from the middle, size). */
function layerBox(layer: RenderLayer, project: Project): Box {
  const c = layer.clip, W = project.width, H = project.height;
  let w = 1, h = 1;
  if (c.kind === 'shape' && c.shape) { w = c.shape.w; h = c.shape.h; }
  else if (c.kind === 'sticker') { h = 0.2; w = (h * H) / W; }
  else if (c.kind === 'text' && c.text) {
    const size = c.text.size / 100, longest = Math.max(...c.text.text.split('\n').map((l) => l.length), 1);
    const natural = longest * size * 0.55 * (H / W);
    w = Math.min(c.text.width, natural) + 0.02;
    const lines = Math.max(c.text.text.split('\n').length, Math.ceil(natural / c.text.width));
    h = lines * size * c.text.lineHeight + 0.01;
  } else if (c.kind === 'video' || c.kind === 'image') {
    const a = project.assets.find((x) => x.id === c.asset);
    if (a && a.width > 0 && a.height > 0) { const k = c.fit === 'cover' ? Math.max(W / a.width, H / a.height) : Math.min(W / a.width, H / a.height); w = (a.width * k) / W; h = (a.height * k) / H; }
  }
  return { cx: layer.x, cy: layer.y, w: w * layer.scale, h: h * layer.scale, rot: layer.rotation };
}
function hit(box: Box, fx: number, fy: number, project: Project): boolean {
  const px = (fx - box.cx) * project.width, py = (fy - box.cy) * project.height, a = (-box.rot * Math.PI) / 180;
  const rx = px * Math.cos(a) - py * Math.sin(a), ry = px * Math.sin(a) + py * Math.cos(a);
  return Math.abs(rx) <= (box.w * project.width) / 2 && Math.abs(ry) <= (box.h * project.height) / 2;
}

/** Where an imported file is kept in the workspace (the backend only accepts paths under .pigry/). */
const mediaPath = (name: string): string => `${VIDEOS_DIR}media/${Date.now().toString(36)}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;

function TimeLabel({ store, total }: { store: TimeStore; total: number }) {
  const t = useTime(store);
  return <span className="ve-time" aria-label="Playhead time" data-testid="time">{fmtTime(t)} <i>/</i> {fmtTime(total)}</span>;
}

function SelectionBox({ project, selected, store, stage }: { project: Project; selected: string | null; store: TimeStore; stage: { w: number; h: number } }) {
  const t = useTime(store);
  if (!selected) return null;
  const layer = layersAt(project, t).find((l) => l.clip.id === selected && !l.outgoing);
  if (!layer) return null;
  const b = layerBox(layer, project);
  return <div className="ve-selbox" aria-hidden style={{ left: stage.w / 2 + b.cx * stage.w - (b.w * stage.w) / 2, top: stage.h / 2 + b.cy * stage.h - (b.h * stage.h) / 2, width: b.w * stage.w, height: b.h * stage.h, transform: `rotate(${b.rot}deg)` }} />;
}

export function VideoScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<MediaTab>('media');
  const [zoom, setZoom] = useState(60);
  const [snap, setSnap] = useState(true);
  const [safe, setSafe] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'new' | 'export'>(null);
  const [exp, setExp] = useState<ExportState>({ busy: false, progress: 0, message: '' });
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);
  const [timeStore] = useState(createTimeStore);

  const projectRef = useRef<Project | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const dragBase = useRef<Project | null>(null);
  const engineRef = useRef<VideoEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasDrag = useRef<{ id: string; x0: number; y0: number; cx: number; cy: number; moved: boolean } | null>(null);

  const syncHist = (): void => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key, ['.video.json']);
    return { owner: owner ?? USER_OWNER, slug };
  };

  /* ---------- persistence ---------- */

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current), p = projectRef.current;
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !p || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try { await saveVideo(ref, p, 'editor'); setDirty(dirtyRef.current); }
    catch (error) { dirtyRef.current = true; notify(`Could not save the video: ${String(error)}`, 'error'); }
    finally { setSaving(false); }
  }, [notify]);
  useEffect(() => registerVideoFlush(saveNow), [saveNow]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  useEffect(() => () => {
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const ref = refOf(currentRef.current), p = projectRef.current;
    if (dirtyRef.current && ref && p) void saveVideo(ref, p, 'editor');
  }, []);

  const openVideo = useCallback(async (key: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { project: loaded, warnings } = await loadVideo(ref);
      undoStack.current = []; redoStack.current = []; dragBase.current = null;
      projectRef.current = loaded;
      const nextKey = refKey(ref);
      currentRef.current = nextKey;
      dirtyRef.current = false;
      setDirty(false); setProject(loaded); setCurrent(nextKey); setSelected(null); setPlaying(false);
      timeStore.set(0);
      syncHist();
      setOpenVideo(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Video opened with ${warnings.length} repaired issue(s).`);
    } catch (error) { notify(`Could not open "${key}": ${String(error)}`, 'error'); }
  }, [saveNow, notify, timeStore]);

  const refreshList = useCallback(async () => { try { setRefs(await listVideoRefs()); } catch { setRefs([]); } }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listVideoRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: VideoOpenRequest | null = takePendingOpenVideo();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openVideo(refKey(found));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<VideoChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setProject(null); projectRef.current = null; setOpenVideo(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openVideo(change.key); }
    };
    const onOpen = (event: Event) => { const request = (event as CustomEvent<VideoOpenRequest>).detail; takePendingOpenVideo(); void openVideo(request.key); };
    window.addEventListener(VIDEO_CHANGED, onChanged);
    window.addEventListener(VIDEO_OPEN, onOpen);
    return () => { window.removeEventListener(VIDEO_CHANGED, onChanged); window.removeEventListener(VIDEO_OPEN, onOpen); };
  }, [openVideo, refreshList]);

  /* ---------- engine ---------- */

  const patchAsset = useCallback((id: string, meta: { duration: number; width: number; height: number }) => {
    const p = projectRef.current;
    if (!p) return;
    let changed = false;
    const assets = p.assets.map((a) => {
      if (a.id !== id) return a;
      const next = { ...a, duration: meta.duration || a.duration, width: meta.width || a.width, height: meta.height || a.height };
      if (next.duration !== a.duration || next.width !== a.width || next.height !== a.height) changed = true;
      return next;
    });
    if (!changed) return;
    const next = { ...p, assets };
    projectRef.current = next;
    setProject(next);
    markDirty();
  }, [markDirty]);

  useEffect(() => {
    const canvas = canvasRef.current, p = projectRef.current;
    if (!current || !canvas || !p) return;
    const engine = new VideoEngine(p, canvas);
    engineRef.current = engine;
    engine.onTime = (t) => timeStore.set(t);
    engine.onState = (on) => setPlaying(on);
    engine.onMeta = patchAsset;
    void engine.loadAssets().then(() => engine.seek(timeStore.get(), false));
    return () => { engine.dispose(); engineRef.current = null; };
  }, [current, patchAsset, timeStore]);

  useEffect(() => { engineRef.current?.setProject(project ?? emptyProject()); }, [project]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const ar = (projectRef.current?.width ?? 9) / (projectRef.current?.height ?? 16);
      const cw = Math.max(10, el.clientWidth - 24), ch = Math.max(10, el.clientHeight - 24);
      setStage(cw / ch > ar ? { w: Math.floor(ch * ar), h: Math.floor(ch) } : { w: Math.floor(cw), h: Math.floor(cw / ar) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [current, project?.width, project?.height]);

  /* ---------- editing with undo ---------- */

  const commit = useCallback((next: Project, label: string, merge?: string): void => {
    const prev = projectRef.current;
    if (!prev) return;
    const last = undoStack.current[undoStack.current.length - 1];
    if (merge && last && last.merge === merge && Date.now() - last.t < 900) last.t = Date.now();
    else { undoStack.current.push({ project: prev, label, merge, t: Date.now() }); if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift(); }
    redoStack.current = [];
    projectRef.current = next;
    setProject(next);
    syncHist();
    markDirty();
  }, [markDirty]);

  /** Applies operations; returns the id of the clip the last clip_add/split/duplicate/captions made. */
  const run = useCallback((ops: Op[], label: string, merge?: string): string | null => {
    const p = projectRef.current;
    if (!p) return null;
    const result = applyOps(p, ops);
    if (result.error) { notify(result.error, 'error'); return null; }
    commit(result.project, label, merge);
    return result.created ?? '';
  }, [commit, notify]);

  const swapTo = (target: HistoryEntry, to: HistoryEntry[]): void => {
    const now = projectRef.current;
    if (!now) return;
    to.push({ project: now, label: target.label, t: 0 });
    projectRef.current = target.project;
    setProject(target.project);
    setSelected((s) => (s && findClip(target.project, s) ? s : null));
    syncHist();
    markDirty();
  };
  const undo = (): void => { const e = undoStack.current.pop(); if (e) swapTo(e, redoStack.current); };
  const redo = (): void => { const e = redoStack.current.pop(); if (e) swapTo(e, undoStack.current); };

  const beginDrag = useCallback(() => { dragBase.current = projectRef.current; }, []);
  const previewOps = useCallback((ops: Op[]) => {
    const base = dragBase.current;
    if (!base) return;
    const r = applyOps(base, ops);
    if (r.error) return;
    projectRef.current = r.project;
    setProject(r.project);
  }, []);
  const endDrag = useCallback((label: string, keep: boolean) => {
    const base = dragBase.current;
    dragBase.current = null;
    const now = projectRef.current;
    if (!base || !now || !keep || base === now) return;
    undoStack.current.push({ project: base, label, t: Date.now() });
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    syncHist();
    markDirty();
  }, [markDirty]);

  /* ---------- transport ---------- */

  const seek = useCallback((t: number) => {
    const p = projectRef.current;
    const dur = p ? projectDuration(p) : 0;
    const to = Math.max(0, Math.min(t, Math.max(dur, 0)));
    timeStore.set(to);
    void engineRef.current?.seek(to);
  }, [timeStore]);
  const togglePlay = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    if (e.playing) e.pause(); else { e.time = timeStore.get(); e.play(); }
  }, [timeStore]);

  /* ---------- clip commands ---------- */

  const clip: Clip | null = project && selected ? findClip(project, selected)?.clip ?? null : null;
  const at = (): number => Math.round(timeStore.get() * 100) / 100;
  const addOps = (ops: Op[], label: string): void => { const created = run(ops, label); if (created) setSelected(created); };
  const splitSelected = (): void => {
    if (!clip) return;
    const t = at();
    if (t <= clip.start + 0.05 || t >= clipEnd(clip) - 0.05) { notify('Move the playhead inside the clip to split it.', 'error'); return; }
    const created = run([{ op: 'clip_split', clip: clip.id, at: t }], 'Split clip');
    if (created) setSelected(created);
  };
  const deleteSelected = (ripple: boolean): void => { if (clip && run([{ op: 'clip_delete', clip: clip.id, ripple }], 'Delete clip') !== null) setSelected(null); };
  const duplicateSelected = (): void => { if (clip) { const created = run([{ op: 'clip_duplicate', clip: clip.id }], 'Duplicate clip'); if (created) setSelected(created); } };

  const importFiles = async (files: FileList): Promise<void> => {
    const ops: Op[] = [];
    for (const file of Array.from(files)) {
      const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : null;
      if (!kind) { notify(`${file.name}: not a video, image or audio file.`, 'error'); continue; }
      if (file.size > MAX_IMPORT) { notify(`${file.name} is larger than 400 MB.`, 'error'); continue; }
      const path = mediaPath(file.name);
      try { await writeWorktreeBinary(path, await blobToBase64(file)); ops.push({ op: 'asset_add', path, name: file.name, kind }); }
      catch (error) { notify(`Could not import ${file.name}: ${String(error)}`, 'error'); }
    }
    if (ops.length) run(ops, 'Import media');
  };
  const addAsset = (id: string): void => {
    const asset = project?.assets.find((a) => a.id === id);
    if (!asset) return;
    addOps([{ op: 'clip_add', asset: id, ...(asset.kind === 'audio' ? { start: at() } : {}) }], `Add ${asset.name}`);
  };
  const mediaActions: MediaActions = {
    importFiles: (files) => { void importFiles(files); },
    addAsset, addOps,
    applyToSelected: (make, label) => { if (clip) run(make(clip), label); },
    playhead: () => timeStore.get(),
  };

  /* ---------- project files ---------- */

  const newVideo = async (name: string, kind: NewKind, aspect: string): Promise<void> => {
    const base = nameSlug(name || (kind === 'promo' ? 'promo' : kind === 'title' ? 'title-card' : 'video'));
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    await saveNow();
    try {
      const title = name.trim() || (kind === 'promo' ? 'Motion promo' : kind === 'title' ? 'Title card' : 'Untitled video');
      let p = kind === 'blank' ? emptyProject(title, aspect) : templateProject(kind, title);
      const a = ASPECTS[aspect];
      if (kind !== 'blank' && a) p = { ...p, width: a.w, height: a.h };
      await saveVideo({ owner: USER_OWNER, slug }, p, 'editor');
      setDialog(null);
      await refreshList();
      await openVideo(`${USER_OWNER}/${slug}`);
    } catch (error) { notify(`Could not create the video: ${String(error)}`, 'error'); }
  };

  const deleteFile = async (key: string): Promise<void> => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); }
      await removeVideo(ref);
      const rest = await listVideoRefs();
      setRefs(rest);
      if (key === currentRef.current) { if (rest[0]) await openVideo(refKey(rest[0])); else { setCurrent(null); setProject(null); projectRef.current = null; setOpenVideo(null); } }
    } catch (error) { notify(`Could not delete the video: ${String(error)}`, 'error'); }
  };

  /* ---------- export ---------- */

  const download = (blob: Blob, name: string): void => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const exportWebm = async (save: boolean): Promise<void> => {
    const ref = refOf(current), p = projectRef.current;
    if (!ref || !p || exp.busy) return;
    engineRef.current?.pause();
    await saveNow();
    setExp({ busy: true, progress: 0, message: 'Recording…' });
    const engine = new VideoEngine(structuredClone(p));
    try {
      await engine.loadAssets();
      const blob = await engine.exportWebM((f) => setExp((s) => ({ ...s, progress: f })));
      const path = videoPath(ref).replace(/\.video\.json$/, '.webm');
      await writeWorktreeBinary(path, await blobToBase64(blob));
      if (save) download(blob, `${nameSlug(p.title) || 'video'}.webm`);
      setExp({ busy: false, progress: 1, message: `Saved ${path} (${(blob.size / 1_000_000).toFixed(1)} MB).` });
    } catch (error) { setExp({ busy: false, progress: 0, message: `Could not export: ${error instanceof Error ? error.message : String(error)}` }); }
    finally { engine.dispose(); }
  };
  const exportFrame = async (save: boolean): Promise<void> => {
    const ref = refOf(current), p = projectRef.current;
    if (!ref || !p || exp.busy) return;
    setExp({ busy: true, progress: 0, message: 'Rendering the frame…' });
    const engine = new VideoEngine(structuredClone(p));
    try {
      const url = await engine.still(Math.min(timeStore.get(), Math.max(0, projectDuration(p) - 0.01)));
      const path = videoPath(ref).replace(/\.video\.json$/, '.png');
      await writeWorktreeBinary(path, url.slice(url.indexOf(',') + 1));
      if (save) download(await (await fetch(url)).blob(), `${nameSlug(p.title) || 'frame'}.png`);
      setExp({ busy: false, progress: 1, message: `Saved ${path}.` });
    } catch (error) { setExp({ busy: false, progress: 0, message: `Could not export: ${error instanceof Error ? error.message : String(error)}` }); }
    finally { engine.dispose(); }
  };

  /* ---------- canvas pointer ---------- */

  const onCanvasDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const p = projectRef.current;
    if (!p || !stage.w) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width - 0.5, fy = (e.clientY - rect.top) / rect.height - 0.5;
    const layers = layersAt(p, timeStore.get()).filter((l) => !l.outgoing).reverse();
    const found = layers.find((l) => hit(layerBox(l, p), fx, fy, p));
    if (!found) { setSelected(null); return; }
    setSelected(found.clip.id);
    if (p.tracks.find((t) => t.clips.includes(found.clip))?.locked) return;
    canvasDrag.current = { id: found.clip.id, x0: e.clientX, y0: e.clientY, cx: found.clip.x, cy: found.clip.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    beginDrag();
  };
  const onCanvasMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = canvasDrag.current;
    if (!d || !stage.w) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
    d.moved = true;
    previewOps([{ op: 'clip_set', clip: d.id, x: d.cx + (e.clientX - d.x0) / stage.w, y: d.cy + (e.clientY - d.y0) / stage.h }]);
  };
  const onCanvasUp = (): void => { const d = canvasDrag.current; canvasDrag.current = null; if (d) endDrag('Move on canvas', d.moved); };

  /* ---------- menus and keys ---------- */

  const has = !!project;
  const total = project ? projectDuration(project) : 0;
  const fitZoom = (): void => { const w = document.querySelector('.ve-tl')?.clientWidth ?? 800; setZoom(Math.max(12, Math.min(240, Math.floor((w - 190) / Math.max(total, 5))))); };
  /* The callbacks below only run when a menu item is clicked, never while rendering. */
  /* eslint-disable react-hooks/refs */
  const menus = (): Record<string, MenuEntry[]> => ({
    File: [
      { label: 'New video…', onSelect: () => setDialog('new') },
      { label: 'Save', keys: 'Ctrl+S', onSelect: () => void saveNow(), disabled: !has },
      { separator: true },
      { label: 'Export…', onSelect: () => { setExp({ busy: false, progress: 0, message: '' }); setDialog('export'); }, disabled: !has || total <= 0 },
    ],
    Edit: [
      { label: 'Undo', keys: 'Ctrl+Z', onSelect: undo, disabled: hist.undo === 0 },
      { label: 'Redo', keys: 'Ctrl+Y', onSelect: redo, disabled: hist.redo === 0 },
      { separator: true },
      { label: 'Split at playhead', keys: 'S', onSelect: splitSelected, disabled: !clip },
      { label: 'Duplicate', keys: 'Ctrl+D', onSelect: duplicateSelected, disabled: !clip },
      { label: 'Delete', keys: 'Delete', onSelect: () => deleteSelected(false), disabled: !clip },
      { label: 'Delete and close the gap', keys: 'Shift+Delete', onSelect: () => deleteSelected(true), disabled: !clip },
      { separator: true },
      { label: 'Add marker', keys: 'M', onSelect: () => run([{ op: 'marker_add', t: at() }], 'Add marker'), disabled: !has },
    ],
    View: [
      { label: 'Snapping', checked: snap, onSelect: () => setSnap((s) => !s) },
      { label: 'Caption safe zone', checked: safe, onSelect: () => setSafe((s) => !s) },
      { separator: true },
      { label: 'Zoom in', keys: '+', onSelect: () => setZoom((z) => Math.min(300, z * 1.4)) },
      { label: 'Zoom out', keys: '−', onSelect: () => setZoom((z) => Math.max(8, z / 1.4)) },
      { label: 'Fit the timeline', onSelect: fitZoom },
      { separator: true },
      { label: 'Keyboard shortcuts', keys: '?', onSelect: () => setHelpOpen(true) },
    ],
  });
  /* eslint-enable react-hooks/refs */

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    const act = (fn: () => void): void => { e.preventDefault(); fn(); };
    if (ctrl && key === 's') return act(() => void saveNow());
    if (typing) return;
    if (ctrl && key === 'z' && !e.shiftKey) return act(undo);
    if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) return act(redo);
    if (ctrl && key === 'd') return act(duplicateSelected);
    if (e.key === 'Escape') { setMenu(null); setHelpOpen(false); setSelected(null); return; }
    if (ctrl || e.altKey) return;
    if (e.key === ' ') return act(togglePlay);
    if (e.key === 'Delete' || e.key === 'Backspace') return act(() => deleteSelected(e.shiftKey));
    if (e.key === 'ArrowLeft') return act(() => seek(timeStore.get() - (e.shiftKey ? 1 : 1 / (project?.fps ?? 30))));
    if (e.key === 'ArrowRight') return act(() => seek(timeStore.get() + (e.shiftKey ? 1 : 1 / (project?.fps ?? 30))));
    if (e.key === 'Home') return act(() => seek(0));
    if (e.key === 'End') return act(() => seek(total));
    if (e.key === '?') return act(() => setHelpOpen(true));
    if (e.key === '+' || e.key === '=') return act(() => setZoom((z) => Math.min(300, z * 1.4)));
    if (e.key === '-') return act(() => setZoom((z) => Math.max(8, z / 1.4)));
    if (key === 's') return act(splitSelected);
    if (key === 'm') return act(() => { run([{ op: 'marker_add', t: at() }], 'Add marker'); });
  };

  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  const menuDefs = menus();
  const aspectKey = project ? Object.entries(ASPECTS).find(([, a]) => a.w === project.width && a.h === project.height)?.[0] ?? 'custom' : '9:16';

  return (
    <div className="screen ve">
      <header className="screen-header">
        <h1 className="screen-header__title">Video Editor</h1>
        <span className="screen-header__meta">CapCut-style timeline editing — the Video Editor agent builds on the same project</span>
        {current && <span className={`ve__save ve__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="ve__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={filesOpen} onClick={() => setFilesOpen((o) => !o)}>
            <Film size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Videos'} <ChevronDown size={11} />
          </button>
          {filesOpen && (
            <div className="ve__popup ve__popup--list" role="menu" aria-label="Videos">
              {refs.length === 0 && <p className="ve-note ve-pad">No videos yet — create one, or ask the Video Editor agent.</p>}
              {grouped.map(([owner, list]) => (
                <div key={owner}>
                  <div className="ve__owner">{owner}</div>
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`ve__file${key === current ? ' ve__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="ve__file-main" title={videoPath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openVideo(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="ve-icon ve-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteFile(key)}><Check size={12} /></button>
                            <button type="button" className="ve-icon" aria-label="Keep video" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : <button type="button" className="ve-icon ve__file-del" aria-label={`Delete ${ref.slug}`} title="Delete video" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="secondary-button" onClick={() => setDialog('new')}><Plus size={12} strokeWidth={1.5} /> New video</button>
        <button type="button" className="primary-button" disabled={!has || total <= 0} onClick={() => { setExp({ busy: false, progress: 0, message: '' }); setDialog('export'); }}><Download size={12} strokeWidth={1.5} /> Export</button>
      </header>

      <div className="screen-body ve__body">
        <div className="ve__main" onKeyDown={onKeyDown}>
          <nav className="ve__menubar" aria-label="Video menu">
            {/* eslint-disable-next-line react-hooks/refs */}
            {Object.entries(menuDefs).map(([name, entries]) => (
              <div key={name} className="ve__menu">
                <button type="button" className={`ve__menu-btn${menu === name ? ' ve__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => { if (menu) setMenu(name); }}>{name}</button>
                {menu === name && (
                  <div className="ve__popup" role="menu" aria-label={name}>
                    {entries.map((entry, i) => entry.separator ? <hr key={i} /> : (
                      <button key={i} type="button" role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} disabled={entry.disabled} onClick={() => { setMenu(null); entry.onSelect?.(); }}>
                        <span>{entry.checked !== undefined && <Check size={11} style={{ opacity: entry.checked ? 1 : 0 }} />} {entry.label}</span>
                        {entry.keys && <kbd>{entry.keys}</kbd>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <span className="ve-grow" />
            <button type="button" className="ve-icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={hist.undo === 0} onClick={undo}><Undo2 size={14} /></button>
            <button type="button" className="ve-icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={hist.redo === 0} onClick={redo}><Redo2 size={14} /></button>
            <button type="button" className="ve-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
          </nav>

          {project ? (
            <div className="ve__work" tabIndex={0} aria-label="Video editor">
              <div className="ve__top">
                <MediaPanel project={project} tab={tab} setTab={setTab} selected={clip} actions={mediaActions} />
                <section className="ve__player" aria-label="Player">
                  <div className="ve__stage" ref={stageRef}>
                    <div className="ve__canvas-box" style={{ width: stage.w, height: stage.h }} onPointerDown={onCanvasDown} onPointerMove={onCanvasMove} onPointerUp={onCanvasUp} onPointerCancel={onCanvasUp} data-testid="stage">
                      <canvas ref={canvasRef} className="ve__canvas" aria-label="Video preview" data-testid="preview" />
                      <SelectionBox project={project} selected={selected} store={timeStore} stage={stage} />
                      {safe && <div className={`ve__safe${project.height > project.width ? ' ve__safe--tall' : ''}`} aria-hidden />}
                    </div>
                  </div>
                  <div className="ve__transport" role="toolbar" aria-label="Playback">
                    <TimeLabel store={timeStore} total={total} />
                    <span className="ve-grow" />
                    <button type="button" className="ve-icon" aria-label="Go to start" title="Start (Home)" onClick={() => seek(0)}><SkipBack size={15} /></button>
                    <button type="button" className="ve-icon ve-icon--play" aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)" disabled={total <= 0} onClick={togglePlay}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
                    <button type="button" className="ve-icon" aria-label="Go to end" title="End" onClick={() => seek(total)}><SkipForward size={15} /></button>
                    <span className="ve-grow" />
                    <select className="ve-select" aria-label="Canvas ratio" value={aspectKey} onChange={(e) => { if (e.target.value !== 'custom') run([{ op: 'project', aspect: e.target.value }], `Ratio ${e.target.value}`); }}>
                      {Object.entries(ASPECTS).map(([k, a]) => <option key={k} value={k}>{k} · {a.label}</option>)}
                      {aspectKey === 'custom' && <option value="custom">{project.width}×{project.height}</option>}
                    </select>
                    <button type="button" className={`ve-icon${safe ? ' ve-icon--on' : ''}`} aria-label="Caption safe zone" aria-pressed={safe} title="Show the caption safe zone" onClick={() => setSafe((s) => !s)}><Frame size={14} /></button>
                  </div>
                </section>
                <aside className="ve__right" aria-label="Properties">
                  <Inspector project={project} clip={clip} run={(ops, label, merge) => { run(ops, label, merge); }} key={clip?.id ?? 'project'} timeStore={timeStore} />
                </aside>
              </div>

              <div className="ve__bottom">
                <div className="ve__tools" role="toolbar" aria-label="Timeline tools">
                  <button type="button" className="ve-tool" disabled={!clip} onClick={splitSelected} title="Split at the playhead (S)"><Scissors size={13} /> Split</button>
                  <button type="button" className="ve-tool" disabled={!clip} onClick={duplicateSelected} title="Duplicate (Ctrl+D)"><Copy size={13} /> Duplicate</button>
                  <button type="button" className="ve-tool" disabled={!clip} onClick={() => deleteSelected(false)} title="Delete (Del)"><Trash2 size={13} /> Delete</button>
                  <span className="ve__sep" />
                  <button type="button" className="ve-tool" onClick={() => run([{ op: 'marker_add', t: at() }], 'Add marker')} title="Marker (M)"><Flag size={13} /> Marker</button>
                  <button type="button" className="ve-tool" onClick={() => run([{ op: 'track_add', kind: 'video', name: 'Layer' }], 'Add video track')} title="Add a video track on top"><Rows3 size={13} /> Video track</button>
                  <button type="button" className="ve-tool" onClick={() => run([{ op: 'track_add', kind: 'audio', name: 'Audio' }], 'Add audio track')} title="Add an audio track"><Volume2 size={13} /> Audio track</button>
                  <span className="ve-grow" />
                  <button type="button" className={`ve-tool${snap ? ' ve-tool--on' : ''}`} aria-pressed={snap} onClick={() => setSnap((s) => !s)} title="Snap to clips, markers and the playhead"><Magnet size={13} /> Snap</button>
                  <button type="button" className="ve-icon" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(8, z / 1.4))}><ZoomOut size={14} /></button>
                  <button type="button" className="ve-icon" aria-label="Fit timeline" onClick={fitZoom}><Maximize2 size={13} /></button>
                  <button type="button" className="ve-icon" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(300, z * 1.4))}><ZoomIn size={14} /></button>
                </div>
                <Timeline project={project} selected={selected} zoom={zoom} snap={snap} store={timeStore} onSelect={setSelected} onSeek={seek} beginDrag={beginDrag} previewOps={previewOps} endDrag={endDrag} run={(ops, label) => { run(ops, label); }} />
              </div>
            </div>
          ) : (
            <div className="ve__welcome">
              <Clapperboard size={34} strokeWidth={1.25} />
              <h2>Video Editor</h2>
              <p>Cut, layer and animate video the CapCut way: a multi-track timeline, text and captions, stickers, filters, effects, transitions, keyframes and music — all in the browser. Start from a motion promo or a blank canvas, import your own footage, or ask the Video Editor agent to build one.</p>
              <button type="button" className="primary-button" onClick={() => setDialog('new')}><Plus size={12} strokeWidth={1.5} /> New video</button>
            </div>
          )}
          {helpOpen && <ShortcutHelp title="Video Editor shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
        </div>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('videoeditor')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {dialog === 'new' && <NewVideoDialog onCreate={(n, k, a) => void newVideo(n, k, a)} onClose={() => setDialog(null)} />}
      {dialog === 'export' && project && <ExportDialog project={project} state={exp} onWebm={(d) => void exportWebm(d)} onFrame={(d) => void exportFrame(d)} onClose={() => setDialog(null)} />}
    </div>
  );
}
