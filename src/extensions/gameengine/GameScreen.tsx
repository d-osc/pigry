import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronLeft, Gamepad2, Keyboard, Magnet, MousePointer2, Move, Pause, Play, Plus, Redo2, Rotate3d, Scale3d, Settings, SkipForward, Square, Trash2, Undo2, X,
  Maximize, Bug, Box as BoxIcon, FileCode2, Clapperboard,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { Editor } from '../../editor/ThemedEditors';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeFile } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import { NODE_TYPES, applyGameOp, cleanNodeName, countNodes, emptyGame, findNode, inherits, is2D, scriptBase, type Game, type GameNode, type GameOp, type GameScene } from './game';
import { GAME_API_DTS } from './gameApi';
import { exportGameHtml, playGame, type GameMessage, type PlayHandle } from './gameHost';
import { templateGame, type TemplateKind } from './gameTemplates';
import {
  GAME_CHANGED, GAME_OPEN, gamePath, listGameRefs, loadGame, registerGameFlush, removeGame, saveGame, setOpenGame, takePendingOpenGame, type GameChange, type GameOpenRequest,
} from './gameStore';
import { GameViewport, type GameViewportHandle, type GizmoMode, type TransformResult } from './GameViewport';
import { FileSystem, Inspector, NodeDock, Output, SceneTree, type LogLine } from './GamePanels';
import { AddNodeDialog, AttachScriptDialog, NameDialog, NewGameDialog, PickSceneDialog, SettingsDialog } from './GameDialogs';
import './GameScreen.css';

type Workspace = '3d' | '2d' | 'script' | 'game';
const LAST_KEY = 'pigry:game-last';
const SAVE_DELAY = 900;
const HISTORY_LIMIT = 80;

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Run', items: [{ keys: 'F5', label: 'Play the project (main scene)' }, { keys: 'F6', label: 'Play the current scene' }, { keys: 'F7', label: 'Pause / resume' }, { keys: 'F8', label: 'Stop' }] },
  { title: 'Tools', items: [{ keys: 'Q', label: 'Select' }, { keys: 'W', label: 'Move' }, { keys: 'E', label: 'Rotate' }, { keys: 'R', label: 'Scale' }, { keys: 'F', label: 'Frame the selected node' }] },
  { title: 'Scene', items: [{ keys: 'Ctrl+A', label: 'Add a child node' }, { keys: 'Ctrl+D', label: 'Duplicate' }, { keys: 'Delete', label: 'Delete' }, { keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+S', label: 'Save now' }] },
  { title: 'Viewport', items: [{ keys: 'Left drag', label: 'Orbit (3D)' }, { keys: 'Right / middle drag', label: 'Pan' }, { keys: 'Scroll', label: 'Zoom' }, { keys: 'Click', label: 'Select the node under the pointer' }, { keys: '?', label: 'This list' }] },
];

interface MenuEntry { label?: string; keys?: string; onSelect?: () => void; disabled?: boolean; separator?: boolean; checked?: boolean }
interface HistoryEntry { game: Game; label: string; merge?: string; t: number }

const classNameOf = (path: string): string => (path.split('/').pop() ?? 'script').replace(/\.(ts|js)$/, '').replace(/(^|[_\-\s]+)(\w)/g, (_m, _s, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '') || 'Script';

/** A starter script for a node type: the class extends the node's type and has the lifecycle methods. */
export function newScriptCode(type: string, path: string): string {
  const ts = path.endsWith('.ts');
  const cls = classNameOf(path);
  const body = inherits(type, 'CharacterBody3D') || inherits(type, 'CharacterBody2D')
    ? `  physicsProcess(delta${ts ? ': number' : ''}) {\n    // set this.velocity, then call this.moveAndSlide()\n    this.moveAndSlide();\n  }\n`
    : `  process(delta${ts ? ': number' : ''}) {\n    // called every frame\n  }\n`;
  return `// ${path} — attached to a ${type}. The class must extend the node's type.\nexport default class ${cls} extends ${type} {\n  ready() {\n    print('${cls} is ready:', this.name);\n  }\n\n${body}}\n`;
}

const scenePathOf = (parent: string, name: string): string => (parent === '.' || parent === '' ? name : `${parent}/${name}`);

export function GameScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sceneName, setSceneName] = useState('main');
  const [selection, setSelection] = useState<string | null>('.');
  const [workspace, setWorkspace] = useState<Workspace>('3d');
  const [mode, setMode] = useState<GizmoMode>('select');
  const [snap, setSnap] = useState(false);
  const [showShapes, setShowShapes] = useState(false);
  const [scriptPath, setScriptPath] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'inspector' | 'node'>('inspector');
  const [menu, setMenu] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'new' | 'add' | 'instance' | 'attach' | 'scene' | 'script' | 'settings'>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stats, setStats] = useState<{ fps: number; nodes: number; frame: number } | null>(null);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);

  const gameRef = useRef<Game | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const dragStart = useRef<Game | null>(null);
  const playRef = useRef<PlayHandle | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<GameViewportHandle | null>(null);
  const logN = useRef(0);
  const sceneRef = useRef(sceneName);
  useEffect(() => { sceneRef.current = sceneName; });

  const syncHist = (): void => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });

  /* ---------- persistence ---------- */

  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key, ['.game.json']);
    return { owner: owner ?? USER_OWNER, slug };
  };

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current), g = gameRef.current;
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !g || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try {
      await saveGame(ref, g, 'editor');
      setDirty(dirtyRef.current);
    } catch (error) {
      dirtyRef.current = true;
      notify(`Could not save the game: ${String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [notify]);

  useEffect(() => registerGameFlush(saveNow), [saveNow]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  const stopPlay = useCallback(() => {
    playRef.current?.dispose();
    playRef.current = null;
    setPlaying(false);
    setPaused(false);
    setStats(null);
  }, []);

  useEffect(() => () => {
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const ref = refOf(currentRef.current), g = gameRef.current;
    if (dirtyRef.current && ref && g) void saveGame(ref, g, 'editor');
    playRef.current?.dispose();
    playRef.current = null;
  }, []);

  const openGame = useCallback(async (key: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { game: loaded, warnings } = await loadGame(ref);
      undoStack.current = []; redoStack.current = []; dragStart.current = null;
      gameRef.current = loaded;
      const nextKey = refKey(ref);
      currentRef.current = nextKey;
      dirtyRef.current = false;
      stopPlay();
      setDirty(false);
      setGame(loaded);
      setCurrent(nextKey);
      setSceneName(loaded.settings.mainScene);
      setSelection('.');
      setScriptPath(Object.keys(loaded.scripts)[0] ?? null);
      setWorkspace(loaded.scenes[loaded.settings.mainScene] && is2D(loaded.scenes[loaded.settings.mainScene].root.type) ? '2d' : '3d');
      syncHist();
      setOpenGame(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Game opened with ${warnings.length} repaired issue(s).`);
    } catch (error) {
      notify(`Could not open "${key}": ${String(error)}`, 'error');
    }
  }, [saveNow, notify, stopPlay]);

  const refreshList = useCallback(async () => {
    try { setRefs(await listGameRefs()); } catch { setRefs([]); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listGameRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: GameOpenRequest | null = takePendingOpenGame();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openGame(refKey(found));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An agent tool wrote the file: show what it built.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<GameChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setGame(null); gameRef.current = null; setOpenGame(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openGame(change.key); }
    };
    const onOpen = (event: Event) => {
      const request = (event as CustomEvent<GameOpenRequest>).detail;
      takePendingOpenGame();
      void openGame(request.key);
    };
    const onScript = (event: Event) => { const p = (event as CustomEvent<string>).detail; if (p) { setScriptPath(p); setWorkspace('script'); } };
    window.addEventListener(GAME_CHANGED, onChanged);
    window.addEventListener(GAME_OPEN, onOpen);
    window.addEventListener('pigry:game-open-script', onScript);
    return () => { window.removeEventListener(GAME_CHANGED, onChanged); window.removeEventListener(GAME_OPEN, onOpen); window.removeEventListener('pigry:game-open-script', onScript); };
  }, [openGame, refreshList]);

  /* ---------- editing with undo ---------- */

  /** Applies a change to a copy of the game. Changes with the same `merge` key within a moment are one undo step. */
  const commit = useCallback((mutator: (draft: Game) => void, label: string, merge?: string): boolean => {
    const prev = gameRef.current;
    if (!prev) return false;
    const next = structuredClone(prev);
    try { mutator(next); } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
    const last = undoStack.current[undoStack.current.length - 1];
    if (merge && last && last.merge === merge && Date.now() - last.t < 900) last.t = Date.now();
    else { undoStack.current.push({ game: prev, label, merge, t: Date.now() }); if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift(); }
    redoStack.current = [];
    gameRef.current = next;
    setGame(next);
    syncHist();
    markDirty();
    return true;
  }, [markDirty, notify]);

  const run = useCallback((op: GameOp, label: string, merge?: string): void => {
    const scene = sceneRef.current;
    const withScene = op.op === 'add_scene' || op.op === 'remove_scene' || op.op === 'rename_scene' || op.op === 'set_main_scene' || op.op === 'set_script' || op.op === 'remove_script' || op.op === 'rename_script' || op.op === 'settings' || op.op === 'input_action' || op.op === 'remove_action' || op.op === 'autoload' || op.op === 'remove_autoload' ? op : { scene, ...op };
    const ok = commit((draft) => { applyGameOp(draft, withScene); }, label, merge);
    if (ok && op.op === 'remove_scene' && op.name === scene) setSceneName(gameRef.current?.settings.mainScene ?? 'main');
    if (ok && op.op === 'set' && typeof op.name === 'string' && typeof op.node === 'string' && op.node !== '.') {
      const parts = op.node.split('/'); parts[parts.length - 1] = cleanNodeName(op.name, parts[parts.length - 1]);
      setSelection((s) => (s === op.node ? parts.join('/') : s));
    }
    if (ok && op.op === 'remove_node') setSelection(null);
  }, [commit]);

  const swapTo = (target: HistoryEntry, to: HistoryEntry[]): void => {
    const now = gameRef.current;
    if (!now) return;
    to.push({ game: now, label: target.label, t: 0 });
    gameRef.current = target.game;
    setGame(target.game);
    if (!target.game.scenes[sceneRef.current]) setSceneName(target.game.settings.mainScene);
    syncHist();
    markDirty();
  };
  const undo = (): void => { const e = undoStack.current.pop(); if (e) swapTo(e, redoStack.current); };
  const redo = (): void => { const e = redoStack.current.pop(); if (e) swapTo(e, undoStack.current); };

  const onTransform = useCallback((path: string, result: TransformResult, final: boolean) => {
    const prev = gameRef.current;
    if (!prev) return;
    if (!dragStart.current) dragStart.current = prev;
    const next = structuredClone(prev);
    const found = findNode(next.scenes[sceneRef.current], path);
    if (!found) return;
    const n = found.node;
    n.props = { ...(n.props ?? {}), position: result.position, rotation: result.rotation.length === 1 ? result.rotation[0] : result.rotation, scale: result.scale };
    gameRef.current = next;
    setGame(next);
    if (final) {
      undoStack.current.push({ game: dragStart.current, label: 'Transform', t: Date.now() });
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      dragStart.current = null;
      syncHist();
    }
    markDirty();
  }, [markDirty]);

  /* ---------- scene commands ---------- */

  const scene: GameScene | undefined = game?.scenes[sceneName] ?? (game ? Object.values(game.scenes)[0] : undefined);
  const selectedNode: GameNode | null = scene && selection ? findNode(scene, selection)?.node ?? null : null;

  const addNode = (type: string): void => {
    if (!scene) return;
    const parentPath = selection && findNode(scene, selection) ? selection : '.';
    const parent = findNode(scene, parentPath)?.node;
    if (parent?.instance) { notify('This node is an instanced scene; add nodes inside that scene instead.', 'error'); return; }
    const ok = commit((draft) => { applyGameOp(draft, { op: 'add_node', scene: scene.name, parent: parentPath, type }); }, `Add ${type}`);
    if (!ok) return;
    const after = gameRef.current?.scenes[scene.name];
    const p = after ? findNode(after, parentPath)?.node : null;
    const added = p?.children?.[p.children.length - 1];
    if (added) setSelection(scenePathOf(parentPath, added.name));
    setDialog(null);
    setRightTab('inspector');
  };

  const instanceScene = (name: string): void => {
    if (!scene) return;
    const parentPath = selection && findNode(scene, selection) ? selection : '.';
    const ok = commit((draft) => { applyGameOp(draft, { op: 'add_node', scene: scene.name, parent: parentPath, type: 'Node', instance: name }); }, 'Instance scene');
    if (ok) {
      const p = findNode(gameRef.current!.scenes[scene.name], parentPath)?.node;
      const added = p?.children?.[p.children.length - 1];
      if (added) setSelection(scenePathOf(parentPath, added.name));
    }
    setDialog(null);
  };

  const attachScript = (path: string, create: boolean): void => {
    if (!scene || !selection || !selectedNode) return;
    const type = selectedNode.type;
    const ok = commit((draft) => {
      if (create) applyGameOp(draft, { op: 'set_script', path, code: newScriptCode(type, path) });
      applyGameOp(draft, { op: 'set', scene: scene.name, node: selection, script: path });
    }, 'Attach script');
    if (ok) { setScriptPath(path); if (create) setWorkspace('script'); }
    setDialog(null);
  };

  const newGame = async (name: string, template: TemplateKind): Promise<void> => {
    const base = nameSlug(name || (template === '2d' ? 'platformer' : 'game'));
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    await saveNow();
    try {
      const g = template === 'empty' ? emptyGame(name.trim() || 'Untitled') : templateGame(template, name.trim() || (template === '2d' ? 'Platformer' : 'Playground'));
      await saveGame({ owner: USER_OWNER, slug }, g, 'editor');
      setDialog(null);
      await refreshList();
      await openGame(`${USER_OWNER}/${slug}`);
    } catch (error) { notify(`Could not create the game: ${String(error)}`, 'error'); }
  };

  const deleteGameFile = async (key: string): Promise<void> => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); stopPlay(); }
      await removeGame(ref);
      const rest = await listGameRefs();
      setRefs(rest);
      if (key === currentRef.current) { if (rest[0]) await openGame(refKey(rest[0])); else { setCurrent(null); setGame(null); gameRef.current = null; setOpenGame(null); } }
    } catch (error) { notify(`Could not delete the game: ${String(error)}`, 'error'); }
  };

  /* ---------- play ---------- */

  const onGameMessage = useCallback((m: GameMessage) => {
    if (m.type === 'log') setLogs((l) => [...l.slice(-400), { level: String(m.level), text: String(m.text), n: ++logN.current }]);
    else if (m.type === 'stats') setStats({ fps: Number(m.fps), nodes: Number(m.nodes), frame: Number(m.frame) });
    else if (m.type === 'quit') stopPlay();
  }, [stopPlay]);

  const startPlay = async (currentSceneOnly: boolean): Promise<void> => {
    const g = gameRef.current;
    if (!g) return;
    stopPlay();
    await saveNow();
    setWorkspace('game');
    setLogs([]);
    setStats(null);
    // wait for the Game workspace to mount its container
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const host = hostRef.current;
    if (!host) return;
    try {
      const handle = await playGame(structuredClone(g), host, onGameMessage, { scene: currentSceneOnly ? sceneRef.current : undefined, debugShapes: showShapes });
      playRef.current = handle;
      setPlaying(true);
      setPaused(false);
      handle.iframe.focus();
    } catch (error) {
      notify(`Could not start the game: ${String(error)}`, 'error');
    }
  };
  const togglePause = (): void => {
    if (!playRef.current) return;
    playRef.current.send({ type: paused ? 'resume' : 'pause' });
    setPaused(!paused);
  };

  const exportHtml = async (download: boolean): Promise<void> => {
    const ref = refOf(current), g = gameRef.current;
    if (!ref || !g) return;
    try {
      const { html, errors } = await exportGameHtml(g);
      if (errors.length) { notify(`Scripts have errors: ${errors[0]}`, 'error'); return; }
      const path = gamePath(ref).replace(/\.game\.json$/, '.html');
      await writeWorktreeFile(path, html);
      if (download) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        a.download = `${nameSlug(g.title)}.html`;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      notify(`Exported ${path} (${Math.round(html.length / 1024)} KB)`);
    } catch (error) { notify(`Could not export: ${String(error)}`, 'error'); }
  };

  /* ---------- menus and keys ---------- */

  const has = !!game;
  /* The callbacks below only run when a menu item is clicked, never while rendering. */
  /* eslint-disable react-hooks/refs */
  const menus = (): Record<string, MenuEntry[]> => ({
    Scene: [
      { label: 'New scene…', onSelect: () => setDialog('scene'), disabled: !has },
      { label: 'Save', keys: 'Ctrl+S', onSelect: () => void saveNow(), disabled: !has },
      { separator: true },
      { label: 'Undo', keys: 'Ctrl+Z', onSelect: undo, disabled: hist.undo === 0 },
      { label: 'Redo', keys: 'Ctrl+Y', onSelect: redo, disabled: hist.redo === 0 },
      { separator: true },
      { label: 'Add child node…', keys: 'Ctrl+A', onSelect: () => setDialog('add'), disabled: !has },
      { label: 'Instance child scene…', onSelect: () => setDialog('instance'), disabled: !has },
      { label: 'Duplicate node', keys: 'Ctrl+D', onSelect: () => selection && selection !== '.' && run({ op: 'duplicate_node', node: selection }, 'Duplicate node'), disabled: !selection || selection === '.' },
      { label: 'Delete node', keys: 'Delete', onSelect: () => selection && selection !== '.' && run({ op: 'remove_node', node: selection }, 'Delete node'), disabled: !selection || selection === '.' },
    ],
    Project: [
      { label: 'Project settings…', onSelect: () => setDialog('settings'), disabled: !has },
      { separator: true },
      { label: 'Export web game (HTML) to workspace', onSelect: () => void exportHtml(false), disabled: !has },
      { label: 'Export web game and download', onSelect: () => void exportHtml(true), disabled: !has },
    ],
    Debug: [
      { label: 'Run project', keys: 'F5', onSelect: () => void startPlay(false), disabled: !has },
      { label: 'Run current scene', keys: 'F6', onSelect: () => void startPlay(true), disabled: !has },
      { label: paused ? 'Resume' : 'Pause', keys: 'F7', onSelect: togglePause, disabled: !playing },
      { label: 'Stop', keys: 'F8', onSelect: stopPlay, disabled: !playing },
      { separator: true },
      { label: 'Visible collision shapes', checked: showShapes, onSelect: () => setShowShapes((s) => !s) },
    ],
    Editor: [
      { label: 'Snap to grid', checked: snap, onSelect: () => setSnap((s) => !s) },
      { label: 'Frame selected node', keys: 'F', onSelect: () => viewportRef.current?.frame(selection), disabled: !selection },
      { label: 'Reset the view', onSelect: () => viewportRef.current?.reset() },
      { separator: true },
      { label: 'Keyboard shortcuts', keys: '?', onSelect: () => setHelpOpen(true) },
    ],
  });

  /* eslint-enable react-hooks/refs */

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.closest('.monaco-editor') !== null;
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    const act = (fn: () => void): void => { e.preventDefault(); fn(); };
    if (e.key === 'F5') return act(() => void startPlay(false));
    if (e.key === 'F6') return act(() => void startPlay(true));
    if (e.key === 'F7') return act(togglePause);
    if (e.key === 'F8') return act(stopPlay);
    if (ctrl && key === 's') return act(() => void saveNow());
    if (typing) return;
    if (ctrl && key === 'z' && !e.shiftKey) return act(undo);
    if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) return act(redo);
    if (ctrl && key === 'a') return act(() => setDialog('add'));
    if (ctrl && key === 'd') return act(() => selection && selection !== '.' && run({ op: 'duplicate_node', node: selection }, 'Duplicate node'));
    if (e.key === 'Delete') return act(() => selection && selection !== '.' && run({ op: 'remove_node', node: selection }, 'Delete node'));
    if (e.key === '?') return act(() => setHelpOpen(true));
    if (e.key === 'Escape') { setMenu(null); setHelpOpen(false); return; }
    if (ctrl || e.altKey) return;
    if (key === 'q') return act(() => setMode('select'));
    if (key === 'w') return act(() => setMode('translate'));
    if (key === 'e') return act(() => setMode('rotate'));
    if (key === 'r') return act(() => setMode('scale'));
    if (key === 'f') return act(() => viewportRef.current?.frame(selection));
  };

  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  const menuDefs = menus();
  const script = scriptPath && game ? game.scripts[scriptPath] : undefined;
  const view: '3d' | '2d' = workspace === '2d' ? '2d' : '3d';
  const gizmos: Array<{ id: GizmoMode; label: string; key: string; icon: typeof Move }> = [
    { id: 'select', label: 'Select', key: 'Q', icon: MousePointer2 }, { id: 'translate', label: 'Move', key: 'W', icon: Move }, { id: 'rotate', label: 'Rotate', key: 'E', icon: Rotate3d }, { id: 'scale', label: 'Scale', key: 'R', icon: Scale3d },
  ];
  const tabs: Array<{ id: Workspace; label: string; icon: typeof BoxIcon }> = [
    { id: '2d', label: '2D', icon: Square }, { id: '3d', label: '3D', icon: BoxIcon }, { id: 'script', label: 'Script', icon: FileCode2 }, { id: 'game', label: 'Game', icon: Gamepad2 },
  ];

  return (
    <div className="screen gm">
      <header className="screen-header">
        <h1 className="screen-header__title">Game Engine</h1>
        <span className="screen-header__meta">Godot-style scenes, nodes and scripts on three.js — the Game Developer agent builds on the same project</span>
        {current && <span className={`gm__save gm__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="gm__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={filesOpen} onClick={() => setFilesOpen((o) => !o)}>
            <Gamepad2 size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Games'} <ChevronDown size={11} />
          </button>
          {filesOpen && (
            <div className="gm__popup gm__popup--list" role="menu" aria-label="Games">
              {refs.length === 0 && <p className="gm-note gm-pad">No games yet — create one, or ask the Game Developer agent.</p>}
              {grouped.map(([owner, list]) => (
                <div key={owner}>
                  <div className="gm__owner">{owner}</div>
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`gm__file${key === current ? ' gm__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="gm__file-main" title={gamePath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openGame(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="gm-icon gm-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteGameFile(key)}><Check size={12} /></button>
                            <button type="button" className="gm-icon" aria-label="Keep game" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : <button type="button" className="gm-icon gm__file-del" aria-label={`Delete ${ref.slug}`} title="Delete game" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="primary-button" onClick={() => setDialog('new')}><Plus size={12} strokeWidth={1.5} /> New game</button>
      </header>

      <div className="screen-body gm__body">
        <div className="gm__main" onKeyDown={onKeyDown}>
          <nav className="gm__menubar" aria-label="Game menu">
            {/* eslint-disable-next-line react-hooks/refs */}
            {Object.entries(menuDefs).map(([name, entries]) => (
              <div key={name} className="gm__menu">
                <button type="button" className={`gm__menu-btn${menu === name ? ' gm__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => { if (menu) setMenu(name); }}>{name}</button>
                {menu === name && (
                  <div className="gm__popup" role="menu" aria-label={name}>
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
            <div className="gm__tabs" role="tablist" aria-label="Workspace">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button key={id} type="button" role="tab" aria-selected={workspace === id} className={`gm__tab${workspace === id ? ' gm__tab--on' : ''}`} onClick={() => setWorkspace(id)}><Icon size={12} /> {label}</button>
              ))}
            </div>
            <div className="gm__run" role="toolbar" aria-label="Run">
              <button type="button" className="gm-icon gm-icon--play" aria-label="Play" title="Run the project (F5)" disabled={!has} onClick={() => void startPlay(false)}><Play size={14} /></button>
              <button type="button" className="gm-icon" aria-label="Pause" title="Pause (F7)" aria-pressed={paused} disabled={!playing} onClick={togglePause}><Pause size={14} /></button>
              <button type="button" className="gm-icon gm-icon--stop" aria-label="Stop" title="Stop (F8)" disabled={!playing} onClick={stopPlay}><Square size={13} /></button>
              <button type="button" className="gm-icon" aria-label="Play scene" title="Run the current scene (F6)" disabled={!has} onClick={() => void startPlay(true)}><SkipForward size={14} /></button>
              <button type="button" className={`gm-icon${showShapes ? ' gm-icon--on' : ''}`} aria-label="Collision shapes" aria-pressed={showShapes} title="Visible collision shapes" onClick={() => setShowShapes((s) => !s)}><Bug size={14} /></button>
            </div>
            <button type="button" className="gm-icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={hist.undo === 0} onClick={undo}><Undo2 size={14} /></button>
            <button type="button" className="gm-icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={hist.redo === 0} onClick={redo}><Redo2 size={14} /></button>
            <button type="button" className="gm-icon" aria-label="Project settings" title="Project settings" disabled={!has} onClick={() => setDialog('settings')}><Settings size={14} /></button>
            <button type="button" className="gm-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
          </nav>

          {game && scene ? (
            <div className="gm__work" tabIndex={0} aria-label="Game editor">
              <aside className="gm__left" aria-label="Scene and files">
                <section className="gm__dock" aria-label="Scene dock">
                  <h2 className="gm__dock-head">Scene <select className="gm-select" aria-label="Edited scene" value={scene.name} onChange={(e) => { setSceneName(e.target.value); setSelection('.'); }}>{Object.keys(game.scenes).map((n) => <option key={n} value={n}>{n}{n === game.settings.mainScene ? ' ★' : ''}</option>)}</select></h2>
                  <SceneTree scene={scene} game={game} selected={selection} onSelect={setSelection} run={run} onAdd={() => setDialog('add')} onInstance={() => setDialog('instance')} onAttach={() => setDialog('attach')} />
                </section>
                <section className="gm__dock gm__dock--fs" aria-label="File system dock">
                  <h2 className="gm__dock-head">FileSystem</h2>
                  <FileSystem game={game} sceneName={scene.name} scriptPath={scriptPath} onOpenScene={(n) => { setSceneName(n); setSelection('.'); }} onOpenScript={(p) => { setScriptPath(p); setWorkspace('script'); }} run={run} onNewScene={() => setDialog('scene')} onNewScript={() => setDialog('script')} />
                </section>
              </aside>

              <div className="gm__center">
                {(workspace === '3d' || workspace === '2d') && (
                  <div className="gm__viewport">
                    <div className="gm__vp-head" role="toolbar" aria-label="Viewport tools">
                      {gizmos.map(({ id, label, key, icon: Icon }) => <button key={id} type="button" className={`gm-icon${mode === id ? ' gm-icon--on' : ''}`} aria-label={label} aria-pressed={mode === id} title={`${label} (${key})`} onClick={() => setMode(id)}><Icon size={14} /></button>)}
                      <span className="gm__sep" />
                      <button type="button" className={`gm-icon${snap ? ' gm-icon--on' : ''}`} aria-label="Snap" aria-pressed={snap} title="Snap" onClick={() => setSnap((s) => !s)}><Magnet size={14} /></button>
                      <button type="button" className="gm-icon" aria-label="Frame selected" title="Frame the selected node (F)" onClick={() => viewportRef.current?.frame(selection)}><Maximize size={14} /></button>
                      <span className="gm-grow" />
                      <span className="gm-note">{workspace === '2d' ? '2D: pixels, +Y up' : '3D: metres, +Y up'} · {countNodes(scene)} nodes</span>
                    </div>
                    <GameViewport ref={viewportRef} game={game} sceneName={scene.name} view={view} selection={selection} mode={mode} snap={snap} showShapes={showShapes} onSelect={setSelection} onTransform={onTransform} />
                  </div>
                )}
                {workspace === 'script' && (
                  <div className="gm__script">
                    <div className="gm__script-head">
                      <FileCode2 size={13} /> <strong>{scriptPath ?? 'No script open'}</strong>
                      {script && <span className="gm-note">{scriptBase(script.code) ? `extends ${scriptBase(script.code)}` : 'no "export default class … extends …"'}</span>}
                      <span className="gm-grow" />
                      <select className="gm-select" aria-label="Open script" value={scriptPath ?? ''} onChange={(e) => setScriptPath(e.target.value || null)}>
                        <option value="">— script —</option>
                        {Object.keys(game.scripts).map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <button type="button" className="gm-btn" onClick={() => setDialog('script')}><Plus size={12} /> New</button>
                    </div>
                    {script && scriptPath ? (
                      <div className="gm__editor" data-testid="script-editor">
                        <Editor
                          key={scriptPath}
                          path={`file:///game/${scriptPath}`}
                          value={script.code}
                          language="typescript"
                          onChange={(value) => { if (value !== undefined && value !== script.code) run({ op: 'set_script', path: scriptPath, code: value }, 'Edit script', `script:${scriptPath}`); }}
                          beforeMount={(monaco) => {
                            type TsApi = { typescriptDefaults?: { addExtraLib(content: string, filePath: string): unknown; getExtraLibs(): Record<string, unknown> } };
                            const ts = (monaco as unknown as { typescript?: TsApi }).typescript;
                            const tsd = ts?.typescriptDefaults;
                            if (tsd && !('ts:game-api.d.ts' in tsd.getExtraLibs())) tsd.addExtraLib(GAME_API_DTS, 'ts:game-api.d.ts');
                          }}
                          onMount={(editor, monaco) => { editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveNow(); }); editor.addCommand(monaco.KeyCode.F5, () => { void startPlay(false); }); }}
                          options={{ fontSize: 13, lineHeight: 20, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 10, bottom: 10 }, tabSize: 2 }}
                        />
                      </div>
                    ) : <p className="gm-note gm-pad">Open a script from the FileSystem dock, or attach a new script to a node.</p>}
                  </div>
                )}
                {workspace === 'game' && (
                  <div className="gm__game" aria-label="Running game">
                    <div ref={hostRef} className="gm__game-host" data-testid="game-host" />
                    {!playing && <div className="gm__game-hint"><Clapperboard size={28} strokeWidth={1.25} /><p>Press Play (F5) to run <strong>{game.title}</strong>, or F6 for the scene you are editing.</p></div>}
                  </div>
                )}
                <Output lines={logs} stats={stats} onClear={() => setLogs([])} />
              </div>

              <aside className="gm__right" aria-label="Inspector">
                <div className="gm-tabs" role="tablist" aria-label="Inspector tabs">
                  <button type="button" role="tab" aria-selected={rightTab === 'inspector'} className={`gm-tab${rightTab === 'inspector' ? ' gm-tab--on' : ''}`} onClick={() => setRightTab('inspector')}>Inspector</button>
                  <button type="button" role="tab" aria-selected={rightTab === 'node'} className={`gm-tab${rightTab === 'node' ? ' gm-tab--on' : ''}`} onClick={() => setRightTab('node')}>Node</button>
                </div>
                <div className="gm__right-body">
                  {rightTab === 'inspector'
                    ? <Inspector game={game} scene={scene} path={selection} run={run} onOpenScript={(p) => { setScriptPath(p); setWorkspace('script'); }} onAttach={() => setDialog('attach')} />
                    : <NodeDock scene={scene} path={selection} run={run} />}
                </div>
              </aside>
            </div>
          ) : (
            <div className="gm__welcome">
              <Gamepad2 size={34} strokeWidth={1.25} />
              <h2>Game Engine</h2>
              <p>Build games the Godot way: scenes made of nodes, scripts in TypeScript or JavaScript, physics, input and UI, running on three.js. Start from a 3D playground or a 2D platformer — or ask the Game Developer agent to build one.</p>
              <button type="button" className="primary-button" onClick={() => setDialog('new')}><Plus size={12} strokeWidth={1.5} /> New game</button>
            </div>
          )}
          {helpOpen && <ShortcutHelp title="Game Engine shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
        </div>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('gameengine')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {dialog === 'new' && <NewGameDialog onCreate={(n, t) => void newGame(n, t)} onClose={() => setDialog(null)} />}
      {dialog === 'add' && game && scene && <AddNodeDialog parentType={selectedNode?.type ?? ''} onAdd={addNode} onClose={() => setDialog(null)} />}
      {dialog === 'instance' && game && scene && <PickSceneDialog game={game} exclude={scene.name} onPick={instanceScene} onClose={() => setDialog(null)} />}
      {dialog === 'attach' && game && selectedNode && <AttachScriptDialog game={game} nodeType={selectedNode.type} onPick={(p) => attachScript(p, false)} onNew={(p) => attachScript(p, true)} onClose={() => setDialog(null)} />}
      {dialog === 'scene' && <NameDialog title="New scene" label="Scene name" placeholder="level1" rootTypes={['Node3D', 'Node2D', 'Node', 'Control', 'CharacterBody3D', 'CharacterBody2D', 'StaticBody3D', 'RigidBody3D', 'Area3D', 'Area2D']} onClose={() => setDialog(null)} onOk={(name, rootType) => { run({ op: 'add_scene', name: nameSlug(name), rootType: rootType && NODE_TYPES[rootType] ? rootType : 'Node3D' }, 'Add scene'); setSceneName(nameSlug(name)); setSelection('.'); setDialog(null); }} />}
      {dialog === 'script' && game && <NameDialog title="New script" label="Script name" placeholder="enemy" onClose={() => setDialog(null)} onOk={(name) => { const path = `scripts/${name.replace(/[^A-Za-z0-9_\-/]/g, '_')}.ts`; run({ op: 'set_script', path, code: newScriptCode('Node', path) }, 'New script'); setScriptPath(path); setWorkspace('script'); setDialog(null); }} />}
      {dialog === 'settings' && game && <SettingsDialog game={game} run={run} onClose={() => setDialog(null)} />}
    </div>
  );
}
