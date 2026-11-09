const fs = require('fs');

// --- AppShell.tsx ---
let s = fs.readFileSync('src/app/AppShell.tsx', 'utf8');
const oldEffect = `  // Load the file list when entering file-search mode.
  useEffect(() => {
    if (!paletteOpen || paletteMode !== 'files') return;
    setPaletteFilesLoading(true);
    getFileTree()
      .then((tree) => setPaletteFiles(tree.entries))
      .catch(() => setPaletteFiles([]))
      .finally(() => setPaletteFilesLoading(false));
  }, [paletteOpen, paletteMode]);`;
const neuEffect = `  // Files are (re)loaded each time file-search mode is entered; the request
  // id marks which load is current.
  useEffect(() => {
    if (paletteMode !== 'files' || !paletteOpen) return;
    let cancelled = false;
    getFileTree()
      .then((tree) => {
        if (!cancelled) setPaletteFilesRequest({ id: filesRequestId, files: tree.entries });
      })
      .catch(() => {
        if (!cancelled) setPaletteFilesRequest({ id: filesRequestId, files: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, paletteMode, filesRequestId]);`;
if (!s.includes(oldEffect)) { console.error('load effect NOT FOUND'); process.exit(1); }
s = s.replace(oldEffect, neuEffect);

const oldState = `  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);
  const [paletteFilesLoading, setPaletteFilesLoading] = useState(false);`;
const neuState = `  const [paletteFilesRequest, setPaletteFilesRequest] = useState<{
    id: number;
    files: string[];
  } | null>(null);
  const [filesRequestId, setFilesRequestId] = useState(0);`;
if (!s.includes(oldState)) { console.error('state NOT FOUND'); process.exit(1); }
s = s.replace(oldState, neuState);

const oldKey = `        setPaletteMode('files');
        setPaletteOpen(true);`;
const neuKey = `        setPaletteMode('files');
        setFilesRequestId((id) => id + 1);
        setPaletteOpen(true);`;
if (!s.includes(oldKey)) { console.error('keydown NOT FOUND'); process.exit(1); }
s = s.replace(oldKey, neuKey);

const oldSwitch = `  const handleSwitchToFiles = useCallback(() => {
    setPaletteMode('files');
  }, []);`;
const neuSwitch = `  const handleSwitchToFiles = useCallback(() => {
    setPaletteMode('files');
    setFilesRequestId((id) => id + 1);
  }, []);`;
if (!s.includes(oldSwitch)) { console.error('switch NOT FOUND'); process.exit(1); }
s = s.replace(oldSwitch, neuSwitch);

const oldFiles = `          files={paletteFiles}
          filesLoading={paletteFilesLoading}`;
const neuFiles = `          files={
            paletteFilesRequest && paletteFilesRequest.id === filesRequestId
              ? paletteFilesRequest.files
              : []
          }
          filesLoading={paletteFilesRequest?.id !== filesRequestId}`;
if (!s.includes(oldFiles)) { console.error('files props NOT FOUND'); process.exit(1); }
s = s.replace(oldFiles, neuFiles);

// key-based remount for Explorer
const oldCase = `    case 'explorer':
      return <ExplorerScreen />;`;
const neuCase = `    case 'explorer':
      return <ExplorerScreen key={explorerOpenPath ?? 'explorer'} openPath={explorerOpenPath} />;`;
if (!s.includes(oldCase)) { console.error('explorer case NOT FOUND'); process.exit(1); }
s = s.replace(oldCase, neuCase);
fs.writeFileSync('src/app/AppShell.tsx', s);
console.log('AppShell patched');

// --- ExplorerScreen.tsx ---
let e = fs.readFileSync('src/screens/explorer/ExplorerScreen.tsx', 'utf8');
const oldExplorerEffect = `  // Honor palette open requests.
  useEffect(() => {
    if (openPath) setSelectedPath(openPath);
  }, [openPath]);

  // Keep a valid selection as files come and go.`;
const neuExplorerEffect = `  // Keep a valid selection as files come and go.`;
if (!e.includes(oldExplorerEffect)) { console.error('explorer effect NOT FOUND'); process.exit(1); }
e = e.replace(oldExplorerEffect, neuExplorerEffect);
const oldInit = `  const [selectedPath, setSelectedPath] = useState<string | null>(null);`;
const neuInit = `  // Remounted by AppShell on openPath change (key), so the initializer runs.
  const [selectedPath, setSelectedPath] = useState<string | null>(openPath ?? null);`;
if (!e.includes(oldInit)) { console.error('explorer init NOT FOUND'); process.exit(1); }
e = e.replace(oldInit, neuInit);
fs.writeFileSync('src/screens/explorer/ExplorerScreen.tsx', e);
console.log('ExplorerScreen patched');
