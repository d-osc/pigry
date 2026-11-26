import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, X } from 'lucide-react';
import { animSteps, hiddenAt, slideTitle, type Deck } from './slides';
import { MOTION_CSS, SLIDE_CSS, slideHtml, stepAnimations } from './slidesRender';

interface Nav { index: number; step: number; forward: boolean; ended: boolean }
type Act = { t: 'next'; steps: number[] } | { t: 'prev'; steps: number[] } | { t: 'go'; index: number; steps: number[]; end?: boolean };
function nav(s: Nav, a: Act): Nav {
  const last = a.steps.length - 1;
  if (a.t === 'go') { const i = Math.max(0, Math.min(last, a.index)); return { index: i, step: a.end ? a.steps[i] - 1 : 0, forward: !a.end, ended: false }; }
  if (a.t === 'next') {
    if (s.ended) return s;
    if (s.step < a.steps[s.index] - 1) return { ...s, step: s.step + 1, forward: true };
    if (s.index < last) return { index: s.index + 1, step: 0, forward: true, ended: false };
    return { ...s, ended: true };
  }
  if (s.ended) return { ...s, ended: false };
  if (s.step > 0) return { ...s, step: s.step - 1, forward: false };
  if (s.index > 0) return { index: s.index - 1, step: a.steps[s.index - 1] - 1, forward: false, ended: false };
  return s;
}
const clock = (sec: number): string => `${Math.floor(sec / 3600) ? `${Math.floor(sec / 3600)}:` : ''}${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

/** A slide drawn to fit a box (transitions and animations replay when key changes). */
function Stage({ deck, index, step, forward, width, height, label }: { deck: Deck; index: number; step: number; forward: boolean; width: number; height: number; label: string }) {
  const slides = deck.slides.filter((s) => !s.hidden);
  const slide = slides[index];
  const k = Math.min(width / deck.size.w, height / deck.size.h);
  const html = useMemo(() => (slide ? slideHtml(deck, slide, { hidden: hiddenAt(slide, step), animate: forward ? stepAnimations(slide, step) : undefined }) : ''), [deck, slide, step, forward]);
  if (!slide) return null;
  const tr = slide.transition && forward && step === 0 ? `sld-t-${slide.transition.type} ${slide.transition.duration}s ease both` : undefined;
  return (
    <div className="sl-pstage" style={{ width: deck.size.w * k, height: deck.size.h * k }} aria-label={label} role="img">
      <div style={{ width: deck.size.w, height: deck.size.h, transform: `scale(${k})`, transformOrigin: '0 0' }}>
        <div key={`${index}:${step}:${forward ? 1 : 0}`} className="sl-stage__slide" style={{ animation: tr }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

export function SlidesPresent({ deck, start, presenter: startPresenter, onExit }: { deck: Deck; start: number; presenter?: boolean; onExit: (index: number) => void }) {
  const shown = useMemo(() => deck.slides.map((s, i) => ({ s, i })).filter((x) => !x.s.hidden), [deck]);
  const steps = useMemo(() => shown.map((x) => animSteps(x.s).length), [shown]);
  const first = Math.max(0, shown.findIndex((x) => x.i >= start));
  const [state, dispatch] = useReducer(nav, { index: first, step: 0, forward: true, ended: false });
  const [presenter, setPresenter] = useState(!!startPresenter);
  const [cover, setCover] = useState<'black' | 'white' | null>(null);
  const [laser, setLaser] = useState(false);
  const [pointer, setPointer] = useState({ x: -100, y: -100 });
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [notesSize, setNotesSize] = useState(18);
  const root = useRef<HTMLDivElement | null>(null);
  const typed = useRef('');
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    const el = root.current;
    el?.focus();
    el?.requestFullscreen?.().catch(() => undefined);
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); };
  }, []);
  useEffect(() => {
    if (paused) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [paused]);

  const exit = () => onExit(shown[stateRef.current.index]?.i ?? start);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (/^[0-9]$/.test(k)) { typed.current += k; return; }
      if (k === 'Enter' && typed.current) { dispatch({ t: 'go', index: Number(typed.current) - 1, steps }); typed.current = ''; e.preventDefault(); return; }
      typed.current = '';
      if (k === 'Escape') { e.preventDefault(); exit(); return; }
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) { e.preventDefault(); if (stateRef.current.ended) { exit(); return; } dispatch({ t: 'next', steps }); setCover(null); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k)) { e.preventDefault(); dispatch({ t: 'prev', steps }); setCover(null); }
      else if (k === 'Home') dispatch({ t: 'go', index: 0, steps });
      else if (k === 'End') dispatch({ t: 'go', index: steps.length - 1, steps, end: true });
      else if (k === 'l' || k === 'L') setLaser((v) => !v);
      else if (k === 'b' || k === 'B' || k === '.') setCover((c) => (c === 'black' ? null : 'black'));
      else if (k === 'w' || k === 'W' || k === ',') setCover((c) => (c === 'white' ? null : 'white'));
      else if (k === 's' || k === 'S') setPresenter((v) => !v);
      else if ((k === 'f' || k === 'F') && e.ctrlKey && e.shiftKey) { if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.(); }
      else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  const cur = shown[state.index];
  const next = shown[state.index + 1];
  const curSteps = steps[state.index] ?? 1;
  const clickNext = () => { if (state.ended) exit(); else dispatch({ t: 'next', steps }); };
  const label = `Slide ${state.index + 1} of ${shown.length}`;

  if (!shown.length) {
    return <div className="sl-present" role="dialog" aria-label="Presentation" tabIndex={-1} ref={root} onClick={exit}><div className="sl-present__end">Every slide is skipped. Click to exit.</div></div>;
  }
  return (
    <div ref={root} className={`sl-present${laser ? ' sl-present--laser' : ''}${presenter ? ' sl-present--presenter' : ''}`} role="dialog" aria-label="Presentation" tabIndex={-1}
      onPointerMove={(e) => { if (laser) setPointer({ x: e.clientX, y: e.clientY }); }}>
      <style>{SLIDE_CSS}{MOTION_CSS}</style>
      {presenter ? (
        <div className="sl-presenter" aria-label="Presenter view">
          <div className="sl-presenter__main" onClick={clickNext}>
            {state.ended ? <div className="sl-present__end">End of slide show. Click or press → to exit.</div>
              : <Stage deck={deck} index={state.index} step={state.step} forward={state.forward} width={size.w * 0.62} height={size.h - 140} label={label} />}
          </div>
          <aside className="sl-presenter__side">
            <div className="sl-presenter__row">
              <span className="sl-presenter__timer" data-testid="presenter-timer" aria-label="Elapsed time">{clock(elapsed)}</span>
              <button type="button" className="sl-pbtn" aria-label={paused ? 'Resume timer' : 'Pause timer'} onClick={() => setPaused((p) => !p)}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
              <button type="button" className="sl-pbtn" aria-label="Reset timer" onClick={() => setElapsed(0)}><RotateCcw size={14} /></button>
              <span className="dc-grow" />
              <span data-testid="presenter-count">{label}{curSteps > 1 ? ` · step ${state.step + 1}/${curSteps}` : ''}</span>
            </div>
            <div className="sl-presenter__next">
              <span>Next</span>
              {next ? <Stage deck={deck} index={state.index + 1} step={0} forward={false} width={size.w * 0.3} height={size.h * 0.26} label={`Next slide: ${slideTitle(next.s) || state.index + 2}`} /> : <div className="sl-presenter__none">End of presentation</div>}
            </div>
            <div className="sl-presenter__notes-head"><span>Speaker notes</span><button type="button" className="sl-pbtn" aria-label="Smaller notes" onClick={() => setNotesSize((n) => Math.max(10, n - 2))}>A−</button><button type="button" className="sl-pbtn" aria-label="Larger notes" onClick={() => setNotesSize((n) => Math.min(40, n + 2))}>A+</button></div>
            <div className="sl-presenter__notes" data-testid="presenter-notes" style={{ fontSize: notesSize }}>{cur?.s.notes.trim() || 'No speaker notes for this slide.'}</div>
          </aside>
        </div>
      ) : (
        <div className="sl-present__main" onClick={clickNext}>
          {state.ended ? <div className="sl-present__end">End of slide show. Click or press → to exit.</div>
            : <Stage deck={deck} index={state.index} step={state.step} forward={state.forward} width={size.w} height={size.h} label={label} />}
        </div>
      )}
      <div className="sl-present__bar" role="toolbar" aria-label="Presentation controls">
        <button type="button" className="sl-pbtn" aria-label="Previous" onClick={() => dispatch({ t: 'prev', steps })}><ChevronLeft size={16} /></button>
        <span className="sl-present__count" data-testid="present-count">{state.index + 1} / {shown.length}</span>
        <button type="button" className="sl-pbtn" aria-label="Next" onClick={clickNext}><ChevronRight size={16} /></button>
        <button type="button" className={`sl-pbtn${laser ? ' sl-pbtn--on' : ''}`} aria-pressed={laser} aria-label="Laser pointer" title="Laser pointer (L)" onClick={() => setLaser((v) => !v)}>●</button>
        <button type="button" className={`sl-pbtn${presenter ? ' sl-pbtn--on' : ''}`} aria-pressed={presenter} aria-label="Presenter view" title="Presenter view (S)" onClick={() => setPresenter((v) => !v)}>▤</button>
        <button type="button" className="sl-pbtn" aria-label="Exit presentation" title="Exit (Esc)" onClick={exit}><X size={16} /></button>
      </div>
      {cover && <div className={`sl-present__cover sl-present__cover--${cover}`} data-testid="present-cover" onClick={() => setCover(null)} />}
      {laser && <div className="sl-laser" data-testid="laser" style={{ left: pointer.x, top: pointer.y }} />}
    </div>
  );
}
