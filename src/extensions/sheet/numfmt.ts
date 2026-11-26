/** Number formats and typed-input parsing for the Sheet menu (pure, no DOM, usable from node tests).
 * Dates are serial numbers like Google Sheets: days since 1899-12-30, the fraction is the time of day. */

export type FmtScalar = number | string | boolean | null | { code: string };

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

export function serialFromParts(y: number, m: number, d: number, hh = 0, mi = 0, ss = 0): number {
  return (Date.UTC(y, m - 1, d, hh, mi, ss) - EPOCH) / DAY_MS;
}
export interface DateParts { y: number; m: number; d: number; hh: number; mi: number; ss: number; ms: number; wd: number }
export function partsFromSerial(serial: number): DateParts {
  const ms = Math.round(serial * DAY_MS) + EPOCH;
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), hh: dt.getUTCHours(), mi: dt.getUTCMinutes(), ss: dt.getUTCSeconds(), ms: dt.getUTCMilliseconds(), wd: dt.getUTCDay() };
}
/** Local wall-clock time of a JS timestamp as a serial (what TODAY/NOW show). */
export function serialFromLocal(ms: number): number {
  const d = new Date(ms);
  return serialFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Ready-made formats (Format ▸ Number). '' is "Automatic". */
export const NUMBER_FORMATS: { id: string; label: string; pattern: string; sample: string }[] = [
  { id: 'auto', label: 'Automatic', pattern: '', sample: '1000.12' },
  { id: 'text', label: 'Plain text', pattern: '@', sample: 'abc' },
  { id: 'number', label: 'Number', pattern: '#,##0.00', sample: '1,000.12' },
  { id: 'integer', label: 'Number, no decimals', pattern: '#,##0', sample: '1,000' },
  { id: 'percent', label: 'Percent', pattern: '0.00%', sample: '10.12%' },
  { id: 'scientific', label: 'Scientific', pattern: '0.00E+00', sample: '1.01E+03' },
  { id: 'accounting', label: 'Accounting', pattern: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', sample: '$ (1,000.12)' },
  { id: 'financial', label: 'Financial', pattern: '#,##0.00;(#,##0.00)', sample: '(1,000.12)' },
  { id: 'currency', label: 'Currency', pattern: '$#,##0.00', sample: '$1,000.12' },
  { id: 'currency_rounded', label: 'Currency rounded', pattern: '$#,##0', sample: '$1,000' },
  { id: 'thb', label: 'Thai baht', pattern: '฿#,##0.00', sample: '฿1,000.12' },
  { id: 'eur', label: 'Euro', pattern: '€#,##0.00', sample: '€1,000.12' },
  { id: 'date', label: 'Date', pattern: 'yyyy-mm-dd', sample: '2026-09-26' },
  { id: 'date_us', label: 'Date (M/D/YYYY)', pattern: 'm/d/yyyy', sample: '9/26/2026' },
  { id: 'date_dmy', label: 'Date (D/M/YYYY)', pattern: 'd/m/yyyy', sample: '26/9/2026' },
  { id: 'date_long', label: 'Date, long', pattern: 'mmmm d, yyyy', sample: 'September 26, 2026' },
  { id: 'time', label: 'Time', pattern: 'h:mm:ss AM/PM', sample: '3:59:00 PM' },
  { id: 'time24', label: 'Time, 24 h', pattern: 'hh:mm', sample: '15:59' },
  { id: 'datetime', label: 'Date time', pattern: 'yyyy-mm-dd hh:mm:ss', sample: '2026-09-26 15:59:00' },
  { id: 'duration', label: 'Duration', pattern: '[h]:mm:ss', sample: '24:01:00' },
];
export const formatPattern = (id: string): string | undefined => NUMBER_FORMATS.find((f) => f.id === id)?.pattern;

/* ---------------- General (automatic) display ---------------- */

export function generalNumber(v: number): string {
  if (!Number.isFinite(v)) return '#NUM!';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-9) return expo(v, 2, '+');
  const s = String(Number(v.toPrecision(10)));
  if (s.includes('e')) return expo(v, 2, '+');
  return s;
}
function expo(v: number, digits: number, sign: string): string {
  const [m, e] = v.toExponential(digits).split('e');
  const n = Number(e);
  const es = String(Math.abs(n)).padStart(2, '0');
  return `${m}E${n < 0 ? '-' : sign === '+' ? '+' : ''}${es}`;
}

export function displayScalar(v: FmtScalar): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return generalNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return v.code;
  return v;
}

/* ---------------- pattern formatter ---------------- */

interface Section { raw: string; color?: string; cond?: { op: string; n: number } }
const cache = new Map<string, Section[]>();

function splitSections(pattern: string): Section[] {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const out: Section[] = [];
  let cur = '', q = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') q = !q;
    if (ch === '\\' && !q) { cur += ch + (pattern[i + 1] ?? ''); i++; continue; }
    if (ch === ';' && !q) { out.push({ raw: cur }); cur = ''; continue; }
    cur += ch;
  }
  out.push({ raw: cur });
  for (const s of out) {
    s.raw = s.raw.replace(/\[(Red|Blue|Green|Black|White|Yellow|Magenta|Cyan|Color\d+)\]/gi, (_, c: string) => { s.color = c.toLowerCase(); return ''; });
    s.raw = s.raw.replace(/\[(<=|>=|<>|<|>|=)(-?\d+(?:\.\d+)?)\]/, (_, op: string, n: string) => { s.cond = { op, n: Number(n) }; return ''; });
  }
  if (cache.size > 500) cache.clear();
  cache.set(pattern, out);
  return out;
}

const COLOR_HEX: Record<string, string> = { red: '#d93025', blue: '#1a73e8', green: '#188038', black: '#000000', white: '#ffffff', yellow: '#f9ab00', magenta: '#a142f4', cyan: '#12b5cb' };

const condOk = (c: { op: string; n: number }, v: number): boolean =>
  c.op === '<' ? v < c.n : c.op === '<=' ? v <= c.n : c.op === '>' ? v > c.n : c.op === '>=' ? v >= c.n : c.op === '=' ? v === c.n : v !== c.n;

export const isDatePattern = (raw: string): boolean => /[yd]|h|s|AM\/PM|A\/P/i.test(raw.replace(/"[^"]*"|\\./g, '').replace(/\[[^\]]*\]/g, (m) => (/\[h+\]|\[m+\]|\[s+\]/i.test(m) ? 'h' : '')).replace(/E[+-]/g, ''));

/** Formats a value with a pattern. Returns the text and an optional colour from [Red]-style codes. */
export function formatValue(v: FmtScalar, pattern?: string): { text: string; color?: string } {
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'object') return { text: v.code };
  if (!pattern) return { text: displayScalar(v) };
  const secs = splitSections(pattern);
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'string') {
    const s = secs.length >= 4 ? secs[3] : secs.find((x) => x.raw.includes('@'));
    if (!s) return { text: v };
    return { text: literalText(s.raw, v), color: s.color ? COLOR_HEX[s.color] : undefined };
  }
  let sec = secs[0], n = v, neg = false;
  if (secs.some((s) => s.cond)) {
    sec = secs.find((s) => s.cond && condOk(s.cond, v)) ?? secs.find((s) => !s.cond) ?? secs[0];
    neg = v < 0 && !sec.cond;
  } else if (v < 0 && secs.length >= 2) { sec = secs[1]; n = -v; }
  else if (v === 0 && secs.length >= 3) sec = secs[2];
  else neg = v < 0;
  if (!sec.raw.trim() && secs.length > 1) return { text: '' };
  const color = sec.color ? COLOR_HEX[sec.color] : undefined;
  if (sec.raw.includes('@') && !/[0#?]/.test(sec.raw)) return { text: literalText(sec.raw, displayScalar(v)), color };
  if (isDatePattern(sec.raw)) return { text: formatDate(n, sec.raw), color };
  const text = formatNumber(neg ? -n : n, sec.raw);
  return { text: neg && text !== '' && /[1-9]/.test(text) ? '-' + text : text, color };
}

function literalText(raw: string, text: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') { const j = raw.indexOf('"', i + 1); out += raw.slice(i + 1, j < 0 ? raw.length : j); i = j < 0 ? raw.length : j; }
    else if (ch === '\\') { out += raw[i + 1] ?? ''; i++; }
    else if (ch === '_') { out += ' '; i++; }
    else if (ch === '*') i++;
    else if (ch === '@') out += text;
    else out += ch;
  }
  return out;
}

function formatNumber(v: number, raw: string): string {
  // split into literal prefix, numeric body, literal suffix
  type Tok = { lit: string } | { ph: string };
  const toks: Tok[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') { const j = raw.indexOf('"', i + 1); toks.push({ lit: raw.slice(i + 1, j < 0 ? raw.length : j) }); i = j < 0 ? raw.length : j; }
    else if (ch === '\\') { toks.push({ lit: raw[i + 1] ?? '' }); i++; }
    else if (ch === '_') { toks.push({ lit: ' ' }); i++; }
    else if (ch === '*') { i++; }
    else if ((ch === 'E' || ch === 'e') && (raw[i + 1] === '+' || raw[i + 1] === '-')) { toks.push({ ph: 'E' + raw[i + 1] }); i++; }
    else if ('0#?,.%'.includes(ch)) toks.push({ ph: ch });
    else toks.push({ lit: ch });
  }
  const firstPh = toks.findIndex((t) => 'ph' in t && t.ph !== '%' && t.ph !== ',');
  if (firstPh < 0) {
    const pct = toks.filter((t) => 'ph' in t && t.ph === '%').length;
    return toks.map((t) => ('lit' in t ? t.lit : t.ph === '%' ? '%' : '')).join('') + (pct ? '' : '');
  }
  let lastPh = firstPh;
  toks.forEach((t, i) => { if ('ph' in t && t.ph !== '%') lastPh = i; });
  const body = toks.slice(firstPh, lastPh + 1).map((t) => ('ph' in t ? t.ph : '')).join('');
  const pct = toks.filter((t) => 'ph' in t && t.ph === '%').length;
  let x = v * Math.pow(100, pct);
  const prefix = toks.slice(0, firstPh).map((t) => ('lit' in t ? t.lit : t.ph === '%' ? '%' : '')).join('');
  const suffix = toks.slice(lastPh + 1).map((t) => ('lit' in t ? t.lit : t.ph === '%' ? '%' : '')).join('');
  // inner literals (e.g. "000-0000") are kept in place
  const inner = toks.slice(firstPh, lastPh + 1);
  const eIdx = body.search(/E[+-]/);
  if (eIdx >= 0) {
    const mant = body.slice(0, eIdx), expPart = body.slice(eIdx + 2);
    const fracDigits = (mant.split('.')[1] ?? '').replace(/[^0#?]/g, '').length;
    const intDigits = Math.max(1, (mant.split('.')[0] ?? '').replace(/[^0#?]/g, '').length);
    let e = x === 0 ? 0 : Math.floor(Math.log10(Math.abs(x)));
    if (intDigits > 1) e = Math.floor(e / intDigits) * intDigits;
    let m = x / Math.pow(10, e);
    if (Number(Math.abs(m).toFixed(fracDigits)) >= Math.pow(10, intDigits)) { m /= 10; e += 1; }
    const ms = Math.abs(m).toFixed(fracDigits);
    const es = String(Math.abs(e)).padStart(expPart.replace(/[^0]/g, '').length || 1, '0');
    return `${prefix}${m < 0 ? '-' : ''}${ms}E${e < 0 ? '-' : body[eIdx + 1] === '+' ? '+' : ''}${es}${suffix}`;
  }
  const dot = body.indexOf('.');
  const intPat = dot >= 0 ? body.slice(0, dot) : body;
  const fracPat = dot >= 0 ? body.slice(dot + 1).replace(/,/g, '') : '';
  // trailing commas scale by 1000
  const trail = /,+$/.exec(intPat.replace(/[^0#?,]/g, ''));
  if (dot < 0 && trail) x /= Math.pow(1000, trail[0].length);
  const thousands = /[0#?],+[0#?]/.test(intPat);
  const fracReq = (fracPat.match(/0/g) ?? []).length;
  const fracMax = fracPat.replace(/[^0#?]/g, '').length;
  const intReq = (intPat.match(/0/g) ?? []).length;
  let fixed = Math.abs(x).toFixed(fracMax);
  let [ip, fp = ''] = fixed.split('.');
  while (fp.length > fracReq && fp.endsWith('0')) fp = fp.slice(0, -1);
  if (ip === '0' && intReq === 0) ip = '';
  ip = ip.padStart(intReq, '0');
  if (thousands) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  fixed = ip + (fracMax > 0 && (fp.length > 0 || dot >= 0) ? (fp.length || fracReq ? '.' + fp : '') : '');
  if (fixed === '' ) fixed = intReq === 0 && fracMax === 0 ? '' : '0';
  // keep literal characters that sat between placeholders after the number (rare: phone-like masks)
  const innerLit = inner.filter((t) => 'lit' in t).map((t) => ('lit' in t ? t.lit : '')).join('');
  if (innerLit && /^[0#]+$/.test(intPat.replace(/[^0#]/g, '')) && dot < 0 && !thousands) {
    // fill digits right-to-left into the mask
    const digits = Math.round(Math.abs(x)).toString().split('');
    const out: string[] = [];
    for (let i = inner.length - 1; i >= 0; i--) {
      const t = inner[i];
      if ('lit' in t) out.unshift(t.lit);
      else if (t.ph === '0') out.unshift(digits.pop() ?? '0');
      else if (t.ph === '#') out.unshift(digits.pop() ?? '');
    }
    return prefix + digits.join('') + out.join('') + suffix;
  }
  return prefix + fixed + suffix;
}

function formatDate(serial: number, raw: string): string {
  const p = partsFromSerial(serial);
  const hasAmPm = /AM\/PM|A\/P/i.test(raw);
  let out = '';
  let lastWasHour = false;
  const lower = raw;
  for (let i = 0; i < lower.length;) {
    const rest = lower.slice(i);
    const ch = lower[i];
    if (ch === '"') { const j = lower.indexOf('"', i + 1); out += lower.slice(i + 1, j < 0 ? lower.length : j); i = j < 0 ? lower.length : j + 1; continue; }
    if (ch === '\\') { out += lower[i + 1] ?? ''; i += 2; continue; }
    let m: RegExpExecArray | null;
    if ((m = /^\[(h+)\]/i.exec(rest))) { out += String(Math.floor(serial * 24)).padStart(m[1].length, '0'); i += m[0].length; lastWasHour = true; continue; }
    if ((m = /^\[(m+)\]/i.exec(rest))) { out += String(Math.floor(serial * 1440)).padStart(m[1].length, '0'); i += m[0].length; continue; }
    if ((m = /^\[(s+)\]/i.exec(rest))) { out += String(Math.floor(serial * 86400)).padStart(m[1].length, '0'); i += m[0].length; continue; }
    if (/^AM\/PM/i.test(rest)) { out += p.hh < 12 ? 'AM' : 'PM'; i += 5; continue; }
    if (/^A\/P/i.test(rest)) { out += p.hh < 12 ? 'A' : 'P'; i += 3; continue; }
    if ((m = /^y+/i.exec(rest))) { out += m[0].length <= 2 ? String(p.y % 100).padStart(2, '0') : String(p.y); i += m[0].length; lastWasHour = false; continue; }
    if ((m = /^d+/i.exec(rest))) {
      const n = m[0].length;
      out += n === 1 ? String(p.d) : n === 2 ? String(p.d).padStart(2, '0') : n === 3 ? DAYS[p.wd].slice(0, 3) : DAYS[p.wd];
      i += n; lastWasHour = false; continue;
    }
    if ((m = /^h+/i.exec(rest))) {
      const h = hasAmPm ? ((p.hh + 11) % 12) + 1 : p.hh;
      out += m[0].length >= 2 ? String(h).padStart(2, '0') : String(h);
      i += m[0].length; lastWasHour = true; continue;
    }
    if ((m = /^m+/i.exec(rest))) {
      const n = m[0].length;
      const after = lower.slice(i + n).replace(/^[^a-z0-9]*/i, '');
      const minute = n <= 2 && (lastWasHour || /^s/i.test(after));
      if (minute) out += n === 2 ? String(p.mi).padStart(2, '0') : String(p.mi);
      else out += n === 1 ? String(p.m) : n === 2 ? String(p.m).padStart(2, '0') : n === 3 ? MONTHS[p.m - 1].slice(0, 3) : n === 5 ? MONTHS[p.m - 1][0] : MONTHS[p.m - 1];
      i += n; lastWasHour = false; continue;
    }
    if ((m = /^s+(\.0+)?/i.exec(rest))) {
      const n = m[0].replace(/\..*/, '').length;
      out += n >= 2 ? String(p.ss).padStart(2, '0') : String(p.ss);
      if (m[1]) out += '.' + String(p.ms).padStart(3, '0').slice(0, m[1].length - 1);
      i += m[0].length; lastWasHour = false; continue;
    }
    out += ch; i++;
  }
  return out;
}

/* ---------------- typed input ---------------- */

export interface ParsedInput { value: number | string | boolean | null; format?: string }

const MONTH_RE = MONTHS.map((m) => m.slice(0, 3).toLowerCase());

/** What a person typed into a cell, read the way Google Sheets reads it: numbers (1,234.5), percent, currency, dates, times, booleans. */
export function parseInput(text: string): ParsedInput {
  if (text === '') return { value: null };
  if (text.startsWith("'")) return { value: text.slice(1) };
  const t = text.trim();
  if (/^(true|false)$/i.test(t)) return { value: t.toLowerCase() === 'true' };
  let m: RegExpExecArray | null;
  if ((m = /^([-+])?\s*([$€£¥฿])\s*([-+])?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.exec(t)) && (m[4] || m[6])) {
    const n = Number(((m[4] ?? '0').replace(/,/g, '')) + (m[6] ?? ''));
    const sign = m[1] === '-' || m[3] === '-' ? -1 : 1;
    return { value: sign * n, format: `${m[2]}#,##0${m[6] ? '.00' : ''}` };
  }
  if ((m = /^([-+]?)(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\s*%$/.exec(t)) && (m[2] || m[4])) {
    const n = Number((m[2] ?? '0').replace(/,/g, '') + (m[4] ?? '')) / 100 * (m[1] === '-' ? -1 : 1);
    return { value: n, format: m[4] ? '0.00%' : '0%' };
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return { value: Number(t) };
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { value: Number(t.replace(/,/g, '')), format: t.includes('.') ? '#,##0.00' : '#,##0' };
  if (/^\(\d+(\.\d+)?\)$/.test(t)) return { value: -Number(t.slice(1, -1)) };
  const d = parseDateText(t);
  if (d) return d;
  return { value: text };
}

/** Parses a date and/or time written as text; null when it is not one. */
export function parseDateText(t: string): ParsedInput | null {
  let m: RegExpExecArray | null;
  const time = (s: string): number | null => {
    const x = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(am|pm|a|p)?$/i.exec(s.trim());
    if (!x) return null;
    let h = Number(x[1]);
    const mi = Number(x[2]), ss = Number(x[3] ?? 0) + Number(x[4] ?? 0);
    if (x[5]) { const pm = /^p/i.test(x[5]); if (h === 12) h = 0; if (pm) h += 12; }
    if (h > 23 && !x[5]) return h < 10000 && mi < 60 ? (h * 3600 + mi * 60 + ss) / 86400 : null;
    if (h > 23 || mi > 59 || ss >= 60) return null;
    return (h * 3600 + mi * 60 + ss) / 86400;
  };
  const tOnly = time(t);
  if (tOnly !== null) return { value: tOnly, format: /[ap]m?$/i.test(t) ? 'h:mm AM/PM' : t.split(':').length > 2 ? 'hh:mm:ss' : 'hh:mm' };
  const [datePart, ...timeRest] = t.split(/\s+(?=\d{1,2}:)/);
  const tf = timeRest.length ? time(timeRest.join(' ')) : 0;
  if (tf === null) return null;
  let y = 0, mo = 0, da = 0, fmt = 'yyyy-mm-dd';
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart))) { y = +m[1]; mo = +m[2]; da = +m[3]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(datePart))) {
    // month first (Google Sheets en-US); if the first part cannot be a month, read it as day/month
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) { da = a; mo = b; fmt = 'd/m/yyyy'; } else { mo = a; da = b; fmt = 'm/d/yyyy'; }
    y = +m[3]; if (m[3].length === 2) y += y < 30 ? 2000 : 1900;
  } else if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{4})$/.exec(datePart))) {
    const k = MONTH_RE.indexOf(m[2].slice(0, 3).toLowerCase()); if (k < 0) return null;
    da = +m[1]; mo = k + 1; y = +m[3]; fmt = 'd mmm yyyy';
  } else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(datePart))) {
    const k = MONTH_RE.indexOf(m[1].slice(0, 3).toLowerCase()); if (k < 0) return null;
    da = +m[2]; mo = k + 1; y = +m[3]; fmt = 'mmmm d, yyyy';
  } else return null;
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || y < 1000 || y > 9999) return null;
  const s = serialFromParts(y, mo, da);
  if (partsFromSerial(s).d !== da) return null;
  return { value: s + tf, format: timeRest.length ? `${fmt} hh:mm:ss` : fmt };
}

/** Number from text the way formulas coerce it ("12", "1,200", "12%", "$5", "2026-01-31"). */
export function textToNumber(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  const p = parseInput(t);
  return typeof p.value === 'number' ? p.value : null;
}
