import { useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowRight, ArrowUp, Copy, Group, Plus, Trash2, X } from 'lucide-react';
import { FRAME_PRESETS, isGradient, resolveColor, type AutoLayout, type Design, type DesignNode, type Fill } from './design';

export type PropAction = 'duplicate' | 'delete' | 'group' | 'forward' | 'backward';

interface Props {
  design: Design;
  selected: DesignNode[];
  parentOf: (id: string) => DesignNode | null | undefined;
  onPatch: (ids: string[], patch: Record<string, unknown>, key?: string) => void;
  /** Ends a run of merged edits (call on blur). */
  onEndEdit: () => void;
  onAction: (action: PropAction) => void;
  onTokens: (colors: Record<string, string | null>) => void;
  onTitle: (title: string) => void;
}

const hex = (value: string): string => (/^#[0-9a-f]{6}$/i.test(value) ? value : /^#[0-9a-f]{3}$/i.test(value) ? `#${value.slice(1).split('').map((c) => c + c).join('')}` : '#888888');

function Num({ label, value, onChange, disabled, min, max, step = 1, title }: { label: string; value: number | undefined; onChange: (value: number) => void; disabled?: boolean; min?: number; max?: number; step?: number; title?: string }) {
  return (
    <label className="dgn-num" title={title}>
      <span>{label}</span>
      <input type="number" aria-label={title ?? label} disabled={disabled} min={min} max={max} step={step} value={value === undefined || Number.isNaN(value) ? '' : Math.round(value * 100) / 100}
        onChange={(event) => { const n = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(n)) onChange(n); }} />
    </label>
  );
}

function ColorField({ label, value, tokens, onChange, onEnd }: { label: string; value: string; tokens: Design['tokens']; onChange: (value: string) => void; onEnd: () => void }) {
  const tokenNames = Object.keys(tokens.colors);
  const isToken = value.startsWith('$');
  return (
    <div className="dgn-color">
      <input type="color" aria-label={`${label} colour`} value={hex(resolveColor(value, tokens))} onChange={(event) => onChange(event.target.value)} onBlur={onEnd} />
      <input className="dgn-input" aria-label={`${label} value`} value={value} spellCheck={false} onChange={(event) => onChange(event.target.value)} onBlur={onEnd} />
      {tokenNames.length > 0 && (
        <select className="dgn-input dgn-color__token" aria-label={`${label} token`} value={isToken ? value : ''} onChange={(event) => { if (event.target.value) { onChange(event.target.value); onEnd(); } }}>
          <option value="">token…</option>
          {tokenNames.map((name) => <option key={name} value={`$${name}`}>{name}</option>)}
        </select>
      )}
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="dgn-section">
      <h3 className="dgn-section__title"><span>{title}</span>{action}</h3>
      {children}
    </section>
  );
}

/** Figma-style properties panel for the selection (or the document when nothing is selected). */
export function DesignProperties({ design, selected, parentOf, onPatch, onEndEdit, onAction, onTokens, onTitle }: Props) {
  const [tokenName, setTokenName] = useState('');
  const [tokenValue, setTokenValue] = useState('#4f46e5');

  if (selected.length === 0) {
    return (
      <div className="dgn-props">
        <Section title="Design">
          <label className="dgn-field"><span>Title</span>
            <input className="dgn-input" aria-label="Design title" value={design.title} onChange={(event) => onTitle(event.target.value)} onBlur={onEndEdit} />
          </label>
        </Section>
        <Section title="Colour tokens">
          {Object.entries(design.tokens.colors).map(([name, value]) => (
            <div key={name} className="dgn-token">
              <input type="color" aria-label={`${name} colour`} value={hex(value)} onChange={(event) => onTokens({ [name]: event.target.value })} onBlur={onEndEdit} />
              <code>${name}</code>
              <input className="dgn-input" aria-label={`${name} value`} value={value} spellCheck={false} onChange={(event) => onTokens({ [name]: event.target.value })} onBlur={onEndEdit} />
              <button type="button" className="dgn-icon" aria-label={`Remove token ${name}`} onClick={() => { onTokens({ [name]: null }); onEndEdit(); }}><X size={12} /></button>
            </div>
          ))}
          <div className="dgn-token dgn-token--new">
            <input type="color" aria-label="New token colour" value={hex(tokenValue)} onChange={(event) => setTokenValue(event.target.value)} />
            <input className="dgn-input" aria-label="New token name" placeholder="name, e.g. primary" value={tokenName} onChange={(event) => setTokenName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && tokenName.trim()) { onTokens({ [tokenName.trim()]: tokenValue }); onEndEdit(); setTokenName(''); } }} />
            <button type="button" className="dgn-icon" aria-label="Add colour token" disabled={!tokenName.trim()} onClick={() => { onTokens({ [tokenName.trim()]: tokenValue }); onEndEdit(); setTokenName(''); }}><Plus size={13} /></button>
          </div>
          <p className="dgn-tip">Use a token as a fill with its name, e.g. <code>$primary</code>. Changing the token recolours everything that uses it.</p>
        </Section>
        <p className="dgn-tip">Select a layer to edit it. Draw with F (frame), R, O, L, T. Hold Space to pan, Ctrl+scroll to zoom.</p>
      </div>
    );
  }

  const node = selected[0];
  const ids = selected.map((n) => n.id);
  const multi = selected.length > 1;
  const parent = parentOf(node.id) ?? null;
  const inFlow = !!parent?.layout;
  const patch = (fields: Record<string, unknown>, key?: string) => onPatch(ids, fields, key ? `${key}:${ids.join(',')}` : undefined);
  const layout = node.layout;
  const setLayout = (next: Partial<AutoLayout> | null) => {
    if (next === null) { patch({ layout: null }); return; }
    const base: AutoLayout = layout ?? { dir: 'column', gap: 0, padding: [0, 0, 0, 0], justify: 'start', align: 'start', hugW: false, hugH: false };
    patch({ layout: { ...base, ...next } });
  };
  const fill: Fill | undefined = node.fill;
  const gradient = isGradient(fill) ? fill : null;
  const solid = typeof fill === 'string' ? fill : gradient ? gradient.from : '';
  const preset = FRAME_PRESETS.find((p) => p.w === Math.round(node.w) && p.h === Math.round(node.h))?.id ?? '';

  return (
    <div className="dgn-props">
      <header className="dgn-props__head">
        <strong>{multi ? `${selected.length} layers` : node.name}</strong>
        <span>{multi ? '' : node.type}</span>
      </header>

      <div className="dgn-actions">
        <button type="button" className="dgn-btn" onClick={() => onAction('duplicate')} title="Duplicate (Ctrl+D)"><Copy size={12} /> Duplicate</button>
        <button type="button" className="dgn-btn" onClick={() => onAction('group')} title="Wrap in a frame (Ctrl+G)"><Group size={12} /> Group</button>
        <button type="button" className="dgn-btn" aria-label="Bring forward" title="Bring forward (])" onClick={() => onAction('forward')}><ArrowUp size={12} /></button>
        <button type="button" className="dgn-btn" aria-label="Send backward" title="Send backward ([)" onClick={() => onAction('backward')}><ArrowDown size={12} /></button>
        <button type="button" className="dgn-btn dgn-btn--danger" aria-label="Delete" title="Delete" onClick={() => onAction('delete')}><Trash2 size={12} /></button>
      </div>

      {!multi && node.type === 'frame' && !parent && (
        <Section title="Frame">
          <select className="dgn-input" aria-label="Frame size preset" value={preset} onChange={(event) => { const p = FRAME_PRESETS.find((x) => x.id === event.target.value); if (p) patch({ w: p.w, h: p.h }); }}>
            <option value="">Custom size</option>
            {FRAME_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Section>
      )}

      {!multi && (
        <Section title="Position & size">
          <div className="dgn-grid">
            <Num label="X" title="X position" value={node.x} disabled={inFlow} onChange={(v) => patch({ x: v }, 'x')} />
            <Num label="Y" title="Y position" value={node.y} disabled={inFlow} onChange={(v) => patch({ y: v }, 'y')} />
            <Num label="W" title="Width" min={1} value={node.w} disabled={(layout?.hugW && node.type === 'frame') || (node.type === 'text' && node.autoSize === 'w')} onChange={(v) => patch({ w: v, ...(node.layout?.hugW ? { layout: { ...node.layout, hugW: false } } : {}) }, 'w')} />
            <Num label="H" title="Height" min={0} value={node.h} disabled={(layout?.hugH && node.type === 'frame') || (node.type === 'text' && node.autoSize !== 'none')} onChange={(v) => patch({ h: v, ...(node.layout?.hugH ? { layout: { ...node.layout, hugH: false } } : {}), ...(node.type === 'text' ? { autoSize: 'none' } : {}) }, 'h')} />
          </div>
          {inFlow && <p className="dgn-tip">Position is controlled by the parent's auto layout.</p>}
        </Section>
      )}

      {!multi && node.type === 'frame' && (
        <Section title="Auto layout" action={layout ? <button type="button" className="dgn-icon" aria-label="Remove auto layout" onClick={() => setLayout(null)}><X size={12} /></button> : undefined}>
          <div className="dgn-seg" role="group" aria-label="Layout direction">
            <button type="button" className={!layout ? 'on' : ''} onClick={() => setLayout(null)}>None</button>
            <button type="button" className={layout?.dir === 'column' ? 'on' : ''} aria-label="Vertical layout" title="Vertical" onClick={() => setLayout({ dir: 'column' })}><ArrowDown size={12} /></button>
            <button type="button" className={layout?.dir === 'row' ? 'on' : ''} aria-label="Horizontal layout" title="Horizontal" onClick={() => setLayout({ dir: 'row' })}><ArrowRight size={12} /></button>
          </div>
          {layout && (
            <>
              <div className="dgn-grid">
                <Num label="Gap" title="Gap" min={0} value={layout.gap} onChange={(v) => setLayout({ gap: v })} />
                <label className="dgn-num"><span>Hug</span>
                  <span className="dgn-hug">
                    <label><input type="checkbox" aria-label="Hug width" checked={layout.hugW} onChange={(event) => setLayout({ hugW: event.target.checked })} /> W</label>
                    <label><input type="checkbox" aria-label="Hug height" checked={layout.hugH} onChange={(event) => setLayout({ hugH: event.target.checked })} /> H</label>
                  </span>
                </label>
              </div>
              <div className="dgn-grid dgn-grid--4">
                {(['T', 'R', 'B', 'L'] as const).map((side, i) => (
                  <Num key={side} label={side} title={`Padding ${side}`} min={0} value={layout.padding[i]} onChange={(v) => { const p = [...layout.padding] as AutoLayout['padding']; p[i] = v; setLayout({ padding: p }); }} />
                ))}
              </div>
              <div className="dgn-grid">
                <label className="dgn-field"><span>Justify</span>
                  <select className="dgn-input" aria-label="Justify" value={layout.justify} onChange={(event) => setLayout({ justify: event.target.value as AutoLayout['justify'] })}>
                    <option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="between">Space between</option>
                  </select>
                </label>
                <label className="dgn-field"><span>Align</span>
                  <select className="dgn-input" aria-label="Align items" value={layout.align} onChange={(event) => setLayout({ align: event.target.value as AutoLayout['align'] })}>
                    <option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option>
                  </select>
                </label>
              </div>
            </>
          )}
          <label className="dgn-check"><input type="checkbox" checked={node.clip !== false} onChange={(event) => patch({ clip: event.target.checked })} /> Clip content</label>
        </Section>
      )}

      {!multi && inFlow && (
        <Section title="In auto layout">
          <div className="dgn-grid">
            <Num label="⇔" title="Grow" min={0} step={1} value={node.grow ?? 0} onChange={(v) => patch({ grow: v })} />
            <label className="dgn-field"><span>Align self</span>
              <select className="dgn-input" aria-label="Align self" value={node.selfAlign ?? ''} onChange={(event) => patch({ selfAlign: event.target.value || null })}>
                <option value="">Parent default</option><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option>
              </select>
            </label>
          </div>
        </Section>
      )}

      <Section title="Appearance">
        <div className="dgn-grid">
          <Num label="%" title="Opacity percent" min={0} max={100} value={Math.round((node.opacity ?? 1) * 100)} onChange={(v) => patch({ opacity: v / 100 }, 'opacity')} />
          {node.type !== 'ellipse' && node.type !== 'text' && node.type !== 'line' && (
            <Num label="R" title="Corner radius" min={0} value={typeof node.radius === 'number' ? node.radius : node.radius?.[0] ?? 0} onChange={(v) => patch({ radius: v }, 'radius')} />
          )}
        </div>
      </Section>

      {node.type !== 'line' && node.type !== 'image' && (
        <Section title={node.type === 'text' ? 'Text colour' : 'Fill'} action={node.type !== 'text' ? (
          <span className="dgn-seg dgn-seg--mini" role="group" aria-label="Fill type">
            <button type="button" className={fill === null ? 'on' : ''} onClick={() => patch({ fill: null })}>None</button>
            <button type="button" className={typeof fill === 'string' ? 'on' : ''} onClick={() => patch({ fill: solid || '#d9d9d9' })}>Solid</button>
            <button type="button" className={gradient ? 'on' : ''} onClick={() => patch({ fill: { from: solid || '#6366f1', to: '#a855f7', angle: 180 } })}>Gradient</button>
          </span>
        ) : undefined}>
          {typeof fill === 'string' && <ColorField label="Fill" value={fill} tokens={design.tokens} onChange={(value) => patch({ fill: value }, 'fill')} onEnd={onEndEdit} />}
          {gradient && (
            <>
              <ColorField label="Gradient start" value={gradient.from} tokens={design.tokens} onChange={(value) => patch({ fill: { ...gradient, from: value } }, 'gfrom')} onEnd={onEndEdit} />
              <ColorField label="Gradient end" value={gradient.to} tokens={design.tokens} onChange={(value) => patch({ fill: { ...gradient, to: value } }, 'gto')} onEnd={onEndEdit} />
              <Num label="°" title="Gradient angle" value={gradient.angle} onChange={(v) => patch({ fill: { ...gradient, angle: v } }, 'gangle')} />
            </>
          )}
        </Section>
      )}

      {node.type !== 'text' && node.type !== 'image' && (
        <Section title="Stroke" action={node.stroke ? <button type="button" className="dgn-icon" aria-label="Remove stroke" onClick={() => patch({ stroke: null })}><X size={12} /></button> : <button type="button" className="dgn-icon" aria-label="Add stroke" onClick={() => patch({ stroke: '#333333', strokeWidth: 1 })}><Plus size={12} /></button>}>
          {node.stroke && (
            <>
              <ColorField label="Stroke" value={node.stroke} tokens={design.tokens} onChange={(value) => patch({ stroke: value }, 'stroke')} onEnd={onEndEdit} />
              <Num label="W" title="Stroke width" min={0} value={node.strokeWidth ?? 1} onChange={(v) => patch({ strokeWidth: v }, 'sw')} />
            </>
          )}
        </Section>
      )}

      {node.type !== 'line' && (
        <Section title="Shadow" action={node.shadow ? <button type="button" className="dgn-icon" aria-label="Remove shadow" onClick={() => patch({ shadow: null })}><X size={12} /></button> : <button type="button" className="dgn-icon" aria-label="Add shadow" onClick={() => patch({ shadow: { x: 0, y: 4, blur: 12, color: 'rgba(0,0,0,0.2)' } })}><Plus size={12} /></button>}>
          {node.shadow && (
            <>
              <div className="dgn-grid dgn-grid--3">
                <Num label="X" title="Shadow X" value={node.shadow.x} onChange={(v) => patch({ shadow: { ...node.shadow, x: v } }, 'shx')} />
                <Num label="Y" title="Shadow Y" value={node.shadow.y} onChange={(v) => patch({ shadow: { ...node.shadow, y: v } }, 'shy')} />
                <Num label="B" title="Shadow blur" min={0} value={node.shadow.blur} onChange={(v) => patch({ shadow: { ...node.shadow, blur: v } }, 'shb')} />
              </div>
              <label className="dgn-field"><span>Colour</span>
                <input className="dgn-input" aria-label="Shadow colour" value={node.shadow.color} spellCheck={false} onChange={(event) => patch({ shadow: { ...node.shadow, color: event.target.value } }, 'shc')} onBlur={onEndEdit} />
              </label>
            </>
          )}
        </Section>
      )}

      {!multi && node.type === 'text' && (
        <Section title="Text">
          <textarea className="dgn-input dgn-area" aria-label="Text content" rows={3} value={node.text ?? ''} onChange={(event) => patch({ text: event.target.value }, 'text')} onBlur={onEndEdit} />
          <div className="dgn-grid">
            <Num label="Size" title="Font size" min={6} value={node.fontSize ?? 16} onChange={(v) => patch({ fontSize: v }, 'fs')} />
            <label className="dgn-field"><span>Weight</span>
              <select className="dgn-input" aria-label="Font weight" value={node.fontWeight ?? 400} onChange={(event) => patch({ fontWeight: Number(event.target.value) })}>
                {[300, 400, 500, 600, 700, 800].map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
          </div>
          <div className="dgn-grid">
            <label className="dgn-field"><span>Font</span>
              <select className="dgn-input" aria-label="Font family" value={node.fontFamily ?? 'sans'} onChange={(event) => patch({ fontFamily: event.target.value })}>
                <option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option>
              </select>
            </label>
            <Num label="LH" title="Line height" min={0.8} max={3} step={0.1} value={node.lineHeight ?? 1.3} onChange={(v) => patch({ lineHeight: v }, 'lh')} />
          </div>
          <div className="dgn-grid">
            <div className="dgn-seg" role="group" aria-label="Text align">
              {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([value, Icon]) => (
                <button key={value} type="button" aria-label={`Align ${value}`} className={(node.textAlign ?? 'left') === value ? 'on' : ''} onClick={() => patch({ textAlign: value })}><Icon size={12} /></button>
              ))}
            </div>
            <label className="dgn-field"><span>Sizing</span>
              <select className="dgn-input" aria-label="Text sizing" value={node.autoSize ?? 'none'} onChange={(event) => patch({ autoSize: event.target.value })}>
                <option value="w">Fit text</option><option value="h">Fixed width</option><option value="none">Fixed box</option>
              </select>
            </label>
          </div>
        </Section>
      )}

      {!multi && node.type === 'image' && (
        <Section title="Image">
          <label className="dgn-field"><span>Source (https: or data: URL)</span>
            <input className="dgn-input" aria-label="Image source" value={node.src?.startsWith('data:') ? '(embedded image)' : node.src ?? ''} spellCheck={false} onChange={(event) => patch({ src: event.target.value }, 'src')} onBlur={onEndEdit} />
          </label>
        </Section>
      )}
    </div>
  );
}
