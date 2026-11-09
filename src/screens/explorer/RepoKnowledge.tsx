/** Project knowledge dialogs — memory + skills, stored IN the working repo
 * so they are versionable with the code:
 *   memory → .orbit/memory.md (one "- entry" per line)
 *   skills → .orbit/skills/<slug>.md (one markdown file per skill)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  deleteWorktreeFile,
  getFileTree,
  readWorktreeFile,
  writeWorktreeFile,
} from '../../lib/tauriClient';
import './RepoKnowledge.css';

const MEMORY_PATH = '.orbit/memory.md';
const SKILLS_DIR = '.orbit/skills/';

export function MemoryDialog({ onClose, notify }: { onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void }) {
  const [entries, setEntries] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Uncontrolled input — value read from the DOM on submit so external
   * value-setters (automation, IMEs) that skip React onChange still work. */
  const draftRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    readWorktreeFile(MEMORY_PATH)
      .then((file) => {
        if (cancelled) return;
        setEntries(
          file.content
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('- '))
            .map((line) => line.slice(2)),
        );
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (next: string[]) => {
      setEntries(next);
      try {
        const body = ['# Project memory', '', ...next.map((line) => `- ${line}`), ''].join('\n');
        await writeWorktreeFile(MEMORY_PATH, body);
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), 'error');
      }
    },
    [notify],
  );

  const addEntry = async () => {
    const line = draftRef.current?.value.trim() ?? '';
    if (!line) return;
    await persist([...entries, line]);
    if (draftRef.current) draftRef.current.value = '';
    notify('Memory saved', 'success');
  };

  const removeEntry = async (index: number) => {
    await persist(entries.filter((_, i) => i !== index));
    notify('Memory removed', 'success');
  };

  return (
    <div
      className="know-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="know-dlg" role="dialog" aria-modal="true" aria-label="Project memory">
        <header className="know-dlg__head">
          <div>
            <strong className="know-dlg__title">Project memory</strong>
            <p className="know-dlg__sub">
              Facts the AI should remember about this repo — stored in{' '}
              <code>{MEMORY_PATH}</code> and versioned with the code.
            </p>
          </div>
          <button type="button" className="know-dlg__close" onClick={onClose} aria-label="Close memory">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>
        <div className="know-dlg__body">
          {!loaded && <p className="know-dlg__empty">Loading…</p>}
          {loaded && entries.length === 0 && (
            <p className="know-dlg__empty">No memories yet — add one below.</p>
          )}
          {entries.map((entry, index) => (
            <div key={`${entry}-${index}`} className="know-row">
              <span className="know-row__text">{entry}</span>
              <button
                type="button"
                className="know-row__del"
                aria-label={`Remove memory: ${entry}`}
                onClick={() => void removeEntry(index)}
              >
                <Trash2 size={11} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
        <form
          className="know-dlg__foot"
          onSubmit={(event) => {
            event.preventDefault();
            void addEntry();
          }}
        >
          <input
            ref={draftRef}
            className="know-dlg__input"
            placeholder="e.g. Tests must run serially on Windows"
            aria-label="New memory"
            spellCheck={false}
          />
          <button type="submit" className="know-dlg__add">
            <Plus size={12} strokeWidth={2} />
            Add
          </button>
        </form>
      </div>
    </div>
  );
}

export function SkillsDialog({ onClose, notify }: { onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void }) {
  const [skills, setSkills] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Uncontrolled new-skill name (read from the DOM on submit). */
  const newNameRef = useRef<HTMLInputElement | null>(null);
  /** Currently open skill: name + body being edited. */
  const [editing, setEditing] = useState<{ name: string; body: string; isNew: boolean } | null>(null);

  const reload = useCallback(async () => {
    try {
      const tree = await getFileTree();
      const names = tree.entries
        .filter((p) => p.startsWith(SKILLS_DIR) && p.endsWith('.md'))
        .map((p) => p.slice(SKILLS_DIR.length, -3))
        .sort();
      setSkills(names);
    } catch {
      setSkills([]);
    }
    setLoaded(true);
  }, []);

  // One-shot initial load with the cancelled guard (react-hooks v7 rule).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tree = await getFileTree();
        if (cancelled) return;
        setSkills(
          tree.entries
            .filter((p) => p.startsWith(SKILLS_DIR) && p.endsWith('.md'))
            .map((p) => p.slice(SKILLS_DIR.length, -3))
            .sort(),
        );
      } catch {
        if (!cancelled) setSkills([]);
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const slugOf = (name: string) =>
    name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'skill';

  const openSkill = async (name: string) => {
    try {
      const file = await readWorktreeFile(`${SKILLS_DIR}${name}.md`);
      // Drop the leading "# Title" line — the name is shown separately.
      const body = file.content.replace(/^#\s+.*\n/, '').trimStart();
      setEditing({ name, body, isNew: false });
    } catch {
      setEditing({ name, body: '', isNew: false });
    }
  };

  const createSkill = async () => {
    const name = newNameRef.current?.value.trim() ?? '';
    if (!name) return;
    const slug = slugOf(name);
    try {
      await readWorktreeFile(`${SKILLS_DIR}${slug}.md`);
      notify(`Skill "${slug}" already exists`, 'error');
      return;
    } catch {
      // not found → good, we can create it
    }
    await writeWorktreeFile(`${SKILLS_DIR}${slug}.md`, `# ${name}\n\n`);
    if (newNameRef.current) newNameRef.current.value = '';
    await reload();
    setEditing({ name: slug, body: '', isNew: true });
    notify(`Skill "${slug}" created`, 'success');
  };

  const saveSkill = async () => {
    if (!editing) return;
    const body = `# ${editing.name}\n\n${editing.body.trimStart()}`;
    try {
      await writeWorktreeFile(`${SKILLS_DIR}${editing.name}.md`, body);
      notify(`Skill "${editing.name}" saved`, 'success');
      setEditing(null);
      await reload();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const removeSkill = async (name: string) => {
    try {
      await deleteWorktreeFile(`${SKILLS_DIR}${name}.md`);
      notify(`Skill "${name}" deleted`, 'success');
      await reload();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <div
      className="know-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="know-dlg" role="dialog" aria-modal="true" aria-label="Project skills">
        <header className="know-dlg__head">
          <div>
            <strong className="know-dlg__title">Project skills</strong>
            <p className="know-dlg__sub">
              Reusable instructions the AI can follow — one markdown file per skill in{' '}
              <code>{SKILLS_DIR}</code>.
            </p>
          </div>
          <button type="button" className="know-dlg__close" onClick={onClose} aria-label="Close skills">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>

        {editing ? (
          <div className="know-dlg__body know-dlg__body--editor">
            <div className="know-editor__head">
              <code className="know-editor__name">{SKILLS_DIR}{editing.name}.md</code>
            </div>
            <textarea
              className="know-editor__body"
              value={editing.body}
              placeholder="Describe when to use this skill and step-by-step instructions…"
              spellCheck={false}
              onChange={(event) =>
                setEditing((prev) => (prev ? { ...prev, body: event.target.value } : prev))
              }
            />
            <div className="know-editor__actions">
              <button
                type="button"
                className="know-editor__btn"
                onClick={() => setEditing(null)}
                disabled={!editing.isNew}
                title={editing.isNew ? 'A new skill must be saved first' : 'Back to the skill list'}
              >
                Back
              </button>
              <button
                type="button"
                className="know-editor__btn know-editor__btn--primary"
                onClick={() => void saveSkill()}
              >
                <Check size={11} strokeWidth={2} />
                Save skill
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="know-dlg__body">
              {!loaded && <p className="know-dlg__empty">Loading…</p>}
              {loaded && skills.length === 0 && (
                <p className="know-dlg__empty">No skills yet — add one below.</p>
              )}
              {skills.map((name) => (
                <div key={name} className="know-row">
                  <button type="button" className="know-row__text know-row__text--btn" onClick={() => void openSkill(name)}>
                    {name}
                  </button>
                  <button
                    type="button"
                    className="know-row__del"
                    aria-label={`Edit skill: ${name}`}
                    onClick={() => void openSkill(name)}
                  >
                    <Pencil size={11} strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    className="know-row__del"
                    aria-label={`Delete skill: ${name}`}
                    onClick={() => void removeSkill(name)}
                  >
                    <Trash2 size={11} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
            <form
              className="know-dlg__foot"
              onSubmit={(event) => {
                event.preventDefault();
                void createSkill();
              }}
            >
              <input
                ref={newNameRef}
                className="know-dlg__input"
                placeholder="New skill name, e.g. Run tests"
                aria-label="New skill name"
                spellCheck={false}
              />
              <button type="submit" className="know-dlg__add">
                <Plus size={12} strokeWidth={2} />
                Add
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
