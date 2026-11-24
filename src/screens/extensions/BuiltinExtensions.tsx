/** The menus that come with Pigry (Diagram, Design, Board, E2E Testing, Reports) as Extension Store entries: they are
 * found by search, have a page of their own, and are switched on or off here as well as in Settings. */
import { ArrowLeft, Check } from 'lucide-react';
import { workspaceNav, type NavItem } from '../../app/navigation';
import { GO_SCREEN_EVENT, setMenuEnabled } from '../../lib/builtinExtensions';
import { MENU_GUIDES } from '../../lib/menuGuides';

export const BUILTIN_CATEGORY = 'Built-in';

export const builtinEntries = (): NavItem[] => workspaceNav.filter(({ group }) => group === 'extension');

/** Same word-by-word matching as the catalog search, over a built-in menu's name and guide. */
export function searchBuiltins(query: string, category: string): NavItem[] {
  if (category && category !== BUILTIN_CATEGORY) return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return builtinEntries().filter(({ id, label }) => {
    const guide = MENU_GUIDES[id];
    const hay = `${label} ${BUILTIN_CATEGORY} menu ${guide.summary} ${guide.features.map((f) => f.title).join(' ')}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

const open = (id: string) => window.dispatchEvent(new CustomEvent(GO_SCREEN_EVENT, { detail: id }));

interface SwitchProps { item: NavItem; enabled: boolean }

function EnableSwitch({ item, enabled }: SwitchProps) {
  return (
    <button
      type="button" role="switch" aria-checked={enabled} aria-label={`Enable ${item.label}`}
      className={`ext-switch${enabled ? ' ext-switch--on' : ''}`}
      onClick={() => setMenuEnabled(item.id, !enabled)}
    ><span /></button>
  );
}

export function BuiltinCard({ item, enabled, onOpenPage }: SwitchProps & { onOpenPage: () => void }) {
  const Icon = item.icon;
  const guide = MENU_GUIDES[item.id as keyof typeof MENU_GUIDES];
  return (
    <article className={`ext-card store-card${enabled ? '' : ' ext-card--off'}`} aria-label={`${item.label} (built-in)`}>
      <button type="button" className="store-card__open" aria-label={`Open ${item.label} page`} onClick={onOpenPage}>
        <span className="ext-card__head">
          <Icon size={18} strokeWidth={1.5} className="ext-card__icon" />
          <span className="ext-card__main">
            <strong>{item.label}</strong>
            <span className="ext-card__meta">Built-in · Pigry</span>
          </span>
        </span>
        <span className="ext-card__desc">{guide.summary}</span>
        <span className="ext-chips"><span>{BUILTIN_CATEGORY}</span><span>menu</span></span>
      </button>
      <div className="store-card__foot">
        <span className="ext-installed"><Check size={12} strokeWidth={1.75} /> Included</span>
        <span className="store-card__installed">
          {enabled && <button type="button" className="store-link" aria-label={`Open ${item.label}`} onClick={() => open(item.id)}>Open</button>}
          <EnableSwitch item={item} enabled={enabled} />
        </span>
      </div>
    </article>
  );
}

export function BuiltinDetail({ item, enabled, onBack }: SwitchProps & { onBack: () => void }) {
  const Icon = item.icon;
  const guide = MENU_GUIDES[item.id as keyof typeof MENU_GUIDES];
  return (
    <article className="ext-detail" aria-label={`${item.label} extension`}>
      <button type="button" className="store-link ext-detail__back" onClick={onBack}><ArrowLeft size={13} strokeWidth={1.5} /> Extension Store</button>
      <header className="ext-detail__head">
        <span className="ext-detail__icon" aria-hidden="true"><Icon size={34} strokeWidth={1.25} /></span>
        <div className="ext-detail__titles">
          <h2>{item.label}</h2>
          <p className="ext-card__meta">Pigry · Built-in · menu</p>
          <p className="ext-detail__lead">{guide.summary}</p>
        </div>
        <div className="ext-detail__actions">
          {enabled && <button type="button" className="ext-btn ext-btn--primary ext-detail__install" aria-label={`Open ${item.label}`} onClick={() => open(item.id)}>Open</button>}
          <EnableSwitch item={item} enabled={enabled} />
        </div>
      </header>
      <div className="ext-detail__layout">
        <div className="ext-detail__main">
          <section aria-label="About">
            <h3>About</h3>
            {guide.overview.map((text) => <p key={text}>{text}</p>)}
          </section>
          <section aria-label="Features">
            <h3>What you can do</h3>
            <div className="ext-detail__list">
              {guide.features.map((feature) => (
                <div key={feature.title} className="ext-detail__item">
                  <strong>{feature.title}</strong>
                  <p>{feature.text}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
        <aside className="ext-detail__side" aria-label="Details">
          <h3>Details</h3>
          <dl>
            <dt>Publisher</dt><dd>Pigry</dd>
            <dt>Kind</dt><dd>Built-in menu</dd>
            <dt>Status</dt><dd>{enabled ? 'On' : 'Off — hidden from the side bar'}</dd>
          </dl>
          <p className="ext-card__meta">Switching it off hides the menu from the side bar and the command palette; its files and agents stay.</p>
        </aside>
      </div>
    </article>
  );
}
