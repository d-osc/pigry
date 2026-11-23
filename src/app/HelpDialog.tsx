/** Full-screen guide for the active workspace menu: what it does, a step-by-step tutorial, tips, cautions and
 * screenshots. Opened by the info button in the title bar. */
import { useEffect, useRef } from 'react';
import { AlertTriangle, BookOpen, Bot, Lightbulb, ListChecks, X } from 'lucide-react';
import { MENU_GUIDES } from '../lib/menuGuides';
import { workspaceNav, type WorkspaceNavId } from './navigation';
import './HelpDialog.css';

const SECTIONS = [
  ['overview', 'Overview'],
  ['screenshots', 'Screenshots'],
  ['features', 'What you can do'],
  ['tutorial', 'Step-by-step tutorial'],
  ['tips', 'Tips'],
  ['cautions', 'Cautions'],
  ['agents', 'Ask the agents'],
] as const;

const imageUrl = (file: string): string => `${import.meta.env.BASE_URL}help/${file}`;

export function HelpDialog({ screen, onClose }: { screen: WorkspaceNavId; onClose: () => void }) {
  const item = workspaceNav.find(({ id }) => id === screen);
  const guide = MENU_GUIDES[screen];
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);

  if (!item || !guide) return null;
  const Icon = item.icon;
  const jump = (id: string) => bodyRef.current?.querySelector(`#help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="help-dialog" role="dialog" aria-modal="true" aria-label={`${item.label} guide`}>
      <header className="help-dialog__header">
        <Icon size={18} strokeWidth={1.5} className="help-dialog__icon" />
        <div className="help-dialog__heading">
          <h2 className="help-dialog__title">{item.label} guide</h2>
          <p className="help-dialog__summary">{guide.summary}</p>
        </div>
        <button ref={closeRef} type="button" className="icon-button help-dialog__close" onClick={onClose} aria-label="Close guide" title="Close (Esc)">
          <X size={16} />
        </button>
      </header>

      <div className="help-dialog__layout">
        <nav className="help-dialog__toc" aria-label="Guide sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" className="help-dialog__toc-link" onClick={() => jump(id)}>{label}</button>
          ))}
        </nav>

        <div ref={bodyRef} className="help-dialog__body">
          <section id="help-overview" className="help-section">
            <h3 className="help-section__title"><BookOpen size={15} strokeWidth={1.5} />Overview</h3>
            {guide.overview.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>

          <section id="help-screenshots" className="help-section">
            <h3 className="help-section__title">Screenshots</h3>
            <div className="help-shots">
              {guide.shots.map((shot) => (
                <figure key={shot.file} className="help-shot">
                  <img src={imageUrl(shot.file)} alt={`${item.label}: ${shot.caption}`} loading="lazy" />
                  <figcaption>{shot.caption}</figcaption>
                </figure>
              ))}
            </div>
          </section>

          <section id="help-features" className="help-section">
            <h3 className="help-section__title"><ListChecks size={15} strokeWidth={1.5} />What you can do</h3>
            <dl className="help-features">
              {guide.features.map((feature) => (
                <div key={feature.title} className="help-feature">
                  <dt>{feature.title}</dt>
                  <dd>{feature.text}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section id="help-tutorial" className="help-section">
            <h3 className="help-section__title"><ListChecks size={15} strokeWidth={1.5} />Step-by-step tutorial</h3>
            <ol className="help-steps">
              {guide.tutorial.map((step) => (
                <li key={step.title} className="help-step">
                  <strong>{step.title}</strong>
                  <span>{step.text}</span>
                </li>
              ))}
            </ol>
          </section>

          <section id="help-tips" className="help-section">
            <h3 className="help-section__title"><Lightbulb size={15} strokeWidth={1.5} />Tips</h3>
            <ul className="help-list help-list--tips">
              {guide.tips.map((tip) => <li key={tip}>{tip}</li>)}
            </ul>
          </section>

          <section id="help-cautions" className="help-section">
            <h3 className="help-section__title"><AlertTriangle size={15} strokeWidth={1.5} />Cautions</h3>
            <ul className="help-list help-list--cautions">
              {guide.cautions.map((caution) => <li key={caution}>{caution}</li>)}
            </ul>
          </section>

          <section id="help-agents" className="help-section">
            <h3 className="help-section__title"><Bot size={15} strokeWidth={1.5} />Ask the agents</h3>
            <p>
              Open the <strong>AI Agent</strong> panel on the right of this menu and just type: <code>@{guide.agents.default}</code> answers when you do not name anyone.
              For a specialist opinion, mention <code>@{guide.agents.base}</code>. Agents see the same menu you do and can use its tools, so describe what you want in plain words.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
