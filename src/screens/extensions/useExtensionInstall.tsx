/** The install flow shared by the Extension Store and Settings › Extensions: check the manifest, show what it would add
 * for review, install on confirmation. `feedback` is the notice or the list of problems; `dialog` is the review. */
import { useCallback, useState, type ReactNode } from 'react';
import { AlertTriangle, Bot, Check, Terminal, Wand2 } from 'lucide-react';
import { needsTrust, parseExtensionManifest, type ExtensionManifest, type InstalledExtension, type InstallPlan } from '../../lib/extensionManifest';
import { installExtension, listExtensions, previewInstall } from '../../lib/extensions';

interface Review {
  manifest: ExtensionManifest;
  source: InstalledExtension['source'];
  plan: InstallPlan;
}

export function useExtensionInstall(onInstalled?: (extension: InstalledExtension) => void): {
  /** Checks `input` (a manifest or its JSON text) and opens the review. */
  startReview: (input: unknown, source: InstalledExtension['source']) => Promise<void>;
  /** The "Installed …" notice and the list of problems, to render where the user is looking. */
  feedback: ReactNode;
  /** The review dialog while one is open. */
  dialog: ReactNode;
  clearFeedback: () => void;
} {
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);

  const startReview = useCallback(async (input: unknown, source: InstalledExtension['source']) => {
    setNotice('');
    const parsed = parseExtensionManifest(input);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setTrusted(false);
    setReview({ manifest: parsed.manifest, source, plan: await previewInstall(parsed.manifest) });
  }, []);

  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    const result = await installExtension(review.manifest, review.source);
    setBusy(false);
    if (!result.ok) {
      setErrors(result.errors);
      setReview(null);
      return;
    }
    setNotice(`Installed ${result.extension.name}.`);
    setReview(null);
    onInstalled?.(result.extension);
  };

  const feedback = (
    <>
      {notice && <p className="ext-notice" role="status"><Check size={13} strokeWidth={1.75} /> {notice}</p>}
      {errors.length > 0 && (
        <div className="ext-errors" role="alert">
          <strong><AlertTriangle size={13} strokeWidth={1.5} /> That extension cannot be installed</strong>
          <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
        </div>
      )}
    </>
  );

  const replaces = review ? listExtensions().some((extension) => extension.id === review.manifest.id) : false;
  const dialog = review && (
    <div className="ext-overlay" role="presentation">
      <div className="ext-review" role="dialog" aria-modal="true" aria-label={`Install ${review.manifest.name}`}>
        <h3>Install {review.manifest.name} <span className="ext-card__meta">v{review.manifest.version}</span></h3>
        {review.manifest.description && <p>{review.manifest.description}</p>}
        {review.manifest.author && <p className="ext-card__meta">By {review.manifest.author} · id {review.manifest.id}</p>}
        {replaces && <p className="ext-warning">This replaces the installed version.</p>}
        <p className="ext-review__label">It will add</p>
        <ul className="ext-review__list">
          {review.manifest.agents.map((agent) => <li key={agent.username}><Bot size={12} strokeWidth={1.5} /> Agent <strong>@{agent.username}</strong> — {agent.role || agent.name}</li>)}
          {review.plan.skills.map((skill) => <li key={skill.id}><Wand2 size={12} strokeWidth={1.5} /> Skill <strong>#{skill.id}</strong> — {skill.name}</li>)}
          {review.manifest.hooks.map((hook) => <li key={hook.command} className="ext-review__run"><Terminal size={12} strokeWidth={1.5} /> Hook ({hook.event}) runs <code>{hook.command}</code></li>)}
          {review.manifest.mcpServers.map((server) => <li key={server.name} className="ext-review__run"><Terminal size={12} strokeWidth={1.5} /> MCP server <strong>{server.name}</strong> {server.transport === 'stdio' ? <>starts <code>{`${server.command} ${server.args}`.trim()}</code></> : <>connects to <code>{server.url}</code></>}</li>)}
        </ul>
        {review.plan.conflicts.length > 0 && (
          <div className="ext-errors" role="alert"><ul>{review.plan.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul></div>
        )}
        {needsTrust(review.manifest) && (
          <label className="ext-trust">
            <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
            <span><AlertTriangle size={13} strokeWidth={1.5} /> This extension makes Pigry run commands or programs on this computer. I have read them above and I trust where this file came from.</span>
          </label>
        )}
        <div className="ext-review__buttons">
          <button type="button" className="ext-btn" onClick={() => setReview(null)}>Cancel</button>
          <button type="button" className="ext-btn ext-btn--primary" disabled={busy || review.plan.conflicts.length > 0 || (needsTrust(review.manifest) && !trusted)} onClick={() => void confirm()}>Install</button>
        </div>
      </div>
    </div>
  );

  return { startReview, feedback, dialog, clearFeedback: () => { setNotice(''); setErrors([]); } };
}
