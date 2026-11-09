// Analyze orbit Figma JSON: design tokens + per-screen structure
import { readFileSync, writeFileSync } from 'node:fs';

const file = JSON.parse(readFileSync(new URL('./orbit-figma.json', import.meta.url), 'utf8'));
const page = file.document.children[0];

// ---------- helpers ----------
const hex = (c) => {
  if (!c) return null;
  const to2 = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  let s = `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`;
  if (c.a !== undefined && c.a < 1) s += ` (${(c.a * 100).toFixed(0)}%)`;
  return s;
};

const colors = new Map();   // hex -> {fill: n, stroke: n, bg: n}
const texts = [];           // unique text node samples
const fonts = new Map();    // family+size+weight+lineHeight -> count
const radii = new Map();
const effects = new Map();

function addColor(h, kind) {
  if (!h) return;
  const key = h.split(' ')[0];
  if (!colors.has(key)) colors.set(key, { fill: 0, stroke: 0, bg: 0, samples: [] });
  colors.get(key)[kind]++;
}

function walk(node, depth, ctx) {
  // fills
  if (node.fills) node.fills.forEach((f) => { if (f.type === 'SOLID') addColor(hex(f.color), 'fill'); });
  if (node.background) node.background.forEach((f) => { if (f.type === 'SOLID') addColor(hex(f.color), 'bg'); });
  if (node.strokes) node.strokes.forEach((f) => { if (f.type === 'SOLID') addColor(hex(f.color), 'stroke'); });

  // effects (shadows)
  if (node.effects) {
    node.effects.forEach((e) => {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        const k = `${e.type} 0x${(e.radius||0)}px(${e.offset?.x},${e.offset?.y}) ${hex(e.color)}`;
        effects.set(k, (effects.get(k) || 0) + 1);
      }
    });
  }

  if (node.cornerRadius) radii.set(node.cornerRadius, (radii.get(node.cornerRadius) || 0) + 1);

  if (node.type === 'TEXT') {
    const st = node.style || {};
    const key = `${st.fontFamily} ${st.fontWeight} ${st.fontSize}px lh=${st.lineHeightPx} ls=${st.letterSpacing}`;
    fonts.set(key, (fonts.get(key) || 0) + 1);
    if (texts.length < 400) {
      texts.push({
        screen: ctx.screen,
        text: (node.characters || '').slice(0, 120),
        size: st.fontSize, weight: st.fontWeight, family: st.fontFamily,
        color: hex(node.fills?.[0]?.color),
        case: st.textCase,
      });
    }
  }
  (node.children || []).forEach((c) => walk(c, depth + 1, ctx));
}

page.children.forEach((frame) => {
  walk(frame, 0, { screen: frame.name });
});

// ---------- report ----------
console.log('=== COLORS (by frequency) ===');
[...colors.entries()]
  .sort((a, b) => (b[1].fill + b[1].stroke + b[1].bg) - (a[1].fill + a[1].stroke + a[1].bg))
  .slice(0, 40)
  .forEach(([k, v]) => console.log(`${k}  fill:${v.fill} text/stroke-fill:${v.stroke} bg:${v.bg}`));

console.log('\n=== TYPOGRAPHY ===');
[...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  .forEach(([k, v]) => console.log(`${v}x  ${k}`));

console.log('\n=== CORNER RADII ===');
[...radii.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, v]) => console.log(`${v}x  ${k}px`));

console.log('\n=== SHADOW/EFFECTS (top) ===');
[...effects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .forEach(([k, v]) => console.log(`${v}x  ${k}`));

writeFileSync(new URL('./texts.json', import.meta.url), JSON.stringify(texts, null, 2));
console.log(`\nSaved ${texts.length} text samples to texts.json`);

// ---------- structure of key screens: print tree (depth-limited) ----------
function tree(node, depth, maxDepth, prefix) {
  if (depth > maxDepth) return;
  const b = node.absoluteBoundingBox;
  const la = node.layoutMode && node.layoutMode !== 'NONE' ? ` [${node.layoutMode} gap=${node.itemGap} pad=${node.paddingTop},${node.paddingRight},${node.paddingBottom},${node.paddingLeft}]` : '';
  const label = `${node.type}: ${node.name}${b ? ` (${Math.round(b.width)}x${Math.round(b.height)})` : ''}${la}`;
  console.log(prefix + label);
  (node.children || []).slice(0, 40).forEach((c) => tree(c, depth + 1, maxDepth, prefix + '  '));
}

const pick = process.argv[2]; // node id
const target = page.children.find((f) => f.id === pick);
if (target) {
  console.log(`\n=== TREE: ${target.name} ===`);
  tree(target, 0, parseInt(process.argv[3] || '4', 10), '');
}
