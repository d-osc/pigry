import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AudioLines, Check, ChevronDown, ChevronLeft, Circle, ClipboardPaste, Copy, Crop, Download, History, Keyboard, MoveHorizontal, MousePointer2, Pause, Play, Plus, Redo2, Repeat, Scissors, SkipBack, SkipForward, Square, Tag, Trash2, Undo2, Upload, VolumeX, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinaryChunked } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import {
  AUDIO_DIR, FX, MEDIA_DIR, SAMPLE_RATES, applyOps, clipEnd, emptyProject, extractRange, findClip, formatInfo, projectDuration, templateOps, type Clip, type GenSpec, type Op, type Project, type Selection,
} from './audio';
import { analyze, describeAnalysis, encodeWav, findClipping, findSilence } from './audioDsp';
import { AudioEngine, decodeAudioBytes, rememberSource } from './audioEngine';
import {
  AUDIO_CHANGED, AUDIO_OPEN, audioPath, listAudioRefs, loadAudio, registerAudioFlush, removeAudio, saveAudio, setOpenAudio, takePendingOpenAudio, type AudioChange, type AudioOpenRequest,
} from './audioStore';
import { Meter, Timeline, clipAtTime, createStore, fmtTime, useStore, type Store, type Tool } from './AudioTimeline';
import {
  EffectDialog, ExportDialog, GenerateDialog, HistoryDialog, LabelDialog, Modal, NewAudioDialog, SpectrumDialog, TextDialog, type ExportFormat, type ExportState, type NewKind,
} from './AudioDialogs';
import './AudioScreen.css';

const LAST_KEY = 'pigry:audio-last';
const SAVE_DELAY = 900;
const HISTORY_LIMIT = 80;
const MAX_IMPORT = 500 * 1000 * 1000;

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Transport', items: [{ keys: 'Space', label: 'Play / stop' }, { keys: 'Shift+Space', label: 'Loop play the selection' }, { keys: 'P', label: 'Pause (keeps the cursor)' }, { keys: 'R', label: 'Record / stop recording' }, { keys: 'Home / End', label: 'Go to the start / end' }, { keys: '← / →', label: 'Move the cursor 0.1 s (Shift = 1 s)' }] },
  { title: 'Editing', items: [{ keys: 'Ctrl+X / C / V', label: 'Cut / copy / paste' }, { keys: 'Delete', label: 'Delete the selection and close the gap' }, { keys: 'Ctrl+L', label: 'Silence the selection' }, { keys: 'Ctrl+T', label: 'Trim to the selection' }, { keys: 'Ctrl+I', label: 'Split at the cursor / selection' }, { keys: 'Ctrl+D', label: 'Duplicate the selection' }, { keys: 'Ctrl+B', label: 'Add a label' }, { keys: 'Ctrl+R', label: 'Repeat the last effect' }] },
  { title: 'Selection and view', items: [{ keys: 'Ctrl+A', label: 'Select all' }, { keys: 'Esc', label: 'Clear the selection' }, { keys: '+ / −', label: 'Zoom in / out' }, { keys: 'F1 / F2 / F3 / F4', label: 'Selection / Envelope / Zoom / Time shift tool' }] },
  { title: 'General', items: [{ keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+S', label: 'Save now' }, { keys: '?', label: 'This list' }] },
];

interface MenuEntry { label?: string; keys?: string; onSelect?: () => void; disabled?: boolean; separator?: boolean; checked?: boolean; heading?: boolean }
interface HistoryEntry { project: Project; label: string; merge?: string; t: number }
type Dialog = null | { kind: 'new' } | { kind: 'export' } | { kind: 'effect'; effect: string } | { kind: 'gen'; type: GenSpec['type'] } | { kind: 'text'; title: string; text: string }
  | { kind: 'spectrum'; samples: Float32Array } | { kind: 'history'; entries: string[] } | { kind: 'label'; id: string } | { kind: 'value'; what: 'speed' | 'tempo' | 'pitch' };

/** Copy / paste buffer shared by every project in this window. */
let clipboard: Clip[] = [];
const setClipboard = (clips: Clip[]): void => { clipboard = clips; };

const mediaPath = (name: string): string => `${MEDIA_DIR}${Date.now().toString(36)}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function TimeLabel({ store, total }: { store: Store<number>; total: number }) {
  const t = useStore(store);
  return <span className="au-time" aria-label="Cursor time" data-testid="time">{fmtTime(t)} <i>/</i> {fmtTime(total)}</span>;
}

function ValueDialog({ what, onApply, onClose }: { what: 'speed' | 'tempo' | 'pitch'; onApply: (v: number) => void; onClose: () => void }) {
  const cfg = { speed: { title: 'Change speed', label: 'Speed factor (2 = twice as fast and an octave higher)', def: 1.25, step: 0.05 }, tempo: { title: 'Change tempo', label: 'Tempo factor (0.8 = 20% slower, same pitch)', def: 0.9, step: 0.05 }, pitch: { title: 'Change pitch', label: 'Semitones (12 = one octave up, same length)', def: 2, step: 1 } }[what];
  const [v, setV] = useState(cfg.def);
  return (
    <Modal title={cfg.title} okLabel="Apply" onClose={onClose} onOk={() => onApply(v)}>
      <label className="au-field">{cfg.label}<input className="au-input" type="number" aria-label="Value" step={cfg.step} value={v} onChange={(e) => setV(Number(e.target.value))} /></label>
      <p className="au-note">Applies to the selection (or everything when nothing is selected). {what === 'speed' ? 'Resamples, like Audacity ▸ Change Speed.' : 'Uses overlap-add time stretching: speech is fine, large changes on music sound processed.'}</p>
    </Modal>
  );
}

export function AudioScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [clipId, setClipId] = useState<string | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pps, setPps] = useState(80);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [loop, setLoop] = useState(false);
  const [showClipping, setShowClipping] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [exp, setExp] = useState<ExportState>({ busy: false, progress: 0, message: '' });
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [rev, setRev] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [noiseProfile, setNoiseProfile] = useState<{ from: number; to: number } | null>(null);
  const [lastEffect, setLastEffect] = useState<{ effect: string; params: Record<string, unknown> } | null>(null);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);
  const [timeStore] = useState(() => createStore(0));
  const [meterStore] = useState(() => createStore({ l: 0, r: 0 }));
  const [engine] = useState(() => new AudioEngine(emptyProject()));

  const projectRef = useRef<Project | null>(null);
  const currentRef = useRef<string | null>(null);
  const selRef = useRef<Selection | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const dragBase = useRef<Project | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const recordStart = useRef(0);

  const syncHist = (): void => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key, ['.audio.json']);
    return { owner: owner ?? USER_OWNER, slug };
  };
  const changeSelection = useCallback((s: Selection | null) => { selRef.current = s; setSelection(s); }, []);

  /* ---------- persistence ---------- */

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current), p = projectRef.current;
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !p || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try { await saveAudio(ref, p, 'editor'); setDirty(dirtyRef.current); }
    catch (error) { dirtyRef.current = true; notify(`Could not save the audio project: ${String(error)}`, 'error'); }
    finally { setSaving(false); }
  }, [notify]);
  useEffect(() => registerAudioFlush(saveNow), [saveNow]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  useEffect(() => () => {
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const ref = refOf(currentRef.current), p = projectRef.current;
    if (dirtyRef.current && ref && p) void saveAudio(ref, p, 'editor');
  }, []);

  const openAudio = useCallback(async (key: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { project: loaded, warnings } = await loadAudio(ref);
      undoStack.current = []; redoStack.current = []; dragBase.current = null;
      projectRef.current = loaded;
      const nextKey = refKey(ref);
      currentRef.current = nextKey;
      dirtyRef.current = false;
      engine.stop();
      setDirty(false); setProject(loaded); setCurrent(nextKey); setClipId(null); setTrackId(loaded.tracks[0]?.id ?? null); setPlaying(false);
      changeSelection(loaded.selection);
      timeStore.set(0);
      syncHist();
      setOpenAudio(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Project opened with ${warnings.length} repaired issue(s).`);
    } catch (error) { notify(`Could not open "${key}": ${String(error)}`, 'error'); }
  }, [saveNow, notify, timeStore, engine, changeSelection]);

  const refreshList = useCallback(async () => { try { setRefs(await listAudioRefs()); } catch { setRefs([]); } }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listAudioRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: AudioOpenRequest | null = takePendingOpenAudio();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openAudio(refKey(found));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<AudioChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setProject(null); projectRef.current = null; setOpenAudio(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openAudio(change.key); }
    };
    const onOpen = (event: Event) => { const request = (event as CustomEvent<AudioOpenRequest>).detail; takePendingOpenAudio(); void openAudio(request.key); };
    window.addEventListener(AUDIO_CHANGED, onChanged);
    window.addEventListener(AUDIO_OPEN, onOpen);
    return () => { window.removeEventListener(AUDIO_CHANGED, onChanged); window.removeEventListener(AUDIO_OPEN, onOpen); };
  }, [openAudio, refreshList]);

  /* ---------- engine ---------- */

  const patchAsset = useCallback((id: string, meta: { duration: number; sampleRate: number; channels: number }) => {
    const p = projectRef.current;
    if (!p) return;
    let changed = false;
    const assets = p.assets.map((a) => {
      if (a.id !== id) return a;
      const next = { ...a, ...meta };
      if (next.duration !== a.duration || next.sampleRate !== a.sampleRate || next.channels !== a.channels) changed = true;
      return next;
    });
    if (!changed) return;
    const next = { ...p, assets };
    projectRef.current = next;
    setProject(next);
    markDirty();
  }, [markDirty]);

  useEffect(() => {
    engine.setHandlers({ onTime: (t) => timeStore.set(t), onMeter: (m) => meterStore.set(m), onState: (on) => setPlaying(on) });
    return () => { engine.dispose(); };
  }, [engine, timeStore, meterStore]);

  const assetKey = project ? project.assets.map((a) => `${a.id}:${a.path}`).join('|') : '';
  useEffect(() => {
    const p = projectRef.current;
    if (!p) return;
    engine.setProject(p);
    let cancelled = false;
    void engine.loadAssets(patchAsset).then((missing) => {
      if (cancelled) return;
      if (missing.length) notify(`Could not load: ${missing.join(', ')}`, 'error');
      setRev((r) => r + 1);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, assetKey, engine]);

  useEffect(() => { if (project) engine.setProject(project); }, [project, engine]);

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
    setClipId((s) => (s && findClip(target.project, s) ? s : null));
    syncHist();
    markDirty();
  };
  const undo = (): void => { const e = undoStack.current.pop(); if (e) swapTo(e, redoStack.current); };
  const redo = (): void => { const e = redoStack.current.pop(); if (e) swapTo(e, undoStack.current); };
  const jumpHistory = (index: number): void => { while (undoStack.current.length > index) undo(); };

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

  const total = project ? projectDuration(project) : 0;
  const seek = useCallback((t: number) => {
    const p = projectRef.current;
    const to = Math.max(0, Math.min(t, p ? Math.max(projectDuration(p), 0) + 600 : 0));
    timeStore.set(to);
    if (engine.playing) engine.stop();
  }, [timeStore, engine]);
  const playRange = (): [number, number] => {
    const s = selRef.current, end = projectDuration(projectRef.current ?? emptyProject());
    return s && s.end - s.start > 0.01 ? [s.start, s.end] : [Math.min(timeStore.get(), end), end];
  };
  const play = (looped = loop): void => {
    if (!projectRef.current) return;
    const [from, to] = playRange();
    if (to - from < 0.01) { notify('Nothing to play from here — move the cursor earlier or add sound.', 'error'); return; }
    engine.setProject(projectRef.current);
    setLoop(looped);
    void engine.play(from, to, looped).catch((e) => notify(`Could not play: ${String(e)}`, 'error'));
  };
  const stop = (): void => { const s = selRef.current; engine.stop(); if (s && s.end > s.start) timeStore.set(s.start); };
  const pause = (): void => { const t = engine.position; engine.stop(); timeStore.set(t); };
  const togglePlay = (looped = false): void => { if (engine.playing) stop(); else play(looped); };

  const startStopRecord = async (): Promise<void> => {
    if (!projectRef.current) return;
    if (!engine.recording) {
      try { engine.stop(); recordStart.current = timeStore.get(); await engine.startRecording(); setRecording(true); }
      catch (error) { notify(`Could not record: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
      return;
    }
    setRecording(false);
    try {
      const take = await engine.stopRecording();
      if (!take || take.source.channels[0].length < 100) { notify('Nothing was recorded.', 'error'); return; }
      const wav = encodeWav(take.source.channels, take.source.sampleRate, 32);
      await addAssetClip(`Recording ${new Date().toLocaleTimeString()}`.replace(/[:]/g, '-') + '.wav', wav, take.source, recordStart.current);
    } catch (error) { notify(`Could not finish the recording: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
  };

  /* ---------- import ---------- */

  /** Registers decoded media as an asset and puts it on a new track at `at`. */
  const addAssetClip = async (name: string, bytes: Uint8Array, source: { sampleRate: number; channels: Float32Array[] }, at = 0): Promise<void> => {
    const p = projectRef.current;
    if (!p) return;
    const path = mediaPath(name);
    setExp({ busy: true, progress: 0, message: `Copying ${name} into the workspace…` });
    try { await writeWorktreeBinaryChunked(path, bytes, (f) => setExp((o) => ({ ...o, progress: f }))); } finally { setExp({ busy: false, progress: 0, message: '' }); }
    rememberSource(path, source);
    const duration = r3(source.channels[0].length / source.sampleRate), channels = source.channels.length;
    const added = applyOps(p, [{ op: 'asset_add', path, name, duration, sampleRate: source.sampleRate, channels }]);
    const assetId = added.project.assets[added.project.assets.length - 1]?.id;
    const next = applyOps(added.project, [{ op: 'track_add', kind: channels === 1 ? 'mono' : 'stereo', name: name.replace(/\.[^.]+$/, '').slice(0, 30) }]);
    const track = next.project.tracks[next.project.tracks.length - 1];
    const placed = applyOps(next.project, [{ op: 'clip_add', asset: assetId, track: track.id, start: r3(at), duration }]);
    if (placed.error) { notify(placed.error, 'error'); return; }
    commit(placed.project, `Import ${name}`);
    setTrackId(track.id); setClipId(placed.created ?? null);
  };
  const importFiles = async (files: FileList): Promise<void> => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_IMPORT) { notify(`${file.name} is larger than 500 MB.`, 'error'); continue; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const source = await decodeAudioBytes(bytes);
        await addAssetClip(file.name, bytes, source, 0);
      } catch (error) { notify(`Could not import ${file.name}: ${error instanceof Error ? error.message : 'the browser cannot decode this file'}`, 'error'); }
    }
  };

  /* ---------- edit commands ---------- */

  const sel = selection && selection.end - selection.start > 0.0005 ? selection : null;
  const need = (): Selection | null => { const s = selRef.current; if (!s || s.end - s.start < 0.0005) { notify('Select a part of the audio first (drag on a track, or Select ▸ All).', 'error'); return null; } return s; };
  const rangeOps = (s: Selection): Record<string, unknown> => ({ from: r3(s.start), to: r3(s.end), ...(s.tracks.length ? { tracks: s.tracks } : {}) });
  const rangeText = sel ? `${sel.start.toFixed(2)}–${sel.end.toFixed(2)} s${sel.tracks.length ? ' on the selected track' : ' on all tracks'}` : `the whole project (${total.toFixed(2)} s)`;
  const withRange = (): Record<string, unknown> => { const s = selRef.current; return s && s.end - s.start > 0.0005 ? rangeOps(s) : { from: 0, to: Math.max(0.01, total) }; };

  const copySel = (): boolean => {
    const s = need(), p = projectRef.current; if (!s || !p) return false;
    setClipboard(extractRange(p, s.start, s.end, s.tracks));
    if (clipboard.length === 0) { notify('There is no audio in the selection.', 'error'); return false; }
    notify(`Copied ${clipboard.length} clip(s).`);
    return true;
  };
  const cutSel = (): void => { const s = selRef.current; if (copySel() && s) run([{ op: 'range_delete', ...rangeOps(s), ripple: true }], 'Cut'); };
  const pasteAt = (): void => {
    if (clipboard.length === 0) { notify('The clipboard is empty — copy or cut something first.', 'error'); return; }
    const p = projectRef.current; if (!p) return;
    const track = p.tracks.find((t) => t.id === trackId && !t.locked) ?? p.tracks.find((t) => !t.locked);
    if (!track) return;
    const created = run([{ op: 'paste', at: r3(timeStore.get()), track: track.id, clips: clipboard }], 'Paste');
    if (created) setClipId(created);
  };
  const deleteSel = (ripple = true): void => { const s = need(); if (s) { run([{ op: ripple ? 'range_delete' : 'range_silence', ...rangeOps(s), ripple }], ripple ? 'Delete' : 'Silence audio'); changeSelection(ripple ? null : s); if (ripple) timeStore.set(s.start); } };
  const trimSel = (): void => { const s = need(); if (s) { run([{ op: 'trim', ...rangeOps(s) }], 'Trim audio'); changeSelection(null); timeStore.set(0); } };
  const duplicateSel = (): void => { const s = need(); if (s) run([{ op: 'range_duplicate', ...rangeOps(s), at: r3(s.end) }], 'Duplicate'); };
  const splitHere = (): void => {
    const p = projectRef.current; if (!p) return;
    const s = selRef.current;
    if (s && s.end - s.start > 0.0005) { run([{ op: 'range_split', ...rangeOps(s) }], 'Split'); return; }
    const t = r3(timeStore.get());
    const ops: Op[] = [];
    for (const track of p.tracks) {
      if (track.locked || (trackId && track.id !== trackId && p.tracks.length > 1 && selRef.current?.tracks.length)) continue;
      const c = clipAtTime(track, t);
      if (c && t > c.start + 0.005 && t < clipEnd(c) - 0.005) ops.push({ op: 'clip_split', clip: c.id, at: t });
    }
    if (ops.length === 0) { notify('Put the cursor inside a clip to split it.', 'error'); return; }
    run(ops, 'Split at the cursor');
  };
  const joinSel = (): void => {
    const s = need(), p = projectRef.current; if (!s || !p) return;
    const split = applyOps(p, [{ op: 'range_split', ...rangeOps(s) }]);
    if (split.error) { notify(split.error, 'error'); return; }
    const ops: Op[] = [{ op: 'range_split', ...rangeOps(s) }];
    for (const t of split.project.tracks) {
      if (s.tracks.length && !s.tracks.includes(t.id)) continue;
      const ids = t.clips.filter((c) => c.start >= s.start - 1e-6 && clipEnd(c) <= s.end + 1e-6).map((c) => c.id);
      if (ids.length > 1) ops.push({ op: 'join', clips: ids });
    }
    run(ops, 'Join');
  };
  const addLabel = (): void => {
    const s = selRef.current, t = r3(timeStore.get());
    run([{ op: 'label_add', start: s && s.end > s.start ? r3(s.start) : t, end: s && s.end > s.start ? r3(s.end) : t, text: `Label ${(projectRef.current?.labels.length ?? 0) + 1}` }], 'Add label');
  };
  const addTrack = (kind: 'mono' | 'stereo'): void => { const before = projectRef.current?.tracks.length ?? 0; if (run([{ op: 'track_add', kind, name: `${kind === 'mono' ? 'Mono' : 'Stereo'} Track ${before + 1}` }], 'Add track') !== null) setTrackId(`t${before + 1}`); };

  const applyEffect = (effect: string, params: Record<string, unknown>): void => {
    const extra = effect === 'noisereduce' && params.profileFrom === undefined && noiseProfile ? { profileFrom: noiseProfile.from, profileTo: noiseProfile.to } : {};
    run([{ op: 'effect', effect, params: { ...params, ...extra }, ...withRange() }], FX[effect].label);
    setLastEffect({ effect, params });
  };
  const fade = (dir: 'fade_in' | 'fade_out'): void => { const s = need(); if (s) run([{ op: dir, ...rangeOps(s) }], dir === 'fade_in' ? 'Fade in' : 'Fade out'); };
  const previewEffect = (effect: string, params: Record<string, unknown>): void => {
    const p = projectRef.current; if (!p) return;
    const r = applyOps(p, [{ op: 'effect', effect, params, ...withRange() }]);
    if (r.error) { notify(r.error, 'error'); return; }
    const s = selRef.current, from = s && s.end > s.start ? s.start : 0, end = s && s.end > s.start ? s.end : Math.max(0.1, total);
    setPreviewing(true);
    engine.setHandlers({ onState: (on) => { setPlaying(on); if (!on) setPreviewing(false); } });
    void engine.play(from, Math.min(end, from + 6), false, r.project).catch((e) => { setPreviewing(false); notify(`Could not preview: ${String(e)}`, 'error'); });
  };
  const stopPreview = (): void => { engine.stop(); setPreviewing(false); engine.setHandlers({ onState: (on) => setPlaying(on) }); };

  const generate = (gen: GenSpec, duration: number): void => {
    const p = projectRef.current; if (!p) return;
    const s = selRef.current;
    const track = p.tracks.find((t) => t.id === trackId && !t.locked) ?? p.tracks.find((t) => !t.locked);
    if (!track) return;
    const created = run([{ op: 'generate', ...gen, type: gen.type, track: track.id, start: r3(s && s.end > s.start ? s.start : timeStore.get()), duration: r3(duration) }], `Generate ${gen.type}`);
    if (created) setClipId(created);
    setDialog(null);
  };

  /* ---------- analysis ---------- */

  const mixOfRange = (): { l: Float32Array; r: Float32Array; sr: number; from: number } => {
    const s = selRef.current, p = projectRef.current as Project;
    engine.setProject(p);
    const from = s && s.end > s.start ? s.start : 0, to = s && s.end > s.start ? s.end : projectDuration(p);
    const mix = engine.mix(from, to);
    return { l: mix.channels[0], r: mix.channels[1], sr: mix.sampleRate, from };
  };
  const analyzeNow = (): void => {
    if (total <= 0) { notify('There is nothing to analyse yet.', 'error'); return; }
    const m = mixOfRange();
    setDialog({ kind: 'text', title: 'Loudness and levels', text: `${sel ? `Selection ${sel.start.toFixed(2)}–${sel.end.toFixed(2)} s` : 'Whole project'}\n${describeAnalysis(analyze([m.l, m.r], m.sr))}` });
  };
  const plotSpectrum = (): void => { if (total <= 0) { notify('There is nothing to analyse yet.', 'error'); return; } const m = mixOfRange(); const mono = m.l.map((v, i) => (v + m.r[i]) / 2); setDialog({ kind: 'spectrum', samples: mono }); };
  const labelRanges = (kind: 'clipping' | 'silence'): void => {
    if (total <= 0) return;
    const m = mixOfRange();
    const ranges = kind === 'clipping' ? findClipping([m.l, m.r], m.sr).ranges : findSilence(m.l.map((v, i) => (v + m.r[i]) / 2), m.sr, -50, 0.3);
    if (ranges.length === 0) { notify(kind === 'clipping' ? 'No clipping found.' : 'No silence found.'); return; }
    run(ranges.slice(0, 50).map((r) => ({ op: 'label_add', start: r3(r.start + m.from), end: r3(r.end + m.from), text: kind === 'clipping' ? 'clipped' : 'silence' })), kind === 'clipping' ? 'Label clipping' : 'Label silences');
  };

  /* ---------- project files ---------- */

  const newAudio = async (name: string, kind: NewKind, rate: number): Promise<void> => {
    const base = nameSlug(name || (kind === 'podcast' ? 'podcast' : kind === 'music' ? 'music' : 'recording'));
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    await saveNow();
    try {
      const title = name.trim() || (kind === 'podcast' ? 'Podcast' : kind === 'music' ? 'Music' : 'Untitled audio');
      const p = applyOps(emptyProject(title, rate), templateOps(kind)).project;
      await saveAudio({ owner: USER_OWNER, slug }, p, 'editor');
      setDialog(null);
      await refreshList();
      await openAudio(`${USER_OWNER}/${slug}`);
    } catch (error) { notify(`Could not create the project: ${String(error)}`, 'error'); }
  };
  const deleteFile = async (key: string): Promise<void> => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); engine.stop(); }
      await removeAudio(ref);
      const rest = await listAudioRefs();
      setRefs(rest);
      if (key === currentRef.current) { if (rest[0]) await openAudio(refKey(rest[0])); else { setCurrent(null); setProject(null); projectRef.current = null; setOpenAudio(null); } }
    } catch (error) { notify(`Could not delete the project: ${String(error)}`, 'error'); }
  };

  /* ---------- export ---------- */

  const download = (blob: Blob, name: string): void => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const doExport = async (format: ExportFormat, range: 'all' | 'selection', save: boolean): Promise<void> => {
    const ref = refOf(current), p = projectRef.current;
    if (!ref || !p || exp.busy) return;
    engine.stop(); await saveNow(); engine.setProject(p);
    const s = selRef.current, useSel = range === 'selection' && s && s.end > s.start;
    const from = useSel ? s.start : 0, to = useSel ? s.end : projectDuration(p);
    setExp({ busy: true, progress: 0, message: format === 'webm' ? 'Recording the mix…' : 'Rendering…' });
    try {
      const ext = format === 'webm' ? '.webm' : '.wav', path = audioPath(ref).replace(/\.audio\.json$/, ext);
      let blob: Blob;
      if (format === 'webm') blob = await engine.exportWebm(from, to, (f) => setExp((o) => ({ ...o, progress: f })));
      else blob = new Blob([engine.exportWav(format === 'wav16' ? 16 : format === 'wav24' ? 24 : 32, from, to) as BlobPart], { type: 'audio/wav' });
      if (blob.size > MAX_IMPORT) throw new Error('the file would be over 500 MB — export a shorter range');
      await writeWorktreeBinaryChunked(path, new Uint8Array(await blob.arrayBuffer()), (f) => setExp((o) => (o.busy && format !== 'webm' ? { ...o, progress: f } : o)));
      if (save) download(blob, `${nameSlug(p.title) || 'audio'}${ext}`);
      setExp({ busy: false, progress: 1, message: `Saved ${path} (${(blob.size / 1_000_000).toFixed(1)} MB).` });
    } catch (error) { setExp({ busy: false, progress: 0, message: `Could not export: ${error instanceof Error ? error.message : String(error)}` }); }
  };

  /* ---------- menus and keys ---------- */

  const has = !!project;
  const zoomBy = (k: number): void => setPps((z) => Math.max(4, Math.min(2000, z * k)));
  const fitZoom = (): void => { const w = document.querySelector('.au-tl')?.clientWidth ?? 900; setPps(Math.max(4, Math.min(1000, (w - 240) / Math.max(total, 2)))); };
  const setView = (view: string): void => { if (trackId) run([{ op: 'track_set', track: trackId, view }], 'Track view'); };
  const fxEntry = (effect: string): MenuEntry => ({ label: `${FX[effect].label}…`, onSelect: () => setDialog({ kind: 'effect', effect }), disabled: !has || total <= 0 });
  const GROUPS = ['Volume', 'EQ & filters', 'Dynamics', 'Restoration', 'Space & colour', 'Channels'];
  const effectEntries = (): MenuEntry[] => {
    const out: MenuEntry[] = [
      { label: 'Repeat last effect', keys: 'Ctrl+R', onSelect: () => { if (lastEffect) applyEffect(lastEffect.effect, lastEffect.params); }, disabled: !lastEffect || total <= 0 },
      { label: 'Fade in', onSelect: () => fade('fade_in'), disabled: !has || total <= 0 },
      { label: 'Fade out', onSelect: () => fade('fade_out'), disabled: !has || total <= 0 },
      { label: 'Reverse', onSelect: () => run([{ op: 'reverse', ...withRange() }], 'Reverse'), disabled: !has || total <= 0 },
      { label: 'Change speed…', onSelect: () => setDialog({ kind: 'value', what: 'speed' }), disabled: !has || total <= 0 },
      { label: 'Change tempo…', onSelect: () => setDialog({ kind: 'value', what: 'tempo' }), disabled: !has || total <= 0 },
      { label: 'Change pitch…', onSelect: () => setDialog({ kind: 'value', what: 'pitch' }), disabled: !has || total <= 0 },
    ];
    for (const group of GROUPS) {
      out.push({ separator: true }, { label: group, heading: true });
      for (const [id, spec] of Object.entries(FX)) if (spec.group === group && id !== 'ramp') out.push(fxEntry(id));
    }
    return out;
  };
  const menus = (): Record<string, MenuEntry[]> => ({
    File: [
      { label: 'New project…', onSelect: () => setDialog({ kind: 'new' }) },
      { label: 'Save', keys: 'Ctrl+S', onSelect: () => void saveNow(), disabled: !has },
      { separator: true },
      { label: 'Import audio…', onSelect: () => fileInput.current?.click(), disabled: !has },
      { label: 'Export…', onSelect: () => { setExp({ busy: false, progress: 0, message: '' }); setDialog({ kind: 'export' }); }, disabled: !has || total <= 0 },
    ],
    Edit: [
      { label: 'Undo', keys: 'Ctrl+Z', onSelect: undo, disabled: hist.undo === 0 },
      { label: 'Redo', keys: 'Ctrl+Y', onSelect: redo, disabled: hist.redo === 0 },
      { separator: true },
      { label: 'Cut', keys: 'Ctrl+X', onSelect: cutSel, disabled: !sel },
      { label: 'Copy', keys: 'Ctrl+C', onSelect: () => { copySel(); }, disabled: !sel },
      { label: 'Paste', keys: 'Ctrl+V', onSelect: pasteAt, disabled: !has },
      { label: 'Delete', keys: 'Delete', onSelect: () => deleteSel(true), disabled: !sel },
      { label: 'Duplicate', keys: 'Ctrl+D', onSelect: duplicateSel, disabled: !sel },
      { label: 'Repeat selection once', onSelect: () => { const s = need(); if (s) run([{ op: 'repeat', ...rangeOps(s), count: 1 }], 'Repeat'); }, disabled: !sel },
      { separator: true },
      { label: 'Silence audio', keys: 'Ctrl+L', onSelect: () => deleteSel(false), disabled: !sel },
      { label: 'Trim audio', keys: 'Ctrl+T', onSelect: trimSel, disabled: !sel },
      { label: 'Split', keys: 'Ctrl+I', onSelect: splitHere, disabled: !has },
      { label: 'Join', onSelect: joinSel, disabled: !sel },
      { separator: true },
      { label: 'Add label at selection', keys: 'Ctrl+B', onSelect: addLabel, disabled: !has },
      { label: 'Add mono track', onSelect: () => addTrack('mono'), disabled: !has },
      { label: 'Add stereo track', onSelect: () => addTrack('stereo'), disabled: !has },
      { label: 'Show history…', onSelect: () => setDialog({ kind: 'history', entries: undoStack.current.map((e) => e.label) }), disabled: !has },
    ],
    Select: [
      { label: 'All', keys: 'Ctrl+A', onSelect: () => changeSelection({ start: 0, end: total, tracks: [] }), disabled: total <= 0 },
      { label: 'None', keys: 'Esc', onSelect: () => changeSelection(null), disabled: !sel },
      { separator: true },
      { label: 'Start to cursor', onSelect: () => changeSelection({ start: 0, end: timeStore.get(), tracks: [] }), disabled: !has },
      { label: 'Cursor to end', onSelect: () => changeSelection({ start: timeStore.get(), end: total, tracks: [] }), disabled: !has },
      { label: 'Clip under the cursor', onSelect: () => { const c = project?.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.start <= timeStore.get() && clipEnd(x) > timeStore.get()); if (c && trackId) changeSelection({ start: c.start, end: clipEnd(c), tracks: [trackId] }); }, disabled: !has },
    ],
    View: [
      { label: 'Zoom in', keys: '+', onSelect: () => zoomBy(1.5) },
      { label: 'Zoom out', keys: '−', onSelect: () => zoomBy(1 / 1.5) },
      { label: 'Zoom to fit the project', onSelect: fitZoom },
      { label: 'Zoom to selection', onSelect: () => { if (sel) setPps(Math.max(4, Math.min(2000, 700 / (sel.end - sel.start)))); }, disabled: !sel },
      { separator: true },
      { label: 'Waveform view (selected track)', onSelect: () => setView('wave'), disabled: !trackId },
      { label: 'Spectrogram view (selected track)', onSelect: () => setView('spectrogram'), disabled: !trackId },
      { label: 'Waveform + spectrogram (selected track)', onSelect: () => setView('both'), disabled: !trackId },
      { label: 'Show clipping', checked: showClipping, onSelect: () => setShowClipping((v) => !v) },
      { separator: true },
      { label: 'Keyboard shortcuts', keys: '?', onSelect: () => setHelpOpen(true) },
    ],
    Transport: [
      { label: 'Play / stop', keys: 'Space', onSelect: () => togglePlay(false), disabled: total <= 0 },
      { label: 'Loop play', keys: 'Shift+Space', onSelect: () => togglePlay(true), disabled: total <= 0 },
      { label: 'Pause', keys: 'P', onSelect: pause, disabled: !playing },
      { label: recording ? 'Stop recording' : 'Record', keys: 'R', onSelect: () => void startStopRecord(), disabled: !has },
      { separator: true },
      { label: 'Go to start', keys: 'Home', onSelect: () => seek(0) },
      { label: 'Go to end', keys: 'End', onSelect: () => seek(total) },
    ],
    Generate: [
      { label: 'Tone…', onSelect: () => setDialog({ kind: 'gen', type: 'tone' }), disabled: !has },
      { label: 'Chirp…', onSelect: () => setDialog({ kind: 'gen', type: 'chirp' }), disabled: !has },
      { label: 'Noise…', onSelect: () => setDialog({ kind: 'gen', type: 'noise' }), disabled: !has },
      { label: 'Silence…', onSelect: () => setDialog({ kind: 'gen', type: 'silence' }), disabled: !has },
      { label: 'Click track…', onSelect: () => setDialog({ kind: 'gen', type: 'click' }), disabled: !has },
    ],
    Effect: effectEntries(),
    Analyze: [
      { label: 'Loudness and levels…', onSelect: analyzeNow, disabled: !has || total <= 0 },
      { label: 'Plot spectrum…', onSelect: plotSpectrum, disabled: !has || total <= 0 },
      { separator: true },
      { label: 'Label clipped parts', onSelect: () => labelRanges('clipping'), disabled: !has || total <= 0 },
      { label: 'Label silences', onSelect: () => labelRanges('silence'), disabled: !has || total <= 0 },
    ],
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    const act = (fn: () => void): void => { e.preventDefault(); fn(); };
    if (ctrl && key === 's') return act(() => void saveNow());
    if (typing && !(e.key === 'Escape')) return;
    if (ctrl && key === 'z' && !e.shiftKey) return act(undo);
    if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) return act(redo);
    if (ctrl && key === 'x') return act(cutSel);
    if (ctrl && key === 'c') return act(() => { copySel(); });
    if (ctrl && key === 'v') return act(pasteAt);
    if (ctrl && key === 'a') return act(() => changeSelection({ start: 0, end: total, tracks: [] }));
    if (ctrl && key === 'd') return act(duplicateSel);
    if (ctrl && key === 'l') return act(() => deleteSel(false));
    if (ctrl && key === 't') return act(trimSel);
    if (ctrl && key === 'i') return act(splitHere);
    if (ctrl && key === 'b') return act(addLabel);
    if (ctrl && key === 'r') return act(() => { if (lastEffect) applyEffect(lastEffect.effect, lastEffect.params); });
    if (e.key === 'Escape') { setMenu(null); setHelpOpen(false); changeSelection(null); return; }
    if (ctrl || e.altKey) return;
    if (e.key === ' ') return act(() => togglePlay(e.shiftKey));
    if (e.key === 'Delete' || e.key === 'Backspace') return act(() => deleteSel(true));
    if (e.key === 'ArrowLeft') return act(() => seek(timeStore.get() - (e.shiftKey ? 1 : 0.1)));
    if (e.key === 'ArrowRight') return act(() => seek(timeStore.get() + (e.shiftKey ? 1 : 0.1)));
    if (e.key === 'Home') return act(() => seek(0));
    if (e.key === 'End') return act(() => seek(total));
    if (e.key === '?') return act(() => setHelpOpen(true));
    if (e.key === '+' || e.key === '=') return act(() => zoomBy(1.5));
    if (e.key === '-') return act(() => zoomBy(1 / 1.5));
    if (e.key === 'F1') return act(() => setTool('select'));
    if (e.key === 'F2') return act(() => setTool('envelope'));
    if (e.key === 'F3') return act(() => setTool('zoom'));
    if (e.key === 'F4') return act(() => setTool('shift'));
    if (key === 'p') return act(pause);
    if (key === 'r') return act(() => void startStopRecord());
  };

  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  const setSel = (field: 'start' | 'end' | 'len', value: number): void => {
    if (!Number.isFinite(value) || value < 0) return;
    const s = selRef.current ?? { start: timeStore.get(), end: timeStore.get(), tracks: [] };
    const start = field === 'start' ? value : s.start, end = field === 'end' ? value : field === 'len' ? s.start + value : s.end;
    changeSelection({ ...s, start: Math.min(start, end), end: Math.max(start, end) });
  };

  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  /* The menu callbacks only run when an item is clicked, never while rendering. */
  // eslint-disable-next-line react-hooks/refs
  const menuDefs = menus();
  const clip = project && clipId ? findClip(project, clipId)?.clip ?? null : null;
  const labelDlg = dialog?.kind === 'label' ? project?.labels.find((l) => l.id === dialog.id) ?? null : null;
  const tools: Array<{ id: Tool; label: string; icon: typeof MousePointer2; key: string }> = [
    { id: 'select', label: 'Selection tool', icon: MousePointer2, key: 'F1' }, { id: 'envelope', label: 'Envelope tool', icon: Activity, key: 'F2' },
    { id: 'zoom', label: 'Zoom tool', icon: ZoomIn, key: 'F3' }, { id: 'shift', label: 'Time shift tool', icon: MoveHorizontal, key: 'F4' },
  ];

  return (
    <div className="screen au">
      <header className="screen-header">
        <h1 className="screen-header__title">Audio Editor</h1>
        <span className="screen-header__meta">Audacity-style multi-track editing — the Audio Editor agent builds on the same project</span>
        {current && <span className={`au__save au__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="au__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={filesOpen} onClick={() => setFilesOpen((o) => !o)}>
            <AudioLines size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Projects'} <ChevronDown size={11} />
          </button>
          {filesOpen && (
            <div className="au__popup au__popup--list" role="menu" aria-label="Audio projects">
              {refs.length === 0 && <p className="au-note au-pad">No audio projects yet — create one, or ask the Audio Editor agent.</p>}
              {grouped.map(([owner, list]) => (
                <div key={owner}>
                  <div className="au__owner">{owner}</div>
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`au__file${key === current ? ' au__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="au__file-main" title={audioPath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openAudio(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="au-icon au-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteFile(key)}><Check size={12} /></button>
                            <button type="button" className="au-icon" aria-label="Keep project" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : <button type="button" className="au-icon au__file-del" aria-label={`Delete ${ref.slug}`} title="Delete project" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New audio</button>
        <button type="button" className="primary-button" disabled={!has || total <= 0} onClick={() => { setExp({ busy: false, progress: 0, message: '' }); setDialog({ kind: 'export' }); }}><Download size={12} strokeWidth={1.5} /> Export</button>
      </header>

      <div className="screen-body au__body">
        <div className="au__main" onKeyDown={onKeyDown}>
          <nav className="au__menubar" aria-label="Audio menu">
            {Object.entries(menuDefs).map(([name, entries]) => (
              <div key={name} className="au__menu">
                <button type="button" className={`au__menu-btn${menu === name ? ' au__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => { if (menu) setMenu(name); }}>{name}</button>
                {menu === name && (
                  <div className="au__popup" role="menu" aria-label={name}>
                    {entries.map((entry, i) => entry.separator ? <hr key={i} /> : entry.heading ? <div key={i} className="au__heading">{entry.label}</div> : (
                      <button key={i} type="button" role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} disabled={entry.disabled} onClick={() => { setMenu(null); entry.onSelect?.(); }}>
                        <span>{entry.checked !== undefined && <Check size={11} style={{ opacity: entry.checked ? 1 : 0 }} />} {entry.label}</span>
                        {entry.keys && <kbd>{entry.keys}</kbd>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <span className="au-grow" />
            <button type="button" className="au-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
          </nav>
          <input ref={fileInput} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus,.webm" multiple hidden aria-label="Import audio files" onChange={(e) => { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }} />

          {project ? (
            <div className="au__work" tabIndex={0} aria-label="Audio editor">
              <div className="au__toolbars" role="toolbar" aria-label="Toolbars">
                <div className="au__group" role="group" aria-label="Transport">
                  <button type="button" className="au-icon" aria-label="Go to start" title="Skip to start (Home)" onClick={() => seek(0)}><SkipBack size={15} /></button>
                  <button type="button" className={`au-icon au-icon--play${playing ? ' au-icon--on' : ''}`} aria-label={playing ? 'Stop' : 'Play'} title="Play / stop (Space)" disabled={total <= 0} onClick={() => togglePlay(false)}>{playing ? <Square size={15} /> : <Play size={16} />}</button>
                  <button type="button" className="au-icon" aria-label="Pause" title="Pause (P)" disabled={!playing} onClick={pause}><Pause size={15} /></button>
                  <button type="button" className="au-icon" aria-label="Go to end" title="Skip to end (End)" onClick={() => seek(total)}><SkipForward size={15} /></button>
                  <button type="button" className={`au-icon${recording ? ' au-icon--rec' : ''}`} aria-label={recording ? 'Stop recording' : 'Record'} aria-pressed={recording} title="Record from the microphone (R)" onClick={() => void startStopRecord()}><Circle size={14} fill={recording ? 'currentColor' : 'none'} /></button>
                  <button type="button" className={`au-icon${loop ? ' au-icon--on' : ''}`} aria-label="Loop" aria-pressed={loop} title="Loop play (Shift+Space)" onClick={() => { setLoop((l) => !l); if (engine.playing) { engine.stop(); } }}><Repeat size={14} /></button>
                </div>
                <div className="au__group" role="group" aria-label="Tools">
                  {tools.map(({ id, label, icon: Icon, key }) => <button key={id} type="button" className={`au-icon${tool === id ? ' au-icon--on' : ''}`} aria-label={label} aria-pressed={tool === id} title={`${label} (${key})`} onClick={() => setTool(id)}><Icon size={14} /></button>)}
                </div>
                <div className="au__group" role="group" aria-label="Edit">
                  <button type="button" className="au-icon" aria-label="Cut" title="Cut (Ctrl+X)" disabled={!sel} onClick={cutSel}><Scissors size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Copy" title="Copy (Ctrl+C)" disabled={!sel} onClick={() => { copySel(); }}><Copy size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Paste" title="Paste (Ctrl+V)" onClick={pasteAt}><ClipboardPaste size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Trim audio outside the selection" title="Trim (Ctrl+T)" disabled={!sel} onClick={trimSel}><Crop size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Silence selection" title="Silence (Ctrl+L)" disabled={!sel} onClick={() => deleteSel(false)}><VolumeX size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={hist.undo === 0} onClick={undo}><Undo2 size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={hist.redo === 0} onClick={redo}><Redo2 size={14} /></button>
                  <button type="button" className="au-icon" aria-label="History" title="Undo history" onClick={() => setDialog({ kind: 'history', entries: undoStack.current.map((e) => e.label) })}><History size={14} /></button>
                </div>
                <div className="au__group" role="group" aria-label="Zoom">
                  <button type="button" className="au-icon" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)}><ZoomOut size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Zoom in" onClick={() => zoomBy(1.5)}><ZoomIn size={14} /></button>
                  <button type="button" className="au-btn au-btn--tiny" onClick={fitZoom}>Fit</button>
                  <button type="button" className="au-icon" aria-label="Add label" title="Add label (Ctrl+B)" onClick={addLabel}><Tag size={14} /></button>
                  <button type="button" className="au-icon" aria-label="Import audio" title="Import audio" onClick={() => fileInput.current?.click()}><Upload size={14} /></button>
                </div>
                <div className="au__group au__group--meters" role="group" aria-label="Meters">
                  <Meter store={meterStore} label={recording ? 'Recording level' : 'Playback level'} />
                </div>
                <TimeLabel store={timeStore} total={total} />
              </div>

              <div className="au__selbar" role="toolbar" aria-label="Selection">
                <label>Project rate <select className="au-select" aria-label="Project sample rate" value={project.sampleRate} onChange={(e) => run([{ op: 'project', sampleRate: Number(e.target.value) }], 'Project rate')}>{SAMPLE_RATES.map((r) => <option key={r} value={r}>{r} Hz</option>)}</select></label>
                <label>Start <input key={`s${selection?.start}`} className="au-input au-num" aria-label="Selection start" defaultValue={selection ? selection.start.toFixed(3) : '0.000'} onBlur={(e) => setSel('start', Number(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
                <label>End <input key={`e${selection?.end}`} className="au-input au-num" aria-label="Selection end" defaultValue={selection ? selection.end.toFixed(3) : '0.000'} onBlur={(e) => setSel('end', Number(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
                <label>Length <input key={`l${selection?.start}-${selection?.end}`} className="au-input au-num" aria-label="Selection length" defaultValue={selection ? (selection.end - selection.start).toFixed(3) : '0.000'} onBlur={(e) => setSel('len', Number(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
                <span className="au-grow" />
                <span className="au-note" title={formatInfo(project)}>{clip ? `Clip ${clip.id}: ${clip.start.toFixed(2)}–${clipEnd(clip).toFixed(2)} s${clip.fx.length ? ` · ${clip.fx.map((f) => f.type).join(' → ')}` : ''}` : `${project.tracks.length} track(s) · ${project.sampleRate} Hz · 32-bit float`}</span>
                {clip && <button type="button" className="au-btn au-btn--tiny" onClick={() => { if (run([{ op: 'clip_delete', clip: clip.id, ripple: false }], 'Delete clip') !== null) setClipId(null); }}>Delete clip</button>}
                {clip && clip.fx.length > 0 && <button type="button" className="au-btn au-btn--tiny" onClick={() => run([{ op: 'clip_set', clip: clip.id }, ...clip.fx.map((_, i) => ({ op: 'effect_remove', clip: clip.id, index: clip.fx.length - 1 - i }))], 'Remove clip effects')}>Remove effects</button>}
              </div>

              <Timeline
                project={project} engine={engine} rev={rev} pps={pps} tool={tool} showClipping={showClipping} selection={selection} clipId={clipId} trackId={trackId} timeStore={timeStore}
                onSeek={seek} onSelection={changeSelection} onClip={setClipId} onTrack={setTrackId} beginDrag={beginDrag} previewOps={previewOps} endDrag={endDrag}
                run={(ops, label, merge) => { run(ops, label, merge); }} onZoom={(dir) => zoomBy(dir > 0 ? 1.6 : 1 / 1.6)} onLabel={(id) => setDialog({ kind: 'label', id })}
              />
            </div>
          ) : (
            <div className="au__welcome">
              <AudioLines size={34} strokeWidth={1.25} />
              <h2>Audio Editor</h2>
              <p>Record, import and edit sound the Audacity way: multi-track clips, cut / copy / paste, fades and envelopes, EQ, compression, noise and hum removal, reverb, loudness measurement and WAV export — all in the browser. Start a project, or ask the Audio Editor agent to clean up a recording.</p>
              <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New audio</button>
            </div>
          )}
          {helpOpen && <ShortcutHelp title="Audio Editor shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
        </div>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('audioeditor')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {dialog?.kind === 'new' && <NewAudioDialog onCreate={(n, k, r) => void newAudio(n, k, r)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'export' && project && <ExportDialog project={project} total={total} hasSelection={!!sel} state={exp} onExport={(f, r, d) => void doExport(f, r, d)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'effect' && (
        <EffectDialog
          key={dialog.effect} effect={dialog.effect} initial={lastEffect?.effect === dialog.effect ? lastEffect.params : {}} rangeText={rangeText} previewing={previewing} noiseProfile={noiseProfile}
          onProfile={() => { const s = need(); if (s) { setNoiseProfile({ from: r3(s.start), to: r3(s.end) }); notify('Noise profile taken from the selection.'); } }}
          onPreview={(params) => previewEffect(dialog.effect, params)} onStop={stopPreview}
          onApply={(params) => { applyEffect(dialog.effect, params); setDialog(null); }} onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'gen' && <GenerateDialog type={dialog.type} duration={sel ? r3(sel.end - sel.start) : 3} onApply={generate} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'text' && <TextDialog title={dialog.title} text={dialog.text} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'spectrum' && project && <SpectrumDialog samples={dialog.samples} sampleRate={project.sampleRate} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'history' && <HistoryDialog entries={dialog.entries} onJump={jumpHistory} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'label' && labelDlg && (
        <LabelDialog label={labelDlg} onClose={() => setDialog(null)}
          onSave={(text) => { run([{ op: 'label_set', label: labelDlg.id, text }], 'Edit label'); setDialog(null); }}
          onDelete={() => { run([{ op: 'label_remove', label: labelDlg.id }], 'Delete label'); setDialog(null); }}
          onSelect={() => { changeSelection({ start: labelDlg.start, end: Math.max(labelDlg.end, labelDlg.start + 0.001), tracks: [] }); setDialog(null); }} />
      )}
      {dialog?.kind === 'value' && (
        <ValueDialog what={dialog.what} onClose={() => setDialog(null)} onApply={(v) => {
          const base = withRange();
          run([dialog.what === 'pitch' ? { op: 'pitch', semitones: v, ...base } : { op: dialog.what, factor: v, ...base }], dialog.what === 'speed' ? 'Change speed' : dialog.what === 'tempo' ? 'Change tempo' : 'Change pitch');
          setDialog(null);
        }} />
      )}
      <span hidden>{AUDIO_DIR}</span>
    </div>
  );
}
