/** Dialogs of the Sheet menu: new spreadsheet, find & replace, conditional formatting, data validation, charts,
 * named ranges, pivot summaries, sorting, custom number formats, alternating colours, functions, review, prompts. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Trash2, X } from 'lucide-react';
import { FUNCTION_CATS, FUNCTIONS } from './functions';
import { formatValue, NUMBER_FORMATS } from './numfmt';
import type { Scalar } from './formula';
import type { Chart, ChartType, CondFormat, CondType, Op, Sheet, Validation, Workbook } from './sheet';
import { SERIES } from './sheetRender';

interface ModalProps { title: string; children: ReactNode; onClose: () => void; onOk?: () => void; okLabel?: string; okDisabled?: boolean; extra?: ReactNode; wide?: boolean }
export function Modal({ title, children, onClose, onOk, okLabel = 'OK', okDisabled, extra, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([aria-label="Close"])')?.focus(); }, []);
  return (
    <div className="sh-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`sh-modal${wide ? ' sh-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && onOk && !okDisabled && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') onOk(); }}>
        <header className="sh-modal__head"><h2>{title}</h2><button type="button" className="sh-icon" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="sh-modal__body">{children}</div>
        {(onOk || extra) && <footer className="sh-modal__foot">{extra}<span className="sh-grow" /><button type="button" className="sh-btn" onClick={onClose}>{onOk ? 'Cancel' : 'Close'}</button>{onOk && <button type="button" className="sh-btn sh-btn--primary" disabled={okDisabled} onClick={onOk}>{okLabel}</button>}</footer>}
      </div>
    </div>
  );
}
const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="sh-field"><span>{label}</span>{children}</label>;

export type Template = 'blank' | 'budget' | 'sales' | 'tasks';
const TEMPLATES: { id: Template; label: string; hint: string }[] = [
  { id: 'blank', label: 'Blank', hint: 'One empty sheet, 1000 rows × 26 columns.' },
  { id: 'budget', label: 'Monthly budget', hint: 'Planned vs actual with differences, % of income, a highlighted overspend and a bar chart.' },
  { id: 'sales', label: 'Sales tracker', hint: 'A sales log with revenue formulas, alternating colours, a filter, a region summary built with SUMIFS and a column chart.' },
  { id: 'tasks', label: 'Task list', hint: 'Checkboxes, coloured status and priority dropdowns, struck-through done rows and red overdue dates.' },
];
export function NewSheetDialog({ onCreate, onClose }: { onCreate: (name: string, t: Template) => void; onClose: () => void }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState<Template>('blank');
  return (
    <Modal title="New spreadsheet" okLabel="Create" onClose={onClose} onOk={() => onCreate(name, kind)}>
      <Field label="Name"><input className="sh-input" aria-label="Spreadsheet name" value={name} placeholder="my-sheet" onChange={(e) => setName(e.target.value)} /></Field>
      <div className="sh-chips" role="radiogroup" aria-label="Template">
        {TEMPLATES.map((t) => <button key={t.id} type="button" role="radio" aria-checked={kind === t.id} className={`sh-chip-btn${kind === t.id ? ' sh-chip-btn--on' : ''}`} onClick={() => setKind(t.id)}>{t.label}</button>)}
      </div>
      <p className="sh-note">{TEMPLATES.find((t) => t.id === kind)?.hint}</p>
    </Modal>
  );
}

export function PromptDialog({ title, label, initial = '', multiline, okLabel = 'OK', onOk, onClose, extra }: { title: string; label: string; initial?: string; multiline?: boolean; okLabel?: string; onOk: (v: string) => void; onClose: () => void; extra?: ReactNode }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} okLabel={okLabel} onClose={onClose} onOk={() => onOk(v)} extra={extra}>
      <Field label={label}>{multiline ? <textarea className="sh-input sh-area" aria-label={label} rows={5} value={v} onChange={(e) => setV(e.target.value)} /> : <input className="sh-input" aria-label={label} value={v} onChange={(e) => setV(e.target.value)} />}</Field>
    </Modal>
  );
}

export interface FindOptions { find: string; replace: string; match_case: boolean; whole: boolean; regex: boolean; formulas: boolean; all_sheets: boolean }
export function FindDialog({ initial, replaceMode, onFind, onReplace, onReplaceAll, onClose }: { initial: string; replaceMode: boolean; onFind: (o: FindOptions, back: boolean) => string; onReplace: (o: FindOptions) => string; onReplaceAll: (o: FindOptions) => string; onClose: () => void }) {
  const [o, setO] = useState<FindOptions>({ find: initial, replace: '', match_case: false, whole: false, regex: false, formulas: false, all_sheets: false });
  const [msg, setMsg] = useState('');
  const set = (patch: Partial<FindOptions>) => setO((x) => ({ ...x, ...patch }));
  return (
    <Modal title={replaceMode ? 'Find and replace' : 'Find'} onClose={onClose} extra={<>
      <button type="button" className="sh-btn" disabled={!o.find} onClick={() => setMsg(onFind(o, true))}>Previous</button>
      <button type="button" className="sh-btn" disabled={!o.find} onClick={() => setMsg(onFind(o, false))}>Find next</button>
      {replaceMode && <><button type="button" className="sh-btn" disabled={!o.find} onClick={() => setMsg(onReplace(o))}>Replace</button><button type="button" className="sh-btn sh-btn--primary" disabled={!o.find} onClick={() => setMsg(onReplaceAll(o))}>Replace all</button></>}
    </>}>
      <Field label="Find"><input className="sh-input" aria-label="Find" value={o.find} onChange={(e) => set({ find: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && o.find) { e.preventDefault(); setMsg(onFind(o, e.shiftKey)); } }} /></Field>
      {replaceMode && <Field label="Replace with"><input className="sh-input" aria-label="Replace with" value={o.replace} onChange={(e) => set({ replace: e.target.value })} /></Field>}
      <div className="sh-checks">
        <label className="sh-check"><input type="checkbox" checked={o.all_sheets} onChange={(e) => set({ all_sheets: e.target.checked })} /> All sheets</label>
        <label className="sh-check"><input type="checkbox" checked={o.match_case} onChange={(e) => set({ match_case: e.target.checked })} /> Match case</label>
        <label className="sh-check"><input type="checkbox" checked={o.whole} onChange={(e) => set({ whole: e.target.checked })} /> Match entire cell contents</label>
        <label className="sh-check"><input type="checkbox" checked={o.regex} onChange={(e) => set({ regex: e.target.checked })} /> Search using regular expressions</label>
        <label className="sh-check"><input type="checkbox" checked={o.formulas} onChange={(e) => set({ formulas: e.target.checked })} /> Also search within formulas</label>
      </div>
      {msg && <p className="sh-note" role="status">{msg}</p>}
    </Modal>
  );
}

const COND_TYPES: { id: CondType; label: string; values: 0 | 1 | 2 }[] = [
  { id: 'gt', label: 'Greater than', values: 1 }, { id: 'gte', label: 'Greater than or equal to', values: 1 }, { id: 'lt', label: 'Less than', values: 1 }, { id: 'lte', label: 'Less than or equal to', values: 1 },
  { id: 'eq', label: 'Is equal to', values: 1 }, { id: 'neq', label: 'Is not equal to', values: 1 }, { id: 'between', label: 'Is between', values: 2 }, { id: 'not_between', label: 'Is not between', values: 2 },
  { id: 'contains', label: 'Text contains', values: 1 }, { id: 'not_contains', label: 'Text does not contain', values: 1 }, { id: 'starts', label: 'Text starts with', values: 1 }, { id: 'ends', label: 'Text ends with', values: 1 },
  { id: 'empty', label: 'Is empty', values: 0 }, { id: 'not_empty', label: 'Is not empty', values: 0 }, { id: 'error', label: 'Is an error', values: 0 },
  { id: 'duplicate', label: 'Duplicate values', values: 0 }, { id: 'unique', label: 'Unique values', values: 0 }, { id: 'top', label: 'Top N', values: 1 }, { id: 'bottom', label: 'Bottom N', values: 1 },
  { id: 'above_avg', label: 'Above average', values: 0 }, { id: 'below_avg', label: 'Below average', values: 0 }, { id: 'formula', label: 'Custom formula is', values: 1 }, { id: 'scale', label: 'Colour scale', values: 0 },
];
const PRESET_STYLES = [{ fill: '#b7e1cd', color: '#0d652d' }, { fill: '#fce8b2', color: '#7f5600' }, { fill: '#f4c7c3', color: '#a50e0e' }, { fill: '#c9daf8', color: '#174ea6' }, { fill: '#ffffff', color: '#a50e0e', b: true }];
const describeCf = (c: CondFormat): string => `${COND_TYPES.find((t) => t.id === c.type)?.label ?? c.type}${c.value !== undefined ? ` ${c.value}` : ''}${c.value2 !== undefined ? ` and ${c.value2}` : ''}${c.n ? ` ${c.n}${c.percent ? '%' : ''}` : ''}`;
export function CondFormatDialog({ sheet, range, onRun, onClose }: { sheet: Sheet; range: string; onRun: (ops: Op[], label: string) => boolean; onClose: () => void }) {
  const [r, setR] = useState(range);
  const [type, setType] = useState<CondType>('gt');
  const [v1, setV1] = useState(''); const [v2, setV2] = useState('');
  const [style, setStyle] = useState(PRESET_STYLES[0] as { fill?: string; color?: string; b?: boolean; i?: boolean; s?: boolean });
  const [scale, setScale] = useState(['#ffffff', '#57bb8a']);
  const spec = COND_TYPES.find((t) => t.id === type)!;
  const num = (v: string) => (v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
  const add = (): void => {
    const op: Op = { op: 'cond_format', sheet: sheet.id, range: r, type };
    if (type === 'top' || type === 'bottom') op.n = Number(v1) || 10;
    else if (spec.values >= 1) op.value = num(v1);
    if (spec.values === 2) op.value2 = num(v2);
    if (type === 'scale') op.colors = scale; else op.style = { fill: style.fill, color: style.color, bold: style.b, italic: style.i, strike: style.s };
    onRun([op], 'Conditional formatting');
  };
  return (
    <Modal title="Conditional format rules" wide onClose={onClose} onOk={add} okLabel="Add rule">
      {sheet.condFormats.length > 0 && (
        <ul className="sh-rules" aria-label="Rules">
          {sheet.condFormats.map((c) => (
            <li key={c.id}>
              <span className="sh-rules__swatch" style={c.type === 'scale' ? { background: `linear-gradient(90deg, ${(c.colors ?? []).join(',')})` } : { background: c.style?.fill, color: c.style?.color, fontWeight: c.style?.b ? 700 : 400 }}>123</span>
              <span className="sh-grow"><b>{c.range}</b> · {describeCf(c)}</span>
              <button type="button" className="sh-icon" aria-label={`Delete rule ${c.id}`} onClick={() => onRun([{ op: 'cond_format_delete', sheet: sheet.id, id: c.id }], 'Delete rule')}><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      <Field label="Apply to range"><input className="sh-input" aria-label="Apply to range" value={r} onChange={(e) => setR(e.target.value)} /></Field>
      <Field label="Format cells if…"><select className="sh-select" aria-label="Condition" value={type} onChange={(e) => setType(e.target.value as CondType)}>{COND_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
      {spec.values >= 1 && <Field label={type === 'formula' ? 'Formula (relative to the top-left cell), e.g. =$C2>100' : type === 'top' || type === 'bottom' ? 'How many' : 'Value'}><input className="sh-input" aria-label="Rule value" value={v1} onChange={(e) => setV1(e.target.value)} /></Field>}
      {spec.values === 2 && <Field label="and"><input className="sh-input" aria-label="Second rule value" value={v2} onChange={(e) => setV2(e.target.value)} /></Field>}
      {type === 'scale' ? (
        <div className="sh-row">
          <Field label="Min colour"><input type="color" className="sh-color" aria-label="Minimum colour" value={scale[0]} onChange={(e) => setScale([e.target.value, ...scale.slice(1)])} /></Field>
          {scale.length === 3 && <Field label="Mid colour"><input type="color" className="sh-color" aria-label="Middle colour" value={scale[1]} onChange={(e) => setScale([scale[0], e.target.value, scale[2]])} /></Field>}
          <Field label="Max colour"><input type="color" className="sh-color" aria-label="Maximum colour" value={scale[scale.length - 1]} onChange={(e) => setScale([...scale.slice(0, -1), e.target.value])} /></Field>
          <label className="sh-check"><input type="checkbox" checked={scale.length === 3} onChange={(e) => setScale(e.target.checked ? [scale[0], '#ffd666', scale[scale.length - 1]] : [scale[0], scale[scale.length - 1]])} /> Midpoint</label>
        </div>
      ) : (
        <>
          <div className="sh-chips" aria-label="Preset styles">{PRESET_STYLES.map((p, i) => <button key={i} type="button" className="sh-swatch" aria-label={`Style ${i + 1}`} style={{ background: p.fill, color: p.color, fontWeight: p.b ? 700 : 400 }} onClick={() => setStyle(p)}>Aa</button>)}</div>
          <div className="sh-row">
            <Field label="Fill"><input type="color" className="sh-color" aria-label="Rule fill colour" value={style.fill ?? '#ffffff'} onChange={(e) => setStyle({ ...style, fill: e.target.value })} /></Field>
            <Field label="Text"><input type="color" className="sh-color" aria-label="Rule text colour" value={style.color ?? '#000000'} onChange={(e) => setStyle({ ...style, color: e.target.value })} /></Field>
            <label className="sh-check"><input type="checkbox" checked={!!style.b} onChange={(e) => setStyle({ ...style, b: e.target.checked })} /> Bold</label>
            <label className="sh-check"><input type="checkbox" checked={!!style.i} onChange={(e) => setStyle({ ...style, i: e.target.checked })} /> Italic</label>
            <label className="sh-check"><input type="checkbox" checked={!!style.s} onChange={(e) => setStyle({ ...style, s: e.target.checked })} /> Strikethrough</label>
          </div>
        </>
      )}
    </Modal>
  );
}

export function ValidationDialog({ sheet, range, existing, onRun, onClose }: { sheet: Sheet; range: string; existing?: Validation; onRun: (ops: Op[], label: string) => boolean; onClose: () => void }) {
  const [r, setR] = useState(existing?.range ?? range);
  const [type, setType] = useState<Validation['type']>(existing?.type ?? 'list');
  const [items, setItems] = useState((existing?.values ?? []).join(', '));
  const [source, setSource] = useState(existing?.source ?? '');
  const [rule, setRule] = useState(existing?.op ?? 'between');
  const [min, setMin] = useState(existing?.min !== undefined ? String(existing.min) : '');
  const [max, setMax] = useState(existing?.max !== undefined ? String(existing.max) : '');
  const [formula, setFormula] = useState(existing?.formula ?? '');
  const [strict, setStrict] = useState(existing?.strict ?? true);
  const [help, setHelp] = useState(existing?.help ?? '');
  const save = (): void => {
    const op: Op = { op: 'validation', sheet: sheet.id, range: r, type, strict };
    if (type === 'list') op.values = items.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    if (type === 'range') op.source = source;
    if (type === 'number' || type === 'date' || type === 'text_length') { op.rule = rule; if (min !== '') op.min = type === 'date' ? min : Number(min); if (max !== '') op.max = type === 'date' ? max : Number(max); }
    if (type === 'custom') op.formula = formula;
    if (help) op.help = help;
    if (onRun([op], 'Data validation')) onClose();
  };
  const one = rule !== 'between' && rule !== 'not_between';
  return (
    <Modal title="Data validation" onClose={onClose} onOk={save} okLabel="Done" extra={existing && <button type="button" className="sh-btn" onClick={() => { if (onRun([{ op: 'validation_clear', sheet: sheet.id, range: existing.range }], 'Remove validation')) onClose(); }}>Remove rule</button>}>
      <Field label="Apply to range"><input className="sh-input" aria-label="Apply to range" value={r} onChange={(e) => setR(e.target.value)} /></Field>
      <Field label="Criteria"><select className="sh-select" aria-label="Criteria" value={type} onChange={(e) => setType(e.target.value as Validation['type'])}>
        <option value="list">Dropdown (list of items)</option><option value="range">Dropdown (from a range)</option><option value="checkbox">Checkbox</option>
        <option value="number">Number</option><option value="date">Date</option><option value="text_length">Text length</option><option value="custom">Custom formula is</option>
      </select></Field>
      {type === 'list' && <Field label="Items (comma or one per line)"><textarea className="sh-input sh-area" aria-label="Items" rows={3} value={items} onChange={(e) => setItems(e.target.value)} /></Field>}
      {type === 'range' && <Field label="Source range"><input className="sh-input" aria-label="Source range" placeholder="Lists!A2:A20" value={source} onChange={(e) => setSource(e.target.value)} /></Field>}
      {(type === 'number' || type === 'date' || type === 'text_length') && (
        <div className="sh-row">
          <Field label="Rule"><select className="sh-select" aria-label="Rule" value={rule} onChange={(e) => setRule(e.target.value)}>
            <option value="between">between</option><option value="not_between">not between</option><option value="gt">greater than</option><option value="gte">greater than or equal to</option><option value="lt">less than</option><option value="lte">less than or equal to</option><option value="eq">equal to</option><option value="neq">not equal to</option>
          </select></Field>
          {(!one || rule === 'gt' || rule === 'gte' || rule === 'eq' || rule === 'neq') && <Field label={one ? 'Value' : 'Min'}><input className="sh-input" aria-label="Minimum" value={min} placeholder={type === 'date' ? '2026-01-01' : ''} onChange={(e) => setMin(e.target.value)} /></Field>}
          {(!one || rule === 'lt' || rule === 'lte') && <Field label={one ? 'Value' : 'Max'}><input className="sh-input" aria-label="Maximum" value={max} placeholder={type === 'date' ? '2026-12-31' : ''} onChange={(e) => setMax(e.target.value)} /></Field>}
        </div>
      )}
      {type === 'custom' && <Field label="Formula (must be TRUE), e.g. =ISEMAIL? → =REGEXMATCH(A2,&quot;@&quot;)"><input className="sh-input" aria-label="Validation formula" value={formula} onChange={(e) => setFormula(e.target.value)} /></Field>}
      <Field label="Help text (shown on hover)"><input className="sh-input" aria-label="Help text" value={help} onChange={(e) => setHelp(e.target.value)} /></Field>
      <div className="sh-checks">
        <label className="sh-check"><input type="radio" name="strict" checked={strict} onChange={() => setStrict(true)} /> Reject the input</label>
        <label className="sh-check"><input type="radio" name="strict" checked={!strict} onChange={() => setStrict(false)} /> Show a warning</label>
      </div>
    </Modal>
  );
}

const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'column', label: 'Column' }, { id: 'stacked_column', label: 'Stacked column' }, { id: 'bar', label: 'Bar' }, { id: 'stacked_bar', label: 'Stacked bar' },
  { id: 'line', label: 'Line' }, { id: 'area', label: 'Area' }, { id: 'combo', label: 'Combo (column + line)' }, { id: 'pie', label: 'Pie' }, { id: 'doughnut', label: 'Doughnut' }, { id: 'scatter', label: 'Scatter' },
];
export function ChartDialog({ sheet, range, chart, onRun, onClose }: { sheet: Sheet; range: string; chart?: Chart; onRun: (ops: Op[], label: string) => boolean; onClose: () => void }) {
  const [c, setC] = useState<Partial<Chart>>(chart ?? { type: 'column', range, title: '', headers: true, labels: true, legend: 'bottom', w: 480, h: 300 });
  const set = (patch: Partial<Chart>) => setC((x) => ({ ...x, ...patch }));
  const save = (): void => {
    const body = { type: c.type, range: c.range, title: c.title || undefined, headers: c.headers, labels: c.labels, legend: c.legend, xTitle: c.xTitle || undefined, yTitle: c.yTitle || undefined, smooth: c.smooth, trendline: c.trendline, colors: c.colors };
    const ok = chart ? onRun([{ op: 'chart_set', id: chart.id, ...body }], 'Edit chart') : onRun([{ op: 'chart_add', sheet: sheet.id, ...body, w: c.w, h: c.h }], 'Insert chart');
    if (ok) onClose();
  };
  return (
    <Modal title={chart ? 'Chart editor' : 'Insert chart'} onClose={onClose} onOk={save} okLabel={chart ? 'Save' : 'Insert'}>
      <Field label="Chart type"><select className="sh-select" aria-label="Chart type" value={c.type} onChange={(e) => set({ type: e.target.value as ChartType })}>{CHART_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
      <Field label="Data range"><input className="sh-input" aria-label="Data range" value={c.range ?? ''} onChange={(e) => set({ range: e.target.value })} /></Field>
      <Field label="Title"><input className="sh-input" aria-label="Chart title" value={c.title ?? ''} onChange={(e) => set({ title: e.target.value })} /></Field>
      <div className="sh-checks">
        <label className="sh-check"><input type="checkbox" checked={c.headers !== false} onChange={(e) => set({ headers: e.target.checked })} /> Use row 1 as headers (series names)</label>
        <label className="sh-check"><input type="checkbox" checked={c.labels !== false} onChange={(e) => set({ labels: e.target.checked })} /> Use column 1 as labels (x axis)</label>
        {(c.type === 'line' || c.type === 'area' || c.type === 'combo') && <label className="sh-check"><input type="checkbox" checked={!!c.smooth} onChange={(e) => set({ smooth: e.target.checked })} /> Smooth lines</label>}
        {c.type === 'scatter' && <label className="sh-check"><input type="checkbox" checked={!!c.trendline} onChange={(e) => set({ trendline: e.target.checked })} /> Trendline</label>}
      </div>
      <div className="sh-row">
        <Field label="Legend"><select className="sh-select" aria-label="Legend" value={c.legend} onChange={(e) => set({ legend: e.target.value as Chart['legend'] })}><option value="bottom">Bottom</option><option value="top">Top</option><option value="right">Right</option><option value="none">None</option></select></Field>
        <Field label="X-axis title"><input className="sh-input" aria-label="X axis title" value={c.xTitle ?? ''} onChange={(e) => set({ xTitle: e.target.value })} /></Field>
        <Field label="Y-axis title"><input className="sh-input" aria-label="Y axis title" value={c.yTitle ?? ''} onChange={(e) => set({ yTitle: e.target.value })} /></Field>
      </div>
      <Field label="Series colours"><div className="sh-chips">{(c.colors?.length ? c.colors : SERIES.slice(0, 4)).map((col, i) => <input key={i} type="color" className="sh-color" aria-label={`Series ${i + 1} colour`} value={col} onChange={(e) => { const next = [...(c.colors?.length ? c.colors : SERIES.slice(0, 4))]; next[i] = e.target.value; set({ colors: next }); }} />)}</div></Field>
    </Modal>
  );
}

export function NamedRangesDialog({ wb, range, onRun, onClose }: { wb: Workbook; range: string; onRun: (ops: Op[], label: string) => boolean; onClose: () => void }) {
  const [name, setName] = useState(''); const [r, setR] = useState(range);
  return (
    <Modal title="Named ranges" onClose={onClose} onOk={() => { if (onRun([{ op: 'name_set', name, range: r }], 'Name range')) setName(''); }} okLabel="Add" okDisabled={!name}>
      <ul className="sh-rules" aria-label="Named ranges">
        {Object.entries(wb.names).map(([n, v]) => <li key={n}><span className="sh-grow"><b>{n}</b> · {v}</span><button type="button" className="sh-icon" aria-label={`Delete name ${n}`} onClick={() => onRun([{ op: 'name_delete', name: n }], 'Delete name')}><Trash2 size={13} /></button></li>)}
        {Object.keys(wb.names).length === 0 && <li className="sh-note">No named ranges yet. Use them in formulas like =SUM(Sales).</li>}
      </ul>
      <div className="sh-row">
        <Field label="Name"><input className="sh-input" aria-label="Range name" value={name} placeholder="Sales" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Range"><input className="sh-input" aria-label="Named range" value={r} onChange={(e) => setR(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function PivotDialog({ range, headers, onRun, onClose }: { range: string; headers: { col: string; label: string }[]; onRun: (ops: Op[], label: string) => boolean; onClose: () => void }) {
  const [source, setSource] = useState(range);
  const [rows, setRows] = useState(headers[0]?.col ?? 'A');
  const [cols, setCols] = useState('');
  const [val, setVal] = useState(headers[headers.length - 1]?.col ?? 'B');
  const [fn, setFn] = useState('sum');
  const [target, setTarget] = useState('Pivot table!A1');
  const opt = headers.map((h) => <option key={h.col} value={h.col}>{h.col} — {h.label}</option>);
  return (
    <Modal title="Pivot table" onClose={onClose} okLabel="Create" onOk={() => { if (onRun([{ op: 'pivot', source, rows, ...(cols ? { columns: cols } : {}), values: [{ col: val, fn }], target }], 'Pivot table')) onClose(); }}>
      <p className="sh-note">Builds a summary table from live SUMIFS / COUNTIFS / AVERAGEIFS / MINIFS / MAXIFS formulas, so it updates when the data changes. New categories need the table to be created again.</p>
      <Field label="Data range (with a header row)"><input className="sh-input" aria-label="Pivot data range" value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      <div className="sh-row">
        <Field label="Rows"><select className="sh-select" aria-label="Pivot rows" value={rows} onChange={(e) => setRows(e.target.value)}>{opt}</select></Field>
        <Field label="Columns (optional)"><select className="sh-select" aria-label="Pivot columns" value={cols} onChange={(e) => setCols(e.target.value)}><option value="">None</option>{opt}</select></Field>
      </div>
      <div className="sh-row">
        <Field label="Values"><select className="sh-select" aria-label="Pivot values" value={val} onChange={(e) => setVal(e.target.value)}>{opt}</select></Field>
        <Field label="Summarise by"><select className="sh-select" aria-label="Summarise by" value={fn} onChange={(e) => setFn(e.target.value)}><option value="sum">SUM</option><option value="count">COUNT</option><option value="counta">COUNTA</option><option value="average">AVERAGE</option><option value="min">MIN</option><option value="max">MAX</option></select></Field>
      </div>
      <Field label="Put it at (cell, or NewSheet!A1)"><input className="sh-input" aria-label="Pivot target" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
    </Modal>
  );
}

export function SortDialog({ range, headers, onRun, onClose }: { range: string; headers: { col: string; label: string }[]; onRun: (ops: Op[], label: string) => boolean; onClose: () => void }) {
  const [hasHeader, setHasHeader] = useState(true);
  const [keys, setKeys] = useState([{ col: headers[0]?.col ?? 'A', desc: false }]);
  return (
    <Modal title="Sort range" onClose={onClose} okLabel="Sort" onOk={() => { if (onRun([{ op: 'sort', range, header: hasHeader, by: keys }], 'Sort range')) onClose(); }}>
      <p className="sh-note">Sorting {range}</p>
      <label className="sh-check"><input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> Data has a header row</label>
      {keys.map((k, i) => (
        <div key={i} className="sh-row">
          <Field label={i ? 'then by' : 'Sort by'}><select className="sh-select" aria-label={`Sort column ${i + 1}`} value={k.col} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, col: e.target.value } : x)))}>{headers.map((h) => <option key={h.col} value={h.col}>{hasHeader ? h.label : `Column ${h.col}`}</option>)}</select></Field>
          <Field label="Order"><select className="sh-select" aria-label={`Sort order ${i + 1}`} value={k.desc ? 'desc' : 'asc'} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, desc: e.target.value === 'desc' } : x)))}><option value="asc">A → Z</option><option value="desc">Z → A</option></select></Field>
        </div>
      ))}
      <button type="button" className="sh-link" onClick={() => setKeys([...keys, { col: headers[0]?.col ?? 'A', desc: false }])}>+ Add another sort column</button>
    </Modal>
  );
}

export function NumberFormatDialog({ sample, initial, onApply, onClose }: { sample: Scalar; initial: string; onApply: (pattern: string) => void; onClose: () => void }) {
  const [p, setP] = useState(initial);
  const preview = formatValue(typeof sample === 'number' ? sample : 1234.5678, p || undefined);
  return (
    <Modal title="Custom number format" onClose={onClose} okLabel="Apply" onOk={() => onApply(p)}>
      <Field label="Format pattern"><input className="sh-input sh-mono" aria-label="Format pattern" value={p} onChange={(e) => setP(e.target.value)} /></Field>
      <p className="sh-note">Preview: <b style={{ color: preview.color }}>{preview.text}</b></p>
      <div className="sh-chips">{['#,##0.00', '0.0%', '$#,##0.00;[Red]-$#,##0.00', '฿#,##0', '0.00E+00', 'yyyy-mm-dd', 'dddd d mmmm yyyy', 'hh:mm', '[h]:mm:ss', '"Qty: "0', '#,##0,"k"'].map((x) => <button key={x} type="button" className="sh-chip-btn" onClick={() => setP(x)}>{x}</button>)}</div>
      <p className="sh-note">0 = digit, # = optional digit, , = thousands (a trailing , divides by 1000), . = decimals, % = percent, E+00 = scientific, "text" = literal text, ; separates positive;negative;zero;text, [Red] colours a section. Dates: yyyy yy mmmm mmm mm m dddd ddd dd d hh h mm ss AM/PM [h].</p>
    </Modal>
  );
}

export function BandingDialog({ range, onRun, onClose }: { range: string; onRun: (ops: Op[], label: string) => boolean; onClose: () => void }) {
  const [r, setR] = useState(range);
  const [header, setHeader] = useState('#4285f4'); const [odd, setOdd] = useState('#ffffff'); const [even, setEven] = useState('#e8f0fe'); const [useHeader, setUseHeader] = useState(true);
  const presets = [['#4285f4', '#ffffff', '#e8f0fe'], ['#34a853', '#ffffff', '#e6f4ea'], ['#fbbc04', '#ffffff', '#fef7e0'], ['#ea4335', '#ffffff', '#fce8e6'], ['#5f6368', '#ffffff', '#f1f3f4']];
  return (
    <Modal title="Alternating colours" onClose={onClose} okLabel="Apply" onOk={() => { if (onRun([{ op: 'banding', range: r, header: useHeader ? header : null, odd, even }], 'Alternating colours')) onClose(); }} extra={<button type="button" className="sh-btn" onClick={() => { if (onRun([{ op: 'banding_delete', range: r }], 'Remove alternating colours')) onClose(); }}>Remove</button>}>
      <Field label="Apply to range"><input className="sh-input" aria-label="Apply to range" value={r} onChange={(e) => setR(e.target.value)} /></Field>
      <div className="sh-chips">{presets.map((p) => <button key={p[0]} type="button" className="sh-swatch sh-swatch--band" aria-label={`Preset ${p[0]}`} onClick={() => { setHeader(p[0]); setOdd(p[1]); setEven(p[2]); }}><i style={{ background: p[0] }} /><i style={{ background: p[1] }} /><i style={{ background: p[2] }} /></button>)}</div>
      <div className="sh-row">
        <label className="sh-check"><input type="checkbox" checked={useHeader} onChange={(e) => setUseHeader(e.target.checked)} /> Header</label>
        <Field label="Header"><input type="color" className="sh-color" aria-label="Header colour" value={header} onChange={(e) => setHeader(e.target.value)} /></Field>
        <Field label="Colour 1"><input type="color" className="sh-color" aria-label="Colour 1" value={odd} onChange={(e) => setOdd(e.target.value)} /></Field>
        <Field label="Colour 2"><input type="color" className="sh-color" aria-label="Colour 2" value={even} onChange={(e) => setEven(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function FunctionsDialog({ onInsert, onClose }: { onInsert: (name: string) => void; onClose: () => void }) {
  const [q, setQ] = useState(''); const [cat, setCat] = useState('');
  const list = useMemo(() => Object.keys(FUNCTIONS).sort().filter((n) => (!cat || FUNCTIONS[n].cat === cat) && (!q || n.includes(q.toUpperCase()) || FUNCTIONS[n].desc.toLowerCase().includes(q.toLowerCase()))), [q, cat]);
  return (
    <Modal title="Functions" wide onClose={onClose}>
      <div className="sh-row">
        <input className="sh-input" aria-label="Search functions" placeholder="Search (e.g. lookup, date, average)" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="sh-select" aria-label="Function category" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{FUNCTION_CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
      </div>
      <p className="sh-note">{list.length} of {Object.keys(FUNCTIONS).length} functions</p>
      <ul className="sh-fnlist" aria-label="Function list">
        {list.map((n) => <li key={n}><button type="button" onClick={() => onInsert(n)}><b>{FUNCTIONS[n].syntax}</b><span>{FUNCTIONS[n].cat} — {FUNCTIONS[n].desc}</span></button></li>)}
      </ul>
    </Modal>
  );
}

export function ReviewDialog({ lines, errors, onClose }: { lines: string[]; errors: { sheet: string; cell: string; code: string; message: string }[]; onClose: () => void }) {
  return (
    <Modal title="Review" wide onClose={onClose}>
      {lines.length === 0 ? <p className="sh-note">Nothing to flag: no formula errors, numbers stored as text, odd formulas or validation breaks were found.</p> : <ul className="sh-review">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {errors.length > 0 && <><p className="sh-h">Formula errors</p><ul className="sh-review">{errors.map((e, i) => <li key={i}><b>{e.sheet}!{e.cell}</b> {e.code} — {e.message}</li>)}</ul></>}
    </Modal>
  );
}

export { NUMBER_FORMATS };
