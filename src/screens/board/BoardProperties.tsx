import { ArrowLeft, ExternalLink, RefreshCw, AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Bold, Copy, Grid3x3, Group, Lock, Trash2, Ungroup, Unlock, ThumbsUp } from 'lucide-react';
import { codeKey, describeCode, type CodeSnapshot } from '../../lib/codeSnap';
import { BOARD_COLORS, COLOR_STYLES, SHAPE_KINDS, STAMPS, type Board, type BoardColor, type BoardItem } from '../../lib/board';

export type BoardAction = 'duplicate' | 'delete' | 'forward' | 'backward' | 'group' | 'ungroup' | 'arrange' | 'vote' | 'unvote';
export const VOTER = 'you';

interface Props {
  board: Board;
  selected: BoardItem[];
  onPatch: (ids: string[], patch: Record<string, unknown>, key?: string) => void;
  onEndEdit: () => void;
  onAction: (action: BoardAction) => void;
  onTitle: (title: string) => void;
  /** Opens the diagram or design an embed shows in its own editor. */
  onOpenSource?: (item: BoardItem) => void;
  /** Re-reads the repository for the code cards. */
  onRefreshCode?: () => void;
  /** Loaded code of the board's code items (for the changed-files list). */
  codeSnapshots?: Record<string, CodeSnapshot>;
  /** Switches a commit/compare card to one file's diff (or back to the file list with null). */
  onShowCodePath?: (id: string, path: string | null) => void;
}

function Num({ label, value, onChange, min = 24 }: { label: string; value: number; onChange: (value: number) => void; min?: number }) {
  return (
    <label className="brd-num">
      <span>{label}</span>
      <input type="number" aria-label={label === 'W' ? 'Width' : 'Height'} min={min} value={Math.round(value)}
        onChange={(event) => { const n = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(n)) onChange(n); }} />
    </label>
  );
}

export function BoardColors({ value, onPick }: { value?: BoardColor; onPick: (color: BoardColor) => void }) {
  return (
    <div className="brd-swatches" role="group" aria-label="Colour">
      {BOARD_COLORS.map((color) => (
        <button key={color} type="button" className={`brd-swatch${value === color ? ' brd-swatch--on' : ''}`} aria-label={`Colour ${color}`} aria-pressed={value === color}
          title={color} style={{ background: COLOR_STYLES[color].fill, borderColor: COLOR_STYLES[color].stroke }} onClick={() => onPick(color)} />
      ))}
    </div>
  );
}

/** Properties for the selected board items (or the board itself when nothing is selected). */
export function BoardProperties({ board, selected, onPatch, onEndEdit, onAction, onTitle, onOpenSource, onRefreshCode, codeSnapshots, onShowCodePath }: Props) {
  if (selected.length === 0) {
    const count = (type: string) => board.items.filter((i) => i.type === type).length;
    const votes = board.items.reduce((sum, i) => sum + (i.votes?.length ?? 0), 0);
    return (
      <div className="brd-props">
        <section className="brd-section">
          <h3 className="brd-section__title">Board</h3>
          <label className="brd-field"><span>Title</span>
            <input className="brd-input" aria-label="Board title" value={board.title} onChange={(event) => onTitle(event.target.value)} onBlur={onEndEdit} />
          </label>
          <p className="brd-stats">{count('sticky')} notes · {count('section')} sections · {count('connector')} connectors{votes ? ` · ${votes} votes` : ''}</p>
        </section>
        <section className="brd-section">
          <h3 className="brd-section__title">Shortcuts</h3>
          <p className="brd-tip"><kbd>S</kbd> sticky · <kbd>T</kbd> text · <kbd>R</kbd> shape · <kbd>C</kbd> connector · <kbd>G</kbd> section · <kbd>P</kbd> pen · <kbd>E</kbd> stamp · <kbd>V</kbd> select</p>
          <p className="brd-tip">Double-click the canvas to add a sticky, double-click a note to edit it. Drag a note onto a section to put it inside; moving a section moves its notes. Space + drag pans, Ctrl + scroll zooms.</p>
        </section>
      </div>
    );
  }

  const item = selected[0];
  const ids = selected.map((s) => s.id);
  const multi = selected.length > 1;
  const patch = (fields: Record<string, unknown>, key?: string) => onPatch(ids, fields, key ? `${key}:${ids.join(',')}` : undefined);
  const textual = item.type === 'sticky' || item.type === 'shape' || item.type === 'text';
  const colored = item.type !== 'text' && item.type !== 'stamp' && item.type !== 'embed' && item.type !== 'code';
  const iVoted = (item.votes ?? []).includes(VOTER);

  return (
    <div className="brd-props">
      <header className="brd-props__head">
        <strong>{multi ? `${selected.length} items` : item.type === 'section' ? item.text || 'Section' : item.type === 'connector' ? 'Connector' : (item.text || item.type).slice(0, 28)}</strong>
        <span>{multi ? '' : item.type}</span>
      </header>

      <div className="brd-actions">
        <button type="button" className="brd-btn" onClick={() => onAction('duplicate')} title="Duplicate (Ctrl+D)"><Copy size={12} /> Duplicate</button>
        {selected.some((s) => s.type !== 'section' && s.type !== 'connector') && <button type="button" className="brd-btn" onClick={() => onAction('group')} title="Put in a new section (Ctrl+G)"><Group size={12} /> Section</button>}
        {selected.some((s) => s.parent) && <button type="button" className="brd-btn" onClick={() => onAction('ungroup')} title="Take out of its section"><Ungroup size={12} /> Ungroup</button>}
        <button type="button" className="brd-btn" aria-label="Bring forward" title="Bring forward (])" onClick={() => onAction('forward')}><ArrowUp size={12} /></button>
        <button type="button" className="brd-btn" aria-label="Send backward" title="Send backward ([)" onClick={() => onAction('backward')}><ArrowDown size={12} /></button>
        <button type="button" className="brd-btn" aria-label={item.locked ? 'Unlock' : 'Lock'} title={item.locked ? 'Unlock' : 'Lock in place'} onClick={() => patch({ locked: !item.locked })}>{item.locked ? <Unlock size={12} /> : <Lock size={12} />}</button>
        <button type="button" className="brd-btn brd-btn--danger" aria-label="Delete" title="Delete" onClick={() => onAction('delete')}><Trash2 size={12} /></button>
      </div>

      {colored && (
        <section className="brd-section">
          <h3 className="brd-section__title">Colour</h3>
          <BoardColors value={item.color} onPick={(color) => patch({ color })} />
        </section>
      )}

      {!multi && item.type === 'embed' && item.embed && (
        <section className="brd-section">
          <h3 className="brd-section__title">{item.embed.kind === 'design' ? 'Embedded design' : 'Embedded diagram'}</h3>
          <label className="brd-field"><span>Title</span>
            <input className="brd-input" aria-label="Embed title" placeholder={item.embed.ref} value={item.text ?? ''} onChange={(event) => patch({ text: event.target.value }, 'etitle')} onBlur={onEndEdit} />
          </label>
          <p className="brd-tip"><code>{item.embed.ref}</code>{item.embed.node ? <> › {item.embed.node}</> : null}<br />Shows the live {item.embed.kind}; it updates when the source changes.</p>
          <button type="button" className="brd-btn" onClick={() => onOpenSource?.(item)}><ExternalLink size={12} /> Open in {item.embed.kind === 'design' ? 'Design' : 'Diagram'} editor</button>
        </section>
      )}

      {!multi && item.type === 'code' && item.code && (() => {
        const code = item.code;
        const setCode = (fields: Partial<typeof code>, key: string) => patch({ code: { ...code, ...fields } }, key);
        const num = (value: string) => (/^\d+$/.test(value.trim()) && Number(value) > 0 ? Number(value) : undefined);
        return (
          <section className="brd-section">
            <h3 className="brd-section__title">{code.kind === 'compare' ? 'Compare' : code.kind === 'commit' ? 'Commit' : 'Code'}</h3>
            <label className="brd-field"><span>Label</span>
              <input className="brd-input" aria-label="Code label" placeholder={describeCode(code)} value={item.text ?? ''} onChange={(event) => patch({ text: event.target.value }, 'ctitle')} onBlur={onEndEdit} />
            </label>
            {code.kind === 'file' && (
              <>
                <label className="brd-field"><span>File</span>
                  <input className="brd-input" aria-label="Code path" value={code.path ?? ''} onChange={(event) => setCode({ path: event.target.value }, 'cpath')} onBlur={onEndEdit} />
                </label>
                <div className="brd-grid">
                  <label className="brd-num"><span>From</span><input type="number" min={1} aria-label="Code first line" value={code.start ?? ''} onChange={(event) => setCode({ start: num(event.target.value) }, 'cstart')} onBlur={onEndEdit} /></label>
                  <label className="brd-num"><span>To</span><input type="number" min={1} aria-label="Code last line" value={code.end ?? ''} onChange={(event) => setCode({ end: num(event.target.value) }, 'cend')} onBlur={onEndEdit} /></label>
                </div>
              </>
            )}
            {code.kind !== 'file' && <p className="brd-tip"><code>{describeCode(code)}</code></p>}
            {code.kind !== 'file' && code.path && (
              <button type="button" className="brd-btn" onClick={() => onShowCodePath?.(item.id, null)}><ArrowLeft size={12} /> Back to {code.kind === 'commit' ? 'commit details' : 'changed files'}</button>
            )}
            {code.kind !== 'file' && !code.path && (() => {
              const files = codeSnapshots?.[codeKey(code)]?.files ?? [];
              return files.length > 0 ? (
                <div className="brd-files" role="list" aria-label="Changed files">
                  {files.map((f) => (
                    <button key={f.path} type="button" role="listitem" className="brd-file" title={`Show the diff of ${f.path}`} onClick={() => onShowCodePath?.(item.id, f.path)}>
                      <b className={`brd-file__st brd-file__st--${f.status.toLowerCase()}`}>{f.status}</b>
                      <span className="brd-file__path">{f.path}</span>
                      <span className="brd-file__stat"><i>+{f.additions}</i> <u>−{f.deletions}</u></span>
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
            <p className="brd-tip">Reads the repository live; refresh after the code changes.</p>
            <div className="brd-actions">
              <button type="button" className="brd-btn" onClick={() => onRefreshCode?.()}><RefreshCw size={12} /> Refresh</button>
              <button type="button" className="brd-btn" onClick={() => onOpenSource?.(item)}><ExternalLink size={12} /> {code.kind === 'commit' && !code.path ? 'Open commit' : 'Open file'}</button>
            </div>
          </section>
        );
      })()}

      {!multi && item.type === 'section' && (
        <section className="brd-section">
          <h3 className="brd-section__title">Section</h3>
          <label className="brd-field"><span>Title</span>
            <input className="brd-input" aria-label="Section title" value={item.text ?? ''} onChange={(event) => patch({ text: event.target.value }, 'title')} onBlur={onEndEdit} />
          </label>
          <button type="button" className="brd-btn" onClick={() => onAction('arrange')}><Grid3x3 size={12} /> Arrange notes in a grid</button>
        </section>
      )}

      {!multi && item.type === 'shape' && (
        <section className="brd-section">
          <h3 className="brd-section__title">Shape</h3>
          <select className="brd-input" aria-label="Shape kind" value={item.shape ?? 'round'} onChange={(event) => patch({ shape: event.target.value })}>
            {SHAPE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </section>
      )}

      {!multi && item.type === 'connector' && (
        <section className="brd-section">
          <h3 className="brd-section__title">Connector</h3>
          <label className="brd-field"><span>Label</span>
            <input className="brd-input" aria-label="Connector label" value={item.text ?? ''} onChange={(event) => patch({ text: event.target.value }, 'clabel')} onBlur={onEndEdit} />
          </label>
          <div className="brd-seg" role="group" aria-label="Line style">
            {(['straight', 'elbow', 'curve'] as const).map((route) => (
              <button key={route} type="button" className={(item.route ?? 'straight') === route ? 'on' : ''} onClick={() => patch({ route })}>{route}</button>
            ))}
          </div>
          <label className="brd-field"><span>Arrow</span>
            <select className="brd-input" aria-label="Arrow style" value={item.arrow ?? 'end'} onChange={(event) => patch({ arrow: event.target.value })}>
              <option value="end">Arrow at target</option><option value="both">Both ends</option><option value="none">No arrow</option>
            </select>
          </label>
          <label className="brd-check"><input type="checkbox" checked={item.dashed === true} onChange={(event) => patch({ dashed: event.target.checked })} /> Dashed line</label>
        </section>
      )}

      {textual && (
        <section className="brd-section">
          <h3 className="brd-section__title">Text</h3>
          {!multi && <textarea className="brd-input brd-area" aria-label="Text content" rows={3} value={item.text ?? ''} onChange={(event) => patch({ text: event.target.value }, 'text')} onBlur={onEndEdit} />}
          <div className="brd-seg" role="group" aria-label="Font size">
            {[12, 16, 20, 28, 40].map((size) => (
              <button key={size} type="button" className={(item.fontSize ?? (item.type === 'text' ? 18 : 16)) === size ? 'on' : ''} onClick={() => patch({ fontSize: size })}>{size}</button>
            ))}
          </div>
          <div className="brd-seg" role="group" aria-label="Text style">
            <button type="button" aria-label="Bold" aria-pressed={item.bold === true} className={item.bold ? 'on' : ''} onClick={() => patch({ bold: !item.bold })}><Bold size={12} /></button>
            {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([value, Icon]) => (
              <button key={value} type="button" aria-label={`Align ${value}`} className={(item.align ?? (item.type === 'shape' ? 'center' : 'left')) === value ? 'on' : ''} onClick={() => patch({ align: value })}><Icon size={12} /></button>
            ))}
          </div>
        </section>
      )}

      {!multi && item.type === 'stamp' && (
        <section className="brd-section">
          <h3 className="brd-section__title">Stamp</h3>
          <div className="brd-stamps">{STAMPS.map((emoji) => <button key={emoji} type="button" className={item.emoji === emoji ? 'on' : ''} aria-label={`Stamp ${emoji}`} onClick={() => patch({ emoji })}>{emoji}</button>)}</div>
        </section>
      )}

      {!multi && item.type === 'sticky' && (
        <section className="brd-section">
          <h3 className="brd-section__title">Votes</h3>
          <div className="brd-vote">
            <button type="button" className={`brd-btn${iVoted ? ' brd-btn--on' : ''}`} onClick={() => onAction(iVoted ? 'unvote' : 'vote')}><ThumbsUp size={12} /> {iVoted ? 'Remove my vote' : 'Vote'}</button>
            <span>{item.votes?.length ?? 0} vote{(item.votes?.length ?? 0) === 1 ? '' : 's'}</span>
          </div>
          {item.author && <p className="brd-tip">Added by {item.author}</p>}
        </section>
      )}

      {!multi && item.type !== 'connector' && item.type !== 'pen' && item.type !== 'text' && item.type !== 'stamp' && (
        <section className="brd-section">
          <h3 className="brd-section__title">Size</h3>
          <div className="brd-grid">
            <Num label="W" value={item.w} onChange={(v) => patch({ w: v }, 'w')} />
            <Num label="H" value={item.h} onChange={(v) => patch({ h: v }, 'h')} />
          </div>
        </section>
      )}
    </div>
  );
}
