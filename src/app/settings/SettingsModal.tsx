/** Repository settings modal: identity, remotes, .gitignore. */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Save, Trash2, X } from 'lucide-react';
import * as client from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';
import type { RemoteEntry } from '../../types/repository';
import './SettingsModal.css';

interface SettingsModalProps {
  onClose: () => void;
  /** Surfaces feedback from every settings action. */
  notify: (message: string, type?: 'success' | 'error') => void;
}

type Section = 'user' | 'remotes' | 'gitignore';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'user', label: 'Identity' },
  { id: 'remotes', label: 'Remotes' },
  { id: 'gitignore', label: '.gitignore' },
];

export function SettingsModal({ onClose, notify }: SettingsModalProps) {
  const { refresh } = useRepository();
  const [section, setSection] = useState<Section>('user');

  // --- identity ---
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  // --- remotes ---
  const [remotes, setRemotes] = useState<RemoteEntry[]>([]);
  const [urlEdits, setUrlEdits] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');

  // --- gitignore ---
  const [gitignore, setGitignore] = useState('');
  const [gitignoreDirty, setGitignoreDirty] = useState(false);

  // One-shot load of every section's data. The entry-guard keeps the async
  // setState calls out of the effect body (react-hooks v7 rule).
  useEffect(() => {
    let cancelled = false;
    client
      .getUserInfo()
      .then((info) => {
        if (cancelled) return;
        setName(info.name ?? '');
        setEmail(info.email ?? '');
      })
      .catch((e: unknown) => notify(String(e), 'error'));
    client
      .listRemotes()
      .then((list) => {
        if (!cancelled) setRemotes(list);
      })
      .catch(() => {
        if (!cancelled) setRemotes([]);
      });
    client
      .readWorktreeFile('.gitignore')
      .then((file) => {
        if (cancelled) return;
        setGitignore(file.content);
        setGitignoreDirty(false);
      })
      .catch(() => {
        if (!cancelled) setGitignore('');
      });
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // Escape closes the modal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const saveIdentity = useCallback(async () => {
    try {
      await client.setUserInfo(name, email);
      await refresh();
      notify('Identity updated');
    } catch (e) {
      notify(String(e), 'error');
    }
  }, [name, email, refresh, notify]);

  const reloadRemotes = useCallback(async () => {
    try {
      setRemotes(await client.listRemotes());
    } catch {
      setRemotes([]);
    }
  }, []);

  const addRemote = useCallback(async () => {
    try {
      await client.addRemote(newName.trim(), newUrl.trim());
      setNewName('');
      setNewUrl('');
      await reloadRemotes();
      await refresh();
      notify(`Remote "${newName.trim()}" added`);
    } catch (e) {
      notify(String(e), 'error');
    }
  }, [newName, newUrl, reloadRemotes, refresh, notify]);

  const saveRemoteUrl = useCallback(
    async (remoteName: string) => {
      const url = urlEdits[remoteName];
      if (url === undefined || url === '') return;
      try {
        await client.setRemoteUrl(remoteName, url);
        await reloadRemotes();
        await refresh();
        notify(`URL of "${remoteName}" updated`);
      } catch (e) {
        notify(String(e), 'error');
      }
    },
    [urlEdits, reloadRemotes, refresh, notify],
  );

  const removeRemote = useCallback(
    async (remoteName: string) => {
      try {
        await client.removeRemote(remoteName);
        await reloadRemotes();
        await refresh();
        notify(`Remote "${remoteName}" removed`);
      } catch (e) {
        notify(String(e), 'error');
      }
    },
    [reloadRemotes, refresh, notify],
  );

  const saveGitignore = useCallback(async () => {
    try {
      await client.writeWorktreeFile('.gitignore', gitignore);
      await refresh();
      setGitignoreDirty(false);
      notify('.gitignore saved');
    } catch (e) {
      notify(String(e), 'error');
    }
  }, [gitignore, refresh, notify]);

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings" role="dialog" aria-modal="true" aria-label="Repository settings">
        <header className="settings__header">
          <h2 className="settings__title">Repository settings</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <X size={14} />
          </button>
        </header>

        <nav className="settings__nav" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`settings__tab${section === entry.id ? ' settings__tab--active' : ''}`}
              onClick={() => setSection(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        {section === 'user' && (
          <div className="settings__section">
            <p className="settings__hint">
              Stored in this repository's local config. Commits made from orbit use this identity.
            </p>
            <label className="settings__field">
              <span>Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your display name"
              />
            </label>
            <label className="settings__field">
              <span>Email</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                type="email"
              />
            </label>
            <div className="settings__actions">
              <button type="button" className="settings__btn settings__btn--primary" onClick={saveIdentity}>
                <Save size={12} />
                Save identity
              </button>
            </div>
          </div>
        )}

        {section === 'remotes' && (
          <div className="settings__section">
            {remotes.length === 0 && (
              <p className="settings__hint">No remotes configured yet.</p>
            )}
            {remotes.map((remote) => {
              const edited = urlEdits[remote.name];
              const changed = edited !== undefined && edited !== remote.url;
              return (
                <div key={remote.name} className="settings__remote">
                  <span className="settings__remote-name">{remote.name}</span>
                  <input
                    className="settings__remote-url"
                    defaultValue={remote.url}
                    placeholder="https://…"
                    onChange={(e) =>
                      setUrlEdits((prev) => ({ ...prev, [remote.name]: e.target.value }))
                    }
                  />
                  {changed && (
                    <button
                      type="button"
                      className="settings__btn settings__btn--small"
                      onClick={() => saveRemoteUrl(remote.name)}
                    >
                      <Save size={11} />
                      Save
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button icon-button--danger"
                    onClick={() => removeRemote(remote.name)}
                    aria-label={`Remove remote ${remote.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            <div className="settings__remote settings__remote--new">
              <input
                className="settings__remote-name-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="name"
                aria-label="New remote name"
              />
              <input
                className="settings__remote-url"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                aria-label="New remote URL"
              />
              <button
                type="button"
                className="settings__btn settings__btn--primary settings__btn--small"
                onClick={addRemote}
                disabled={!newName.trim() || !newUrl.trim()}
              >
                <Plus size={11} />
                Add
              </button>
            </div>
          </div>
        )}

        {section === 'gitignore' && (
          <div className="settings__section">
            <p className="settings__hint">
              Patterns listed here are excluded from status and commits.
            </p>
            <textarea
              className="settings__gitignore"
              value={gitignore}
              onChange={(e) => {
                setGitignore(e.target.value);
                setGitignoreDirty(true);
              }}
              spellCheck={false}
              aria-label=".gitignore contents"
            />
            <div className="settings__actions">
              <button
                type="button"
                className="settings__btn settings__btn--primary"
                onClick={saveGitignore}
                disabled={!gitignoreDirty}
              >
                <Save size={12} />
                Save .gitignore
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
