/** In-page scripts for the QA agent's CSS / style testing (browser_e2e actions
 * `styles`, `assert_style`, `check_layout`). Each builder returns the BODY of a
 * function — the caller wraps it as `(function(){ … })()` — that ends in
 * `return JSON.stringify(...)`. Pure DOM + getComputedStyle, no dependencies. */

/** Shared helpers injected into every script. */
const HELPERS = `
var __cv = document.createElement('canvas'); __cv.width = 1; __cv.height = 1;
var __cx = __cv.getContext('2d', { willReadFrequently: true });
function rgba(color) {
  __cx.clearRect(0, 0, 1, 1); __cx.fillStyle = '#000'; __cx.fillStyle = color; __cx.fillRect(0, 0, 1, 1);
  var d = __cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
}
function lum(c) {
  var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function ratio(a, b) { var l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
function over(top, bottom) {
  var a = top[3] + bottom[3] * (1 - top[3]);
  if (a === 0) return [255, 255, 255, 1];
  return [0, 1, 2].map(function (i) { return (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a; }).concat([a]);
}
function bgOf(el) {
  var stack = [];
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
    var c = rgba(getComputedStyle(n).backgroundColor);
    if (c[3] > 0) { stack.push(c); if (c[3] >= 1) break; }
  }
  var acc = [255, 255, 255, 1];
  for (var i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
  return acc;
}
function visible(el) {
  var cs = getComputedStyle(el), r = el.getBoundingClientRect();
  return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && r.width > 0 && r.height > 0;
}
function path(el) {
  var parts = [];
  for (var n = el; n && n.nodeType === 1 && parts.length < 4 && n !== document.body; n = n.parentElement) {
    var s = n.tagName.toLowerCase();
    if (n.id) { parts.unshift(s + '#' + n.id); break; }
    var cls = (n.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    if (cls) s += '.' + cls;
    parts.unshift(s);
  }
  return parts.join(' > ');
}
`;

/** Computed styles + box of one element, for reading how it is really styled. */
export function stylesScript(selector: string): string {
  return `
var sel = ${JSON.stringify(selector)};
var el = document.querySelector(sel);
if (!el) throw new Error('no element ' + sel);
var cs = getComputedStyle(el), r = el.getBoundingClientRect();
var names = ['display','position','box-sizing','width','height','margin','padding','border','border-radius',
  'color','background-color','background-image','font-family','font-size','font-weight','line-height','letter-spacing',
  'text-align','text-overflow','white-space','opacity','overflow','z-index','flex','flex-direction','align-items',
  'justify-content','gap','grid-template-columns','box-shadow','transform','cursor','visibility','transition'];
var styles = {};
names.forEach(function (p) { styles[p] = cs.getPropertyValue(p); });
return JSON.stringify({
  selector: sel, tag: el.tagName.toLowerCase(),
  box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
  styles: styles
});`;
}

/** Compares one computed property with an expected value (colors and px are normalized). */
export function assertStyleScript(selector: string, property: string, expected: string, contains = false): string {
  return `${HELPERS}
var sel = ${JSON.stringify(selector)}, prop = ${JSON.stringify(property)}, want = ${JSON.stringify(expected)};
var el = document.querySelector(sel);
if (!el) throw new Error('no element ' + sel);
var actual = getComputedStyle(el).getPropertyValue(prop).trim();
if (/color/.test(prop)) { want = 'rgba(' + rgba(want).map(function (v, i) { return i < 3 ? Math.round(v) : v; }).join(',') + ')'; actual = 'rgba(' + rgba(actual).map(function (v, i) { return i < 3 ? Math.round(v) : v; }).join(',') + ')'; }
var px = function (v) { var m = /^(-?\\d*\\.?\\d+)px$/.exec(v); return m ? parseFloat(m[1]) : null; };
var squash = function (v) { return v.replace(/\\s+/g, ' ').trim(); };
var pass = ${contains ? 'squash(actual).indexOf(squash(want)) !== -1' : `squash(actual) === squash(want) || (px(actual) !== null && px(want) !== null && Math.abs(px(actual) - px(want)) <= 0.5)`};
return JSON.stringify({ pass: pass, property: prop, expected: want, actual: actual, element: path(el) });`;
}

/** Heuristic visual/CSS audit of the current page at the current viewport. */
export function checkLayoutScript(): string {
  return `${HELPERS}
var issues = [], vw = window.innerWidth, vh = window.innerHeight;
var root = document.scrollingElement || document.documentElement;
if (root.scrollWidth > vw + 1) issues.push({ type: 'horizontal-scroll', detail: 'page is ' + root.scrollWidth + 'px wide in a ' + vw + 'px viewport' });
var all = Array.prototype.slice.call(document.querySelectorAll('body *')).slice(0, 3000).filter(visible);
var scrollsX = function (el) {
  for (var n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    var o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
    if (getComputedStyle(n).position === 'fixed') return true;
  }
  return false;
};
var flagged = new Set(), count = { offscreen: 0, clipped: 0, contrast: 0, target: 0, image: 0 };
all.forEach(function (el) {
  var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  // content wider than the viewport
  if ((r.right > vw + 1 || r.left < -1) && cs.position !== 'fixed' && !scrollsX(el) && !(el.parentElement && flagged.has(el.parentElement))) {
    flagged.add(el); if (++count.offscreen <= 8) issues.push({ type: 'overflows-viewport', element: path(el), detail: 'x ' + Math.round(r.left) + '..' + Math.round(r.right) + ' in ' + vw + 'px viewport' });
  }
  // text cut off without an ellipsis
  if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && /\\S/.test(el.textContent || '')) {
    if (++count.clipped <= 8) issues.push({ type: 'clipped-text', element: path(el), detail: 'content ' + el.scrollWidth + 'px in a ' + el.clientWidth + 'px box (overflow hidden, no ellipsis)' });
  }
  // text contrast (WCAG AA)
  var hasText = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && /\\S/.test(n.nodeValue); });
  if (hasText) {
    var fg = rgba(cs.color), bg = bgOf(el); fg = over(fg, bg);
    var size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    var need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5, got = ratio(fg, bg);
    if (got < need && ++count.contrast <= 10) issues.push({ type: 'low-contrast', element: path(el), detail: got.toFixed(2) + ':1 (needs ' + need + ':1) text ' + cs.color + ' on ' + 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')' });
  }
  // tiny click targets (WCAG 2.2: 24px)
  if (el.matches('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]') && (r.width < 24 || r.height < 24) && !(el.tagName === 'A' && el.closest('p,li') && el.parentElement && el.parentElement.textContent.length > el.textContent.length + 10)) {
    if (++count.target <= 8) issues.push({ type: 'small-target', element: path(el), detail: Math.round(r.width) + 'x' + Math.round(r.height) + 'px (min 24x24)' });
  }
  if (el.tagName === 'IMG' && ((el.complete && el.naturalWidth === 0) || !el.hasAttribute('alt'))) {
    if (++count.image <= 6) issues.push({ type: el.complete && el.naturalWidth === 0 ? 'broken-image' : 'image-missing-alt', element: path(el), detail: (el.currentSrc || el.src || '').slice(0, 80) });
  }
});
var total = count.offscreen + count.clipped + count.contrast + count.target + count.image + (issues.some(function (i) { return i.type === 'horizontal-scroll'; }) ? 1 : 0);
return JSON.stringify({ viewport: vw + 'x' + vh, scanned: all.length, issueCount: total, issues: issues, note: 'Heuristic audit — confirm findings visually before reporting.' });`;
}
