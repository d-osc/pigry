import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ChevronRight, Folder, FolderOpen, TerminalSquare } from 'lucide-react';
import { ensurePtyListener, PtyTerminalView } from '../../app/PtyTerminalView';
import { useRepository } from '../../hooks/useRepository';
import { useRequestGate } from '../../hooks/useRequestGate';
import { useTerminalTheme } from '../../hooks/useTerminalTheme';
import { cancelSshWorkspaceStart, isTauri, ptyCreateSsh, ptyKill, ptyStartSshWorkspace, ptyWrite, type PtySessionInfo } from '../../lib/tauriClient';
import '../../app/TerminalPanel.css';

const ignoreTerminalEvent = () => undefined;
const folderProtocol = 697;

interface RemoteDirectory {
  path: string;
  folders: string[];
}

function canSendPath(path: string) {
  return ![...path].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function decodeDirectory(chunks: string[]): RemoteDirectory | null {
  const pairs = chunks.join('').match(/.{2}/g) ?? [];
  const bytes = Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const entries: (string | null)[] = [];
  let start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 0) continue;
    try {
      entries.push(decoder.decode(bytes.subarray(start, end)));
    } catch {
      entries.push(null);
    }
    start = end + 1;
  }
  const [path, ...names] = entries;
  if (start !== bytes.length || !path?.startsWith('/') || !canSendPath(path)) return null;
  return {
    path,
    folders: names.filter((name): name is string => !!name && !name.includes('/') && canSendPath(name)),
  };
}

export function SshWorkspace() {
  const desktop = isTauri();
  const theme = useTerminalTheme();
  const { openSshWorkspace, error: workspaceError } = useRepository();
  const request = useRequestGate();
  const setupRequest = useRequestGate();
  const sessionId = useRef<number | null>(null);
  const setupId = useRef<number | null>(null);
  const folderRequest = useRef<{ path: string } | null>(null);
  const directoryChunks = useRef<string[] | null>(null);
  const [session, setSession] = useState<PtySessionInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [folderPending, setFolderPending] = useState(false);
  const [setup, setSetup] = useState<PtySessionInfo | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => () => {
    if (sessionId.current !== null) void ptyKill(sessionId.current).catch(() => undefined);
    if (setupId.current !== null) void cancelSshWorkspaceStart(setupId.current).catch(() => undefined);
  }, []);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!desktop || connecting || session) return;

    const form = new FormData(event.currentTarget);
    const address = String(form.get('host') ?? '').trim();
    const separator = address.lastIndexOf('@');
    const host = address.slice(separator + 1).replace(/^\[([^\]]+)\]$/, '$1');
    const username = String(form.get('username') ?? '').trim() || (separator >= 0 ? address.slice(0, separator) : '');
    const port = String(form.get('port') ?? '').trim();
    const browseFolders = !form.has('terminalOnly');
    if (!host) {
      setError('Enter a host or SSH config alias.');
      return;
    }
    const isCurrent = request.begin();
    setError(null);
    setConnecting(true);
    try {
      await ensurePtyListener();
      if (!isCurrent()) return;
      const info = await ptyCreateSsh(host, username || null, port ? Number(port) : null, browseFolders);
      if (!isCurrent()) {
        await ptyKill(info.id);
        return;
      }
      sessionId.current = info.id;
      folderRequest.current = browseFolders ? { path: '' } : null;
      directoryChunks.current = null;
      setDirectory(null);
      setFolderPath('');
      setFolderPending(browseFolders);
      setChoosing(false);
      setSession(info);
      setEnded(false);
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setConnecting(false);
    }
  };

  const disconnect = async () => {
    const id = sessionId.current;
    try {
      if (id !== null) await ptyKill(id);
      if (sessionId.current !== null && sessionId.current !== id) return;
      sessionId.current = null;
      folderRequest.current = null;
      setSession(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onFolderMessage = (message: string) => {
    const [channel, event, payload] = message.split(';', 3);
    if (channel !== 'pigry') return false;
    const pending = folderRequest.current;
    if (!pending) return true;

    if (event === 'ready') {
      setChoosing(true);
    } else if (event === 'begin') {
      directoryChunks.current = [];
    } else if (event === 'data' && directoryChunks.current && payload) {
      const hex = payload.replace(/ /g, '');
      if (/^(?:[0-9a-f]{2})+$/.test(hex)) directoryChunks.current.push(hex);
    } else if (event === 'end') {
      const listing = decodeDirectory(directoryChunks.current ?? []);
      directoryChunks.current = null;
      folderRequest.current = null;
      setFolderPending(false);
      if (listing) {
        setDirectory(listing);
        setFolderPath(listing.path);
      } else {
        setError('Could not read the remote folder listing.');
      }
    } else if (event === 'error') {
      directoryChunks.current = null;
      folderRequest.current = null;
      setFolderPending(false);
      setError('Could not list that folder on the server.');
    }
    return true;
  };

  const listFolder = async (path: string) => {
    const id = sessionId.current;
    if (id === null || folderRequest.current) return;
    if (!path.startsWith('/') || !canSendPath(path)) {
      setError('Enter an absolute server path beginning with /.');
      return;
    }

    const pending = { path };
    folderRequest.current = pending;
    setFolderPending(true);
    setError(null);
    try {
      await ptyWrite(id, 'list ' + path + '\r');
    } catch (error) {
      if (folderRequest.current !== pending) return;
      folderRequest.current = null;
      setFolderPending(false);
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const openFolder = async () => {
    const id = sessionId.current;
    if (id === null || folderRequest.current || openingPath !== null) return;
    if (!folderPath.startsWith('/') || !canSendPath(folderPath)) {
      setError('Enter an absolute server path beginning with /.');
      return;
    }
    const isCurrent = setupRequest.begin();
    setError(null);
    setOpeningPath(folderPath);
    setOpening(true);
    try {
      const info = await ptyStartSshWorkspace(id, folderPath);
      if (!isCurrent()) {
        await cancelSshWorkspaceStart(info.id);
        return;
      }
      setupId.current = info.id;
      setSetup(info);
      const opened = await openSshWorkspace(info.id, isCurrent);
      if (!opened) await cancelSshWorkspaceStart(info.id);
    } catch (error) {
      if (isCurrent()) {
        setOpeningPath(null);
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (isCurrent()) setOpening(false);
    }
  };

  const backToFolders = () => {
    setupRequest.invalidate();
    if (setupId.current !== null) void cancelSshWorkspaceStart(setupId.current).catch(() => undefined);
    setupId.current = null;
    setSetup(null);
    setOpeningPath(null);
    setOpening(false);
  };

  return (
    <>
      <form className="home__ssh-form" onSubmit={(event) => void connect(event)} hidden={session !== null}>
        <label>
          Host
          <input className="home__clone-input" name="host" placeholder="user@server.example.com" required spellCheck={false} autoFocus />
        </label>
        <label>
          Username (optional)
          <input className="home__clone-input" name="username" placeholder="Use SSH config or local username" spellCheck={false} />
        </label>
        <label>
          Port (optional)
          <input className="home__clone-input" name="port" type="number" min="1" max="65535" placeholder="Use SSH config or 22" />
        </label>
        <label className="home__ssh-terminal-only">
          <input type="checkbox" name="terminalOnly" />
          Terminal only
        </label>
        <button type="submit" className="primary-button" disabled={!desktop || connecting}>
          <TerminalSquare size={14} />
          {connecting ? 'Opening SSH terminal…' : 'Connect over SSH'}
        </button>
        {!desktop && <p className="home__clone-hint">SSH connections are available in the desktop app.</p>}
      </form>
      {error && <p className="home__error" role="alert">{error}</p>}
      {openingPath !== null && (
        <section className="home__ssh-session" aria-label="Opening server workspace">
          <div className="home__ssh-session-header">
            <strong>Server workspace</strong>
            <span className="home__ssh-opened-path" title={openingPath}>{openingPath}</span>
            <button type="button" className="outline-button" onClick={backToFolders}>
              {opening ? 'Cancel' : 'Back to folders'}
            </button>
          </div>
          {opening && <p className="home__ssh-setup-message" role="status">Starting PIGRY Server over SSH. Complete sign-in if prompted.</p>}
          {!opening && workspaceError && <p className="home__error" role="alert">{workspaceError}</p>}
          {setup && <PtyTerminalView key={setup.id} id={setup.id} focused={opening} inputEnabled={opening}
            theme={theme} onFocused={ignoreTerminalEvent} onTitle={ignoreTerminalEvent} onExited={ignoreTerminalEvent} />}
        </section>
      )}
      {session && (
        <section className="home__ssh-session" hidden={openingPath !== null} aria-label={choosing ? 'Remote folder picker' : 'SSH terminal'}>
          <div className="home__ssh-session-header">
            <strong>{session.label}</strong>
            <button type="button" className="outline-button" onClick={() => void disconnect()}>
              {ended ? 'Close terminal' : 'Disconnect'}
            </button>
          </div>
          {choosing && (
            <div className="home__ssh-folder-picker">
              <h3>Open a folder on the server</h3>
              <form className="home__ssh-folder-path" onSubmit={(event) => {
                event.preventDefault();
                void listFolder(folderPath);
              }}>
                <button type="button" className="outline-button" aria-label="Parent folder"
                  disabled={folderPending || !directory || directory.path === '/'}
                  onClick={() => directory && void listFolder(directory.path.slice(0, directory.path.lastIndexOf('/')) || '/')}>
                  <ArrowUp size={14} />
                </button>
                <input className="home__clone-input" aria-label="Remote folder path" value={folderPath}
                  placeholder="/path/to/folder" spellCheck={false} disabled={folderPending}
                  onChange={(event) => setFolderPath(event.target.value)} />
                <button type="submit" className="outline-button" disabled={folderPending || !folderPath}>Browse</button>
                <button type="button" className="primary-button" disabled={folderPending || !folderPath}
                  onClick={() => void openFolder()}>
                  <FolderOpen size={14} /> Open folder
                </button>
              </form>
              {folderPending && <p className="home__clone-hint" role="status">Waiting for the server…</p>}
              {directory && (
                <ul className="home__ssh-folder-list" aria-label="Remote folders">
                  {directory.folders.map((folder) => (
                    <li key={folder}>
                      <button type="button" className="home__recent-item" disabled={folderPending}
                        onClick={() => void listFolder(directory.path.replace(/\/$/, '') + '/' + folder)}>
                        <Folder size={14} />
                        <span className="home__ssh-folder-name" title={folder}>{folder}</span>
                        <ChevronRight size={14} />
                      </button>
                    </li>
                  ))}
                  {directory.folders.length === 0 && <li className="home__recent-empty">No subfolders</li>}
                </ul>
              )}
            </div>
          )}
          <div className="home__ssh-terminal" hidden={choosing}>
            <PtyTerminalView
              key={session.id}
              id={session.id}
              focused={!choosing && openingPath === null}
              inputEnabled={!choosing && openingPath === null}
              oscHandler={{ identifier: folderProtocol, handle: onFolderMessage }}
              theme={theme}
              onFocused={ignoreTerminalEvent}
              onTitle={ignoreTerminalEvent}
              onExited={() => {
                sessionId.current = null;
                folderRequest.current = null;
                setChoosing(false);
                setEnded(true);
              }}
            />
          </div>
        </section>
      )}
    </>
  );
}
