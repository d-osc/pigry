/** Side panels of the Video Editor: the CapCut-style media library (media, audio, text, stickers, effects, transitions, filters,
 * captions) and the clip inspector (basic, text, audio, filters, animation, keyframes). */
import { useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import {
  Captions, Diamond, Film, ImageIcon, Layers, Music, PlusCircle, Smile, Sparkles, Type, Upload, Wand2, X, Scissors,
} from 'lucide-react';
import { useTime, type TimeStore } from './VideoTimeline';
import {
  ANIMATIONS, ASPECTS, BLENDS, EASES, EFFECTS, FILTERS, FONTS, SHAPES, SYNTH_PRESETS, TEXT_STYLES, TRANSITIONS, ADJUST_RANGES, checkProject, keyframeValue, projectDuration,
  type Adjust, type AnimProp, type Clip, type EaseId, type Op, type Project,
} from './video';

export type MediaTab = 'media' | 'audio' | 'text' | 'stickers' | 'effects' | 'transitions' | 'filters' | 'captions';
export const MEDIA_TABS: Array<{ id: MediaTab; label: string; icon: typeof Film }> = [
  { id: 'media', label: 'Media', icon: Film }, { id: 'audio', label: 'Audio', icon: Music }, { id: 'text', label: 'Text', icon: Type }, { id: 'stickers', label: 'Stickers', icon: Smile },
  { id: 'effects', label: 'Effects', icon: Sparkles }, { id: 'transitions', label: 'Transitions', icon: Layers }, { id: 'filters', label: 'Filters', icon: Wand2 }, { id: 'captions', label: 'Captions', icon: Captions },
];

const STICKERS = ['🔥', '✨', '❤️', '😂', '😍', '🎉', '👍', '🚀', '⭐', '💯', '🌈', '🎬', '🎵', '📣', '⚡', '💥', '🌟', '😎', '🙌', '👀', '🏆', '💡', '✅', '➡️'];
const BACKGROUNDS: Array<[string, string, string, number]> = [
  ['Sunset', '#ff512f', '#dd2476', 150], ['Ocean', '#2193b0', '#6dd5ed', 160], ['Night', '#1d2671', '#c33764', 60], ['Mint', '#11998e', '#38ef7d', 200], ['Gold', '#f7971e', '#ffd200', 120], ['Slate', '#232526', '#414345', 90],
];
const AUDIO_PRESETS: Array<{ label: string; synth: Record<string, unknown>; duration: number; volume: number }> = [
  { label: 'Upbeat beat', synth: { preset: 'beat', bpm: 120 }, duration: 8, volume: 0.6 }, { label: 'Chill beat', synth: { preset: 'beat', bpm: 84 }, duration: 8, volume: 0.55 },
  { label: 'Warm pad', synth: { preset: 'pad', note: 'D3', scale: 'minor' }, duration: 8, volume: 0.5 }, { label: 'Bass line', synth: { preset: 'bass', note: 'A1', bpm: 120 }, duration: 8, volume: 0.5 },
  { label: 'Arpeggio', synth: { preset: 'arp', note: 'C4', scale: 'major', bpm: 110 }, duration: 8, volume: 0.45 }, { label: 'Riser', synth: { preset: 'riser', note: 'A3' }, duration: 3, volume: 0.6 },
  { label: 'Whoosh', synth: { preset: 'whoosh' }, duration: 1.2, volume: 0.8 }, { label: 'Impact', synth: { preset: 'impact' }, duration: 1.2, volume: 0.9 }, { label: 'Click', synth: { preset: 'click' }, duration: 0.2, volume: 0.8 },
  { label: 'Tone', synth: { preset: 'tone', note: 'A3' }, duration: 2, volume: 0.4 },
];

export interface MediaActions {
  importFiles: (files: FileList) => void;
  addAsset: (id: string) => void;
  addOps: (ops: Op[], label: string) => void;
  applyToSelected: (ops: (clip: Clip) => Op[], label: string) => void;
  playhead: () => number;
}

export function MediaPanel({ project, tab, setTab, selected, actions }: { project: Project; tab: MediaTab; setTab: (t: MediaTab) => void; selected: Clip | null; actions: MediaActions }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [captionText, setCaptionText] = useState('');
  const [captionStyle, setCaptionStyle] = useState('caption');
  const [transitionLen, setTransitionLen] = useState(0.5);
  const at = (): number => Math.round(actions.playhead() * 10) / 10;
  const needClip = !selected ? <p className="ve-note ve-pad">Select a clip on the timeline, then pick one to apply it.</p> : null;
  const onFiles = (e: ChangeEvent<HTMLInputElement>): void => { if (e.target.files?.length) actions.importFiles(e.target.files); e.target.value = ''; };
  const upload = (
    <>
      <input ref={fileRef} type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={onFiles} aria-label="Import media files" />
      <button type="button" className="ve-btn ve-btn--primary ve-import" onClick={() => fileRef.current?.click()}><Upload size={13} /> Import media</button>
    </>
  );
  return (
    <aside className="ve__media" aria-label="Media library">
      <div className="ve-tabs" role="tablist" aria-label="Library">
        {MEDIA_TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`ve-tab${tab === id ? ' ve-tab--on' : ''}`} onClick={() => setTab(id)}><Icon size={14} /><span>{label}</span></button>
        ))}
      </div>
      <div className="ve__media-body">
        {tab === 'media' && (
          <div className="ve-pad">
            {upload}
            <p className="ve-note">Footage, photos and audio are copied into <code>.pigry/videos/media</code> of this workspace, so the project and the AI agent can use them.</p>
            {project.assets.length === 0 && <p className="ve-note">No media yet. You can also build a whole video from text, shapes, stickers and generated sound.</p>}
            <ul className="ve-assets" aria-label="Project media">
              {project.assets.map((a) => (
                <li key={a.id} className="ve-asset">
                  <span className="ve-asset__icon">{a.kind === 'video' ? <Film size={14} /> : a.kind === 'audio' ? <Music size={14} /> : <ImageIcon size={14} />}</span>
                  <span className="ve-asset__name" title={a.path}>{a.name}<small>{a.kind}{a.duration ? ` · ${a.duration.toFixed(1)}s` : ''}{a.width ? ` · ${a.width}×${a.height}` : ''}</small></span>
                  <button type="button" className="ve-icon" aria-label={`Add ${a.name} to the timeline`} title="Add to the timeline" onClick={() => actions.addAsset(a.id)}><PlusCircle size={15} /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {tab === 'audio' && (
          <div className="ve-pad">
            {upload}
            <h3 className="ve-h">Generated music &amp; sound effects</h3>
            <div className="ve-grid ve-grid--2">
              {AUDIO_PRESETS.map((p) => (
                <button key={p.label} type="button" className="ve-card" onClick={() => actions.addOps([{ op: 'clip_add', kind: 'synth', start: at(), duration: p.duration, synth: p.synth, volume: p.volume, name: p.label }], `Add ${p.label}`)}><Music size={14} /> {p.label}</button>
              ))}
            </div>
            <p className="ve-note">Synthesised in the browser — nothing to download. Add your own tracks with Import.</p>
          </div>
        )}
        {tab === 'text' && (
          <div className="ve-pad">
            <button type="button" className="ve-btn ve-btn--primary ve-import" onClick={() => actions.addOps([{ op: 'clip_add', kind: 'text', start: at(), duration: 3, text: 'Your text', style: 'title' }], 'Add text')}><Type size={13} /> Add text</button>
            <h3 className="ve-h">Text styles</h3>
            <div className="ve-grid ve-grid--2">
              {Object.entries(TEXT_STYLES).map(([id, s]) => (
                <button key={id} type="button" className={`ve-card ve-card--text ve-style--${id}`} onClick={() => actions.addOps([{ op: 'clip_add', kind: 'text', start: at(), duration: 3, text: s.label, style: id }], `Add ${s.label}`)}>{s.label}</button>
              ))}
            </div>
          </div>
        )}
        {tab === 'stickers' && (
          <div className="ve-pad">
            <h3 className="ve-h">Stickers</h3>
            <div className="ve-grid ve-grid--6">
              {STICKERS.map((s) => <button key={s} type="button" className="ve-emoji" aria-label={`Sticker ${s}`} onClick={() => actions.addOps([{ op: 'clip_add', kind: 'sticker', sticker: s, start: at(), duration: 3, scale: 1.6 }, { op: 'anim_set', clip: 'last', which: 'in', type: 'pop', duration: 0.4 }], `Add sticker ${s}`)}>{s}</button>)}
            </div>
            <h3 className="ve-h">Shapes</h3>
            <div className="ve-grid ve-grid--3">
              {SHAPES.filter((s) => s !== 'line').map((s) => <button key={s} type="button" className="ve-card" onClick={() => actions.addOps([{ op: 'clip_add', kind: 'shape', start: at(), duration: 3, shape: { shape: s, w: 0.3, h: s === 'ellipse' || s === 'rect' ? 0.2 : 0.3, color: '#ffd166' } }], `Add ${s}`)}>{s}</button>)}
            </div>
            <h3 className="ve-h">Backgrounds</h3>
            <div className="ve-grid ve-grid--2">
              {BACKGROUNDS.map(([name, a, b, angle]) => (
                <button key={name} type="button" className="ve-card ve-bg" style={{ background: `linear-gradient(${angle}deg, ${a}, ${b})` }} onClick={() => actions.addOps([{ op: 'clip_add', kind: 'shape', track: 't1', start: at(), duration: 4, shape: { shape: 'rect', w: 1, h: 1, color: a, color2: b, angle }, name }], `Add ${name} background`)}>{name}</button>
              ))}
            </div>
          </div>
        )}
        {tab === 'effects' && (
          <div className="ve-pad">
            {needClip}
            <div className="ve-grid ve-grid--2">
              {Object.entries(EFFECTS).map(([id, label]) => (
                <button key={id} type="button" disabled={!selected} className={`ve-card${selected?.effect === id ? ' ve-card--on' : ''}`} onClick={() => actions.applyToSelected(() => [{ op: 'clip_set', clip: selected!.id, effect: id }], `Effect ${label}`)}><Sparkles size={13} /> {label}</button>
              ))}
            </div>
          </div>
        )}
        {tab === 'transitions' && (
          <div className="ve-pad">
            {needClip}
            <label className="ve-field">Length {transitionLen.toFixed(1)}s<input type="range" min={0.2} max={2} step={0.1} value={transitionLen} onChange={(e) => setTransitionLen(Number(e.target.value))} aria-label="Transition length" /></label>
            <p className="ve-note">A transition plays at the start of the selected clip, over the cut from the clip before it on the same track.</p>
            <div className="ve-grid ve-grid--2">
              <button type="button" disabled={!selected} className={`ve-card${selected && !selected.transitionIn ? ' ve-card--on' : ''}`} onClick={() => actions.applyToSelected(() => [{ op: 'transition_set', clip: selected!.id, type: 'none' }], 'Remove transition')}><X size={13} /> None</button>
              {Object.entries(TRANSITIONS).map(([id, label]) => (
                <button key={id} type="button" disabled={!selected} className={`ve-card${selected?.transitionIn?.type === id ? ' ve-card--on' : ''}`} onClick={() => actions.applyToSelected(() => [{ op: 'transition_set', clip: selected!.id, type: id, duration: transitionLen }], `Transition ${label}`)}><Layers size={13} /> {label}</button>
              ))}
            </div>
          </div>
        )}
        {tab === 'filters' && (
          <div className="ve-pad">
            {needClip}
            <div className="ve-grid ve-grid--3">
              {Object.entries(FILTERS).map(([id, f]) => (
                <button key={id} type="button" disabled={!selected} className={`ve-filter${selected?.filter === id ? ' ve-filter--on' : ''}`} onClick={() => actions.applyToSelected(() => [{ op: 'clip_set', clip: selected!.id, filter: id }], `Filter ${f.label}`)}>
                  <span className="ve-filter__swatch" style={{ filter: `brightness(${f.brightness}) contrast(${f.contrast}) saturate(${f.saturate}) hue-rotate(${f.hue}deg) sepia(${f.sepia}) grayscale(${f.gray})` }} />
                  <span>{f.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'captions' && (
          <div className="ve-pad">
            <p className="ve-note">Paste a script. It is split into captions that fit the screen (about {project.height > project.width ? '24' : '42'} characters per line) and timed to a comfortable reading speed.</p>
            <label className="ve-field">Script<textarea className="ve-input ve-area" rows={6} value={captionText} onChange={(e) => setCaptionText(e.target.value)} aria-label="Caption script" placeholder="Type or paste what is said in the video…" /></label>
            <label className="ve-field">Style<select className="ve-select" value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)} aria-label="Caption style">{Object.entries(TEXT_STYLES).map(([id, s]) => <option key={id} value={id}>{s.label}</option>)}</select></label>
            <button type="button" className="ve-btn ve-btn--primary ve-import" disabled={!captionText.trim()} onClick={() => { actions.addOps([{ op: 'captions', text: captionText, start: at(), style: captionStyle }], 'Generate captions'); setCaptionText(''); }}><Captions size={13} /> Generate captions at the playhead</button>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- inspector */

const FIELD_NUM = 've-input ve-num';
export function Num({ label, value, onChange, min, max, step = 1, unit }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string }) {
  return (
    <label className="ve-row"><span className="ve-row__label">{label}</span>
      <span className="ve-row__ctl"><input className={FIELD_NUM} type="number" aria-label={label} value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0} min={min} max={max} step={step} onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) onChange(n); }} />{unit && <small>{unit}</small>}</span>
    </label>
  );
}
function Slider({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return (
    <label className="ve-row"><span className="ve-row__label">{label}</span>
      <span className="ve-row__ctl"><input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /><output>{Math.round(value * 100) / 100}</output></span>
    </label>
  );
}
function Pick({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  return (
    <label className="ve-row"><span className="ve-row__label">{label}</span>
      <span className="ve-row__ctl"><select className="ve-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></span>
    </label>
  );
}
function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return <label className="ve-row"><span className="ve-row__label">{label}</span><span className="ve-row__ctl"><input type="checkbox" aria-label={label} checked={value} onChange={(e) => onChange(e.target.checked)} /></span></label>;
}
function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="ve-sec"><h3>{title}</h3>{children}</section>; }
const colorOf = (c: string): string => (/^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : '#000000');
function Color({ label, value, onChange, allowNone }: { label: string; value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <label className="ve-row"><span className="ve-row__label">{label}</span>
      <span className="ve-row__ctl"><input type="color" className="ve-color" aria-label={label} value={colorOf(value)} onChange={(e) => onChange(e.target.value)} />{allowNone && <button type="button" className="ve-chip" disabled={!value} onClick={() => onChange('')}>none</button>}</span>
    </label>
  );
}

const KEY_PROPS: Array<{ prop: AnimProp; label: string; visual: boolean; sound: boolean; scale: number }> = [
  { prop: 'x', label: 'Position X', visual: true, sound: false, scale: 100 }, { prop: 'y', label: 'Position Y', visual: true, sound: false, scale: 100 }, { prop: 'scale', label: 'Scale', visual: true, sound: false, scale: 100 },
  { prop: 'rotation', label: 'Rotation', visual: true, sound: false, scale: 1 }, { prop: 'opacity', label: 'Opacity', visual: true, sound: false, scale: 100 }, { prop: 'volume', label: 'Volume', visual: false, sound: true, scale: 100 },
];

export function Inspector({ project, clip, timeStore, run }: { project: Project; clip: Clip | null; timeStore: TimeStore; run: (ops: Op[], label: string, merge?: string) => void }) {
  const [keyEase, setKeyEase] = useState<EaseId>('ease-in-out');
  const time = useTime(timeStore);
  if (!clip) return <ProjectPanel project={project} run={run} />;
  const visual = clip.kind !== 'audio' && clip.kind !== 'synth';
  const sound = clip.kind === 'video' || clip.kind === 'audio' || clip.kind === 'synth';
  const media = clip.kind === 'video' || clip.kind === 'image';
  const set = (props: Record<string, unknown>): void => run([{ op: 'clip_set', clip: clip.id, ...props }], 'Edit clip', `${clip.id}:${Object.keys(props).join(',')}`);
  const patch = (key: 'text' | 'shape' | 'synth', props: Record<string, unknown>): void => set({ [key]: props });
  const adj = (key: keyof Adjust, v: number): void => set({ adjust: { [key]: v } });
  const local = Math.min(clip.duration, Math.max(0, time - clip.start));
  const currentValue = (prop: AnimProp): number => keyframeValue(clip.keyframes[prop], local, ({ x: clip.x, y: clip.y, scale: clip.scale, rotation: clip.rotation, opacity: clip.opacity, volume: clip.volume } as Record<AnimProp, number>)[prop]);
  const asset = clip.asset ? project.assets.find((a) => a.id === clip.asset) : undefined;
  return (
    <div className="ve-inspector" aria-label="Clip properties">
      <div className="ve-insp-head">
        <input className="ve-input" aria-label="Clip name" value={clip.name} placeholder={`${clip.kind} ${clip.id}`} onChange={(e) => set({ name: e.target.value })} />
        <span className="ve-type">{clip.kind}</span>
      </div>
      {asset && <p className="ve-note ve-pad">{asset.name}</p>}

      {clip.kind === 'text' && clip.text && (
        <Section title="Text">
          <textarea className="ve-input ve-area" rows={3} aria-label="Text content" value={clip.text.text} onChange={(e) => patch('text', { text: e.target.value })} />
          <Pick label="Font" value={clip.text.font} options={FONTS.map((f) => [f, f])} onChange={(v) => patch('text', { font: v })} />
          <Num label="Size" value={clip.text.size} min={1} max={40} step={0.5} unit="% height" onChange={(v) => patch('text', { size: v })} />
          <Color label="Colour" value={clip.text.color} onChange={(v) => patch('text', { color: v })} />
          <div className="ve-chips">
            <button type="button" className={`ve-chip${clip.text.bold ? ' ve-chip--on' : ''}`} aria-pressed={clip.text.bold} onClick={() => patch('text', { bold: !clip.text!.bold })}><b>B</b></button>
            <button type="button" className={`ve-chip${clip.text.italic ? ' ve-chip--on' : ''}`} aria-pressed={clip.text.italic} onClick={() => patch('text', { italic: !clip.text!.italic })}><i>I</i></button>
            {(['left', 'center', 'right'] as const).map((a) => <button key={a} type="button" className={`ve-chip${clip.text!.align === a ? ' ve-chip--on' : ''}`} aria-pressed={clip.text!.align === a} onClick={() => patch('text', { align: a })}>{a}</button>)}
            <button type="button" className={`ve-chip${clip.text.shadow ? ' ve-chip--on' : ''}`} aria-pressed={clip.text.shadow} onClick={() => patch('text', { shadow: !clip.text!.shadow })}>shadow</button>
          </div>
          <Color label="Outline" value={clip.text.stroke} onChange={(v) => patch('text', { stroke: v, strokeWidth: clip.text!.strokeWidth || 6 })} allowNone />
          <Slider label="Outline width" value={clip.text.strokeWidth} min={0} max={20} onChange={(v) => patch('text', { strokeWidth: v })} />
          <Color label="Box" value={clip.text.bg} onChange={(v) => patch('text', { bg: v })} allowNone />
          <Slider label="Wrap width" value={clip.text.width} min={0.2} max={1} step={0.02} onChange={(v) => patch('text', { width: v })} />
        </Section>
      )}
      {clip.kind === 'shape' && clip.shape && (
        <Section title="Shape">
          <Pick label="Shape" value={clip.shape.shape} options={SHAPES.map((s) => [s, s])} onChange={(v) => patch('shape', { shape: v })} />
          <Color label="Colour" value={clip.shape.color} onChange={(v) => patch('shape', { color: v })} />
          <Color label="Gradient to" value={clip.shape.color2} onChange={(v) => patch('shape', { color2: v })} allowNone />
          <Num label="Gradient angle" value={clip.shape.angle} min={-360} max={360} unit="°" onChange={(v) => patch('shape', { angle: v })} />
          <Num label="Width" value={clip.shape.w * 100} min={1} max={500} unit="% canvas" onChange={(v) => patch('shape', { w: v / 100 })} />
          <Num label="Height" value={clip.shape.h * 100} min={1} max={500} unit="% canvas" onChange={(v) => patch('shape', { h: v / 100 })} />
          <Slider label="Corner radius" value={clip.shape.radius} min={0} max={0.5} step={0.01} onChange={(v) => patch('shape', { radius: v })} />
        </Section>
      )}
      {clip.kind === 'sticker' && (
        <Section title="Sticker"><label className="ve-row"><span className="ve-row__label">Emoji</span><span className="ve-row__ctl"><input className="ve-input" aria-label="Emoji" value={clip.sticker} maxLength={8} onChange={(e) => set({ sticker: e.target.value })} /></span></label></Section>
      )}
      {clip.kind === 'synth' && clip.synth && (
        <Section title="Generated sound">
          <Pick label="Sound" value={clip.synth.preset} options={SYNTH_PRESETS.map((s) => [s, s])} onChange={(v) => patch('synth', { preset: v })} />
          <label className="ve-row"><span className="ve-row__label">Note</span><span className="ve-row__ctl"><input className="ve-input" aria-label="Note" value={clip.synth.note} maxLength={3} onChange={(e) => { if (/^[A-Ga-g][#b]?[0-8]$/.test(e.target.value)) patch('synth', { note: e.target.value }); }} /></span></label>
          <Num label="Tempo" value={clip.synth.bpm} min={40} max={220} unit="bpm" onChange={(v) => patch('synth', { bpm: v })} />
          <Pick label="Scale" value={clip.synth.scale} options={[['major', 'major'], ['minor', 'minor']]} onChange={(v) => patch('synth', { scale: v })} />
          <Pick label="Wave" value={clip.synth.wave} options={[['sine', 'sine'], ['triangle', 'triangle'], ['square', 'square'], ['sawtooth', 'sawtooth']]} onChange={(v) => patch('synth', { wave: v })} />
        </Section>
      )}

      {visual && (
        <Section title="Basic">
          <Num label="Position X" value={clip.x * 100} step={1} unit="%" onChange={(v) => set({ x: v / 100 })} />
          <Num label="Position Y" value={clip.y * 100} step={1} unit="%" onChange={(v) => set({ y: v / 100 })} />
          <Num label="Scale" value={clip.scale * 100} min={1} max={2000} unit="%" onChange={(v) => set({ scale: v / 100 })} />
          <Num label="Rotation" value={clip.rotation} unit="°" onChange={(v) => set({ rotation: v })} />
          <Slider label="Opacity" value={clip.opacity} min={0} max={1} step={0.01} onChange={(v) => set({ opacity: v })} />
          <div className="ve-chips">
            <button type="button" className={`ve-chip${clip.flipX ? ' ve-chip--on' : ''}`} aria-pressed={clip.flipX} onClick={() => set({ flipX: !clip.flipX })}>Flip ↔</button>
            <button type="button" className={`ve-chip${clip.flipY ? ' ve-chip--on' : ''}`} aria-pressed={clip.flipY} onClick={() => set({ flipY: !clip.flipY })}>Flip ↕</button>
          </div>
          {media && <Pick label="Fit" value={clip.fit} options={[['contain', 'Fit (letterbox)'], ['cover', 'Fill (crop)']]} onChange={(v) => set({ fit: v })} />}
          <Pick label="Blend" value={clip.blend} options={Object.keys(BLENDS).map((b) => [b, b])} onChange={(v) => set({ blend: v })} />
        </Section>
      )}

      <Section title="Timing">
        <Num label="Start" value={clip.start} min={0} step={0.1} unit="s" onChange={(v) => run([{ op: 'clip_move', clip: clip.id, start: v }], 'Move clip', `${clip.id}:start`)} />
        <Num label="Duration" value={clip.duration} min={0.1} step={0.1} unit="s" onChange={(v) => set({ duration: v })} />
        {(clip.kind === 'video' || clip.kind === 'audio') && <Num label="Speed" value={clip.speed} min={0.1} max={8} step={0.1} unit="×" onChange={(v) => set({ speed: v })} />}
        {(clip.kind === 'video' || clip.kind === 'audio') && <Num label="Source start" value={clip.offset} min={0} step={0.1} unit="s" onChange={(v) => set({ offset: v })} />}
      </Section>

      {sound && (
        <Section title="Audio">
          <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.05} onChange={(v) => set({ volume: v })} />
          <Slider label="Fade in" value={clip.fadeIn} min={0} max={5} step={0.1} onChange={(v) => set({ fadeIn: v })} />
          <Slider label="Fade out" value={clip.fadeOut} min={0} max={5} step={0.1} onChange={(v) => set({ fadeOut: v })} />
          <Check label="Mute" value={clip.muted} onChange={(v) => set({ muted: v })} />
        </Section>
      )}
      {visual && (clip.kind === 'text' || clip.kind === 'shape' || clip.kind === 'sticker') && (
        <Section title="Fade">
          <Slider label="Fade in" value={clip.fadeIn} min={0} max={5} step={0.1} onChange={(v) => set({ fadeIn: v })} />
          <Slider label="Fade out" value={clip.fadeOut} min={0} max={5} step={0.1} onChange={(v) => set({ fadeOut: v })} />
        </Section>
      )}

      {visual && (
        <Section title="Filter & adjust">
          <Pick label="Filter" value={clip.filter} options={Object.entries(FILTERS).map(([id, f]) => [id, f.label])} onChange={(v) => set({ filter: v })} />
          {(Object.keys(ADJUST_RANGES) as Array<keyof Adjust>).map((k) => <Slider key={k} label={k[0].toUpperCase() + k.slice(1)} value={clip.adjust[k]} min={ADJUST_RANGES[k][0]} max={ADJUST_RANGES[k][1]} onChange={(v) => adj(k, v)} />)}
          <Pick label="Effect" value={clip.effect} options={Object.entries(EFFECTS)} onChange={(v) => set({ effect: v })} />
          {clip.effect !== 'none' && <Slider label="Effect amount" value={clip.effectAmount} min={0} max={1} step={0.05} onChange={(v) => set({ effectAmount: v })} />}
        </Section>
      )}

      {visual && (
        <Section title="Animation & transition">
          {(['in', 'out'] as const).map((which) => {
            const cur = which === 'in' ? clip.animIn : clip.animOut;
            return (
              <div key={which} className="ve-anim">
                <Pick label={`Animation ${which}`} value={cur?.type ?? 'none'} options={[['none', 'None'], ...Object.entries(ANIMATIONS).filter(([id]) => id !== 'typewriter' || clip.kind === 'text')]} onChange={(v) => run([{ op: 'anim_set', clip: clip.id, which, type: v, duration: cur?.duration ?? 0.5 }], 'Animation')} />
                {cur && <Num label={`${which === 'in' ? 'In' : 'Out'} length`} value={cur.duration} min={0.1} max={5} step={0.1} unit="s" onChange={(v) => run([{ op: 'anim_set', clip: clip.id, which, type: cur.type, duration: v }], 'Animation length', `${clip.id}:anim${which}`)} />}
              </div>
            );
          })}
          <Pick label="Transition in" value={clip.transitionIn?.type ?? 'none'} options={[['none', 'None'], ...Object.entries(TRANSITIONS)]} onChange={(v) => run([{ op: 'transition_set', clip: clip.id, type: v, duration: clip.transitionIn?.duration ?? 0.5 }], 'Transition')} />
          {clip.transitionIn && <Num label="Transition length" value={clip.transitionIn.duration} min={0.1} max={5} step={0.1} unit="s" onChange={(v) => run([{ op: 'transition_set', clip: clip.id, type: clip.transitionIn!.type, duration: v }], 'Transition length', `${clip.id}:trans`)} />}
        </Section>
      )}

      <Section title="Keyframes">
        <p className="ve-note">Move the playhead inside the clip, set a value, then add a keyframe — the value animates between keyframes.</p>
        <Pick label="Easing" value={keyEase} options={EASES.map((e) => [e, e])} onChange={(v) => setKeyEase(v as EaseId)} />
        {KEY_PROPS.filter((k) => (k.visual && visual) || (k.sound && sound)).map(({ prop, label, scale }) => {
          const frames = clip.keyframes[prop] ?? [];
          return (
            <div key={prop} className="ve-key">
              <span className="ve-key__label">{label}</span>
              <button type="button" className="ve-chip" aria-label={`Add ${label} keyframe`} title={`Keyframe ${label} = ${Math.round(currentValue(prop) * scale * 100) / 100} at ${local.toFixed(1)}s`} onClick={() => run([{ op: 'keyframe_set', clip: clip.id, prop, t: Math.round(local * 100) / 100, v: currentValue(prop), ease: keyEase }], `Keyframe ${label}`)}><Diamond size={10} /> add</button>
              {frames.length > 0 && <button type="button" className="ve-chip" aria-label={`Clear ${label} keyframes`} onClick={() => run([{ op: 'keyframe_clear', clip: clip.id, prop }], `Clear ${label} keyframes`)}>clear</button>}
              <span className="ve-key__list">{frames.map((f) => <button key={f.t} type="button" className="ve-kf" title={`${label} ${Math.round(f.v * scale * 100) / 100} at ${f.t}s — click to remove`} onClick={() => run([{ op: 'keyframe_clear', clip: clip.id, prop, t: f.t }], 'Remove keyframe')}>◆ {f.t}s</button>)}</span>
            </div>
          );
        })}
        {clip.kind === 'image' && <button type="button" className="ve-btn" onClick={() => run([{ op: 'kenburns', clip: clip.id, from: 1, to: 1.2, dx: 0.04 }], 'Ken Burns')}><Scissors size={12} /> Ken Burns zoom</button>}
      </Section>
    </div>
  );
}

export function ProjectPanel({ project, run }: { project: Project; run: (ops: Op[], label: string, merge?: string) => void }) {
  const warnings = checkProject(project);
  const aspect = Object.entries(ASPECTS).find(([, a]) => a.w === project.width && a.h === project.height)?.[0] ?? 'custom';
  return (
    <div className="ve-inspector" aria-label="Project settings">
      <div className="ve-insp-head"><strong>Project</strong><span className="ve-type">{projectDuration(project).toFixed(1)}s</span></div>
      <Section title="Canvas">
        <label className="ve-row"><span className="ve-row__label">Title</span><span className="ve-row__ctl"><input className="ve-input" aria-label="Project title" value={project.title} onChange={(e) => run([{ op: 'project', title: e.target.value }], 'Rename project', 'project:title')} /></span></label>
        <Pick label="Ratio" value={aspect} options={[...Object.entries(ASPECTS).map(([k, a]): [string, string] => [k, `${k} · ${a.label}`]), ['custom', `${project.width}×${project.height}`]]} onChange={(v) => { if (v !== 'custom') run([{ op: 'project', aspect: v }], `Ratio ${v}`); }} />
        <Pick label="Frame rate" value={String(project.fps)} options={[['24', '24 fps'], ['25', '25 fps'], ['30', '30 fps'], ['60', '60 fps']]} onChange={(v) => run([{ op: 'project', fps: Number(v) }], 'Frame rate')} />
        <Color label="Background" value={project.background} onChange={(v) => run([{ op: 'project', background: v }], 'Background', 'project:bg')} />
      </Section>
      <Section title="Review">
        {warnings.length === 0 ? <p className="ve-note">Nothing to flag.</p> : <ul className="ve-warn" aria-label="Review warnings">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      </Section>
      <p className="ve-note ve-pad">Select a clip on the timeline to edit it.</p>
    </div>
  );
}
