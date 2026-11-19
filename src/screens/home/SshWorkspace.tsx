import { useEffect, useRef, useState, type FormEvent } from 'react';
import { TerminalSquare } from 'lucide-react';
import { ensurePtyListener, PtyTerminalView } from '../../app/PtyTerminalView';
import { useRequestGate } from '../../hooks/useRequestGate';
import { useTerminalTheme } from '../../hooks/useTerminalTheme';
import { isTauri, ptyCreateSsh, ptyKill, type PtySessionInfo } from '../../lib/tauriClient';
import '../../app/TerminalPanel.css';

const ignoreTerminalEvent = () => undefined;

export function SshWorkspace() {
  const desktop = isTauri();
  const theme = useTerminalTheme();
  const request = useRequestGate();
  const sessionId = useRef<number | null>(null);
  const [session, setSession] = useState<PtySessionInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (sessionId.current !== null) void ptyKill(sessionId.current).catch(() => undefined);
  }, []);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!desktop || connecting || session) return;

    const form = new FormData(event.currentTarget);
    const host = String(form.get('host') ?? '').trim();
    const username = String(form.get('username') ?? '').trim();
    const port = String(form.get('port') ?? '').trim();
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
      const info = await ptyCreateSsh(host, username || null, port ? Number(port) : null);
      if (!isCurrent()) {
        await ptyKill(info.id);
        return;
      }
      sessionId.current = info.id;
      setSession(info);
      setEnded(false);
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      if (sessionId.current !== null) await ptyKill(sessionId.current);
      sessionId.current = null;
      setSession(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <form className="home__ssh-form" onSubmit={(event) => void connect(event)} hidden={session !== null}>
        <label>
          Host
          <input className="home__clone-input" name="host" placeholder="server.example.com" required spellCheck={false} />
        </label>
        <label>
          Username (optional)
          <input className="home__clone-input" name="username" placeholder="Use SSH config or local username" spellCheck={false} />
        </label>
        <label>
          Port (optional)
          <input className="home__clone-input" name="port" type="number" min="1" max="65535" placeholder="Use SSH config or 22" />
        </label>
        <button type="submit" className="primary-button" disabled={!desktop || connecting}>
          <TerminalSquare size={14} />
          {connecting ? 'Opening SSH terminal…' : 'Connect over SSH'}
        </button>
        {!desktop && <p className="home__clone-hint">SSH connections are available in the desktop app.</p>}
      </form>
      {error && <p className="home__error" role="alert">{error}</p>}
      {session && (
        <section className="home__ssh-session" aria-label="SSH terminal">
          <div className="home__ssh-session-header">
            <strong>{session.label}</strong>
            <button type="button" className="outline-button" onClick={() => void disconnect()}>
              {ended ? 'Close terminal' : 'Disconnect'}
            </button>
          </div>
          <PtyTerminalView
            key={session.id}
            id={session.id}
            focused
            theme={theme}
            onFocused={ignoreTerminalEvent}
            onTitle={ignoreTerminalEvent}
            onExited={() => {
              sessionId.current = null;
              setEnded(true);
            }}
          />
        </section>
      )}
    </>
  );
}
