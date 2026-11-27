import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Globe, Plus, Send, X } from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { nameSlug, USER_OWNER } from '../../lib/ownedFiles';
import { writeWorktreeFile, yamlToJson } from '../../lib/tauriClient';
import { PromptDialog } from '../docs/DocsDialogs';
import {
  addItem, clone, duplicateItem, effectiveAuth, emptyCollection, emptyEnvironment, findItem, listRequests, moveItem, newFolder, newId, newRequest, newVariable, prepareRequest, removeItem, reId,
  varsToMap, walk,
  type ApiFolder, type ApiItem, type ApiRequest, type Collection, type CookieJar, type Environment, type HistoryEntry, type Variable, type VarScopes,
} from './api';
import { exportEnvironment, exportPostman, importAny, parseCurl } from './apiFormat';
import { runCollection, runRequest, scopeChanges, type RunnerStep, type RunResult } from './apiRun';
import {
  API_CHANGED, API_LOCAL_CHANGED, API_OPEN, cancelRequest, getSelectedEnvironment, listCollectionRefs, listEnvironmentRefs, loadCollection,
  loadCookies, loadEnvironment, loadGlobals, loadHistory, pushHistory, refOfKey, registerApiFlush, removeCollection, removeEnvironment, removeHistory, runScriptSandboxed, saveCollection,
  saveCookies, saveEnvironment, saveGlobals, sendViaBackend, setOpenApi, setSelectedEnvironment, takePendingOpenApi, type ApiChange, type ApiOpenRequest,
} from './apiStore';
import { MethodBadge, type ResponseTab } from './ApiParts';
import { CodeDialog, ImportDialog, RunnerDialog, SaveAsDialog, UnsavedDialog, type SaveTarget } from './ApiDialogs';
import { CollectionTree, ConfirmDelete, EnvironmentList, HistoryList, SideHeader, type DragRef, type DropPos, type MenuItem, type SideSection } from './ApiSidebar';
import { ContainerEditor, EnvironmentEditor, RequestEditor, type ContainerSection, type ReqTab } from './ApiEditors';
import './ApiScreen.css';

const SAVE_DELAY = 600;
const GLOBALS = 'globals';

type Tab =
  | { id: string; kind: 'request'; source: { key: string; id: string } | null; draft: ApiRequest; dirty: boolean; result: RunResult | null; sending: string | null; reqTab: ReqTab; resTab: ResponseTab }
  | { id: string; kind: 'collection'; key: string; section: ContainerSection }
  | { id: string; kind: 'folder'; key: string; folder: string; section: ContainerSection }
  | { id: string; kind: 'environment'; key: string };
type RequestTab = Extract<Tab, { kind: 'request' }>;

/** Open tabs survive switching to another menu and back. */
const memo: { tabs: Tab[]; active: string | null; open: string[] } = { tabs: [], active: null, open: [] };

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Requests', items: [{ keys: 'Ctrl+Enter', label: 'Send the request' }, { keys: 'Ctrl+S', label: 'Save the request' }, { keys: 'Alt+T', label: 'New request tab' }, { keys: 'Alt+W', label: 'Close the tab' }, { keys: 'Ctrl+/', label: 'This list' }] },
  { title: 'Editors', items: [{ keys: 'Tab / Shift+Tab', label: 'Indent in body and script editors' }, { keys: 'Enter', label: 'Send from the URL bar' }] },
];

const nowIso = (): string => new Date().toISOString();
const isReq = (t: Tab | undefined): t is RequestTab => t?.kind === 'request';
const stripFiles = (r: ApiRequest): ApiRequest => ({ ...r, body: { ...r.body, formdata: r.body.formdata.map((f) => (f.src ? { ...f, src: undefined } : f)), file: r.body.file ? { name: r.body.file.name, src: '' } : null } });
/** Applies a run's variable changes to a list of variables (existing keys get the new value, new keys are added). */
function applyVarChanges(vars: Variable[], ch: { set: Record<string, string>; unset: string[] }): Variable[] {
  const out = vars.filter((v) => !ch.unset.includes(v.key)).map((v) => (Object.prototype.hasOwnProperty.call(ch.set, v.key) ? { ...v, value: ch.set[v.key] } : v));
  for (const [k, v] of Object.entries(ch.set)) if (!out.some((x) => x.key === k)) out.push(newVariable(k, v));
  return out;
}
const changed = (ch: { set: Record<string, string>; unset: string[] }): boolean => Object.keys(ch.set).length > 0 || ch.unset.length > 0;
const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });

export function ApiScreen() {
  const { repository, notify } = useRepository();
  const [cols, setCols] = useState<Record<string, Collection>>({});
  const [colKeys, setColKeys] = useState<string[]>([]);
  const [envs, setEnvs] = useState<Record<string, Environment>>({});
  const [envKeys, setEnvKeys] = useState<string[]>([]);
  const [globals, setGlobals] = useState<Environment>(() => emptyEnvironment('Globals'));
  const [selectedEnv, setSelectedEnv] = useState<string | null>(() => getSelectedEnvironment());
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [jar, setJar] = useState<CookieJar>({});
  const [tabs, setTabs] = useState<Tab[]>(() => memo.tabs);
  const [active, setActive] = useState<string | null>(() => memo.active);
  const [open, setOpen] = useState<Set<string>>(() => new Set(memo.open));
  const [section, setSection] = useState<SideSection>('collections');
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<{ key: string; id: string | null } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'import' } | { kind: 'code'; tab: string } | { kind: 'saveas'; tab: string; closeAfter?: boolean } | { kind: 'unsaved'; tab: string } | { kind: 'help' }
    | { kind: 'newcol' } | { kind: 'newenv' } | { kind: 'delete'; what: string; run: () => void } | { kind: 'export'; title: string; text: string; file: string }
    | { kind: 'run'; key: string; folder: string | null } | null
  >(null);
  const [runner, setRunner] = useState<{ running: boolean; steps: RunnerStep[] }>({ running: false, steps: [] });
  const [saving, setSaving] = useState(false);
  const [dirtyTick, setDirtyTick] = useState(0);
  const [split, setSplit] = useState(300);
  const [sideWidth, setSideWidth] = useState(280);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);
  const [now, setNow] = useState(0);

  const colsRef = useRef(cols);
  const envsRef = useRef(envs);
  const globalsRef = useRef(globals);
  const tabsRef = useRef(tabs);
  const jarRef = useRef(jar);
  const dirtyCols = useRef(new Set<string>());
  const dirtyEnvs = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const fileTarget = useRef<{ tab: string; target: 'binary' | string } | null>(null);
  const stopRun = useRef(false);

  useEffect(() => { colsRef.current = cols; }, [cols]);
  useEffect(() => { envsRef.current = envs; }, [envs]);
  useEffect(() => { globalsRef.current = globals; }, [globals]);
  useEffect(() => { tabsRef.current = tabs; memo.tabs = tabs; }, [tabs]);
  useEffect(() => { memo.active = active; }, [active]);
  useEffect(() => { memo.open = [...open]; }, [open]);
  useEffect(() => { jarRef.current = jar; }, [jar]);
  useEffect(() => { const t = window.setTimeout(() => setNow(Date.now()), 0); const i = window.setInterval(() => setNow(Date.now()), 60_000); return () => { window.clearTimeout(t); window.clearInterval(i); }; }, []);

  /* ---------- loading ---------- */

  const reloadAll = useCallback(async () => {
    const [cRefs, eRefs] = await Promise.all([listCollectionRefs().catch(() => []), listEnvironmentRefs().catch(() => [])]);
    const nextCols: Record<string, Collection> = {};
    for (const ref of cRefs) {
      const key = `${ref.owner ? `${ref.owner}/` : ''}${ref.slug}`;
      if (dirtyCols.current.has(key) && colsRef.current[key]) { nextCols[key] = colsRef.current[key]; continue; }
      try { nextCols[key] = (await loadCollection(ref)).collection; } catch { /* unreadable: skipped */ }
    }
    const nextEnvs: Record<string, Environment> = {};
    for (const ref of eRefs) {
      const key = `${ref.owner ? `${ref.owner}/` : ''}${ref.slug}`;
      if (dirtyEnvs.current.has(key) && envsRef.current[key]) { nextEnvs[key] = envsRef.current[key]; continue; }
      try { nextEnvs[key] = await loadEnvironment(ref); } catch { /* unreadable */ }
    }
    const g = dirtyEnvs.current.has(GLOBALS) ? globalsRef.current : await loadGlobals();
    colsRef.current = nextCols; envsRef.current = nextEnvs; globalsRef.current = g;
    setCols(nextCols); setColKeys(Object.keys(nextCols));
    setEnvs(nextEnvs); setEnvKeys(Object.keys(nextEnvs));
    setGlobals(g);
    // clean tabs of saved requests follow the files
    setTabs((list) => list.flatMap((t): Tab[] => {
      if (t.kind === 'request' && t.source && !t.dirty) {
        const found = nextCols[t.source.key] ? findItem(nextCols[t.source.key], t.source.id) : null;
        if (!found || found.item.type !== 'request') return [{ ...t, source: null, dirty: true }];
        return [{ ...t, draft: clone(found.item) }];
      }
      if (t.kind === 'collection' && !nextCols[t.key]) return [];
      if (t.kind === 'folder' && (!nextCols[t.key] || !findItem(nextCols[t.key], t.folder))) return [];
      if (t.kind === 'environment' && t.key !== GLOBALS && !nextEnvs[t.key]) return [];
      return [t];
    }));
  }, []);

  const openRequestTab = useCallback((key: string, id: string) => {
    const c = colsRef.current[key];
    const found = c ? findItem(c, id) : null;
    if (!found || found.item.type !== 'request') return;
    const item = found.item;
    const existing = tabsRef.current.find((t) => t.kind === 'request' && t.source?.key === key && t.source.id === id);
    if (existing) { setActive(existing.id); return; }
    const tab: RequestTab = { id: newId('t'), kind: 'request', source: { key, id }, draft: clone(item), dirty: false, result: null, sending: null, reqTab: 'params', resTab: 'body' };
    setTabs((l) => [...l, tab]);
    setActive(tab.id);
    setOpen((s) => new Set([...s, key, ...found.folders.map((f) => f.id)]));
  }, []);

  /* ---------- saving collections and environments ---------- */

  const saveNow = useCallback(async () => {
    const colList = [...dirtyCols.current], envList = [...dirtyEnvs.current];
    if (!colList.length && !envList.length) return;
    dirtyCols.current.clear(); dirtyEnvs.current.clear();
    setSaving(true);
    try {
      for (const key of colList) { const c = colsRef.current[key]; if (c) await saveCollection(refOfKey(key), c, 'editor'); }
      for (const key of envList) {
        if (key === GLOBALS) await saveGlobals(globalsRef.current, 'editor');
        else { const e = envsRef.current[key]; if (e) await saveEnvironment(refOfKey(key), e, 'editor'); }
      }
    } catch (error) {
      for (const k of colList) dirtyCols.current.add(k);
      for (const k of envList) dirtyEnvs.current.add(k);
      notify(`Could not save: ${String(error)}`, 'error');
    } finally { setSaving(false); }
  }, [notify]);
  useEffect(() => {
    if (!dirtyTick) return;
    const t = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
    return () => window.clearTimeout(t);
  }, [dirtyTick, saveNow]);
  useEffect(() => registerApiFlush(saveNow), [saveNow]);
  useEffect(() => () => { void saveNow(); }, [saveNow]);

  const editCollection = (key: string, fn: (c: Collection) => void | false): boolean => {
    const base = colsRef.current[key];
    if (!base) return false;
    const next = clone(base);
    if (fn(next) === false) return false;
    const all = { ...colsRef.current, [key]: next };
    colsRef.current = all;
    setCols(all);
    dirtyCols.current.add(key);
    setDirtyTick((t) => t + 1);
    return true;
  };
  const editEnv = (key: string, fn: (e: Environment) => void) => {
    if (key === GLOBALS) {
      const next = clone(globalsRef.current); fn(next);
      globalsRef.current = next; setGlobals(next);
    } else {
      const base = envsRef.current[key];
      if (!base) return;
      const next = clone(base); fn(next);
      const all = { ...envsRef.current, [key]: next };
      envsRef.current = all; setEnvs(all);
    }
    dirtyEnvs.current.add(key);
    setDirtyTick((t) => t + 1);
  };

  /* ---------- tabs ---------- */

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[tabs.length - 1];
  const activeId = activeTab?.id ?? null;
  const updateTab = (id: string, patch: Partial<RequestTab> | ((t: Tab) => Tab)) => setTabs((l) => l.map((t) => (t.id !== id ? t : typeof patch === 'function' ? patch(t) : ({ ...t, ...patch } as Tab))));
  const editDraft = (id: string, fn: (r: ApiRequest) => void) => updateTab(id, (t) => {
    if (t.kind !== 'request') return t;
    const draft = { ...t.draft, params: [...t.draft.params], headers: [...t.draft.headers], pathVars: [...t.draft.pathVars], body: { ...t.draft.body }, settings: { ...t.draft.settings }, auth: { ...t.draft.auth } };
    fn(draft);
    return { ...t, draft, dirty: true };
  });
  const newRequestTab = (req?: ApiRequest) => {
    const tab: RequestTab = { id: newId('t'), kind: 'request', source: null, draft: req ?? newRequest({ name: 'Untitled Request' }), dirty: !!req, result: null, sending: null, reqTab: 'params', resTab: 'body' };
    setTabs((l) => [...l, tab]);
    setActive(tab.id);
    return tab.id;
  };
  const openContainer = (key: string, folder: string | null) => {
    const existing = tabsRef.current.find((t) => (folder ? t.kind === 'folder' && t.key === key && t.folder === folder : t.kind === 'collection' && t.key === key));
    if (existing) { setActive(existing.id); return; }
    const tab: Tab = folder ? { id: newId('t'), kind: 'folder', key, folder, section: 'overview' } : { id: newId('t'), kind: 'collection', key, section: 'overview' };
    setTabs((l) => [...l, tab]);
    setActive(tab.id);
  };
  const openEnvTab = (key: string) => {
    const existing = tabsRef.current.find((t) => t.kind === 'environment' && t.key === key);
    if (existing) { setActive(existing.id); return; }
    const tab: Tab = { id: newId('t'), kind: 'environment', key };
    setTabs((l) => [...l, tab]);
    setActive(tab.id);
  };
  const closeTab = (id: string, force = false) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    if (!force && isReq(t) && t.dirty) { setDialog({ kind: 'unsaved', tab: id }); return; }
    if (isReq(t) && t.sending) void cancelRequest(t.sending);
    const list = tabsRef.current;
    const i = list.findIndex((x) => x.id === id);
    const rest = list.filter((x) => x.id !== id);
    setTabs(rest);
    if (activeId === id) setActive(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  };

  const handleOpen = (r: ApiOpenRequest) => {
    setSection('collections');
    setOpen((s) => new Set([...s, r.key]));
    if (r.request) openRequestTab(r.key, r.request);
    else if (colsRef.current[r.key]) openContainer(r.key, null);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reloadAll();
      const [h, j] = await Promise.all([loadHistory(), loadCookies()]);
      if (cancelled) return;
      setHistory(h); setJar(j);
      const pending = takePendingOpenApi();
      if (pending) handleOpen(pending);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<ApiChange>).detail;
      if (change.source === 'agent' || change.deleted) void reloadAll();
    };
    const onOpen = (event: Event) => { takePendingOpenApi(); const r = (event as CustomEvent<ApiOpenRequest>).detail; void reloadAll().then(() => handleOpen(r)); };
    const onLocal = () => { void loadHistory().then(setHistory); setSelectedEnv(getSelectedEnvironment()); };
    window.addEventListener(API_CHANGED, onChanged);
    window.addEventListener(API_OPEN, onOpen);
    window.addEventListener(API_LOCAL_CHANGED, onLocal);
    return () => { window.removeEventListener(API_CHANGED, onChanged); window.removeEventListener(API_OPEN, onOpen); window.removeEventListener(API_LOCAL_CHANGED, onLocal); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadAll]);

  /* ---------- saving a request ---------- */

  const saveRequestTab = (id: string): boolean => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!isReq(t)) return false;
    if (!t.source || !colsRef.current[t.source.key] || !findItem(colsRef.current[t.source.key], t.source.id)) { setDialog({ kind: 'saveas', tab: id }); return false; }
    const { key, id: rid } = t.source;
    editCollection(key, (c) => { const f = findItem(c, rid); if (!f) return false; (f.parent ? f.parent.items : c.items)[f.index] = clone(t.draft); });
    updateTab(id, { dirty: false });
    return true;
  };
  const saveAs = async (tabId: string, target: SaveTarget, closeAfter?: boolean) => {
    setDialog(null);
    const t = tabsRef.current.find((x) => x.id === tabId);
    if (!isReq(t)) return;
    let key = target.collection;
    if (!key || !colsRef.current[key]) key = await createCollection('My Collection', false);
    if (!key) return;
    const req = { ...clone(t.draft), id: newId('r'), name: target.name };
    editCollection(key, (c) => { addItem(c, req, target.folder); });
    setOpen((s) => new Set([...s, key, ...(target.folder ? [target.folder] : [])]));
    updateTab(tabId, { source: { key, id: req.id }, draft: req, dirty: false });
    if (closeAfter) closeTab(tabId, true);
  };

  /* ---------- collections, folders, environments ---------- */

  const uniqueKey = (base: string, ext: 'collection' | 'environment'): string => {
    const taken = new Set(ext === 'collection' ? Object.keys(colsRef.current) : [...Object.keys(envsRef.current), `${USER_OWNER}/globals`]);
    const slug = nameSlug(base, ['.api.json', '.env.json']);
    let key = `${USER_OWNER}/${slug}`;
    for (let n = 2; taken.has(key); n++) key = `${USER_OWNER}/${slug}-${n}`;
    return key;
  };
  const createCollection = async (name: string, startRename = true, from?: Collection): Promise<string> => {
    const key = uniqueKey(name, 'collection');
    const c = from ?? emptyCollection(name.trim() || 'New Collection');
    try {
      await saveCollection(refOfKey(key), c, 'editor');
      const all = { ...colsRef.current, [key]: c };
      colsRef.current = all; setCols(all); setColKeys(Object.keys(all));
      setOpen((s) => new Set([...s, key]));
      setSection('collections');
      if (startRename) setRenaming({ key, id: null });
      return key;
    } catch (error) { notify(`Could not create the collection: ${String(error)}`, 'error'); return ''; }
  };
  const createEnvironment = async (name: string, from?: Environment): Promise<string> => {
    const key = uniqueKey(name, 'environment');
    const env = from ?? emptyEnvironment(name.trim() || 'New Environment');
    try {
      await saveEnvironment(refOfKey(key), env, 'editor');
      const all = { ...envsRef.current, [key]: env };
      envsRef.current = all; setEnvs(all); setEnvKeys(Object.keys(all));
      setSection('environments');
      openEnvTab(key);
      return key;
    } catch (error) { notify(`Could not create the environment: ${String(error)}`, 'error'); return ''; }
  };
  const deleteCollection = async (key: string) => {
    try {
      await removeCollection(refOfKey(key));
      const all = { ...colsRef.current }; delete all[key];
      colsRef.current = all; setCols(all); setColKeys(Object.keys(all));
      setTabs((l) => l.filter((t) => !((t.kind === 'collection' || t.kind === 'folder') && t.key === key)).map((t) => (t.kind === 'request' && t.source?.key === key ? { ...t, source: null, dirty: true } : t)));
    } catch (error) { notify(`Could not delete: ${String(error)}`, 'error'); }
  };
  const deleteEnv = async (key: string) => {
    try {
      await removeEnvironment(refOfKey(key));
      const all = { ...envsRef.current }; delete all[key];
      envsRef.current = all; setEnvs(all); setEnvKeys(Object.keys(all));
      if (selectedEnv === key) chooseEnv(null);
      setTabs((l) => l.filter((t) => !(t.kind === 'environment' && t.key === key)));
    } catch (error) { notify(`Could not delete: ${String(error)}`, 'error'); }
  };
  const chooseEnv = (key: string | null) => { setSelectedEnv(key); setSelectedEnvironment(key); };

  const addRequestTo = (key: string, folder: string | null) => {
    const r = newRequest({ name: 'New Request' });
    editCollection(key, (c) => { addItem(c, r, folder); });
    setOpen((s) => new Set([...s, key, ...(folder ? [folder] : [])]));
    const tab: RequestTab = { id: newId('t'), kind: 'request', source: { key, id: r.id }, draft: clone(r), dirty: false, result: null, sending: null, reqTab: 'params', resTab: 'body' };
    setTabs((l) => [...l, tab]);
    setActive(tab.id);
    setRenaming({ key, id: r.id });
  };
  const addFolderTo = (key: string, parent: string | null) => {
    const f = newFolder('New Folder');
    editCollection(key, (c) => { addItem(c, f, parent); });
    setOpen((s) => new Set([...s, key, ...(parent ? [parent] : [])]));
    setRenaming({ key, id: f.id });
  };
  const rename = (key: string, id: string | null, name: string | null) => {
    setRenaming(null);
    if (!name) return;
    editCollection(key, (c) => { if (id === null) c.name = name; else { const f = findItem(c, id); if (!f) return false; f.item.name = name; } });
    if (id) setTabs((l) => l.map((t) => (t.kind === 'request' && t.source?.key === key && t.source.id === id ? { ...t, draft: { ...t.draft, name } } : t)));
  };
  const onDrop = (from: DragRef, to: { key: string; id: string | null }, pos: DropPos) => {
    if (pos === 'inside') setOpen((o) => new Set([...o, to.key, ...(to.id ? [to.id] : [])]));
    if (from.key === to.key) { editCollection(from.key, (c) => (moveItem(c, from.id, to.id, pos) ? undefined : false)); return; }
    const src = colsRef.current[from.key];
    const moving = src ? findItem(src, from.id)?.item : null;
    if (!moving) return;
    const ok = editCollection(to.key, (c) => {
      if (to.id === null) { addItem(c, moving); return; }
      const t = findItem(c, to.id);
      if (!t) return false;
      if (pos === 'inside' && t.item.type === 'folder') t.item.items.push(moving);
      else (t.parent ? t.parent.items : c.items).splice(t.index + (pos === 'after' ? 1 : 0), 0, moving);
    });
    if (ok) {
      editCollection(from.key, (c) => { removeItem(c, from.id); });
      setTabs((l) => l.map((t) => (t.kind === 'request' && t.source?.key === from.key && (t.source.id === from.id || (moving.type === 'folder' && [...walk(moving.items)].some((f) => f.item.id === t.source?.id))) ? { ...t, source: { key: to.key, id: t.source.id } } : t)));
    }
  };
  const menuFor = (key: string, item: ApiItem | null): MenuItem[] => {
    const c = colsRef.current[key];
    if (!item) return [
      { label: 'Add request', run: () => addRequestTo(key, null) },
      { label: 'Add folder', run: () => addFolderTo(key, null) },
      { label: 'Run collection', run: () => { setRunner({ running: false, steps: [] }); setDialog({ kind: 'run', key, folder: null }); } },
      { label: 'Rename', run: () => setRenaming({ key, id: null }) },
      { label: 'Duplicate', run: () => { if (c) { const copy = clone(c); copy.items = copy.items.map(reId); copy.name = `${c.name} Copy`; void createCollection(copy.name, false, copy); } } },
      { label: 'Export (Postman v2.1)', run: () => { if (c) setDialog({ kind: 'export', title: `Export ${c.name}`, text: JSON.stringify(exportPostman(c), null, 2), file: `${key.split('/').pop()}.postman_collection.json` }); } },
      { label: 'Delete', danger: true, run: () => setDialog({ kind: 'delete', what: `collection “${c?.name ?? key}”`, run: () => void deleteCollection(key) }) },
    ];
    if (item.type === 'folder') return [
      { label: 'Add request', run: () => addRequestTo(key, item.id) },
      { label: 'Add folder', run: () => addFolderTo(key, item.id) },
      { label: 'Run folder', run: () => { setRunner({ running: false, steps: [] }); setDialog({ kind: 'run', key, folder: item.id }); } },
      { label: 'Rename', run: () => setRenaming({ key, id: item.id }) },
      { label: 'Duplicate', run: () => editCollection(key, (x) => { duplicateItem(x, item.id); }) },
      { label: 'Delete', danger: true, run: () => setDialog({ kind: 'delete', what: `folder “${item.name}” and everything in it`, run: () => { editCollection(key, (x) => { removeItem(x, item.id); }); } }) },
    ];
    return [
      { label: 'Open in a tab', run: () => openRequestTab(key, item.id) },
      { label: 'Rename', run: () => setRenaming({ key, id: item.id }) },
      { label: 'Duplicate', run: () => { let copy: ApiItem | null = null; editCollection(key, (x) => { copy = duplicateItem(x, item.id); }); if (copy) window.setTimeout(() => openRequestTab(key, (copy as ApiItem).id), 0); } },
      { label: 'Delete', danger: true, run: () => setDialog({ kind: 'delete', what: `request “${item.name}”`, run: () => { editCollection(key, (x) => { removeItem(x, item.id); }); setTabs((l) => l.filter((t) => !(t.kind === 'request' && t.source?.key === key && t.source.id === item.id))); } }) },
    ];
  };
  const envMenu = (key: string): MenuItem[] => {
    const e = envsRef.current[key];
    return [
      { label: selectedEnv === key ? 'Deactivate' : 'Set active', run: () => chooseEnv(selectedEnv === key ? null : key) },
      { label: 'Duplicate', run: () => { if (e) void createEnvironment(`${e.name} Copy`, { ...clone(e), name: `${e.name} Copy` }); } },
      { label: 'Export', run: () => { if (e) setDialog({ kind: 'export', title: `Export ${e.name}`, text: JSON.stringify(exportEnvironment(e), null, 2), file: `${key.split('/').pop()}.postman_environment.json` }); } },
      { label: 'Delete', danger: true, run: () => setDialog({ kind: 'delete', what: `environment “${e?.name ?? key}”`, run: () => void deleteEnv(key) }) },
    ];
  };

  /* ---------- variables and sending ---------- */

  const env = selectedEnv ? envs[selectedEnv] ?? null : null;
  const scopesFor = useCallback((key: string | null | undefined): VarScopes => ({
    globals: varsToMap(globals.values),
    collection: key && cols[key] ? varsToMap(cols[key].variables) : {},
    environment: env ? varsToMap(env.values) : {},
    local: {},
  }), [globals, cols, env]);

  const send = async (tabId: string) => {
    const t = tabsRef.current.find((x) => x.id === tabId);
    if (!isReq(t) || t.sending) return;
    // a pasted cURL command in the URL bar becomes the request
    if (/^\s*curl(\.exe)?\s/i.test(t.draft.url)) {
      try { const parsed = parseCurl(t.draft.url); editDraft(tabId, (d) => { Object.assign(d, { ...parsed, id: d.id, name: d.name === 'Untitled Request' ? parsed.name : d.name }); }); notify('Imported the cURL command into the request.'); }
      catch (error) { notify(String(error instanceof Error ? error.message : error), 'error'); }
      return;
    }
    const sendId = newId('send');
    const key = t.source?.key ?? null;
    const collection = key && colsRef.current[key] ? colsRef.current[key] : emptyCollection();
    const envKey = selectedEnv && envsRef.current[selectedEnv] ? selectedEnv : null;
    const before: VarScopes = {
      globals: varsToMap(globalsRef.current.values), collection: varsToMap(collection.variables),
      environment: envKey ? varsToMap(envsRef.current[envKey].values) : {}, local: {},
    };
    updateTab(tabId, { sending: sendId });
    const result = await runRequest({ collection, request: t.draft, scopes: before, hasEnvironment: !!envKey, send: sendViaBackend, runScript: runScriptSandboxed, jar: jarRef.current, id: sendId });
    const stillOpen = tabsRef.current.find((x) => x.id === tabId);
    if (isReq(stillOpen) && stillOpen.sending !== sendId) return; // cancelled
    // variables set by scripts
    const envCh = scopeChanges(before.environment, result.scopes.environment);
    if (envKey && changed(envCh)) editEnv(envKey, (e) => { e.values = applyVarChanges(e.values, envCh); });
    const colCh = scopeChanges(before.collection, result.scopes.collection);
    if (key && colsRef.current[key] && changed(colCh)) editCollection(key, (c) => { c.variables = applyVarChanges(c.variables, colCh); });
    const gCh = scopeChanges(before.globals, result.scopes.globals);
    if (changed(gCh)) editEnv(GLOBALS, (g) => { g.values = applyVarChanges(g.values, gCh); });
    if (JSON.stringify(result.jar) !== JSON.stringify(jarRef.current)) { jarRef.current = result.jar; setJar(result.jar); void saveCookies(result.jar).catch(() => undefined); }
    const res = result.response;
    const entry: HistoryEntry = {
      id: newId('h'), at: nowIso(), method: result.prepared?.method ?? t.draft.method, url: result.prepared?.url ?? t.draft.url,
      status: res?.status ?? null, timeMs: res ? Math.round(res.timeMs) : null, size: res ? res.bodySize : null, ...(result.error ? { error: result.error } : {}),
      ...(t.source ? { source: { collection: t.source.key, request: t.source.id } } : {}), request: stripFiles(clone(t.draft)),
    };
    void pushHistory(entry).then(setHistory).catch(() => undefined);
    updateTab(tabId, (x) => (x.kind === 'request' ? { ...x, sending: null, result, resTab: result.tests.some((tt) => !tt.passed) && x.resTab === 'body' ? 'tests' : x.resTab } : x));
  };
  const cancel = (tabId: string) => {
    const t = tabsRef.current.find((x) => x.id === tabId);
    if (!isReq(t) || !t.sending) return;
    void cancelRequest(t.sending);
    updateTab(tabId, { sending: null, result: { prepared: null, response: null, error: 'Request cancelled', tests: [], logs: [], scopes: scopesFor(t.source?.key), jar: jarRef.current } });
  };

  const startRun = async (key: string, folder: string | null) => {
    const c = colsRef.current[key];
    if (!c) return;
    const requests = folder ? (() => { const f = findItem(c, folder); return f && f.item.type === 'folder' ? [...walk(f.item.items)].filter((x) => x.item.type === 'request').map((x) => x.item as ApiRequest) : []; })() : listRequests(c).map((x) => x.request);
    stopRun.current = false;
    setRunner({ running: true, steps: [] });
    const envKey = selectedEnv && envsRef.current[selectedEnv] ? selectedEnv : null;
    const before: VarScopes = { globals: varsToMap(globalsRef.current.values), collection: varsToMap(c.variables), environment: envKey ? varsToMap(envsRef.current[envKey].values) : {}, local: {} };
    const out = await runCollection({ collection: c, requests, scopes: before, hasEnvironment: !!envKey, send: sendViaBackend, runScript: runScriptSandboxed, jar: jarRef.current, shouldStop: () => stopRun.current, onStep: (step) => setRunner((r) => ({ ...r, steps: [...r.steps, step] })) });
    setRunner((r) => ({ ...r, running: false }));
    const envCh = scopeChanges(before.environment, out.scopes.environment);
    if (envKey && changed(envCh)) editEnv(envKey, (e) => { e.values = applyVarChanges(e.values, envCh); });
    const colCh = scopeChanges(before.collection, out.scopes.collection);
    if (changed(colCh)) editCollection(key, (x) => { x.variables = applyVarChanges(x.variables, colCh); });
    const gCh = scopeChanges(before.globals, out.scopes.globals);
    if (changed(gCh)) editEnv(GLOBALS, (g) => { g.values = applyVarChanges(g.values, gCh); });
    if (JSON.stringify(out.jar) !== JSON.stringify(jarRef.current)) { jarRef.current = out.jar; setJar(out.jar); void saveCookies(out.jar).catch(() => undefined); }
  };

  /* ---------- import ---------- */

  const doImport = async (text: string, fileName?: string): Promise<string | null> => {
    let yaml: unknown;
    const t = text.trim();
    if (!/^curl(\.exe)?\s/i.test(t) && !/^[[{]/.test(t)) {
      try { yaml = await yamlToJson(t); } catch (error) { return `Could not read the text: ${error instanceof Error ? error.message : String(error)}`; }
    }
    try {
      const result = importAny(t, yaml);
      setDialog(null);
      if (result.kind === 'request') { newRequestTab(result.request); notify(`Imported a ${result.format} request.`); return null; }
      if (result.kind === 'environment') { await createEnvironment(result.environment.name, result.environment); notify(`Imported the ${result.format} “${result.environment.name}”.`); return null; }
      const key = await createCollection(result.collection.name, false, result.collection);
      if (key) { setOpen((s) => new Set([...s, key])); openContainer(key, null); notify(`Imported “${result.collection.name}” (${result.format}${fileName ? `, ${fileName}` : ''}).`); }
      return null;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  };

  /* ---------- files for form-data and binary bodies ---------- */

  const pickFile = (tab: string, target: 'binary' | string) => { fileTarget.current = { tab, target }; fileInput.current?.click(); };
  const onFile = async (file: File | undefined) => {
    const target = fileTarget.current;
    fileTarget.current = null;
    if (!file || !target) return;
    if (file.size > 20 * 1024 * 1024) { notify('Files over 20 MB cannot be attached (the file would be stored in the collection).', 'error'); return; }
    let src: string;
    try { src = await readFileAsDataUrl(file); } catch { notify(`Could not read ${file.name}`, 'error'); return; }
    editDraft(target.tab, (d) => {
      if (target.target === 'binary') d.body = { ...d.body, mode: 'binary', file: { name: file.name, src } };
      else d.body = { ...d.body, formdata: d.body.formdata.map((f) => (f.id === target.target ? { ...f, type: 'file', fileName: file.name, src } : f)) };
    });
  };

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !root.isConnected) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !root.contains(t)) return;
      if (t?.closest('.ai-panel') || document.querySelector('.dc-modal__scrim')) return;
      const mod = e.ctrlKey || e.metaKey;
      const tab = tabsRef.current.find((x) => x.id === active) ?? tabsRef.current[tabsRef.current.length - 1];
      if (mod && e.key === 'Enter' && isReq(tab)) { e.preventDefault(); e.stopPropagation(); void send(tab.id); }
      else if (mod && e.key.toLowerCase() === 's' && isReq(tab)) { e.preventDefault(); e.stopPropagation(); saveRequestTab(tab.id); }
      else if (mod && e.key === '/') { e.preventDefault(); e.stopPropagation(); setDialog({ kind: 'help' }); }
      else if (e.altKey && !mod && e.key.toLowerCase() === 't') { e.preventDefault(); e.stopPropagation(); newRequestTab(); }
      else if (e.altKey && !mod && e.key.toLowerCase() === 'w' && tab) { e.preventDefault(); e.stopPropagation(); closeTab(tab.id); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  /* ---------- what the agent panel is told ---------- */

  useEffect(() => {
    if (isReq(activeTab)) setOpenApi(activeTab.source?.key ?? null, activeTab.source?.id ?? null);
    else if (activeTab && activeTab.kind !== 'environment') setOpenApi(activeTab.key, activeTab.kind === 'folder' ? activeTab.folder : null);
    else setOpenApi(null);
  }, [activeTab]);
  useEffect(() => () => setOpenApi(null), []);

  /* ---------- render ---------- */

  const collectionsList = useMemo(() => colKeys.filter((k) => cols[k]).map((key) => ({ key, collection: cols[key] })), [colKeys, cols]);
  const envList = useMemo(() => envKeys.filter((k) => envs[k]).map((key) => ({ key, env: envs[key] })), [envKeys, envs]);
  const dirtyCount = tabs.filter((t) => isReq(t) && t.dirty).length;

  const tabLabel = (t: Tab): { name: string; method?: string } => {
    if (t.kind === 'request') return { name: t.draft.name || 'Untitled Request', method: t.draft.method };
    if (t.kind === 'collection') return { name: cols[t.key]?.name ?? t.key };
    if (t.kind === 'folder') { const f = cols[t.key] ? findItem(cols[t.key], t.folder) : null; return { name: f?.item.name ?? 'Folder' }; }
    return { name: t.key === GLOBALS ? 'Globals' : envs[t.key]?.name ?? t.key };
  };

  const renderActive = () => {
    const t = activeTab;
    if (!t) {
      return (
        <div className="api-welcome">
          <Send size={34} className="api-muted" />
          <h2>RESTful API</h2>
          <p>Send HTTP requests, save them in collections, use environments and variables, and test the responses with scripts — like Postman, with everything stored in this repository.</p>
          <div className="api-welcome__actions">
            <button type="button" className="dc-btn dc-btn--primary" onClick={() => newRequestTab()}><Plus size={12} /> New request</button>
            <button type="button" className="dc-btn" onClick={() => setDialog({ kind: 'newcol' })}>New collection</button>
            <button type="button" className="dc-btn" onClick={() => setDialog({ kind: 'import' })}>Import</button>
          </div>
        </div>
      );
    }
    if (t.kind === 'request') {
      const key = t.source?.key ?? null;
      const c = key ? cols[key] : null;
      const found = c && t.source ? findItem(c, t.source.id) : null;
      const inherited = c ? effectiveAuth(c, t.draft.id, { type: 'inherit' }) : { auth: { type: 'none' as const }, from: 'collection (none: not saved in a collection)' };
      const path = c ? [c.name, ...(found?.folders.map((f) => f.name) ?? [])] : ['Unsaved'];
      return (
        <RequestEditor key={t.id} draft={t.draft} path={path} dirty={t.dirty} scopes={scopesFor(key)} inherited={inherited} result={t.result} sending={!!t.sending} reqTab={t.reqTab} resTab={t.resTab} split={split} jar={jar}
          onChange={(fn) => editDraft(t.id, fn)} onSend={() => void send(t.id)} onCancel={() => cancel(t.id)} onSave={() => saveRequestTab(t.id)} onCode={() => setDialog({ kind: 'code', tab: t.id })}
          onReqTab={(x) => updateTab(t.id, { reqTab: x })} onResTab={(x) => updateTab(t.id, { resTab: x })} onSplit={(dy) => setSplit((s) => Math.max(140, Math.min(window.innerHeight - 260, s + dy)))}
          onPickFile={(target) => pickFile(t.id, target)} onClearCookies={() => { jarRef.current = {}; setJar({}); void saveCookies({}).catch(() => undefined); }} />
      );
    }
    if (t.kind === 'collection' || t.kind === 'folder') {
      const c = cols[t.key];
      if (!c) return null;
      const folder = t.kind === 'folder' ? findItem(c, t.folder) : null;
      const target = t.kind === 'folder' ? (folder?.item as ApiFolder | undefined) : c;
      if (!target) return null;
      const parentAuth = t.kind === 'folder' && folder ? (() => { for (const f of [...folder.folders].reverse()) if (f.auth.type !== 'inherit') return { auth: f.auth, from: `folder “${f.name}”` }; return { auth: c.auth, from: 'collection' }; })() : undefined;
      return (
        <ContainerEditor key={t.id} kind={t.kind} target={target} fileKey={t.key} section={t.section} scopes={scopesFor(t.key)} inherited={parentAuth}
          onSection={(s) => updateTab(t.id, (x) => ({ ...x, section: s } as Tab))}
          onChange={(fn) => editCollection(t.key, (x) => { if (t.kind === 'collection') fn(x); else { const f = findItem(x, t.folder); if (!f || f.item.type !== 'folder') return false; fn(f.item); } })}
          onRun={() => { setRunner({ running: false, steps: [] }); setDialog({ kind: 'run', key: t.key, folder: t.kind === 'folder' ? t.folder : null }); }} />
      );
    }
    const e = t.key === GLOBALS ? globals : envs[t.key];
    if (!e) return null;
    return <EnvironmentEditor key={t.id} env={e} fileKey={t.key} globals={t.key === GLOBALS} active={selectedEnv === t.key} scopes={scopesFor(null)} onChange={(fn) => editEnv(t.key, fn)} onActivate={() => chooseEnv(t.key)} />;
  };

  const codeTab = dialog?.kind === 'code' ? tabs.find((x) => x.id === dialog.tab) : undefined;
  const codePrepared = isReq(codeTab) ? (() => {
    const key = codeTab.source?.key ?? null;
    const c = key ? cols[key] : null;
    const auth = codeTab.draft.auth.type === 'inherit' && c ? effectiveAuth(c, codeTab.draft.id, { type: 'inherit' }).auth : codeTab.draft.auth.type === 'inherit' ? { type: 'none' as const } : codeTab.draft.auth;
    return prepareRequest(codeTab.draft, scopesFor(key), auth);
  })() : null;
  const runTarget = dialog?.kind === 'run' ? cols[dialog.key] : undefined;
  const runRequests = dialog?.kind === 'run' && runTarget ? (dialog.folder ? (() => { const f = findItem(runTarget, dialog.folder); return f && f.item.type === 'folder' ? [...walk(f.item.items)].filter((x) => x.item.type === 'request').map((x) => x.item as ApiRequest) : []; })() : listRequests(runTarget).map((x) => x.request)) : [];
  const activeReqSource = isReq(activeTab) ? activeTab.source : null;
  const activeOther = activeTab?.kind === 'collection' ? activeTab.key : activeTab?.kind === 'folder' ? `${activeTab.key}#${activeTab.folder}` : activeTab?.kind === 'environment' ? activeTab.key : null;

  const dialogTab = dialog?.kind === 'saveas' || dialog?.kind === 'unsaved' ? tabs.find((x) => x.id === dialog.tab) : undefined;
  const saveAsFromDialog = (target: SaveTarget) => { if (dialog?.kind === 'saveas') void saveAs(dialog.tab, target, dialog.closeAfter); };
  const discardUnsaved = () => { if (!dialogTab) return; setDialog(null); closeTab(dialogTab.id, true); };
  const saveUnsaved = () => { if (!dialogTab) return; const id = dialogTab.id; setDialog(null); if (saveRequestTab(id)) closeTab(id, true); else setDialog({ kind: 'saveas', tab: id, closeAfter: true }); };

  return (
    <div className="screen api" ref={rootRef}>
      <header className="screen-header">
        <h1 className="screen-header__title">RESTful API</h1>
        <span className="screen-header__meta">A Postman-style API client — collections, environments and tests are files in this repository</span>
        <span className={`dc__save dc__save--${saving ? 'saving' : 'saved'}`} role="status">{saving ? 'Saving…' : dirtyCount ? `${dirtyCount} unsaved tab${dirtyCount === 1 ? '' : 's'}` : 'All changes saved'}</span>
        <span className="dc-grow" />
        <label className="api-envpick" title="Environment used when sending">
          <Globe size={13} className="api-muted" />
          <select className="dc-select" aria-label="Environment" value={selectedEnv && envs[selectedEnv] ? selectedEnv : ''} onChange={(e) => chooseEnv(e.target.value || null)}>
            <option value="">No environment</option>
            {envList.map(({ key, env: e }) => <option key={key} value={key}>{e.name}</option>)}
          </select>
        </label>
        <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'import' })}>Import</button>
        <button type="button" className="secondary-button" onClick={() => newRequestTab()}><Plus size={12} strokeWidth={1.5} /> New request</button>
      </header>

      <div className="screen-body api__body">
        <aside className="api-side" style={{ width: sideWidth }} aria-label="Collections, environments and history">
          <SideHeader section={section} onSection={setSection} filter={filter} onFilter={setFilter} onImport={() => setDialog({ kind: 'import' })} onNew={() => setDialog({ kind: section === 'environments' ? 'newenv' : 'newcol' })} />
          <div className="api-side__scroll">
            {section === 'collections' && (
              <CollectionTree collections={collectionsList} open={open} filter={filter} renaming={renaming} activeRequest={activeReqSource} activeOther={activeOther}
                onToggle={(id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                onRename={rename} onOpenRequest={openRequestTab} onOpenCollection={(k) => openContainer(k, null)} onOpenFolder={(k, id) => openContainer(k, id)} menuFor={menuFor} onDrop={onDrop} />
            )}
            {section === 'environments' && <EnvironmentList envs={envList} selected={selectedEnv} activeTab={activeTab?.kind === 'environment' ? activeTab.key : null} onSelect={chooseEnv} onOpen={openEnvTab} menuFor={envMenu} />}
            {section === 'history' && (
              <HistoryList entries={history} now={now} onOpen={(e) => newRequestTab({ ...clone(e.request), id: newId('r') })}
                onRemove={(id) => void removeHistory(id).then(setHistory)} onClear={() => setDialog({ kind: 'delete', what: 'the whole history', run: () => void removeHistory(null).then(setHistory) })} />
            )}
          </div>
        </aside>
        <ResizeHandle orientation="v" label="Resize side bar" onDelta={(dx) => setSideWidth((w) => Math.max(200, Math.min(520, w + dx)))} />

        <main className="api-main">
          <div className="api-tabstrip" role="tablist" aria-label="Open tabs">
            {tabs.map((t) => {
              const { name, method } = tabLabel(t);
              const dirty = isReq(t) && t.dirty;
              return (
                <div key={t.id} role="tab" aria-selected={t.id === activeId} aria-label={name} className={`api-tabstrip__tab${t.id === activeId ? ' api-tabstrip__tab--on' : ''}`} onClick={() => setActive(t.id)} onAuxClick={(e) => { if (e.button === 1) closeTab(t.id); }} title={name}>
                  {method ? <MethodBadge method={method} short /> : <span className="api-tabstrip__kind">{t.kind === 'environment' ? 'ENV' : t.kind === 'folder' ? 'DIR' : 'COL'}</span>}
                  <span className="api-tabstrip__name">{name}</span>
                  {dirty && <span className="api-tabstrip__dirty" aria-label="Unsaved changes" />}
                  {isReq(t) && t.sending && <span className="api-spinner api-spinner--tiny" aria-hidden />}
                  <button type="button" className="dc-icon api-tabstrip__close" aria-label={`Close ${name}`} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><X size={11} /></button>
                </div>
              );
            })}
            <button type="button" className="dc-icon api-tabstrip__new" aria-label="New request tab" title="New request (Alt+T)" onClick={() => newRequestTab()}><Plus size={14} /></button>
          </div>
          <div className="api-main__content">{renderActive()}</div>
        </main>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('api')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      <input ref={fileInput} type="file" hidden aria-label="Attach a file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }} />

      {dialog?.kind === 'import' && <ImportDialog onImport={doImport} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'code' && codePrepared && <CodeDialog prepared={codePrepared} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'saveas' && isReq(dialogTab) && <SaveAsDialog name={dialogTab.draft.name} collections={collectionsList} initial={dialogTab.source?.key} onSave={saveAsFromDialog} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'unsaved' && isReq(dialogTab) && <UnsavedDialog name={dialogTab.draft.name} onClose={() => setDialog(null)} onDiscard={discardUnsaved} onSave={saveUnsaved} />}
      {dialog?.kind === 'newcol' && <PromptDialog title="New collection" label="Collection name" initial="New Collection" okLabel="Create" onOk={(v) => { setDialog(null); if (v.trim()) void createCollection(v.trim(), false); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'newenv' && <PromptDialog title="New environment" label="Environment name" initial="Development" okLabel="Create" onOk={(v) => { setDialog(null); if (v.trim()) void createEnvironment(v.trim()); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && <ConfirmDelete what={dialog.what} onNo={() => setDialog(null)} onYes={() => { const run = dialog.run; setDialog(null); run(); }} />}
      {dialog?.kind === 'export' && (
        <CodeExport title={dialog.title} text={dialog.text} file={dialog.file} onClose={() => setDialog(null)}
          onSave={async () => { const path = `.pigry/apis/exports/${dialog.file}`; try { await writeWorktreeFile(path, `${dialog.text}\n`); notify(`Saved ${path}`); setDialog(null); } catch (error) { notify(`Could not save: ${String(error)}`, 'error'); } }} />
      )}
      {dialog?.kind === 'run' && runTarget && (
        <RunnerDialog title={dialog.folder ? (findItem(runTarget, dialog.folder)?.item.name ?? 'folder') : runTarget.name} requests={runRequests} running={runner.running} steps={runner.steps}
          onRun={() => void startRun(dialog.key, dialog.folder)} onStop={() => { stopRun.current = true; }} onClose={() => { stopRun.current = true; setDialog(null); }} />
      )}
      {dialog?.kind === 'help' && <ShortcutHelp title="RESTful API shortcuts" groups={SHORTCUTS} onClose={() => setDialog(null)} />}
    </div>
  );
}

function CodeExport({ title, text, file, onSave, onClose }: { title: string; text: string; file: string; onSave: () => void; onClose: () => void }) {
  return (
    <div className="dc-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-modal dc-modal--wide" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <header className="dc-modal__head"><h2>{title}</h2><button type="button" className="dc-icon" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="dc-modal__body">
          <pre className="api-pre api-pre--code" aria-label="Exported JSON">{text}</pre>
          <p className="dc-note">Secret values are left out. Save writes .pigry/apis/exports/{file}.</p>
        </div>
        <footer className="dc-modal__foot">
          <button type="button" className="dc-btn" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
          <span className="dc-grow" />
          <button type="button" className="dc-btn" onClick={onClose}>Close</button>
          <button type="button" className="dc-btn dc-btn--primary" onClick={onSave}>Save file</button>
        </footer>
      </div>
    </div>
  );
}
