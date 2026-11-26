import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Play, Trash2, X } from 'lucide-react';
import {
  ANIM_EFFECTS, LAYOUTS, SHAPES, THEMES, TRANSITIONS, clone, elText, newId, resolveColor, round1,
  type AnimEffect, type AnimStart, type Background, type Deck, type El, type LayoutId, type ShapeKind, type Slide, type TransitionKind,
} from './slides';
import { SlideThumb } from './SlidesDialogs';
import { relayout } from './slidesOps';

export type PanelKind = 'theme' | 'motion' | 'format' | 'comments';
/** Edits the deck copy; slide and els are the current slide and the selected elements inside that copy. */
export type Edit = (label: string, fn: (deck: Deck, slide: Slide, els: El[]) => void) => void;

function elLabel(e: El): string {
  if (e.name) return e.name;
  const first = elText(e).split('\n')[0].trim().slice(0, 28);
  switch (e.type) {
    case 'chart': return `Chart${e.title ? `: ${e.title}` : ` (${e.chart})`}`;
    case 'table': return `Table: ${e.rows[0]?.map((c) => c.text).join(', ').slice(0, 24) || e.id}`;
    case 'image': return `Image${e.alt ? `: ${e.alt.slice(0, 24)}` : ''}`;
    case 'icon': return `Icon ${e.glyph}`;
    case 'line': return 'Line';
    case 'embed': return e.kind === 'video' ? 'Video' : 'Link';
    case 'shape': return first ? `Shape: ${first}` : `Shape (${e.shape})`;
    default: return first ? `Text: ${first}` : `Text box ${e.id}`;
  }
}
const Head = ({ title, onClose }: { title: string; onClose: () => void }) => <div className="sl-side__head">{title}<button type="button" className="dc-icon" aria-label={`Close ${title}`} onClick={onClose}><X size={13} /></button></div>;
const Num = ({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) => (
  <label className="sl-num"><span>{label}</span><input type="number" aria-label={label} step={step} key={`${label}:${value}`} defaultValue={round1(value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== round1(value)) onChange(v); }} /></label>
);
const Color = ({ label, value, theme, onChange }: { label: string; value: string | undefined; theme: Deck['theme']; onChange: (v: string | undefined) => void }) => {
  const shown = resolveColor(theme, value, '');
  return (
    <div className="sl-colorfield">
      <span>{label}</span>
      <input type="color" aria-label={label} value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : '#ffffff'} onChange={(e) => onChange(e.target.value)} />
      <div className="sl-swatches">{(['$accent', '$accent2', '$accent3', '$accent4', '$text', '$surface', '$background'] as const).map((c) => <button key={c} type="button" className={`sl-swatch${value === c ? ' sl-swatch--on' : ''}`} aria-label={`${label} ${c.slice(1)}`} title={`Theme ${c.slice(1)}`} style={{ background: resolveColor(theme, c) }} onClick={() => onChange(c)} />)}</div>
      <button type="button" className="dc-link" onClick={() => onChange(undefined)}>None</button>
    </div>
  );
};

/* ---------------- themes ---------------- */

export function ThemePanel({ deck, onApply, onEdit, onClose }: { deck: Deck; onApply: (themeId: string) => void; onEdit: () => void; onClose: () => void }) {
  return (
    <aside className="sl-side" aria-label="Themes">
      <Head title="Themes" onClose={onClose} />
      <p className="dc-note">In this presentation: <b>{deck.theme.name}</b></p>
      <button type="button" className="dc-btn" onClick={onEdit}>Edit theme (colours and fonts)…</button>
      <div className="sl-theme-list">
        {THEMES.map((t) => {
          const preview: Deck = { ...deck, theme: t, slides: deck.slides.slice(0, 1) };
          const slide = preview.slides[0];
          return (
            <button key={t.id} type="button" className={`sl-theme-card${deck.theme.id === t.id ? ' sl-theme-card--on' : ''}`} aria-label={`Theme ${t.name}`} aria-pressed={deck.theme.id === t.id} onClick={() => onApply(t.id)}>
              {slide ? <SlideThumb deck={preview} slide={slide} width={220} /> : <span className="sl-theme-card__blank" style={{ background: t.colors.background, color: t.colors.title, fontFamily: t.fonts.title }}>Aa</span>}
              <span>{t.name}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/* ---------------- transition and motion ---------------- */

export function MotionPanel({ deck, slide, selected, edit, onPlay, onClose }: { deck: Deck; slide: Slide; selected: El[]; edit: Edit; onPlay: () => void; onClose: () => void }) {
  const tr = slide.transition ?? { type: 'none' as TransitionKind, duration: 0.6 };
  const els = new Map(slide.elements.map((e) => [e.id, e]));
  return (
    <aside className="sl-side" aria-label="Motion">
      <Head title="Motion" onClose={onClose} />
      <h4>Slide transition</h4>
      <div className="dc-row">
        <label className="dc-field"><span>Type</span><select className="dc-select" aria-label="Transition type" value={tr.type} onChange={(e) => edit('Transition', (_, s) => { const t = e.target.value as TransitionKind; if (t === 'none') delete s.transition; else s.transition = { type: t, duration: s.transition?.duration ?? 0.6 }; })}>{TRANSITIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
        <label className="dc-field"><span>Duration {tr.duration.toFixed(1)}s</span><input type="range" aria-label="Transition duration" min={0.2} max={3} step={0.1} value={tr.duration} disabled={tr.type === 'none'} onChange={(e) => edit('Transition speed', (_, s) => { if (s.transition) s.transition.duration = Number(e.target.value); })} /></label>
      </div>
      <button type="button" className="dc-btn" onClick={() => edit('Transition on all slides', (d, s) => { for (const x of d.slides) { if (s.transition) x.transition = { ...s.transition }; else delete x.transition; } })}>Apply to all slides</button>
      <h4>Object animations</h4>
      {slide.anims.length === 0 && <p className="dc-note">Select an object on the slide and add an animation. Animations play in this order, one click at a time.</p>}
      <ol className="sl-anims">
        {slide.anims.map((a, i) => (
          <li key={a.id} className="sl-anim" data-testid="animation-row">
            <div className="sl-anim__head"><b>{i + 1}.</b> <span title={a.el}>{els.get(a.el) ? elLabel(els.get(a.el)!) : a.el}</span><span className="dc-grow" />
              <button type="button" className="dc-icon" aria-label={`Move animation ${i + 1} up`} disabled={i === 0} onClick={() => edit('Reorder animation', (_, s) => { const k = s.anims.findIndex((x) => x.id === a.id); [s.anims[k - 1], s.anims[k]] = [s.anims[k], s.anims[k - 1]]; })}><ArrowUp size={12} /></button>
              <button type="button" className="dc-icon" aria-label={`Move animation ${i + 1} down`} disabled={i === slide.anims.length - 1} onClick={() => edit('Reorder animation', (_, s) => { const k = s.anims.findIndex((x) => x.id === a.id); [s.anims[k + 1], s.anims[k]] = [s.anims[k], s.anims[k + 1]]; })}><ArrowDown size={12} /></button>
              <button type="button" className="dc-icon" aria-label={`Delete animation ${i + 1}`} onClick={() => edit('Delete animation', (_, s) => { s.anims = s.anims.filter((x) => x.id !== a.id); })}><Trash2 size={12} /></button>
            </div>
            <div className="dc-row">
              <select className="dc-select" aria-label={`Animation ${i + 1} effect`} value={a.effect} onChange={(e) => edit('Animation effect', (_, s) => { const x = s.anims.find((y) => y.id === a.id); if (x) x.effect = e.target.value as AnimEffect; })}>{ANIM_EFFECTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              <select className="dc-select" aria-label={`Animation ${i + 1} start`} value={a.start} onChange={(e) => edit('Animation start', (_, s) => { const x = s.anims.find((y) => y.id === a.id); if (x) x.start = e.target.value as AnimStart; })}><option value="click">On click</option><option value="with">With previous</option><option value="after">After previous</option></select>
              <input className="dc-input sl-small" type="number" aria-label={`Animation ${i + 1} duration`} min={0.1} max={10} step={0.1} key={`${a.id}:${a.duration}`} defaultValue={a.duration} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== a.duration) edit('Animation duration', (_, s) => { const x = s.anims.find((y) => y.id === a.id); if (x) x.duration = v; }); }} onKeyDown={(e) => e.stopPropagation()} />
            </div>
          </li>
        ))}
      </ol>
      <div className="dc-row">
        <button type="button" className="dc-btn" disabled={!selected.length} onClick={() => edit('Add animation', (d, s, sel) => { for (const e of sel) s.anims.push({ id: newId(d, 'a'), el: e.id, effect: 'fade-in', start: 'click', duration: 0.5 }); })}>+ Add animation</button>
        <button type="button" className="dc-btn" onClick={onPlay}><Play size={12} /> Play</button>
      </div>
      <p className="dc-note">{selected.length ? `Adds to: ${selected.map(elLabel).join(', ')}` : 'Nothing selected.'}</p>
      <p className="dc-note">Slide {deck.slides.indexOf(slide) + 1}</p>
    </aside>
  );
}

/* ---------------- format options ---------------- */

export function FormatPanel({ deck, slide, selected, edit, onChartData, onPickImage, onClose }: { deck: Deck; slide: Slide; selected: El[]; edit: Edit; onChartData: (id: string) => void; onPickImage: (forBackground: boolean) => void; onClose: () => void }) {
  const el = selected[0];
  const t = deck.theme;
  const [bgKind, setBgKind] = useState<Background['type']>(slide.background?.type ?? 'color');
  const all = (fn: (e: El) => void) => (_d: Deck, _s: Slide, els: El[]) => { for (const e of els) fn(e); };
  if (!el) {
    const bg = slide.background;
    return (
      <aside className="sl-side" aria-label="Format options">
        <Head title="Slide" onClose={onClose} />
        <label className="dc-field"><span>Layout</span><select className="dc-select" aria-label="Slide layout" value={slide.layout} onChange={(e) => edit('Layout', (d, s) => { relayout(d, s, e.target.value as LayoutId); })}>{LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></label>
        <h4>Background</h4>
        <div className="dc-chips" role="radiogroup" aria-label="Background kind">{(['color', 'gradient', 'image'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={bgKind === k} className={`dc-chip-btn${bgKind === k ? ' dc-chip-btn--on' : ''}`} onClick={() => setBgKind(k)}>{k === 'color' ? 'Colour' : k}</button>)}</div>
        {bgKind === 'color' && <Color label="Background colour" theme={t} value={bg?.type === 'color' ? bg.color : undefined} onChange={(v) => edit('Background', (_, s) => { if (v) s.background = { type: 'color', color: v }; else delete s.background; })} />}
        {bgKind === 'gradient' && (
          <>
            <Color label="Gradient from" theme={t} value={bg?.type === 'gradient' ? bg.from : undefined} onChange={(v) => edit('Background', (_, s) => { const cur = s.background?.type === 'gradient' ? s.background : { type: 'gradient' as const, from: '$background', to: '$surface', angle: 180 }; s.background = { ...cur, from: v ?? '$background' }; })} />
            <Color label="Gradient to" theme={t} value={bg?.type === 'gradient' ? bg.to : undefined} onChange={(v) => edit('Background', (_, s) => { const cur = s.background?.type === 'gradient' ? s.background : { type: 'gradient' as const, from: '$background', to: '$surface', angle: 180 }; s.background = { ...cur, to: v ?? '$surface' }; })} />
            <Num label="Angle" value={bg?.type === 'gradient' ? bg.angle ?? 180 : 180} onChange={(v) => edit('Background', (_, s) => { if (s.background?.type === 'gradient') s.background.angle = v; else s.background = { type: 'gradient', from: '$background', to: '$surface', angle: v }; })} />
          </>
        )}
        {bgKind === 'image' && <button type="button" className="dc-btn" onClick={() => onPickImage(true)}>Choose image…</button>}
        <div className="dc-row">
          <button type="button" className="dc-btn" onClick={() => edit('Reset background', (_, s) => { delete s.background; })}>Reset to theme</button>
          <button type="button" className="dc-btn" onClick={() => edit('Background on all slides', (d, s) => { for (const x of d.slides) { if (s.background) x.background = clone(s.background); else delete x.background; } })}>Apply to all slides</button>
        </div>
        <label className="dc-check"><input type="checkbox" checked={!!slide.hidden} onChange={(e) => edit(e.target.checked ? 'Skip slide' : 'Unskip slide', (_, s) => { if (e.target.checked) s.hidden = true; else delete s.hidden; })} /> Skip this slide in the presentation</label>
      </aside>
    );
  }
  const geo = selected.length === 1;
  return (
    <aside className="sl-side" aria-label="Format options">
      <Head title={selected.length > 1 ? `${selected.length} objects` : 'Format options'} onClose={onClose} />
      {geo && (
        <>
          <h4>Size and position</h4>
          <div className="sl-grid2">
            <Num label="X" value={el.x} onChange={(v) => edit('Move', all((e) => { e.x = v; }))} />
            <Num label="Y" value={el.y} onChange={(v) => edit('Move', all((e) => { e.y = v; }))} />
            <Num label="Width" value={el.w} onChange={(v) => edit('Resize', all((e) => { e.w = Math.max(1, v); }))} />
            <Num label="Height" value={el.h} onChange={(v) => edit('Resize', all((e) => { e.h = Math.max(1, v); }))} />
            <Num label="Rotation" value={el.rot ?? 0} onChange={(v) => edit('Rotate', all((e) => { e.rot = ((v % 360) + 360) % 360 || undefined; }))} />
            <Num label="Opacity %" value={Math.round((el.opacity ?? 1) * 100)} onChange={(v) => edit('Opacity', all((e) => { const o = Math.max(0, Math.min(100, v)) / 100; if (o >= 1) delete e.opacity; else e.opacity = o; }))} />
          </div>
        </>
      )}
      <label className="dc-check"><input type="checkbox" checked={!!el.locked} onChange={(e) => edit(e.target.checked ? 'Lock' : 'Unlock', all((x) => { if (e.target.checked) x.locked = true; else delete x.locked; }))} /> Lock position</label>
      {(el.type === 'shape' || el.type === 'text') && (
        <>
          <h4>Fill and border</h4>
          <Color label="Fill colour" theme={t} value={el.fill} onChange={(v) => edit('Fill', all((e) => { if (e.type === 'shape' || e.type === 'text') { if (v) e.fill = v; else if (e.type === 'shape') e.fill = 'none'; else delete e.fill; } }))} />
          <Color label="Border colour" theme={t} value={el.stroke} onChange={(v) => edit('Border', all((e) => { if (e.type === 'shape' || e.type === 'text') { if (v) { e.stroke = v; e.strokeW = e.strokeW || 2; } else delete e.stroke; } }))} />
          <Num label="Border weight" value={el.strokeW ?? 0} onChange={(v) => edit('Border weight', all((e) => { if (e.type === 'shape' || e.type === 'text') e.strokeW = Math.max(0, v); }))} />
        </>
      )}
      {el.type === 'shape' && (
        <>
          <label className="dc-field"><span>Shape</span><select className="dc-select" aria-label="Shape kind" value={el.shape} onChange={(e) => edit('Change shape', all((x) => { if (x.type === 'shape') x.shape = e.target.value as ShapeKind; }))}>{SHAPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
          <label className="dc-check"><input type="checkbox" checked={!!el.shadow} onChange={(e) => edit('Shadow', all((x) => { if (x.type === 'shape') { if (e.target.checked) x.shadow = true; else delete x.shadow; } }))} /> Drop shadow</label>
          <label className="dc-check"><input type="checkbox" checked={!!el.dash} onChange={(e) => edit('Dashed border', all((x) => { if (x.type === 'shape') { if (e.target.checked) x.dash = true; else delete x.dash; } }))} /> Dashed border</label>
        </>
      )}
      {(el.type === 'shape' || el.type === 'text') && (
        <>
          <h4>Text fitting</h4>
          <div className="dc-chips" role="radiogroup" aria-label="Vertical alignment">{(['top', 'middle', 'bottom'] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={(el.valign ?? (el.type === 'shape' ? 'middle' : 'top')) === v} className={`dc-chip-btn${(el.valign ?? (el.type === 'shape' ? 'middle' : 'top')) === v ? ' dc-chip-btn--on' : ''}`} onClick={() => edit('Vertical align', all((x) => { if (x.type === 'shape' || x.type === 'text') x.valign = v; }))}>{v}</button>)}</div>
          {el.type === 'text' && (
            <>
              <label className="dc-field"><span>Autofit</span><select className="dc-select" aria-label="Autofit" value={el.autofit ?? 'none'} onChange={(e) => edit('Autofit', all((x) => { if (x.type === 'text') x.autofit = e.target.value as 'none'; }))}><option value="none">Do not autofit</option><option value="shrink">Shrink text on overflow</option><option value="resize">Resize shape to fit text</option></select></label>
              <Num label="Padding" value={el.pad ?? 8} onChange={(v) => edit('Padding', all((x) => { if (x.type === 'text') x.pad = Math.max(0, v); }))} />
            </>
          )}
        </>
      )}
      {el.type === 'line' && (
        <>
          <h4>Line</h4>
          <Color label="Line colour" theme={t} value={el.stroke} onChange={(v) => edit('Line colour', all((x) => { if (x.type === 'line') x.stroke = v ?? '$text'; }))} />
          <Num label="Line weight" value={el.strokeW ?? 3} onChange={(v) => edit('Line weight', all((x) => { if (x.type === 'line') x.strokeW = Math.max(0.5, v); }))} />
          <div className="dc-row">
            {(['start', 'end'] as const).map((k) => <label key={k} className="dc-field"><span>{k === 'start' ? 'Start' : 'End'}</span><select className="dc-select" aria-label={`Line ${k}`} value={el[k] ?? 'none'} onChange={(e) => edit('Arrow', all((x) => { if (x.type === 'line') x[k] = e.target.value as 'none'; }))}><option value="none">None</option><option value="arrow">Arrow</option><option value="dot">Dot</option></select></label>)}
          </div>
          <label className="dc-check"><input type="checkbox" checked={!!el.dash} onChange={(e) => edit('Dashed line', all((x) => { if (x.type === 'line') { if (e.target.checked) x.dash = true; else delete x.dash; } }))} /> Dashed</label>
        </>
      )}
      {el.type === 'image' && (
        <>
          <h4>Image</h4>
          <label className="dc-field"><span>Fit</span><select className="dc-select" aria-label="Image fit" value={el.fit ?? 'cover'} onChange={(e) => edit('Image fit', all((x) => { if (x.type === 'image') x.fit = e.target.value as 'cover'; }))}><option value="cover">Fill the box (crop)</option><option value="contain">Fit inside the box</option><option value="fill">Stretch</option></select></label>
          <Num label="Corner radius" value={el.radius ?? 0} onChange={(v) => edit('Corner radius', all((x) => { if (x.type === 'image') { if (v > 0) x.radius = v; else delete x.radius; } }))} />
          <button type="button" className="dc-btn" onClick={() => onPickImage(false)}>Replace image…</button>
        </>
      )}
      {el.type === 'table' && (
        <>
          <h4>Table</h4>
          <div className="sl-grid2">
            <button type="button" className="dc-btn" onClick={() => edit('Insert row', all((x) => { if (x.type === 'table') x.rows.push(x.rows[0].map(() => ({ text: '' }))); }))}>+ Row</button>
            <button type="button" className="dc-btn" onClick={() => edit('Insert column', all((x) => { if (x.type === 'table') for (const r of x.rows) r.push({ text: '' }); }))}>+ Column</button>
            <button type="button" className="dc-btn" disabled={el.rows.length < 2} onClick={() => edit('Delete row', all((x) => { if (x.type === 'table' && x.rows.length > 1) x.rows.pop(); }))}>− Row</button>
            <button type="button" className="dc-btn" disabled={(el.rows[0]?.length ?? 0) < 2} onClick={() => edit('Delete column', all((x) => { if (x.type === 'table' && x.rows[0].length > 1) for (const r of x.rows) r.pop(); }))}>− Column</button>
          </div>
          <label className="dc-check"><input type="checkbox" checked={el.header !== false} onChange={(e) => edit('Header row', all((x) => { if (x.type === 'table') x.header = e.target.checked; }))} /> Header row</label>
          <label className="dc-check"><input type="checkbox" checked={!!el.band} onChange={(e) => edit('Banded rows', all((x) => { if (x.type === 'table') { if (e.target.checked) x.band = true; else delete x.band; } }))} /> Alternating rows</label>
          <Num label="Text size" value={el.size ?? 14} onChange={(v) => edit('Table text size', all((x) => { if (x.type === 'table') x.size = Math.max(6, v); }))} />
          <p className="dc-note">Double-click a cell to type in it.</p>
        </>
      )}
      {el.type === 'chart' && (
        <>
          <h4>Chart</h4>
          <button type="button" className="dc-btn" onClick={() => onChartData(el.id)}>Edit data…</button>
          <label className="dc-check"><input type="checkbox" checked={el.values ?? false} onChange={(e) => edit('Data labels', all((x) => { if (x.type === 'chart') x.values = e.target.checked; }))} /> Data labels</label>
          <label className="dc-check"><input type="checkbox" checked={el.legend ?? (el.series.length > 1 || el.chart === 'pie' || el.chart === 'doughnut')} onChange={(e) => edit('Legend', all((x) => { if (x.type === 'chart') x.legend = e.target.checked; }))} /> Legend</label>
          <label className="dc-field"><span>Highlight one category (grey the rest)</span><select className="dc-select" aria-label="Highlight category" value={el.highlight ?? -1} onChange={(e) => edit('Highlight', all((x) => { if (x.type === 'chart') { const v = Number(e.target.value); if (v >= 0) x.highlight = v; else delete x.highlight; } }))}><option value={-1}>None</option>{el.labels.map((l, i) => <option key={i} value={i}>{l}</option>)}</select></label>
        </>
      )}
      {el.type === 'icon' && <Color label="Icon colour" theme={t} value={el.color} onChange={(v) => edit('Icon colour', all((x) => { if (x.type === 'icon') { if (v) x.color = v; else delete x.color; } }))} />}
      {el.type === 'embed' && (
        <>
          <h4>{el.kind === 'video' ? 'Video' : 'Link'}</h4>
          <label className="dc-field"><span>URL</span><input className="dc-input" aria-label="Embed URL" key={`${el.id}:${el.url}`} defaultValue={el.url} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { const v = e.target.value.trim(); if (v !== el.url) edit('Embed URL', all((x) => { if (x.type === 'embed') x.url = v; })); }} /></label>
          <label className="dc-field"><span>Title</span><input className="dc-input" aria-label="Embed title" key={`${el.id}:${el.title}`} defaultValue={el.title ?? ''} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { const v = e.target.value; if (v !== (el.title ?? '')) edit('Embed title', all((x) => { if (x.type === 'embed') x.title = v; })); }} /></label>
        </>
      )}
      <h4>Accessibility</h4>
      <label className="dc-field"><span>Alt text (what it shows or means)</span><textarea className="dc-input dc-area" aria-label="Alt text" rows={2} key={`${el.id}:${el.alt}`} defaultValue={el.alt ?? ''} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (el.alt ?? '')) edit('Alt text', all((x) => { if (v) x.alt = v; else delete x.alt; })); }} /></label>
      {el.type !== 'embed' && <label className="dc-field"><span>Link (opens when presenting)</span><input className="dc-input" aria-label="Object link" key={`${el.id}:${el.link}`} defaultValue={el.link ?? ''} placeholder="https://…" onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (el.link ?? '')) edit('Link', all((x) => { if (v) x.link = v; else delete x.link; })); }} /></label>}
    </aside>
  );
}

/* ---------------- comments ---------------- */

export function CommentsPanel({ slide, selected, author, edit, onSelectEl, onClose, draftOpen, setDraftOpen }: { slide: Slide; selected: El[]; author: string; edit: Edit; onSelectEl: (id: string) => void; onClose: () => void; draftOpen: boolean; setDraftOpen: (v: boolean) => void }) {
  const [text, setText] = useState('');
  const [reply, setReply] = useState<Record<string, string>>({});
  const at = () => new Date().toISOString();
  const els = new Map(slide.elements.map((e) => [e.id, e]));
  const submit = () => { const v = text.trim(); if (!v) return; const anchor = selected[0]?.id; edit('Comment', (d, s) => { s.comments.push({ id: newId(d, 'c'), author, at: at(), text: v, ...(anchor ? { el: anchor } : {}), replies: [] }); }); setText(''); setDraftOpen(false); };
  return (
    <aside className="sl-side" aria-label="Comments">
      <Head title="Comments" onClose={onClose} />
      {draftOpen ? (
        <div className="dc-card dc-card--on">
          {selected[0] && <div className="dc-card__quote">On: {elLabel(selected[0])}</div>}
          <textarea className="dc-input dc-area" aria-label="Comment text" rows={3} autoFocus value={text} placeholder="Comment" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); if (e.key === 'Escape') setDraftOpen(false); }} />
          <div className="dc-row dc-row--end"><button type="button" className="dc-btn" onClick={() => setDraftOpen(false)}>Cancel</button><button type="button" className="dc-btn dc-btn--primary" disabled={!text.trim()} onClick={submit}>Comment</button></div>
        </div>
      ) : <button type="button" className="dc-btn" onClick={() => setDraftOpen(true)}>+ Add a comment</button>}
      {slide.comments.length === 0 && !draftOpen && <p className="dc-note">No comments on this slide.</p>}
      {slide.comments.map((c) => (
        <div key={c.id} className={`dc-card${c.resolved ? ' dc-card--resolved' : ''}`} data-testid="slide-comment" onClick={() => { if (c.el) onSelectEl(c.el); }}>
          <div className="dc-card__who"><b>{c.author}</b>{c.at && <span>{c.at.slice(0, 16).replace('T', ' ')}</span>}<span className="dc-grow" />
            <button type="button" className="dc-icon" aria-label={c.resolved ? `Reopen comment ${c.id}` : `Resolve comment ${c.id}`} onClick={(e) => { e.stopPropagation(); edit('Resolve', (_, s) => { const x = s.comments.find((y) => y.id === c.id); if (x) { if (x.resolved) delete x.resolved; else x.resolved = true; } }); }}><Check size={13} /></button>
            <button type="button" className="dc-icon" aria-label={`Delete comment ${c.id}`} onClick={(e) => { e.stopPropagation(); edit('Delete comment', (_, s) => { s.comments = s.comments.filter((y) => y.id !== c.id); }); }}><Trash2 size={12} /></button>
          </div>
          {c.el && els.get(c.el) && <div className="dc-card__quote">On: {elLabel(els.get(c.el)!)}</div>}
          <div className="dc-card__text">{c.text}</div>
          {c.replies.map((r, i) => <div key={i} className="dc-card__reply"><b>{r.author}</b> {r.text}</div>)}
          {!c.resolved && <input className="dc-input" aria-label={`Reply to ${c.id}`} placeholder="Reply" value={reply[c.id] ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => setReply({ ...reply, [c.id]: e.target.value })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (reply[c.id] ?? '').trim()) { const v = reply[c.id].trim(); setReply({ ...reply, [c.id]: '' }); edit('Reply', (_, s) => { s.comments.find((y) => y.id === c.id)?.replies.push({ author, at: at(), text: v }); }); } }} />}
        </div>
      ))}
    </aside>
  );
}
