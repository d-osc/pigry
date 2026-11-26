import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { PAGE_SIZES, type Align, type DocStats, type Margins, type PageSetup, type PageSize } from './docs';
import { TEMPLATES, eqToHtml, type TemplateId } from './docsFormat';

interface ModalProps { title: string; children: ReactNode; onClose: () => void; onOk?: () => void; okLabel?: string; okDisabled?: boolean; extra?: ReactNode; wide?: boolean }
export function Modal({ title, children, onClose, onOk, okLabel = 'OK', okDisabled, extra, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([aria-label="Close"])')?.focus(); }, []);
  return (
    <div className="dc-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`dc-modal${wide ? ' dc-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && onOk && !okDisabled && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') onOk(); }}>
        <header className="dc-modal__head"><h2>{title}</h2><button type="button" className="dc-icon" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="dc-modal__body">{children}</div>
        {(onOk || extra) && <footer className="dc-modal__foot">{extra}<span className="dc-grow" /><button type="button" className="dc-btn" onClick={onClose}>{onOk ? 'Cancel' : 'Close'}</button>{onOk && <button type="button" className="dc-btn dc-btn--primary" disabled={okDisabled} onClick={onOk}>{okLabel}</button>}</footer>}
      </div>
    </div>
  );
}
export const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="dc-field"><span>{label}</span>{children}</label>;

export function NewDocDialog({ initial = 'blank', onCreate, onClose }: { initial?: TemplateId; onCreate: (name: string, t: TemplateId) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TemplateId>(initial);
  return (
    <Modal title="New document" okLabel="Create" onClose={onClose} onOk={() => onCreate(name, kind)}>
      <Field label="Name"><input className="dc-input" aria-label="Document name" value={name} placeholder="my-document" onChange={(e) => setName(e.target.value)} /></Field>
      <div className="dc-templates" role="radiogroup" aria-label="Template">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={kind === t.id} className={`dc-template${kind === t.id ? ' dc-template--on' : ''}`} onClick={() => setKind(t.id)}>
            <TemplateThumb id={t.id} /><span>{t.label}</span>
          </button>
        ))}
      </div>
      <p className="dc-note">{TEMPLATES.find((t) => t.id === kind)?.hint}</p>
    </Modal>
  );
}
/** A tiny drawing of a template's first page. */
export function TemplateThumb({ id }: { id: TemplateId }) {
  const lines = id === 'blank' ? [] : id === 'meeting' ? ['t', 's', 'h', 'l', 'h', 'n', 'n', 'h', 'c', 'c'] : id === 'proposal' ? ['t', 's', 'h', 'l', 'l', 'h', 'n', 'n', 'h', 'g'] : ['t', 's', 'k', 'k', 'h', 'l', 'h', 'g', 'l'];
  return (
    <span className="dc-thumb" aria-hidden>
      {lines.map((k, i) => <i key={i} className={`dc-thumb__${k}`} />)}
    </span>
  );
}

export function PromptDialog({ title, label, initial = '', multiline, okLabel = 'OK', onOk, onClose }: { title: string; label: string; initial?: string; multiline?: boolean; okLabel?: string; onOk: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} okLabel={okLabel} onClose={onClose} onOk={() => onOk(v)}>
      <Field label={label}>{multiline ? <textarea className="dc-input dc-area" aria-label={label} rows={5} value={v} onChange={(e) => setV(e.target.value)} /> : <input className="dc-input" aria-label={label} value={v} onChange={(e) => setV(e.target.value)} />}</Field>
    </Modal>
  );
}

export function LinkDialog({ text, url, canEditText, onOk, onRemove, onClose }: { text: string; url: string; canEditText: boolean; onOk: (text: string, url: string) => void; onRemove?: () => void; onClose: () => void }) {
  const [t, setT] = useState(text);
  const [u, setU] = useState(url);
  return (
    <Modal title="Insert link" okLabel="Apply" okDisabled={!u.trim()} onClose={onClose} onOk={() => onOk(t, u.trim())} extra={onRemove ? <button type="button" className="dc-btn" onClick={onRemove}>Remove link</button> : undefined}>
      {canEditText && <Field label="Text"><input className="dc-input" aria-label="Link text" value={t} onChange={(e) => setT(e.target.value)} /></Field>}
      <Field label="Link"><input className="dc-input" aria-label="Link URL" value={u} placeholder="https://… or #heading" onChange={(e) => setU(e.target.value)} /></Field>
    </Modal>
  );
}

export interface FindState { find: string; replace: string; matchCase: boolean; wholeWord: boolean; regex: boolean }
export function FindDialog({ replaceMode, initial, status, onChange, onNext, onReplace, onReplaceAll, onClose }: {
  replaceMode: boolean; initial: string; status: string; onChange: (o: FindState) => void; onNext: (o: FindState, back: boolean) => void; onReplace: (o: FindState) => void; onReplaceAll: (o: FindState) => void; onClose: () => void;
}) {
  const [o, setO] = useState<FindState>({ find: initial, replace: '', matchCase: false, wholeWord: false, regex: false });
  const set = (patch: Partial<FindState>) => { const next = { ...o, ...patch }; setO(next); onChange(next); };
  return (
    <Modal title={replaceMode ? 'Find and replace' : 'Find'} onClose={onClose} extra={<>
      <button type="button" className="dc-btn" disabled={!o.find} onClick={() => onNext(o, true)}>Previous</button>
      <button type="button" className="dc-btn" disabled={!o.find} onClick={() => onNext(o, false)}>Next</button>
      {replaceMode && <><button type="button" className="dc-btn" disabled={!o.find} onClick={() => onReplace(o)}>Replace</button><button type="button" className="dc-btn dc-btn--primary" disabled={!o.find} onClick={() => onReplaceAll(o)}>Replace all</button></>}
    </>}>
      <Field label="Find"><input className="dc-input" aria-label="Find" value={o.find} onChange={(e) => set({ find: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && o.find) { e.preventDefault(); onNext(o, e.shiftKey); } }} /></Field>
      {replaceMode && <Field label="Replace with"><input className="dc-input" aria-label="Replace with" value={o.replace} onChange={(e) => set({ replace: e.target.value })} /></Field>}
      <div className="dc-checks">
        <label className="dc-check"><input type="checkbox" checked={o.matchCase} onChange={(e) => set({ matchCase: e.target.checked })} /> Match case</label>
        <label className="dc-check"><input type="checkbox" checked={o.wholeWord} onChange={(e) => set({ wholeWord: e.target.checked })} /> Whole words only</label>
        <label className="dc-check"><input type="checkbox" checked={o.regex} onChange={(e) => set({ regex: e.target.checked })} /> Use regular expressions</label>
      </div>
      <p className="dc-note" role="status" data-testid="find-status">{status}</p>
    </Modal>
  );
}

export function PageSetupDialog({ page, onOk, onClose }: { page: PageSetup; onOk: (p: PageSetup) => void; onClose: () => void }) {
  const [p, setP] = useState<PageSetup>(page);
  const margin = (k: keyof Margins, v: string) => { const n = Number(v); if (n >= 0 && n <= 4) setP({ ...p, margins: { ...p.margins, [k]: n } }); };
  return (
    <Modal title="Page setup" onClose={onClose} onOk={() => onOk(p)}>
      <div className="dc-chips" role="radiogroup" aria-label="Orientation">
        {(['portrait', 'landscape'] as const).map((o) => <button key={o} type="button" role="radio" aria-checked={p.orientation === o} className={`dc-chip-btn${p.orientation === o ? ' dc-chip-btn--on' : ''}`} onClick={() => setP({ ...p, orientation: o })}>{o === 'portrait' ? 'Portrait' : 'Landscape'}</button>)}
      </div>
      <Field label="Paper size">
        <select className="dc-select" aria-label="Paper size" value={p.size} onChange={(e) => setP({ ...p, size: e.target.value as PageSize })}>{(Object.keys(PAGE_SIZES) as PageSize[]).map((s) => <option key={s} value={s}>{PAGE_SIZES[s].label}</option>)}</select>
      </Field>
      <div className="dc-row">
        {(['top', 'bottom', 'left', 'right'] as const).map((k) => <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} (inches)`}><input className="dc-input" type="number" step="0.1" min="0" max="4" aria-label={`${k} margin`} value={p.margins[k]} onChange={(e) => margin(k, e.target.value)} /></Field>)}
      </div>
      <Field label="Page colour"><input className="dc-color" type="color" aria-label="Page colour" value={p.color ?? '#ffffff'} onChange={(e) => setP({ ...p, color: e.target.value === '#ffffff' ? undefined : e.target.value })} /></Field>
    </Modal>
  );
}

export interface HeaderFooterValue { header: string; headerAlign: Align; footer: string; footerAlign: Align; firstPageDifferent: boolean }
export function HeaderFooterDialog({ value, onOk, onClose }: { value: HeaderFooterValue; onOk: (v: HeaderFooterValue) => void; onClose: () => void }) {
  const [v, setV] = useState(value);
  const align = (key: 'headerAlign' | 'footerAlign') => (
    <div className="dc-chips" role="radiogroup" aria-label={key === 'headerAlign' ? 'Header alignment' : 'Footer alignment'}>
      {(['left', 'center', 'right'] as const).map((a) => <button key={a} type="button" role="radio" aria-checked={v[key] === a} className={`dc-chip-btn${v[key] === a ? ' dc-chip-btn--on' : ''}`} onClick={() => setV({ ...v, [key]: a })}>{a}</button>)}
    </div>
  );
  return (
    <Modal title="Headers & footers" onClose={onClose} onOk={() => onOk(v)} extra={<button type="button" className="dc-btn" onClick={() => setV({ ...v, footer: v.footer ? v.footer : 'Page {page} of {pages}', footerAlign: v.footer ? v.footerAlign : 'right' })}>Add page numbers</button>}>
      <Field label="Header"><input className="dc-input" aria-label="Header text" value={v.header} placeholder="e.g. {title}" onChange={(e) => setV({ ...v, header: e.target.value })} /></Field>
      {align('headerAlign')}
      <Field label="Footer"><input className="dc-input" aria-label="Footer text" value={v.footer} placeholder="e.g. Page {page} of {pages}" onChange={(e) => setV({ ...v, footer: e.target.value })} /></Field>
      {align('footerAlign')}
      <label className="dc-check"><input type="checkbox" checked={v.firstPageDifferent} onChange={(e) => setV({ ...v, firstPageDifferent: e.target.checked })} /> Different first page (no header or footer on page 1)</label>
      <p className="dc-note">Fields: {'{page}'} page number, {'{pages}'} page count, {'{title}'} document title, {'{date}'} today. Leave a box empty to remove it.</p>
    </Modal>
  );
}

export function WordCountDialog({ stats, selection, pages, showWhileTyping, onToggle, onClose }: { stats: DocStats; selection: DocStats | null; pages: number; showWhileTyping: boolean; onToggle: (v: boolean) => void; onClose: () => void }) {
  const rows: [string, number, number | undefined][] = [
    ['Pages', pages, undefined], ['Words', stats.words, selection?.words], ['Characters', stats.characters, selection?.characters], ['Characters excluding spaces', stats.charactersNoSpaces, selection?.charactersNoSpaces],
    ['Paragraphs', stats.paragraphs, selection?.paragraphs],
  ];
  return (
    <Modal title="Word count" onClose={onClose} extra={<span />}>
      <table className="dc-count" aria-label="Word count">
        {selection && <thead><tr><th /><th>Selection</th><th>Document</th></tr></thead>}
        <tbody>{rows.map(([label, all, part]) => <tr key={label}><td>{label}</td>{selection && <td>{part ?? ''}</td>}<td data-testid={`count-${label.toLowerCase().replace(/\s+/g, '-')}`}>{all.toLocaleString()}</td></tr>)}</tbody>
      </table>
      <label className="dc-check"><input type="checkbox" checked={showWhileTyping} onChange={(e) => onToggle(e.target.checked)} /> Display word count while typing</label>
    </Modal>
  );
}

const CHAR_SETS: Record<string, string> = {
  Punctuation: '“”‘’«»‹›„‚–—…·•†‡§¶©®™°′″‰¡¿※',
  Arrows: '←→↑↓↔↕⇐⇒⇑⇓⇔↩↪⟵⟶➔➜➤',
  Maths: '±×÷≠≈≡≤≥∞∑∏∫√∂∆∇∈∉⊂⊃∪∩∧∨¬∀∃∅ℕℤℚℝℂπ¼½¾⅓⅔²³¹',
  Currency: '$€£¥฿₩₹₽₫₱₺¢',
  Greek: 'αβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΦΨΩ',
  Symbols: '✓✔✗✘★☆♥♦♣♠☐☑☒●○■□▲△▼▽◆◇♪♫☀☁☂☎✉✂✏',
  Thai: '๐๑๒๓๔๕๖๗๘๙฿ๆฯ๏๚๛',
};
export function SpecialCharsDialog({ onInsert, onClose }: { onInsert: (ch: string) => void; onClose: () => void }) {
  const [set, setSet] = useState('Punctuation');
  return (
    <Modal title="Special characters" onClose={onClose} wide>
      <div className="dc-chips" role="tablist" aria-label="Character sets">
        {Object.keys(CHAR_SETS).map((k) => <button key={k} type="button" role="tab" aria-selected={set === k} className={`dc-chip-btn${set === k ? ' dc-chip-btn--on' : ''}`} onClick={() => setSet(k)}>{k}</button>)}
      </div>
      <div className="dc-chars">{[...CHAR_SETS[set]].map((ch) => <button key={ch} type="button" aria-label={`Insert ${ch}`} onClick={() => onInsert(ch)}>{ch}</button>)}</div>
    </Modal>
  );
}

export function EquationDialog({ initial, onOk, onRemove, onClose }: { initial: string; onOk: (tex: string) => void; onRemove?: () => void; onClose: () => void }) {
  const [tex, setTex] = useState(initial);
  const add = (s: string) => setTex((t) => `${t}${s}`);
  return (
    <Modal title="Equation" okLabel={initial ? 'Update' : 'Insert'} okDisabled={!tex.trim()} onClose={onClose} onOk={() => onOk(tex.trim())} extra={onRemove ? <button type="button" className="dc-btn" onClick={onRemove}>Remove</button> : undefined}>
      <Field label="Equation (TeX: ^ superscript, _ subscript, \frac{a}{b}, \sqrt{x}, \alpha, \sum, \leq …)"><input className="dc-input dc-mono" aria-label="Equation" value={tex} onChange={(e) => setTex(e.target.value)} /></Field>
      <div className="dc-chips">{['^{2}', '_{i}', '\\frac{a}{b}', '\\sqrt{x}', '\\pi', '\\alpha', '\\sum', '\\int', '\\leq', '\\geq', '\\neq', '\\pm', '\\times', '\\infty', '\\rightarrow'].map((s) => <button key={s} type="button" className="dc-chip-btn dc-mono" onClick={() => add(s)}>{s}</button>)}</div>
      <div className="dc-eqpreview" aria-label="Equation preview" dangerouslySetInnerHTML={{ __html: eqToHtml(tex) || '&nbsp;' }} />
    </Modal>
  );
}

export function TableDialog({ onOk, onClose }: { onOk: (rows: number, cols: number) => void; onClose: () => void }) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  return (
    <Modal title="Insert table" okLabel="Insert" onClose={onClose} onOk={() => onOk(rows, cols)}>
      <div className="dc-row">
        <Field label="Rows"><input className="dc-input" type="number" min={1} max={500} aria-label="Rows" value={rows} onChange={(e) => setRows(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} /></Field>
        <Field label="Columns"><input className="dc-input" type="number" min={1} max={50} aria-label="Columns" value={cols} onChange={(e) => setCols(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></Field>
      </div>
    </Modal>
  );
}

/** The table size grid of Insert ▸ Table. */
export function TableGrid({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ r: 0, c: 0 });
  return (
    <div className="dc-tgrid" aria-label="Table size">
      <div className="dc-tgrid__cells" onMouseLeave={() => setHover({ r: 0, c: 0 })}>
        {Array.from({ length: 8 }, (_, r) => Array.from({ length: 10 }, (_, c) => (
          <button key={`${r}-${c}`} type="button" aria-label={`${r + 1} x ${c + 1} table`} className={r < hover.r && c < hover.c ? 'dc-tgrid--on' : ''} onMouseEnter={() => setHover({ r: r + 1, c: c + 1 })} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(r + 1, c + 1)} />
        )))}
      </div>
      <div className="dc-tgrid__label">{hover.r ? `${hover.r} × ${hover.c}` : 'Pick a size'}</div>
    </div>
  );
}

export function ReviewDialog({ lines, onClose }: { lines: string[]; onClose: () => void }) {
  return (
    <Modal title="Writing review" onClose={onClose} wide extra={<span />}>
      {lines.length ? <ul className="dc-review">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="dc-note">Nothing to flag: headings are in order, images have alt text and there are no repeated words or double spaces.</p>}
    </Modal>
  );
}

export function LimitsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="What is not supported (compared with Google Docs)" wide onClose={onClose} extra={<span />}>
      <ul className="dc-review">
        <li>No real-time collaboration, sharing or version-history browser — the document is a file in Git and Git is the history.</li>
        <li>Pages are laid out block by block: a paragraph or table taller than a page runs over the page gap instead of splitting, and footnotes are listed at the end of the document rather than at the bottom of each page.</li>
        <li>Suggesting mode tracks typed and deleted text; splitting or joining paragraphs and formatting changes are applied directly, not as suggestions.</li>
        <li>No drawings, charts, smart chips, building blocks, columns, section breaks with different page setups, bookmarks or voice typing. Headers and footers are one line of text with fields.</li>
        <li>Spelling uses the system spell checker (red underlines, right-click for suggestions); there is no grammar checker.</li>
        <li>Word export writes equations as plain text and the table of contents as a static list; Markdown loses colours, fonts, alignment and merged cells. PDF: File ▸ Print, or download the web page and print it.</li>
      </ul>
    </Modal>
  );
}
