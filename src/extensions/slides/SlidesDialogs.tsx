import { useMemo, useState } from 'react';
import { Field, Modal } from '../docs/DocsDialogs';
import { FONTS, SIZES, THEMES, THEME_COLOR_KEYS, aspectOf, type ChartEl, type Deck, type Slide, type Theme, type ThemeColors } from './slides';
import { TEMPLATES, templateDeck, type TemplateId } from './slidesFormat';
import { slideHtml } from './slidesRender';

/** A slide drawn small (live HTML, scaled). */
export function SlideThumb({ deck, slide, width, label }: { deck: Deck; slide: Slide; width: number; label?: string }) {
  const k = width / deck.size.w;
  const html = useMemo(() => slideHtml(deck, slide), [deck, slide]);
  return (
    <span className="sl-mini" style={{ width, height: deck.size.h * k }} aria-label={label} role={label ? 'img' : undefined}>
      <span className="sl-mini__inner" style={{ width: deck.size.w, height: deck.size.h, transform: `scale(${k})` }} dangerouslySetInnerHTML={{ __html: html }} />
    </span>
  );
}
function TemplateThumb({ id }: { id: TemplateId }) {
  const deck = useMemo(() => templateDeck(id, TEMPLATES.find((t) => t.id === id)?.label ?? 'Title'), [id]);
  return <SlideThumb deck={deck} slide={deck.slides[0]} width={150} />;
}
export function TemplateGallery({ onPick, picked, idPrefix = 'New' }: { onPick: (id: TemplateId) => void; picked?: TemplateId; idPrefix?: string }) {
  return (
    <div className="sl-templates" role="radiogroup" aria-label="Template">
      {TEMPLATES.map((t) => (
        <button key={t.id} type="button" role={picked !== undefined ? 'radio' : undefined} aria-checked={picked !== undefined ? picked === t.id : undefined} aria-label={picked !== undefined ? t.label : `${idPrefix} ${t.label} presentation`}
          className={`sl-template${picked === t.id ? ' sl-template--on' : ''}`} onClick={() => onPick(t.id)}>
          <TemplateThumb id={t.id} /><span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function NewDeckDialog({ initial = 'blank', onCreate, onClose }: { initial?: TemplateId; onCreate: (name: string, t: TemplateId) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TemplateId>(initial);
  return (
    <Modal title="New presentation" okLabel="Create" wide onClose={onClose} onOk={() => onCreate(name, kind)}>
      <Field label="Name"><input className="dc-input" aria-label="Presentation name" value={name} placeholder="my-talk" onChange={(e) => setName(e.target.value)} /></Field>
      <TemplateGallery picked={kind} onPick={setKind} />
      <p className="dc-note">{TEMPLATES.find((t) => t.id === kind)?.hint}</p>
    </Modal>
  );
}

export interface FindState { find: string; replace: string; matchCase: boolean }
export function FindDialog({ replaceMode, status, onChange, onNext, onReplace, onReplaceAll, onClose }: { replaceMode: boolean; status: string; onChange: (s: FindState) => void; onNext: (back?: boolean) => void; onReplace: () => void; onReplaceAll: () => void; onClose: () => void }) {
  const [s, setS] = useState<FindState>({ find: '', replace: '', matchCase: false });
  const set = (p: Partial<FindState>) => { const n = { ...s, ...p }; setS(n); onChange(n); };
  return (
    <Modal title={replaceMode ? 'Find and replace' : 'Find'} onClose={onClose}
      extra={<><button type="button" className="dc-btn" onClick={() => onNext(true)}>Previous</button><button type="button" className="dc-btn" onClick={() => onNext()}>Next</button>{replaceMode && <><button type="button" className="dc-btn" onClick={onReplace}>Replace</button><button type="button" className="dc-btn dc-btn--primary" onClick={onReplaceAll}>Replace all</button></>}</>}>
      <Field label="Find"><input className="dc-input" aria-label="Find" value={s.find} onChange={(e) => set({ find: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onNext(e.shiftKey); } }} /></Field>
      {replaceMode && <Field label="Replace with"><input className="dc-input" aria-label="Replace with" value={s.replace} onChange={(e) => set({ replace: e.target.value })} /></Field>}
      <label className="dc-check"><input type="checkbox" checked={s.matchCase} onChange={(e) => set({ matchCase: e.target.checked })} /> Match case</label>
      <p className="dc-note" role="status">{status}</p>
    </Modal>
  );
}

const COLOR_LABEL: Record<keyof ThemeColors, string> = { background: 'Background', surface: 'Surface (cards, table bands)', text: 'Text', title: 'Titles', muted: 'Muted text', accent: 'Accent 1', accent2: 'Accent 2', accent3: 'Accent 3', accent4: 'Accent 4' };
/** Edit the theme (master): colours and fonts every slide uses. */
export function ThemeDialog({ theme, onOk, onClose }: { theme: Theme; onOk: (t: Theme) => void; onClose: () => void }) {
  const [t, setT] = useState<Theme>(() => structuredClone(theme));
  const preview = useMemo(() => { const d = templateDeck('blank', 'Theme preview'); d.theme = t; d.slides[0].elements.forEach((e) => { if (e.type === 'text' && e.role === 'subtitle') e.paras = [{ runs: [{ t: 'Body text and ' }, { t: 'accent', color: '$accent', b: true }] }]; }); return d; }, [t]);
  return (
    <Modal title="Edit theme" okLabel="Apply to all slides" wide onClose={onClose} onOk={() => onOk({ ...t, id: t.id === theme.id && JSON.stringify(t) === JSON.stringify(theme) ? t.id : 'custom', name: t.name })}>
      <div className="sl-theme-edit">
        <div>
          <Field label="Theme name"><input className="dc-input" aria-label="Theme name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <div className="dc-row">
            <Field label="Title font"><select className="dc-select" aria-label="Title font" value={t.fonts.title} onChange={(e) => setT({ ...t, fonts: { ...t.fonts, title: e.target.value } })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></Field>
            <Field label="Body font"><select className="dc-select" aria-label="Body font" value={t.fonts.body} onChange={(e) => setT({ ...t, fonts: { ...t.fonts, body: e.target.value } })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></Field>
          </div>
          <div className="dc-row">
            <Field label="Title size (pt)"><input className="dc-input" type="number" aria-label="Title size" min={12} max={120} value={t.titleSize ?? 36} onChange={(e) => setT({ ...t, titleSize: Number(e.target.value) || 36 })} /></Field>
            <Field label="Body size (pt)"><input className="dc-input" type="number" aria-label="Body size" min={8} max={60} value={t.bodySize ?? 18} onChange={(e) => setT({ ...t, bodySize: Number(e.target.value) || 18 })} /></Field>
          </div>
          <div className="sl-colors">
            {THEME_COLOR_KEYS.map((k) => (
              <label key={k} className="sl-color-row"><input type="color" aria-label={`${COLOR_LABEL[k]} colour`} value={t.colors[k]} onChange={(e) => setT({ ...t, colors: { ...t.colors, [k]: e.target.value } })} /><span>{COLOR_LABEL[k]}</span><code>{t.colors[k]}</code></label>
            ))}
          </div>
        </div>
        <div className="sl-theme-edit__preview">
          <SlideThumb deck={preview} slide={preview.slides[0]} width={300} label="Theme preview" />
          <p className="dc-note">Start from a built-in theme:</p>
          <div className="dc-chips">{THEMES.map((x) => <button key={x.id} type="button" className="dc-chip-btn" onClick={() => setT(structuredClone(x))}>{x.name}</button>)}</div>
        </div>
      </div>
    </Modal>
  );
}

/** Chart data as a small table of text: first row = series names, first column = categories. */
export function ChartDialog({ chart, onOk, onClose }: { chart: ChartEl; onOk: (c: Pick<ChartEl, 'labels' | 'series' | 'chart' | 'title'>) => void; onClose: () => void }) {
  const initial = [['', ...chart.series.map((s) => s.name)].join('\t'), ...chart.labels.map((l, i) => [l, ...chart.series.map((s) => String(s.values[i] ?? ''))].join('\t'))].join('\n');
  const [text, setText] = useState(initial);
  const [kind, setKind] = useState(chart.chart);
  const [title, setTitle] = useState(chart.title ?? '');
  const parse = () => {
    const rows = text.split('\n').map((l) => l.split(/\t|,|;/).map((c) => c.trim())).filter((r) => r.some(Boolean));
    const names = (rows[0] ?? []).slice(1);
    const body = rows.slice(1);
    return { chart: kind, title: title || undefined, labels: body.map((r) => r[0] ?? ''), series: names.map((n, si) => ({ name: n || `Series ${si + 1}`, values: body.map((r) => Number(String(r[si + 1] ?? '').replace(/[^\d.-]/g, '')) || 0), ...(chart.series[si]?.color ? { color: chart.series[si].color } : {}) })) };
  };
  return (
    <Modal title="Chart data" okLabel="Update chart" onClose={onClose} onOk={() => onOk(parse())}>
      <div className="dc-row">
        <Field label="Chart type"><select className="dc-select" aria-label="Chart type" value={kind} onChange={(e) => setKind(e.target.value as ChartEl['chart'])}>{['column', 'bar', 'line', 'pie', 'doughnut'].map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
        <Field label="Title"><input className="dc-input" aria-label="Chart title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      </div>
      <Field label="Data — one row per category; first row is the series names (tabs or commas)"><textarea className="dc-input dc-area dc-mono" aria-label="Chart data" rows={8} value={text} onChange={(e) => setText(e.target.value)} /></Field>
    </Modal>
  );
}

export function MarkdownDialog({ onOk, onClose }: { onOk: (md: string, replace: boolean) => void; onClose: () => void }) {
  const [md, setMd] = useState('# Talk title\nSubtitle\n\n## First point\n- Supporting fact\n- Another fact\n> What to say on this slide\n\n## 42%\nThe one number that matters');
  const [replace, setReplace] = useState(false);
  return (
    <Modal title="Import Markdown outline" okLabel="Add slides" wide onClose={onClose} onOk={() => onOk(md, replace)}>
      <p className="dc-note">"# " or "## " starts a slide, "---" splits slides, "- " makes bullets, lines starting with "&gt;" or "Notes:" become speaker notes, ![alt](data:…) adds a picture and | a | b | rows make a table. A heading that is only a number makes a big-number slide.</p>
      <textarea className="dc-input dc-area dc-mono" aria-label="Markdown outline" rows={12} value={md} onChange={(e) => setMd(e.target.value)} />
      <label className="dc-check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace all slides</label>
    </Modal>
  );
}

export function PageSetupDialog({ deck, onOk, onClose }: { deck: Deck; onOk: (size: { w: number; h: number }) => void; onClose: () => void }) {
  const [v, setV] = useState(aspectOf(deck.size) in SIZES ? aspectOf(deck.size) : '16:9');
  return (
    <Modal title="Page setup" okLabel="Apply" onClose={onClose} onOk={() => onOk(SIZES[v as keyof typeof SIZES])}>
      <Field label="Slide size"><select className="dc-select" aria-label="Slide size" value={v} onChange={(e) => setV(e.target.value)}>{Object.entries(SIZES).map(([k, s]) => <option key={k} value={k}>{k === 'A4' ? 'A4 (landscape)' : `Widescreen ${k}`.replace('Widescreen 4:3', 'Standard 4:3')} — {s.w}×{s.h}</option>)}</select></Field>
      <p className="dc-note">Elements are scaled to the new size; check text boxes afterwards.</p>
    </Modal>
  );
}
