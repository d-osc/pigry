/** Floating server-containers manager — Docker-like process containers
 * (create / start / stop / remove / logs) backed by real OS processes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, X } from 'lucide-react';
import {
  composeServiceStart,
  composeServices,
  containerCreate,
  containerList,
  containerLogs,
  containerRemove,
  containerStart,
  containerStop,
  type ComposeService,
  type ServerContainer,
} from '../lib/serverContainers';
import './ContainersPanel.css';

const STATE_DOT: Record<string, string> = {
  running: 'containers-dot--running',
  exited: 'containers-dot--exited',
  stopped: 'containers-dot--stopped',
};

/** Drag by the header (pointer capture), same pattern as BrowserPanel. */
export function ContainersPanel({ repoPath, onClose }: { repoPath: string | null; onClose: () => void }) {
  const [containers, setContainers] = useState<ServerContainer[]>([]);
  const [composeList, setComposeList] = useState<ComposeService[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftCommand, setDraftCommand] = useState('');
  const [draftOs, setDraftOs] = useState('');
  const [draftHostname, setDraftHostname] = useState('');
  const [draftPassword, setDraftPassword] = useState('');
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logsText, setLogsText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [pos, setPos] = useState(() => ({
    x: Math.max(16, window.innerWidth - 500),
    y: 96,
  }));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  /** Pulls the container list — setState only inside async callbacks. */
  const refresh = useCallback(() => {
    if (!repoPath) return;
    containerList(repoPath)
      .then((list) => {
        setContainers(list);
        setError('');
      })
      .catch((err) => setError(String(err)));
    composeServices(repoPath)
      .then((services) => setComposeList(services))
      .catch(() => setComposeList([]));
  }, [repoPath]);

  useEffect(() => {
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Logs polling for the opened drawer
  useEffect(() => {
    if (!logsFor || !repoPath) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const text = await containerLogs(repoPath, logsFor);
        if (!cancelled) setLogsText(text);
      } catch {
        // ignore
      }
    };
    void pull();
    const timer = setInterval(pull, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [logsFor, repoPath]);

  const create = async () => {
    if (!repoPath || !draftName.trim() || !draftCommand.trim()) return;
    setBusyId('__create');
    try {
      await containerCreate(
        repoPath,
        draftName.trim(),
        draftCommand.trim(),
        '',
        [],
        '',
        'manual',
        draftOs.trim(),
        draftHostname.trim(),
        draftPassword,
      );
      setDraftName('');
      setDraftCommand('');
      setDraftOs('');
      setDraftHostname('');
      setDraftPassword('');
      setCreating(false);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  /** Imports a docker-compose service: registers it as a managed local
   * process container AND starts it immediately. */
  const importService = async (service: ComposeService) => {
    if (!repoPath) return;
    if (!service.localRunnable) {
      setError(`${service.name} is image/build-only — no local command to run.`);
      return;
    }
    setImporting(service.name);
    try {
      await composeServiceStart(repoPath, service);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(null);
    }
  };

  const lifecycle = async (id: string, action: 'start' | 'stop') => {
    setBusyId(id);
    try {
      if (action === 'start') await containerStart(repoPath ?? '', id);
      else await containerStop(repoPath ?? '', id);
      await refresh();
      if (logsFor === id) setLogsText(await containerLogs(repoPath ?? '', id));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await containerRemove(repoPath ?? '', id);
      if (logsFor === id) setLogsFor(null);
      setConfirmDelete(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  // drag handlers
  const onHeaderPointerDown = (event: React.PointerEvent) => {
    // Interactive controls keep their clicks — never start a drag from them.
    if ((event.target as HTMLElement).closest('button, input, textarea, a')) return;
    dragRef.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onHeaderPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.min(Math.max(event.clientX - drag.dx, 8), window.innerWidth - 460);
    const y = Math.min(Math.max(event.clientY - drag.dy, 8), window.innerHeight - 120);
    setPos({ x, y });
  };
  const onHeaderPointerUp = () => {
    dragRef.current = null;
  };


  if (!repoPath) {
    return createPortal(
      <div
        className="containers-win"
        style={{ left: pos.x, top: pos.y }}
        data-no-drag=""
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="containers-win__head" onPointerDown={onHeaderPointerDown} onPointerMove={onHeaderPointerMove} onPointerUp={onHeaderPointerUp}>
          <strong>Server Containers</strong>
          <button type="button" aria-label="Close containers" onClick={onClose}>
            <X size={11} strokeWidth={2} />
          </button>
        </div>
        <p className="containers-win__hint">Open a repository first — containers run against its workspace.</p>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="containers-win"
      style={{ left: pos.x, top: pos.y }}
      data-no-drag=""
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="containers-win__head" onPointerDown={onHeaderPointerDown} onPointerMove={onHeaderPointerMove} onPointerUp={onHeaderPointerUp}>
        <strong>Server Containers</strong>
        <span className="containers-win__spacer" />
        <button type="button" aria-label="Close containers" onClick={onClose}>
          <X size={11} strokeWidth={2} />
        </button>
      </div>

      <div className="containers-win__body">
        {error && <p className="containers-win__error">{error}</p>}

        <button
          type="button"
          className="containers-win__add"
          onClick={() => setCreating((value) => !value)}
        >
          <Plus size={11} strokeWidth={1.5} />
          New container
        </button>

        {creating && (
          <div className="containers-win__form">
            <input
              autoFocus
              value={draftName}
              placeholder="name — e.g. dev-server"
              onChange={(event) => setDraftName(event.target.value)}
            />
            <input
              value={draftCommand}
              placeholder="command — e.g. npm run dev"
              onChange={(event) => setDraftCommand(event.target.value)}
            />
            <select
              value={draftOs}
              aria-label="OS"
              onChange={(event) => setDraftOs(event.target.value)}
            >
              <option value="">os — any</option>
              <option value="windows">windows</option>
              <option value="linux">linux</option>
            </select>
            <input
              value={draftHostname}
              placeholder="hostname — e.g. dev-box-01"
              onChange={(event) => setDraftHostname(event.target.value)}
            />
            <input
              type="password"
              value={draftPassword}
              placeholder="password (stored locally)"
              onChange={(event) => setDraftPassword(event.target.value)}
            />
            <button
              type="button"
              disabled={!draftName.trim() || !draftCommand.trim()}
              onClick={() => void create()}
            >
              Create
            </button>
          </div>
        )}

        {composeList.length > 0 && (
          <section className="containers-win__compose">
            <p className="containers-win__compose-head">From docker-compose.yml</p>
            {composeList.map((service) => {
              const imported = containers.some((c) => c.name === service.name);
              return (
                <div key={service.name} className="containers-compose-item">
                  <div className="containers-compose-item__main">
                    <strong>{service.name}</strong>
                    {service.image && (
                      <span className="containers-compose-item__img">{service.image}</span>
                    )}
                    {service.command && (
                      <p className="containers-compose-item__cmd">$ {service.command}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={imported || !service.localRunnable || importing === service.name}
                    title={
                      imported
                        ? 'Already imported'
                        : service.localRunnable
                          ? 'Import as a managed local container and start it'
                          : 'Image/build-only service — no local command to run'
                    }
                    onClick={() => void importService(service)}
                  >
                    {imported ? 'Imported' : importing === service.name ? '…' : 'Import'}
                  </button>
                </div>
              );
            })}
          </section>
        )}

        {containers.length === 0 && !creating && (
          <p className="containers-win__hint">
            No containers yet — add one and run it like a Docker container (start / stop / logs).
          </p>
        )}

        <div className="containers-win__list">
          {containers.map((container) => {
            const running = container.state === 'running';
            return (
              <section key={container.id} className="containers-item">
                <div className="containers-item__head">
                  <span className={`containers-dot ${STATE_DOT[container.state] ?? ''}`} />
                  <strong>{container.name}</strong>
                  {container.os && (
                    <span className="containers-item__chip">{container.os}</span>
                  )}
                  {container.hostname && (
                    <span className="containers-item__chip">{container.hostname}</span>
                  )}
                  <span className="containers-item__state">{container.state}</span>
                  {container.pid && (
                    <span className="containers-item__pid">pid {container.pid}</span>
                  )}
                </div>
                <p className="containers-item__cmd">$ {container.command}</p>
                <div className="containers-item__actions">
                  {running ? (
                    <button
                      type="button"
                      disabled={busyId === container.id}
                      onClick={() => void lifecycle(container.id, 'stop')}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === container.id}
                      onClick={() => void lifecycle(container.id, 'start')}
                    >
                      Start
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setLogsFor((current) => (current === container.id ? null : container.id))}
                  >
                    {logsFor === container.id ? 'Hide logs' : 'Logs'}
                  </button>
                  {confirmDelete === container.id ? (
                    <span className="containers-item__confirm">
                      Delete?
                      <button type="button" onClick={() => void remove(container.id)}>Yes</button>
                      <button type="button" onClick={() => setConfirmDelete(null)}>No</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${container.name}`}
                      onClick={() => setConfirmDelete(container.id)}
                    >
                      <Trash2 size={10} strokeWidth={1.5} />
                    </button>
                  )}
                </div>
                {logsFor === container.id && (
                  <pre className="containers-item__logs">{logsText || '(no output yet)'}</pre>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
