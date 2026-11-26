/** Templates, Markdown outline ⇄ slides, plain-text outline and the self-contained HTML presentation. Pure — node tests import it. */
import {
  addSlide, animSteps, emptyDeck, hasText, hiddenAt, newId, para, parasText, parasToText, slideTitle, textToParas,
  type ChartEl, type Deck, type El, type ImageEl, type LayoutId, type ShapeEl, type Slide, type TableEl, type TextEl,
} from './slides.ts';
import { MOTION_CSS, SLIDE_CSS, esc, slideHtml, stepAnimations } from './slidesRender.ts';

/* ---------------- templates ---------------- */

export type TemplateId = 'blank' | 'pitch' | 'update' | 'lesson';
export const TEMPLATES: { id: TemplateId; label: string; theme: string; hint: string }[] = [
  { id: 'blank', label: 'Blank', theme: 'simple-light', hint: 'One title slide on the Simple Light theme.' },
  { id: 'pitch', label: 'Pitch deck', theme: 'focus', hint: 'Ten slides: problem, solution, market, product, business model, traction, competition, team and the ask.' },
  { id: 'update', label: 'Project update', theme: 'simple-light', hint: 'Status at a glance, progress chart, milestones table, risks and next steps.' },
  { id: 'lesson', label: 'Lesson', theme: 'coral', hint: 'Objectives, agenda, a concept, an example in two columns, an activity, a quick check and a recap.' },
];

function shape(deck: Deck, s: Slide, props: Partial<ShapeEl> & { x: number; y: number; w: number; h: number }): ShapeEl {
  const el: ShapeEl = { id: newId(deck, 'e'), type: 'shape', shape: 'roundRect', fill: '$surface', paras: [para()], ...props };
  s.elements.push(el);
  return el;
}
function text(deck: Deck, s: Slide, props: Partial<TextEl> & { x: number; y: number; w: number; h: number }, md: string): TextEl {
  const el: TextEl = { id: newId(deck, 'e'), type: 'text', ...props, paras: textToParas(md) };
  s.elements.push(el);
  return el;
}
const fade = (deck: Deck, s: Slide, el: El, start: 'click' | 'with' | 'after' = 'click') => { s.anims.push({ id: newId(deck, 'a'), el: el.id, effect: 'fade-in', start, duration: 0.5 }); };
const card = (deck: Deck, s: Slide, x: number, y: number, w: number, h: number, head: string, body: string, color = '$accent') => {
  shape(deck, s, { x, y, w, h, fill: '$surface', paras: [para()] });
  shape(deck, s, { x, y, w: 6, h, shape: 'rect', fill: color, paras: [para()] });
  text(deck, s, { x: x + 18, y: y + 12, w: w - 30, h: h - 24 }, `**${head}**\n${body}`);
};

/** A new presentation from a template. */
export function templateDeck(id: TemplateId, title: string, date = ''): Deck {
  const t = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0];
  const deck = emptyDeck(title, t.theme);
  if (id === 'blank') { addSlide(deck, 'title', undefined, { title }); return deck; }
  if (id === 'pitch') {
    addSlide(deck, 'title', undefined, { title, subtitle: 'One line that says what you do and for whom', notes: 'Introduce yourself and the company in one sentence. Say why you are here: the ask comes on the last slide.' });
    addSlide(deck, 'big-number', undefined, { number: '68%', body: 'of small teams still track this by hand — the problem in one number', notes: 'Tell one customer story that shows the pain. Use a real, sourced number.' });
    const sol = addSlide(deck, 'title-only', undefined, { title: 'We make it automatic in three steps' });
    ['Connect', 'Review', 'Done'].forEach((h, i) => { const el = shape(deck, sol, { x: 60 + i * 290, y: 190, w: 260, h: 220, fill: i === 1 ? '$accent' : '$surface', paras: textToParas(`**${i + 1}. ${h}**\nOne sentence about this step`) }); fade(deck, sol, el, i === 0 ? 'click' : 'after'); });
    const market = addSlide(deck, 'title-only', undefined, { title: 'A $4.2B market growing 18% a year' });
    [['TAM', '$4.2B', 360], ['SAM', '$900M', 250], ['SOM', '$60M', 140]].forEach(([l, v, d], i) => shape(deck, market, { x: 300 - Number(d) / 2, y: 480 - Number(d), w: Number(d), h: Number(d), shape: 'ellipse', fill: ['$surface', '$accent2', '$accent'][i], paras: i === 2 ? textToParas(`**${l}**\n${v}`) : [para()] }));
    text(deck, market, { x: 640, y: 170, w: 280, h: 240 }, '- **TAM** $4.2B — every team that does this\n- **SAM** $900M — teams we can reach\n- **SOM** $60M — our three-year target');
    const prod = addSlide(deck, 'two-columns', undefined, { title: 'The product', left: ['What the user sees first', 'The moment it saves time', 'Why it is hard to copy'] });
    const right = prod.elements.find((e) => e.name === 'Right column');
    if (right) { prod.elements = prod.elements.filter((e) => e !== right); shape(deck, prod, { x: right.x, y: right.y, w: right.w, h: right.h, fill: '$surface', paras: textToParas('Screenshot or demo here') }); }
    const biz = addSlide(deck, 'title-only', undefined, { title: 'Subscription per seat, paid back in five months' });
    card(deck, biz, 60, 160, 260, 160, 'Starter', '$12 per seat a month');
    card(deck, biz, 350, 160, 260, 160, 'Team', '$29 per seat a month', '$accent2');
    card(deck, biz, 640, 160, 260, 160, 'Enterprise', 'Annual contract', '$accent3');
    const tr = addSlide(deck, 'title-only', undefined, { title: 'Revenue tripled in the last six months' });
    tr.elements.push({ id: newId(deck, 'e'), type: 'chart', chart: 'column', x: 70, y: 140, w: 820, h: 340, labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ name: 'MRR ($k)', values: [14, 17, 22, 28, 35, 44] }], values: true, highlight: 5, legend: false } as ChartEl);
    const comp = addSlide(deck, 'title-only', undefined, { title: 'Only we are both simple and automatic' });
    comp.elements.push({ id: newId(deck, 'e'), type: 'table', x: 90, y: 150, w: 780, h: 260, header: true, size: 16, rows: [[{ text: '' }, { text: 'Us' }, { text: 'Spreadsheet' }, { text: 'Big suite' }], [{ text: 'Automatic', b: true }, { text: '✔' }, { text: '—' }, { text: '✔' }], [{ text: 'Set up in a day', b: true }, { text: '✔' }, { text: '✔' }, { text: '—' }], [{ text: 'Price per seat', b: true }, { text: '$12' }, { text: '$0' }, { text: '$45' }]].map((r) => r.map((c, ci) => ({ ...c, align: ci ? 'center' as const : 'left' as const }))) } as TableEl);
    const team = addSlide(deck, 'title-only', undefined, { title: 'A team that has built this before' });
    ['Name — CEO', 'Name — CTO', 'Name — Design'].forEach((n, i) => { shape(deck, team, { x: 130 + i * 260, y: 160, w: 140, h: 140, shape: 'ellipse', fill: '$surface', paras: [para()] }); text(deck, team, { x: 80 + i * 260, y: 315, w: 240, h: 80, paras: [] }, `**${n}**\nOne relevant fact`).paras.forEach((p) => { p.align = 'center'; }); });
    addSlide(deck, 'section', undefined, { title: 'Raising $1.5M to reach 1,000 teams', subtitle: '18 months of runway · hire 4 engineers · launch in two new markets', notes: 'Say exactly what the money buys and what milestone it reaches. Then stop and take questions.' });
    for (const s of deck.slides.slice(1)) s.transition = { type: 'fade', duration: 0.5 };
    return deck;
  }
  if (id === 'update') {
    addSlide(deck, 'title', undefined, { title, subtitle: date ? `Status update · ${date}` : 'Status update', notes: 'Who this is for and what you need from them today.' });
    const st = addSlide(deck, 'title-only', undefined, { title: 'On track for the March launch; one risk needs a decision' });
    [['Scope', 'On track', '$accent2'], ['Schedule', 'At risk', '$accent3'], ['Budget', 'On track', '$accent2']].forEach(([h, v, c], i) => card(deck, st, 60 + i * 290, 170, 260, 150, h, v, c));
    const pr = addSlide(deck, 'title-only', undefined, { title: '72% of the work is done' });
    pr.elements.push({ id: newId(deck, 'e'), type: 'chart', chart: 'bar', x: 80, y: 140, w: 800, h: 330, labels: ['Design', 'Backend', 'Mobile app', 'Testing'], series: [{ name: 'Done %', values: [100, 80, 65, 40] }], values: true, legend: false } as ChartEl);
    const ms = addSlide(deck, 'title-only', undefined, { title: 'Milestones' });
    ms.elements.push({ id: newId(deck, 'e'), type: 'table', x: 70, y: 140, w: 820, h: 300, header: true, band: true, size: 16, rows: [['Milestone', 'Owner', 'Due', 'Status'], ['Design sign-off', 'Ana', 'Jan 12', 'Done'], ['Beta release', 'Ben', 'Feb 20', 'In progress'], ['Launch', 'Chai', 'Mar 15', 'Not started']].map((r) => r.map((c) => ({ text: c }))) } as TableEl);
    addSlide(deck, 'two-columns', undefined, { title: 'Risks and what we are doing about them', left: ['**Risk:** test devices arrive late', '**Risk:** API limits in the beta'], right: ['**Plan:** use the cloud device lab', '**Plan:** ask the vendor for a higher quota'] });
    addSlide(deck, 'title-body', undefined, { title: 'Next steps', body: ['Decide on the device lab by Friday — Ana', 'Start the beta with 50 customers — Ben', 'Next update on Feb 1'] });
    return deck;
  }
  // lesson
  addSlide(deck, 'title', undefined, { title, subtitle: 'Lesson · 45 minutes' });
  addSlide(deck, 'title-body', undefined, { title: 'By the end of this lesson you can…', body: ['Explain the idea in your own words', 'Use it to solve a simple problem', 'Spot when it does not apply'], notes: 'Read the objectives aloud. Come back to them in the recap.' });
  addSlide(deck, 'title-body', undefined, { title: 'Agenda', body: ['1. Warm-up question (5 min)', '2. The big idea (15 min)', '3. Worked example (10 min)', '4. Your turn (10 min)', '5. Recap (5 min)'].map((x) => x.replace(/^\d\. /, '')) });
  const ag = deck.slides[2].elements.find((e): e is TextEl => e.type === 'text' && e.role === 'body');
  if (ag) for (const p of ag.paras) p.list = 'number';
  addSlide(deck, 'section', undefined, { title: 'The big idea', subtitle: 'One sentence that you want everyone to remember' });
  addSlide(deck, 'two-columns', undefined, { title: 'Worked example', left: ['Step 1: what we know', 'Step 2: what we try', 'Step 3: what we check'], right: ['Draw it, show it, or write the numbers here'] });
  const act = addSlide(deck, 'title-only', undefined, { title: 'Your turn: try it in pairs' });
  const timer = shape(deck, act, { x: 380, y: 170, w: 200, h: 200, shape: 'ellipse', fill: '$accent', paras: textToParas('**10 min**') });
  fade(deck, act, timer);
  text(deck, act, { x: 120, y: 400, w: 720, h: 60, paras: [] }, 'Instructions in one or two short sentences').paras.forEach((p) => { p.align = 'center'; });
  addSlide(deck, 'big-number', undefined, { number: '?', body: 'Quick check: one question to see who got it' });
  addSlide(deck, 'title-body', undefined, { title: 'Recap', body: ['The big idea in one line', 'Where you will use it next', 'Homework or next lesson'] });
  return deck;
}

/* ---------------- Markdown outline → slides ---------------- */

const IMG = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
/** Markdown outline → slides. "# " / "## " headings start slides (so does "---"); bullets and text become the body;
 * "> " lines and lines after "Notes:" become speaker notes; images and | tables | become elements. */
export function markdownToSlides(deck: Deck, markdown: string): Slide[] {
  const blocks: { level: number; title: string; lines: string[] }[] = [];
  let cur: { level: number; title: string; lines: string[] } | null = null;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) { cur = { level: h[1].length, title: h[2].trim(), lines: [] }; blocks.push(cur); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(raw)) { cur = null; continue; }
    if (!cur) { if (!raw.trim()) continue; cur = { level: 2, title: '', lines: [] }; blocks.push(cur); }
    cur.lines.push(raw);
  }
  const out: Slide[] = [];
  blocks.forEach((b, bi) => {
    const notes: string[] = [];
    const body: string[] = [];
    const images: { alt: string; src: string }[] = [];
    const table: string[][] = [];
    let inNotes = false;
    for (const line of b.lines) {
      if (/^\s*(notes?|speaker notes)\s*:/i.test(line)) { inNotes = true; const rest = line.replace(/^\s*(notes?|speaker notes)\s*:\s*/i, ''); if (rest) notes.push(rest); continue; }
      if (inNotes) { notes.push(line); continue; }
      if (/^\s*>\s?/.test(line)) { notes.push(line.replace(/^\s*>\s?/, '')); continue; }
      const im = IMG.exec(line.trim());
      if (im) { images.push({ alt: im[1], src: im[2] }); continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())); continue; }
      body.push(line);
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    const bodyText = body.join('\n');
    const bullets = body.some((l) => /^\s*([-*•]|\d+[.)])\s/.test(l));
    let layout: LayoutId;
    if (bi === 0 && b.level === 1 && !bullets && body.length <= 2 && !images.length && !table.length) layout = 'title';
    else if (!images.length && !table.length && b.title && /^[\d$€£฿.,%+-]+[kKmMbB%x×]?$/.test(b.title.trim())) layout = 'big-number';
    else if (!bodyText && !images.length && !table.length) layout = b.level === 1 || bi === 0 ? 'section' : 'title-only';
    else if (images.length || table.length) layout = 'title-only';
    else layout = 'title-body';
    const s = addSlide(deck, layout, undefined, layout === 'title' || layout === 'section' ? { title: b.title, subtitle: bodyText || undefined } : layout === 'big-number' ? { number: b.title.trim(), body: bodyText || undefined } : { title: b.title, body: bodyText || undefined });
    s.notes = notes.join('\n').trim();
    const W = deck.size.w, H = deck.size.h;
    const area = { x: Math.round(W * 0.06), y: Math.round(H * 0.26), w: Math.round(W * 0.88), h: Math.round(H * 0.64) };
    if (bodyText && (images.length || table.length)) {
      text(deck, s, { x: area.x, y: area.y, w: area.w * 0.46, h: area.h, role: 'body' }, bodyText);
      area.x += area.w * 0.52; area.w *= 0.48;
    }
    if (table.length) {
      const width = Math.max(...table.map((r) => r.length));
      s.elements.push({ id: newId(deck, 'e'), type: 'table', ...area, h: Math.min(area.h, 44 * table.length), header: true, size: 14, rows: table.map((r) => Array.from({ length: width }, (_, c) => ({ text: (r[c] ?? '').replace(/\*\*/g, '') }))) } as TableEl);
    } else images.forEach((im, k) => {
      const w = area.w / images.length;
      s.elements.push({ id: newId(deck, 'e'), type: 'image', src: im.src, alt: im.alt, fit: 'contain', x: area.x + k * w, y: area.y, w: w - 10, h: area.h } as ImageEl);
    });
    out.push(s);
  });
  return out;
}
/** A deck from a Markdown outline. */
export function markdownToDeck(markdown: string, title = 'Untitled presentation', theme = 'simple-light'): Deck {
  const deck = emptyDeck(title, theme);
  markdownToSlides(deck, markdown);
  if (!deck.slides.length) addSlide(deck, 'title', undefined, { title });
  const t = slideTitle(deck.slides[0]);
  if (t && title === 'Untitled presentation') deck.title = t;
  return deck;
}

/** Slides → Markdown outline (the inverse of markdownToSlides, as far as text goes). */
export function deckToMarkdown(deck: Deck): string {
  const out: string[] = [];
  deck.slides.forEach((s, i) => {
    if (i) out.push('---', '');
    const title = slideTitle(s);
    out.push(`${s.layout === 'title' || s.layout === 'section' ? '#' : '##'} ${title || `Slide ${i + 1}`}`, '');
    for (const e of s.elements) {
      if (e.type === 'text' && (e.role === 'title' || e.role === 'number') && parasText(e.paras).split('\n')[0].trim() === title) continue;
      if (hasText(e) && parasText(e.paras).trim()) out.push(parasToText(e.paras), '');
      if (e.type === 'table') { e.rows.forEach((r, ri) => { out.push(`| ${r.map((c) => c.text.replace(/\|/g, '\\|')).join(' | ')} |`); if (ri === 0) out.push(`| ${r.map(() => '---').join(' | ')} |`); }); out.push(''); }
      if (e.type === 'image') out.push(`![${e.alt ?? ''}](${e.src.startsWith('data:') ? 'image' : e.src})`, '');
      if (e.type === 'chart') out.push(`Chart: ${e.title ?? e.chart} — ${e.labels.map((l, k) => `${l} ${e.series.map((sr) => sr.values[k] ?? '').join('/')}`).join(', ')}`, '');
      if (e.type === 'embed') out.push(`[${e.title || e.kind}](${e.url})`, '');
    }
    if (s.notes.trim()) out.push(`Notes: ${s.notes.trim()}`, '');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
/** Every slide's text and notes as plain text (the outline). */
export function deckToText(deck: Deck): string {
  return deck.slides.map((s, i) => {
    const lines = [`Slide ${i + 1}${s.hidden ? ' (skipped)' : ''}: ${slideTitle(s)}`];
    for (const e of s.elements) {
      if (e.type === 'text' && e.role === 'title') continue;
      const t = hasText(e) ? parasText(e.paras) : e.type === 'table' ? e.rows.map((r) => r.map((c) => c.text).join('\t')).join('\n') : '';
      if (t.trim()) lines.push(t.split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (s.notes.trim()) lines.push(`  Notes: ${s.notes.trim()}`);
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

/* ---------------- HTML presentation ---------------- */

const PLAYER = `
(function(){
var D=JSON.parse(document.getElementById('deck-data').textContent);
var secs=[].slice.call(document.querySelectorAll('section.slide'));
var i=0,step=0,typed='',cover='';
function fit(){var k=Math.min(innerWidth/D.w,innerHeight/D.h);secs.forEach(function(s){s.style.transform='translate(-50%,-50%) scale('+k+')';});}
function paint(anim){var s=D.slides[i];secs.forEach(function(el,k){el.style.display=k===i?'block':'none';});
 var sec=secs[i];var hid=s.hidden[step]||[];var an=anim?(s.anim[step]||{}):{};
 [].forEach.call(sec.querySelectorAll('.sld-el'),function(el){var id=el.getAttribute('data-id');el.style.visibility=hid.indexOf(id)>=0?'hidden':'';el.style.animation=an[id]||'';});
 document.getElementById('count').textContent=(i+1)+' / '+secs.length;
 document.getElementById('notes').textContent=s.notes||'';}
function go(n,fromEnd){if(n<0||n>=secs.length)return;var s=D.slides[n];i=n;step=fromEnd?s.steps-1:0;paint(!fromEnd);
 var box=secs[i].firstElementChild;box.style.animation=s.tr&&!fromEnd?('sld-t-'+s.tr+' '+s.dur+'s ease both'):'';}
function next(){var s=D.slides[i];if(step<s.steps-1){step++;paint(true);}else go(i+1);}
function prev(){if(step>0){step--;paint(false);}else go(i-1,true);}
function setCover(c){cover=cover===c?'':c;var el=document.getElementById('cover');el.style.display=cover?'block':'none';el.style.background=cover==='b'?'#000':'#fff';}
addEventListener('keydown',function(e){var k=e.key;
 if(/^[0-9]$/.test(k)){typed+=k;return;}
 if(k==='Enter'&&typed){go(Math.max(0,Math.min(secs.length-1,parseInt(typed,10)-1)));typed='';return;}typed='';
 if(k==='ArrowRight'||k==='PageDown'||k===' '||k==='Enter'||k==='n'){e.preventDefault();next();}
 else if(k==='ArrowLeft'||k==='PageUp'||k==='Backspace'||k==='p'){e.preventDefault();prev();}
 else if(k==='Home')go(0);else if(k==='End')go(secs.length-1,true);
 else if(k==='f'){if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen();}
 else if(k==='b'||k==='.')setCover('b');else if(k==='w'||k===',')setCover('w');
 else if(k==='s'){var n=document.getElementById('notes');n.style.display=n.style.display==='block'?'none':'block';}
 else if(k==='l'){document.body.classList.toggle('laser');}});
addEventListener('mousemove',function(e){var l=document.getElementById('laser');l.style.left=e.clientX+'px';l.style.top=e.clientY+'px';});
document.getElementById('stage').addEventListener('click',function(e){if(e.target.closest('a'))return;next();});
addEventListener('resize',fit);fit();go(0);
})();`;

/** A self-contained web page that plays the presentation: transitions, click-by-click animations, keyboard navigation,
 * full screen (F), black / white screen (B / W), speaker notes (S) and a laser pointer (L). */
export function deckToHtml(deck: Deck): string {
  const shown = deck.slides.filter((s) => !s.hidden);
  const data = {
    w: deck.size.w, h: deck.size.h,
    slides: shown.map((s) => {
      const steps = animSteps(s).length;
      return {
        tr: s.transition && s.transition.type !== 'none' ? s.transition.type : '', dur: s.transition?.duration ?? 0.6, steps, notes: s.notes,
        hidden: Array.from({ length: steps }, (_, k) => [...hiddenAt(s, k)]),
        anim: Array.from({ length: steps }, (_, k) => Object.fromEntries(stepAnimations(s, k))),
      };
    }),
  };
  const sections = shown.map((s, i) => `<section class="slide" aria-label="Slide ${i + 1}">${slideHtml(deck, s)}</section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(deck.title)}</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:Arial,sans-serif}
#stage{position:fixed;inset:0}
section.slide{position:absolute;left:50%;top:50%;width:${deck.size.w}px;height:${deck.size.h}px;transform-origin:50% 50%;display:none}
#count{position:fixed;right:12px;bottom:8px;color:#fff8;font-size:12px}
#notes{display:none;position:fixed;left:0;right:0;bottom:0;max-height:30vh;overflow:auto;padding:12px 16px;background:#000c;color:#fff;font-size:16px;white-space:pre-wrap}
#cover{display:none;position:fixed;inset:0;z-index:5}
#laser{display:none;position:fixed;z-index:6;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#f33;box-shadow:0 0 10px 4px #f339;pointer-events:none}
body.laser,body.laser *{cursor:none!important}body.laser #laser{display:block}
${SLIDE_CSS}
${MOTION_CSS}
</style></head>
<body>
<div id="stage">
${sections}
</div>
<div id="count"></div><div id="notes"></div><div id="cover"></div><div id="laser"></div>
<script type="application/json" id="deck-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${PLAYER}</script>
</body></html>
`;
}
