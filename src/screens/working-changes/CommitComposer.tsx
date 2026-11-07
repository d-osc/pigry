import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import './CommitComposer.css';

const TITLE_LIMIT = 72;

export function CommitComposer() {
  const { repository, commit, busy } = useRepository();
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);

  const stagedCount = repository?.files.filter((f) => f.staged).length ?? 0;
  const canCommit = !busy && !committing && stagedCount > 0;

  const [title, ...bodyLines] = useMemo(
    () => message.split('\n'),
    [message],
  );
  const titleLength = title?.length ?? 0;
  const overLimit = titleLength > TITLE_LIMIT;

  const handleCommit = async () => {
    if (!canCommit) return;
    setCommitting(true);
    try {
      await commit(title ?? '', bodyLines.join('\n').trim(), amend);
      setMessage('');
      setAmend(false);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="commit-composer">
      <div className="commit-composer__head">
        <h2 className="commit-composer__title">Create commit</h2>
        <button type="button" className="commit-composer__generate" title="Coming soon">
          <Sparkles size={12} />
          Generate message
        </button>
      </div>

      <textarea
        className="commit-composer__message"
        placeholder={`Summary line…\n\nDescription`}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        spellCheck={false}
        aria-label="Commit message"
        disabled={committing}
      />

      <div className="commit-composer__options">
        <label className="commit-composer__amend">
          <input
            type="checkbox"
            checked={amend}
            onChange={(event) => setAmend(event.target.checked)}
          />
          Amend last commit
        </label>
        <span className={`commit-composer__counter${overLimit ? ' is-over' : ''}`}>
          {titleLength} / {TITLE_LIMIT}
        </span>
      </div>

      {repository && (
        <div className="commit-composer__author">
          <div className="avatar avatar--sm">{repository.account.initials}</div>
          <div className="commit-composer__author-meta">
            <span className="commit-composer__author-name">
              {repository.account.name}
            </span>
            <span className="commit-composer__author-email">
              {repository.account.email}
            </span>
          </div>
        </div>
      )}

      <div className="commit-composer__submit">
        <button
          type="button"
          className="primary-button"
          onClick={() => void handleCommit()}
          disabled={!canCommit}
        >
          {committing
            ? 'Committing…'
            : amend
              ? 'Amend commit'
              : `Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`}
          <kbd>⌘ ↵</kbd>
        </button>
        <p className="commit-composer__note">
          {stagedCount === 0
            ? 'Stage files to enable committing'
            : amend
              ? 'The previous commit will be replaced'
              : 'Unstaged files stay in your working tree'}
        </p>
      </div>
    </div>
  );
}
