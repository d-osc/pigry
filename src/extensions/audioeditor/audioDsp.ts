/** Audio Editor signal processing — pure functions on Float32Array channels (no DOM, no Web Audio), so the editor, the agent tools
 * and the node tests all render exactly the same sound. Contains: filters, dynamics, noise reduction, reverb and friends, the clip
 * and project renderer, loudness / peak / spectrum analysis, and WAV encoding and decoding. Imports use explicit `.ts` so node can run it. */
import { FX, allClips, dbToLin, envelopeAt, fadeShape, linToDb, rate, round, type Clip, type Fx, type GenSpec, type Project, type Track } from './audio.ts';

export interface Source { sampleRate: number; channels: Float32Array[] }
export type Sources = Record<string, Source>
type Chs = Float32Array[];

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const peakOf = (ch: Chs): number => { let m = 0; for (const c of ch) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > m) m = a; } return m; };

/* ---------------------------------------------------------------- FFT */

/** In-place radix-2 FFT. `inverse` also divides by the length. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = ((inverse ? -1 : 1) * -TAU) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}
const hann = (N: number): Float64Array => { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((TAU * i) / N); return w; };

/* ---------------------------------------------------------------- filters */

type BiquadType = 'lowpass' | 'highpass' | 'notch' | 'peak' | 'lowshelf' | 'highshelf' | 'bandpass';
/** RBJ cookbook biquad → [b0, b1, b2, a1, a2] (already divided by a0). */
export function biquadCoef(type: BiquadType, f: number, q: number, gainDb: number, sr: number): number[] {
  const w0 = (TAU * clamp(f, 10, sr * 0.49)) / sr, cos = Math.cos(w0), sin = Math.sin(w0), alpha = sin / (2 * Math.max(0.05, q)), A = 10 ** (gainDb / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'lowpass': b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'notch': b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'peak': b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + beta); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - beta);
      a0 = (A + 1) + (A - 1) * cos + beta; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - beta; break;
    }
    case 'highshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + beta); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - beta);
      a0 = (A + 1) - (A - 1) * cos + beta; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - beta; break;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
export function applyBiquad(x: Float32Array, c: number[]): Float32Array {
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const [b0, b1, b2, a1, a2] = c;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}
const BUTTER_Q: Record<number, number[]> = { 1: [0.7071], 2: [0.5412, 1.3066], 4: [0.5098, 0.6013, 0.9, 2.5629] };
function butter(x: Float32Array, type: 'lowpass' | 'highpass', f: number, slope: number, sr: number): Float32Array {
  const order = slope >= 48 ? 4 : slope >= 24 ? 2 : 1;
  let y = x;
  for (const q of BUTTER_Q[order]) y = applyBiquad(y, biquadCoef(type, f, q, 0, sr));
  return y;
}
const each = (ch: Chs, fn: (x: Float32Array, i: number) => Float32Array): Chs => ch.map(fn);

/* ---------------------------------------------------------------- resampling and time stretching */

/** Reads the signal `r` times faster (r > 1 = higher pitch and shorter) with cubic interpolation; low-passes first when downsampling. */
export function resampleBy(x: Float32Array, r: number): Float32Array {
  if (Math.abs(r - 1) < 1e-9) return x.slice();
  const src = r > 1.001 ? applyBiquad(applyBiquad(x, biquadCoef('lowpass', (0.45 * 44100) / r, 0.7071, 0, 44100)), biquadCoef('lowpass', (0.45 * 44100) / r, 0.7071, 0, 44100)) : x;
  const len = Math.max(0, Math.floor((x.length - 1) / r) + 1);
  const out = new Float32Array(len);
  const g = (i: number): number => src[clamp(i, 0, src.length - 1)];
  for (let i = 0; i < len; i++) {
    const pos = i * r, i0 = Math.floor(pos), f = pos - i0;
    const p0 = g(i0 - 1), p1 = g(i0), p2 = g(i0 + 1), p3 = g(i0 + 2);
    out[i] = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}
/** Converts between sample rates. */
export function convertRate(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const a = resampleBy(x, from / to);
  return a;
}

/** WSOLA time stretch: output length ≈ input length / rate, pitch unchanged. */
export function timeStretch(x: Float32Array, rateFactor: number, sr: number): Float32Array {
  if (Math.abs(rateFactor - 1) < 1e-4 || x.length < 64) return Math.abs(rateFactor - 1) < 1e-4 ? x.slice() : resampleBy(x, rateFactor);
  const N = 2 * Math.round((sr * 0.04) / 2), Hs = N / 2, tol = Math.round(N / 4);
  const outLen = Math.max(1, Math.floor(x.length / rateFactor));
  const out = new Float32Array(outLen + N), weight = new Float32Array(outLen + N), win = hann(N);
  let prev = -1;
  for (let j = 0; ; j++) {
    const synth = j * Hs;
    if (synth >= outLen) break;
    const target = Math.round(synth * rateFactor);
    let pos = target;
    if (j > 0 && prev >= 0) {
      const ref = prev + Hs;
      let best = -Infinity;
      const lo = Math.max(0, target - tol), hi = Math.min(x.length - N - 1, target + tol);
      const score = (c: number): number => { let s = 0; for (let k = 0; k < Hs; k += 4) { const a = ref + k < x.length ? x[ref + k] : 0; s += a * x[c + k]; } return s; };
      let cBest = lo;
      for (let c = lo; c <= hi; c += 4) { const s = score(c); if (s > best) { best = s; cBest = c; } }
      for (let c = Math.max(lo, cBest - 3); c <= Math.min(hi, cBest + 3); c++) { const s = score(c); if (s > best) { best = s; cBest = c; } }
      pos = cBest;
    }
    prev = pos;
    for (let k = 0; k < N; k++) { const s = pos + k < x.length ? x[pos + k] : 0; out[synth + k] += s * win[k]; weight[synth + k] += win[k]; }
  }
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = weight[i] > 1e-6 ? out[i] / weight[i] : 0;
  return res;
}

/* ---------------------------------------------------------------- generators */

function prng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function generate(g: GenSpec, seconds: number, sr: number): Float32Array {
  const len = Math.max(1, Math.round(seconds * sr)), out = new Float32Array(len);
  const amp = g.amp;
  switch (g.type) {
    case 'tone': {
      for (let i = 0; i < len; i++) {
        const ph = (g.freq * i / sr) % 1;
        out[i] = amp * (g.wave === 'square' ? (ph < 0.5 ? 1 : -1) : g.wave === 'sawtooth' ? 2 * ph - 1 : g.wave === 'triangle' ? 4 * Math.abs(ph - 0.5) - 1 : Math.sin(TAU * ph));
      }
      break;
    }
    case 'chirp': {
      const k = (g.freq2 - g.freq) / Math.max(1e-6, seconds);
      for (let i = 0; i < len; i++) { const t = i / sr; out[i] = amp * Math.sin(TAU * (g.freq * t + 0.5 * k * t * t)); }
      break;
    }
    case 'noise': {
      const rnd = prng(12345);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
      for (let i = 0; i < len; i++) {
        const w = rnd() * 2 - 1;
        if (g.color === 'white') out[i] = amp * w;
        else if (g.color === 'pink') { b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; out[i] = amp * 0.11 * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362); b6 = w * 0.115926; }
        else { brown = (brown + 0.02 * w) / 1.02; out[i] = amp * brown * 3.5; }
      }
      break;
    }
    case 'click': {
      const beat = Math.round((60 / g.bpm) * sr), burst = Math.round(sr * 0.012);
      for (let s = 0; s < len; s += beat) for (let k = 0; k < burst && s + k < len; k++) out[s + k] = amp * Math.sin((TAU * 1000 * k) / sr) * Math.exp((-6 * k) / burst);
      break;
    }
    default: break;
  }
  return out;
}

/* ---------------------------------------------------------------- dynamics */

function compressor(ch: Chs, sr: number, p: Record<string, unknown>): Chs {
  const th = n(p.threshold, -18), ratio = Math.max(1, n(p.ratio, 3)), knee = n(p.knee, 6);
  const at = Math.exp(-1 / (Math.max(0.1, n(p.attack, 10)) * 0.001 * sr)), rl = Math.exp(-1 / (Math.max(1, n(p.release, 120)) * 0.001 * sr));
  const makeup = dbToLin(p.auto === true ? -th * (1 - 1 / ratio) * 0.5 : n(p.makeup, 0));
  const len = ch[0]?.length ?? 0, gains = new Float32Array(len);
  let gr = 0;
  for (let i = 0; i < len; i++) {
    let lvl = 0; for (const c of ch) { const a = Math.abs(c[i]); if (a > lvl) lvl = a; }
    const over = linToDb(lvl) - th; let target = 0;
    if (2 * over < -knee) target = 0;
    else if (2 * Math.abs(over) <= knee) target = (1 / ratio - 1) * ((over + knee / 2) ** 2) / (2 * Math.max(knee, 1e-6));
    else target = (1 / ratio - 1) * over;
    const coef = target < gr ? at : rl;
    gr = coef * gr + (1 - coef) * target;
    gains[i] = dbToLin(gr) * makeup;
  }
  return each(ch, (c) => { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = c[i] * gains[i]; return o; });
}

function limiter(ch: Chs, sr: number, p: Record<string, unknown>): Chs {
  const ceil = dbToLin(n(p.ceiling, -1)), L = Math.max(1, Math.round(n(p.lookahead, 5) * 0.001 * sr)), rel = Math.exp(-1 / (Math.max(1, n(p.release, 50)) * 0.001 * sr));
  const len = ch[0]?.length ?? 0, need = new Float32Array(len);
  for (let i = 0; i < len; i++) { let a = 0; for (const c of ch) { const v = Math.abs(c[i]); if (v > a) a = v; } need[i] = a > ceil ? ceil / a : 1; }
  // sliding minimum over the next L samples (monotonic deque), so the gain comes down before the peak arrives
  const mins = new Float32Array(len), dq = new Int32Array(len + 1);
  let h = 0, t = 0;
  for (let i = len - 1; i >= 0; i--) {
    while (t > h && need[dq[t - 1]] >= need[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + L) h++;
    mins[i] = need[dq[h]];
  }
  // smooth the attack over the look-ahead window (never above the required gain), then add a release tail
  const g = new Float32Array(len); let acc = 0, cur = 1;
  for (let i = 0; i < len; i++) {
    acc += mins[i]; if (i >= L) acc -= mins[i - L];
    const s = acc / Math.min(i + 1, L);
    cur = s < cur ? s : rel * cur + (1 - rel) * s; if (cur > s) cur = s;
    g[i] = cur;
  }
  return each(ch, (c) => { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = clamp(c[i] * Math.min(g[i], need[i]), -ceil, ceil); return o; });
}

function gate(ch: Chs, sr: number, p: Record<string, unknown>): Chs {
  const th = dbToLin(n(p.threshold, -50)), floor = dbToLin(-n(p.reduction, 40)), hold = Math.round(n(p.hold, 50) * 0.001 * sr);
  const at = Math.exp(-1 / (Math.max(0.1, n(p.attack, 5)) * 0.001 * sr)), rl = Math.exp(-1 / (Math.max(5, n(p.release, 150)) * 0.001 * sr));
  const len = ch[0]?.length ?? 0, g = new Float32Array(len);
  let env = 0, cur = floor, cnt = 0;
  const dec = Math.exp(-1 / (0.005 * sr));
  for (let i = 0; i < len; i++) {
    let a = 0; for (const c of ch) { const v = Math.abs(c[i]); if (v > a) a = v; }
    env = a > env ? a : env * dec + a * (1 - dec);
    if (env > th) cnt = hold;
    const open = env > th || cnt-- > 0;
    const target = open ? 1 : floor;
    const coef = target > cur ? at : rl; cur = coef * cur + (1 - coef) * target; g[i] = cur;
  }
  return each(ch, (c) => { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = c[i] * g[i]; return o; });
}

function deesser(ch: Chs, sr: number, p: Record<string, unknown>): Chs {
  const f = n(p.freq, 6500), th = n(p.threshold, -30), amount = n(p.amount, 8), coef = Math.exp(-1 / (0.004 * sr));
  return each(ch, (c) => {
    const band = applyBiquad(applyBiquad(c, biquadCoef('highpass', f * 0.8, 0.7071, 0, sr)), biquadCoef('lowpass', Math.min(sr * 0.45, f * 2.2), 0.7071, 0, sr));
    const out = new Float32Array(c.length); let env = 0, gr = 0;
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(band[i]); env = a > env ? a : env * coef + a * (1 - coef);
      const target = -Math.min(amount, Math.max(0, linToDb(env) - th));
      gr = target < gr ? target : gr * 0.995 + target * 0.005;
      out[i] = c[i] - band[i] * (1 - dbToLin(gr));
    }
    return out;
  });
}

/* ---------------------------------------------------------------- noise reduction (spectral gating) */

function noiseReduce(ch: Chs, sr: number, p: Record<string, unknown>, profile?: Chs): Chs {
  const N = 2048, H = 512, bins = N / 2 + 1, win = hann(N);
  const floor = dbToLin(-n(p.reduction, 12)), sens = n(p.sensitivity, 6), smooth = Math.round(n(p.smoothing, 3));
  return ch.map((x, ci) => {
    const prof = profile ? profile[Math.min(ci, profile.length - 1)] : quietest(x, Math.round(sr * 0.5));
    // learn the noise: mean and spread of the magnitude in every bin
    const mean = new Float64Array(bins), sq = new Float64Array(bins); let frames = 0;
    const re = new Float64Array(N), im = new Float64Array(N);
    const source = prof.length >= N ? prof : x.slice(0, Math.max(N, Math.min(x.length, N * 4)));
    for (let s = 0; s + N <= source.length; s += H) {
      for (let i = 0; i < N; i++) { re[i] = source[s + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < bins; k++) { const m = Math.hypot(re[k], im[k]); mean[k] += m; sq[k] += m * m; }
      frames++;
    }
    if (frames === 0) return x.slice();
    const thr = new Float64Array(bins);
    for (let k = 0; k < bins; k++) { const mu = mean[k] / frames, sd = Math.sqrt(Math.max(0, sq[k] / frames - mu * mu)); thr[k] = mu + (sens / 3) * sd + 1e-9; }
    // gate the signal frame by frame
    const out = new Float64Array(x.length + N), norm = new Float64Array(x.length + N), prevG = new Float64Array(bins).fill(1), g = new Float64Array(bins), sg = new Float64Array(bins);
    for (let s = -N + H; s < x.length; s += H) {
      for (let i = 0; i < N; i++) { const j = s + i; re[i] = (j >= 0 && j < x.length ? x[j] : 0) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < bins; k++) g[k] = Math.hypot(re[k], im[k]) < thr[k] ? floor : 1;
      for (let k = 0; k < bins; k++) { let a = 0, c = 0; for (let d = -smooth; d <= smooth; d++) { const kk = k + d; if (kk >= 0 && kk < bins) { a += g[kk]; c++; } } sg[k] = a / c; }
      for (let k = 0; k < bins; k++) { const v = sg[k] >= prevG[k] ? sg[k] : prevG[k] * 0.7 + sg[k] * 0.3; prevG[k] = v; sg[k] = v; }
      for (let k = 0; k < bins; k++) { re[k] *= sg[k]; im[k] *= sg[k]; if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; } }
      fft(re, im, true);
      for (let i = 0; i < N; i++) { const j = s + i; if (j >= 0 && j < x.length) { out[j] += re[i] * win[i]; norm[j] += win[i] * win[i]; } }
    }
    const res = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) res[i] = norm[i] > 1e-6 ? out[i] / norm[i] : x[i];
    return res;
  });
}
/** The quietest window of a signal — used as the noise sample when the user gave none. */
function quietest(x: Float32Array, win: number): Float32Array {
  if (x.length <= win) return x;
  const hop = Math.max(1, Math.round(win / 2)); let best = 0, bestE = Infinity;
  for (let s = 0; s + win <= x.length; s += hop) { let e = 0; for (let i = 0; i < win; i += 4) e += x[s + i] * x[s + i]; if (e < bestE) { bestE = e; best = s; } }
  return x.subarray(best, best + win);
}

/* ---------------------------------------------------------------- restoration */

function declick(ch: Chs, p: Record<string, unknown>): Chs {
  const k = 1200 / Math.max(1, n(p.sensitivity, 40)), maxW = Math.max(1, Math.round(n(p.width, 10)));
  return each(ch, (x) => {
    const y = x.slice(), len = x.length, d = new Float32Array(len);
    for (let i = 2; i < len; i++) d[i] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]);
    const BLOCK = 2048;
    for (let s = 0; s < len; s += BLOCK) {
      const e = Math.min(len, s + BLOCK), sorted = Array.from(d.subarray(s, e)).sort((a, b) => a - b), med = sorted[sorted.length >> 1] + 1e-6, thr = Math.max(k * med, 0.02);
      for (let i = Math.max(s, 2); i < e; i++) {
        if (d[i] <= thr) continue;
        // a click is a short burst: find its extent, then interpolate across it
        let a = i - 2, b = i;
        while (b + 1 < len && b - a < maxW + 2 && d[b + 1] > thr * 0.3) b++;
        a = Math.max(0, a - 1); b = Math.min(len - 1, b + 1);
        if (b - a > maxW + 4) { i = b; continue; }
        const va = y[a], vb = y[b];
        for (let j = a + 1; j < b; j++) y[j] = va + ((vb - va) * (j - a)) / (b - a);
        i = b;
      }
    }
    return y;
  });
}

/* ---------------------------------------------------------------- space & colour */

function reverb(ch: Chs, sr: number, p: Record<string, unknown>): Chs {
  const room = n(p.room, 0.5), damp = n(p.damp, 0.5) * 0.4, wet = n(p.wet, 0.25), pre = Math.round(n(p.predelay, 10) * 0.001 * sr);
  const fb = 0.7 + room * 0.28, scale = sr / 44100;
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], apT = [556, 441, 341, 225];
  return ch.map((x, ci) => {
    const len = x.length, out = new Float32Array(len);
    const combs = combT.map((t) => ({ buf: new Float32Array(Math.round((t + ci * 23) * scale)), pos: 0, store: 0 }));
    const aps = apT.map((t) => ({ buf: new Float32Array(Math.round((t + ci * 23) * scale)), pos: 0 }));
    for (let i = 0; i < len; i++) {
      const inp = (i - pre >= 0 ? x[i - pre] : 0) * 0.03; let sum = 0;
      for (const c of combs) { const o = c.buf[c.pos]; c.store = o * (1 - damp) + c.store * damp; c.buf[c.pos] = inp + c.store * fb; if (++c.pos >= c.buf.length) c.pos = 0; sum += o; }
      for (const a of aps) { const bo = a.buf[a.pos], o = -sum + bo; a.buf[a.pos] = sum + bo * 0.5; if (++a.pos >= a.buf.length) a.pos = 0; sum = o; }
      out[i] = x[i] * (1 - wet * 0.5) + sum * wet * 2.2;
    }
    return out;
  });
}
function echo(ch: Chs, sr: number, p: Record<string, unknown>): Chs {
  const d = Math.max(1, Math.round(n(p.delay, 0.4) * sr)), decay = n(p.decay, 0.5), reps = Math.round(n(p.repeats, 4));
  return each(ch, (x) => { const o = x.slice(); for (let r = 1; r <= reps; r++) { const off = r * d, g = decay ** r; for (let i = off; i < x.length; i++) o[i] += x[i - off] * g; } return o; });
}
function chorus(ch: Chs, sr: number, p: Record<string, unknown>): Chs {
  const rateHz = n(p.rate, 0.8), depth = n(p.depth, 3) * 0.001 * sr, mix = n(p.mix, 0.5), base = 0.016 * sr;
  return each(ch, (x, ci) => {
    const o = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let w = 0;
      for (let v = 0; v < 2; v++) {
        const d = base + depth * Math.sin(TAU * rateHz * (i / sr) + v * Math.PI * 0.7 + ci * 0.4), pos = i - d, i0 = Math.floor(pos), f = pos - i0;
        const a = i0 >= 0 && i0 < x.length ? x[i0] : 0, b = i0 + 1 >= 0 && i0 + 1 < x.length ? x[i0 + 1] : 0;
        w += (a + (b - a) * f) / 2;
      }
      o[i] = x[i] * (1 - mix * 0.5) + w * mix;
    }
    return o;
  });
}
function distortion(ch: Chs, p: Record<string, unknown>): Chs {
  const type = String(p.type ?? 'soft'), drive = dbToLin(n(p.drive, 12)), mix = n(p.mix, 1), levels = 2 ** (Math.round(n(p.bits, 8)) - 1);
  return each(ch, (x) => {
    const o = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = x[i] * drive; let y: number;
      if (type === 'hard') y = clamp(v, -1, 1);
      else if (type === 'fold') { let t = v; while (Math.abs(t) > 1) t = t > 1 ? 2 - t : -2 - t; y = t; }
      else if (type === 'bitcrush') y = Math.round(clamp(x[i], -1, 1) * levels) / levels;
      else y = Math.tanh(v) / Math.tanh(Math.max(drive, 1));
      o[i] = x[i] * (1 - mix) + y * mix;
    }
    return o;
  });
}

/* ---------------------------------------------------------------- loudness & analysis */

/** ITU-R BS.1770 K-weighting filter coefficients for any sample rate. */
function kWeight(x: Float32Array, sr: number): Float32Array {
  const G = 3.999843853973347, Q = 0.7071752369554196, fc = 1681.9744509555319;
  let K = Math.tan((Math.PI * fc) / sr); const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416; let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  const Q2 = 0.5003270373238773, fc2 = 38.13547087613982; K = Math.tan((Math.PI * fc2) / sr); a0 = 1 + K / Q2 + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0];
  return applyBiquad(applyBiquad(x, shelf), hp);
}

export interface Loudness { integrated: number; momentaryMax: number; shortTermMax: number; range: number }
/** Integrated loudness (LUFS), max momentary (400 ms) and short-term (3 s) loudness, loudness range (LU) per ITU-R BS.1770 / EBU R128. */
export function loudness(ch: Chs, sr: number): Loudness {
  const none: Loudness = { integrated: -Infinity, momentaryMax: -Infinity, shortTermMax: -Infinity, range: 0 };
  const len = ch[0]?.length ?? 0; if (len === 0) return none;
  const sub = Math.max(1, Math.round(sr * 0.1)), cnt = Math.max(1, Math.floor(len / sub));
  const e = new Float64Array(cnt);
  for (const c of ch.slice(0, 2)) { const k = kWeight(c, sr); for (let b = 0; b < cnt; b++) { let s = 0; const a = b * sub, z = b === cnt - 1 ? len : a + sub; for (let i = a; i < z; i++) s += k[i] * k[i]; e[b] += s / (z - a); } }
  const lu = (ms: number): number => (ms <= 0 ? -Infinity : -0.691 + 10 * Math.log10(ms));
  const win = (w: number): number[] => { const out: number[] = []; if (cnt < w) { out.push(e.reduce((a, b) => a + b, 0) / cnt); return out; } for (let b = 0; b + w <= cnt; b++) { let s = 0; for (let i = 0; i < w; i++) s += e[b + i]; out.push(s / w); } return out; };
  const mom = win(4), st = win(30);
  const gated = mom.filter((m) => lu(m) > -70);
  if (gated.length === 0) return none;
  const rel = lu(gated.reduce((a, b) => a + b, 0) / gated.length) - 10;
  const g2 = gated.filter((m) => lu(m) > rel);
  const integrated = lu((g2.length ? g2 : gated).reduce((a, b) => a + b, 0) / (g2.length ? g2 : gated).length);
  const stl = st.map(lu).filter((v) => v > -70);
  let range = 0;
  if (stl.length > 1) {
    const mean = lu(st.filter((m) => lu(m) > -70).reduce((a, b) => a + b, 0) / stl.length) - 20, v = stl.filter((x) => x > mean).sort((a, b) => a - b);
    if (v.length > 1) range = v[Math.floor(0.95 * (v.length - 1))] - v[Math.floor(0.1 * (v.length - 1))];
  }
  return { integrated, momentaryMax: Math.max(...mom.map(lu)), shortTermMax: Math.max(...st.map(lu)), range };
}

/** Estimated true peak in dBTP (4× oversampling with an 8-tap windowed-sinc interpolator). */
export function truePeakDb(ch: Chs): number {
  const taps = [0.25, 0.5, 0.75].map((f) => Array.from({ length: 8 }, (_, i) => { const x = i - 3 - f; const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); return s * (0.5 + 0.5 * Math.cos((Math.PI * x) / 4.5)); }));
  let m = 0;
  for (const c of ch) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]); if (a > m) m = a;
      if (a < m * 0.5 && a < 0.3) continue;
      for (const t of taps) { let s = 0; for (let k = 0; k < 8; k++) { const j = i + k - 3; if (j >= 0 && j < c.length) s += c[j] * t[k]; } if (Math.abs(s) > m) m = Math.abs(s); }
    }
  }
  return linToDb(m);
}

export interface Range { start: number; end: number }
export function findSilence(x: Float32Array, sr: number, thresholdDb = -50, minDuration = 0.3): Range[] {
  const win = Math.max(1, Math.round(sr * 0.01)), th = dbToLin(thresholdDb), out: Range[] = [];
  let start = -1;
  const total = Math.floor(x.length / win);
  for (let b = 0; b <= total; b++) {
    let quiet = b < total;
    if (b < total) { let s = 0; for (let i = b * win; i < (b + 1) * win; i++) s += x[i] * x[i]; quiet = Math.sqrt(s / win) < th; }
    if (quiet && start < 0) start = b * win;
    else if (!quiet && start >= 0) { const end = b * win; if ((end - start) / sr >= minDuration) out.push({ start: round(start / sr, 3), end: round(end / sr, 3) }); start = -1; }
  }
  return out;
}
export function findClipping(ch: Chs, sr: number, level = 0.999, minRun = 3): { samples: number; ranges: Range[] } {
  const ranges: Range[] = []; let samples = 0;
  for (const c of ch) {
    let run = 0;
    for (let i = 0; i <= c.length; i++) {
      if (i < c.length && Math.abs(c[i]) >= level) run++;
      else { if (run >= minRun) { samples += run; ranges.push({ start: round((i - run) / sr, 4), end: round(i / sr, 4) }); } run = 0; }
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return { samples, ranges: ranges.slice(0, 50) };
}

export interface Spectrum { binHz: number; db: Float32Array }
export function spectrum(x: Float32Array, sr: number, size = 4096): Spectrum {
  const win = hann(size), re = new Float64Array(size), im = new Float64Array(size), acc = new Float64Array(size / 2 + 1);
  const hop = Math.max(size / 2, Math.floor((x.length - size) / 300)); let frames = 0;
  for (let s = 0; s + size <= Math.max(size, x.length); s += hop) {
    for (let i = 0; i < size; i++) { re[i] = (s + i < x.length ? x[s + i] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / (size * size * 0.375);
    frames++;
  }
  const db = new Float32Array(acc.length);
  for (let k = 0; k < acc.length; k++) db[k] = 10 * Math.log10(acc[k] / Math.max(1, frames) + 1e-14);
  return { binHz: sr / size, db };
}
export const BANDS: [string, number, number][] = [['sub', 20, 60], ['bass', 60, 250], ['low-mid', 250, 500], ['mid', 500, 2000], ['high-mid', 2000, 4000], ['presence', 4000, 6000], ['air', 6000, 20000]];
export function bandLevels(sp: Spectrum, sr: number): { band: string; db: number }[] {
  return BANDS.filter(([, lo]) => lo < sr / 2).map(([band, lo, hi]) => {
    let e = 0; for (let k = Math.max(1, Math.floor(lo / sp.binHz)); k <= Math.min(sp.db.length - 1, Math.floor(hi / sp.binHz)); k++) e += 10 ** (sp.db[k] / 10);
    return { band, db: round(10 * Math.log10(e + 1e-14), 1) };
  });
}
export function detectHum(sp: Spectrum): { freq: number; excessDb: number } | null {
  let best: { freq: number; excessDb: number } | null = null;
  for (const f of [50, 60]) {
    const k = Math.round(f / sp.binHz); if (k < 4 || k + 4 >= sp.db.length) continue;
    const peak = Math.max(sp.db[k - 1], sp.db[k], sp.db[k + 1]);
    const around = (sp.db[k - 4] + sp.db[k - 3] + sp.db[k + 3] + sp.db[k + 4]) / 4;
    if (peak > -75 && peak - around > 10 && (!best || peak - around > best.excessDb)) best = { freq: f, excessDb: round(peak - around, 1) };
  }
  return best;
}

export interface Spectrogram { cols: number; bins: number; binHz: number; db: Float32Array }
/** Short-time Fourier transform magnitudes in dB (columns × bins, low frequency first). */
export function spectrogram(x: Float32Array, sr: number, columns = 400, size = 1024, maxHz = 20000): Spectrogram {
  const bins = Math.min(size / 2, Math.floor(maxHz / (sr / size))), win = hann(size), re = new Float64Array(size), im = new Float64Array(size);
  const cols = Math.max(1, columns), db = new Float32Array(cols * bins), span = Math.max(1, x.length - size);
  for (let c = 0; c < cols; c++) {
    const s = Math.floor((span * c) / Math.max(1, cols - 1));
    for (let i = 0; i < size; i++) { re[i] = (s + i < x.length ? x[s + i] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < bins; k++) db[c * bins + k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / (size * size * 0.375) + 1e-14);
  }
  return { cols, bins, binHz: sr / size, db };
}
/** Min / max pairs per bucket, for drawing a waveform. */
export function waveformPeaks(x: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2), step = x.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let lo = 0, hi = 0; const a = Math.floor(b * step), z = Math.max(a + 1, Math.floor((b + 1) * step));
    for (let i = a; i < z && i < x.length; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[b * 2] = lo; out[b * 2 + 1] = hi;
  }
  return out;
}

export interface Analysis {
  duration: number; sampleRate: number; channels: number; peakDb: number; truePeakDb: number; rmsDb: number; crestDb: number; dcOffset: number;
  loudness: Loudness; noiseFloorDb: number; clipping: { samples: number; ranges: Range[] }; silences: Range[]; bands: { band: string; db: number }[]; hum: { freq: number; excessDb: number } | null;
}
export function analyze(ch: Chs, sr: number, opts: { silenceDb?: number; minSilence?: number } = {}): Analysis {
  const len = ch[0]?.length ?? 0, mono = new Float32Array(len);
  for (const c of ch) for (let i = 0; i < len; i++) mono[i] += c[i] / ch.length;
  let sum = 0, dc = 0; for (const c of ch) for (let i = 0; i < len; i++) { sum += c[i] * c[i]; dc += c[i]; }
  const total = Math.max(1, len * ch.length), rms = Math.sqrt(sum / total), peak = peakOf(ch);
  const win = Math.max(1, Math.round(sr * 0.05)); const rmsList: number[] = [];
  for (let s = 0; s + win <= len; s += win) { let e = 0; for (let i = s; i < s + win; i++) e += mono[i] * mono[i]; rmsList.push(Math.sqrt(e / win)); }
  rmsList.sort((a, b) => a - b);
  const sp = spectrum(mono, sr);
  return {
    duration: round(len / sr, 3), sampleRate: sr, channels: ch.length, peakDb: round(linToDb(peak), 2), truePeakDb: round(truePeakDb(ch), 2), rmsDb: round(linToDb(rms), 2), crestDb: round(linToDb(peak) - linToDb(rms), 2), dcOffset: round(dc / total, 5),
    loudness: loudness(ch, sr), noiseFloorDb: round(linToDb(rmsList[Math.floor(rmsList.length * 0.1)] ?? 0), 1), clipping: findClipping(ch, sr), silences: findSilence(mono, sr, opts.silenceDb ?? -50, opts.minSilence ?? 0.3), bands: bandLevels(sp, sr), hum: detectHum(sp),
  };
}
export function describeAnalysis(a: Analysis, targetLufs?: number): string {
  const f = (v: number): string => (Number.isFinite(v) ? String(round(v, 1)) : '−∞');
  const lines = [
    `${a.duration}s, ${a.sampleRate} Hz, ${a.channels === 1 ? 'mono' : 'stereo'}`,
    `Peak ${f(a.peakDb)} dBFS (true peak ≈ ${f(a.truePeakDb)} dBTP), RMS ${f(a.rmsDb)} dBFS, crest factor ${f(a.crestDb)} dB, DC offset ${a.dcOffset}`,
    `Loudness: integrated ${f(a.loudness.integrated)} LUFS, max short-term ${f(a.loudness.shortTermMax)} LUFS, max momentary ${f(a.loudness.momentaryMax)} LUFS, range ${f(a.loudness.range)} LU`,
    `Noise floor (quietest 10% of 50 ms windows) ≈ ${f(a.noiseFloorDb)} dBFS`,
    `Clipping: ${a.clipping.samples} clipped sample(s)${a.clipping.ranges.length ? ' at ' + a.clipping.ranges.slice(0, 6).map((r) => `${r.start}s`).join(', ') : ''}`,
    `Silence (≥ threshold): ${a.silences.length ? a.silences.slice(0, 10).map((r) => `${r.start}–${r.end}s`).join(', ') + (a.silences.length > 10 ? ` … (${a.silences.length} total)` : '') : 'none'}`,
    `Spectrum by band: ${a.bands.map((b) => `${b.band} ${b.db} dB`).join(', ')}`,
    a.hum ? `Hum: ${a.hum.freq} Hz stands ${a.hum.excessDb} dB above its surroundings — use dehum` : 'Hum: none detected at 50/60 Hz',
  ];
  const notes: string[] = [];
  if (a.clipping.samples > 0) notes.push('clipping present — lower the gain before processing; clipped peaks cannot be restored');
  if (a.truePeakDb > -1) notes.push('true peak above −1 dBTP — add a limiter (ceiling −1 dB) before export');
  if (targetLufs !== undefined && Number.isFinite(a.loudness.integrated) && Math.abs(a.loudness.integrated - targetLufs) > 1) notes.push(`${f(a.loudness.integrated - targetLufs)} LU away from the ${targetLufs} LUFS target — use loudnorm`);
  if (a.noiseFloorDb > -50 && a.noiseFloorDb < 0) notes.push('noise floor is high (above −50 dBFS) — consider noise reduction');
  return lines.join('\n') + (notes.length ? '\nNotes:\n- ' + notes.join('\n- ') : '');
}

/* ---------------------------------------------------------------- effect chain */

const mono = (ch: Chs): Float32Array => { const o = new Float32Array(ch[0].length); for (const c of ch) for (let i = 0; i < o.length; i++) o[i] += c[i] / ch.length; return o; };

export interface FxContext { profile?: Chs }
export function applyFx(fx: Fx, ch: Chs, sr: number, ctx: FxContext = {}): Chs {
  const p = fx.p;
  switch (fx.type) {
    case 'amplify': { const g = dbToLin(n(p.db, 0)); return each(ch, (x) => x.map((v) => v * g)); }
    case 'normalize': {
      const src = p.dc === false ? ch : each(ch, (x) => { let m = 0; for (let i = 0; i < x.length; i++) m += x[i]; m /= Math.max(1, x.length); return x.map((v) => v - m); });
      const pk = peakOf(src); if (pk < 1e-9) return src;
      const g = dbToLin(n(p.peak, -1)) / pk; return each(src, (x) => x.map((v) => v * g));
    }
    case 'loudnorm': {
      const l = loudness(ch, sr); if (!Number.isFinite(l.integrated)) return ch;
      const g = dbToLin(n(p.target, -16) - l.integrated); const out = each(ch, (x) => x.map((v) => v * g));
      return peakOf(out) > dbToLin(n(p.ceiling, -1)) ? limiter(out, sr, { ceiling: n(p.ceiling, -1), release: 80, lookahead: 5 }) : out;
    }
    case 'invert': return each(ch, (x) => x.map((v) => -v));
    case 'dcremove': return each(ch, (x) => { let m = 0; for (let i = 0; i < x.length; i++) m += x[i]; m /= Math.max(1, x.length); return x.map((v) => v - m); });
    case 'eq': {
      const bands = Array.isArray(p.bands) ? (p.bands as { type: BiquadType; f: number; gain: number; q: number }[]) : [
        { type: 'lowshelf' as const, f: 100, gain: n(p.low, 0), q: 0.7 }, { type: 'peak' as const, f: 400, gain: n(p.lowmid, 0), q: 1 }, { type: 'peak' as const, f: 1000, gain: n(p.mid, 0), q: 1 },
        { type: 'peak' as const, f: 3500, gain: n(p.highmid, 0), q: 1 }, { type: 'highshelf' as const, f: 10000, gain: n(p.high, 0), q: 0.7 },
      ];
      return each(ch, (x) => { let y = x; for (const b of bands) { if (['peak', 'lowshelf', 'highshelf'].includes(b.type) && Math.abs(b.gain) < 0.01) continue; y = applyBiquad(y, biquadCoef(b.type, b.f, b.q, b.gain, sr)); } return y; });
    }
    case 'hpf': return each(ch, (x) => butter(x, 'highpass', n(p.freq, 80), n(p.slope, 12), sr));
    case 'lpf': return each(ch, (x) => butter(x, 'lowpass', n(p.freq, 8000), n(p.slope, 12), sr));
    case 'notch': return each(ch, (x) => { let y = x; for (let h = 0; h <= n(p.harmonics, 0); h++) { const f = n(p.freq, 60) * (h + 1); if (f < sr * 0.45) y = applyBiquad(y, biquadCoef('notch', f, n(p.q, 30), 0, sr)); } return y; });
    case 'dehum': return each(ch, (x) => { let y = x; for (let h = 1; h <= n(p.harmonics, 4); h++) { const f = n(p.freq, 50) * h; if (f < sr * 0.45) y = applyBiquad(y, biquadCoef('notch', f, n(p.q, 30), 0, sr)); } return y; });
    case 'bass': return each(ch, (x) => applyBiquad(x, biquadCoef('lowshelf', n(p.freq, 100), 0.7, n(p.db, 3), sr)));
    case 'treble': return each(ch, (x) => applyBiquad(x, biquadCoef('highshelf', n(p.freq, 5000), 0.7, n(p.db, 3), sr)));
    case 'compressor': return compressor(ch, sr, p);
    case 'limiter': return limiter(ch, sr, p);
    case 'gate': return gate(ch, sr, p);
    case 'deesser': return deesser(ch, sr, p);
    case 'noisereduce': return noiseReduce(ch, sr, p, ctx.profile);
    case 'declick': return declick(ch, p);
    case 'reverb': return reverb(ch, sr, p);
    case 'echo': return echo(ch, sr, p);
    case 'chorus': return chorus(ch, sr, p);
    case 'distortion': return distortion(ch, p);
    case 'tremolo': { const r = n(p.rate, 5), d = n(p.depth, 0.5); return each(ch, (x) => x.map((v, i) => v * (1 - d * (0.5 + 0.5 * Math.sin(TAU * r * (i / sr)))))); }
    case 'mono': {
      if (ch.length < 2) return ch;
      const mode = String(p.mode ?? 'mix'), [l, r] = ch;
      if (mode === 'left') return [l.slice(), l.slice()];
      if (mode === 'right') return [r.slice(), r.slice()];
      if (mode === 'swap') return [r.slice(), l.slice()];
      if (mode === 'vocal') { const m = l.map((v, i) => (v - r[i]) / 2); return [m, m.slice()]; }
      const m = mono(ch); return [m, m.slice()];
    }
    case 'ramp': {
      const from = n(p.from, 0), to = n(p.to, 1), curve = (FX.ramp.params.curve.choices ?? []).includes(String(p.curve)) ? (String(p.curve) as 'linear') : 'linear';
      return each(ch, (x) => x.map((v, i) => v * fadeShape(curve, from + ((to - from) * i) / Math.max(1, x.length - 1))));
    }
    default: return ch;
  }
}

/* ---------------------------------------------------------------- rendering */

const ASSET_CACHE = new WeakMap<Source, Map<number, Chs>>();
function atRate(src: Source, sr: number): Chs {
  if (src.sampleRate === sr) return src.channels;
  let byRate = ASSET_CACHE.get(src); if (!byRate) { byRate = new Map(); ASSET_CACHE.set(src, byRate); }
  let c = byRate.get(sr); if (!c) { c = src.channels.map((x) => convertRate(x, src.sampleRate, sr)); byRate.set(sr, c); }
  return c;
}
const conform = (ch: Chs, want: number): Chs => (ch.length === want ? ch : want === 1 ? [mono(ch)] : [ch[0], ch[ch.length > 1 ? 1 : 0]]);
const fit = (x: Float32Array, len: number): Float32Array => { if (x.length === len) return x; const o = new Float32Array(len); o.set(x.subarray(0, Math.min(len, x.length))); return o; };

/** Renders one clip to `want` channels at the project rate, with speed / tempo / pitch, effects, fades, envelope and gain applied. */
export function renderClip(clip: Clip, want: 1 | 2, sources: Sources, sr: number): Chs {
  const len = Math.max(1, Math.round(clip.duration * sr));
  if (clip.muted) return Array.from({ length: want }, () => new Float32Array(len));
  let ch: Chs; let profile: Chs | undefined;
  if (clip.gen) ch = Array.from({ length: want }, () => generate(clip.gen as GenSpec, clip.duration, sr));
  else {
    const src = sources[clip.asset];
    const span = Math.round(clip.duration * rate(clip) * sr), start = Math.round(clip.offset * sr);
    if (!src) ch = Array.from({ length: want }, () => new Float32Array(len));
    else {
      const data = atRate(src, sr);
      ch = conform(data, want).map((x) => { const seg = new Float32Array(span); if (start < x.length) seg.set(x.subarray(start, Math.min(x.length, start + span))); return seg; });
      const np = clip.fx.find((f) => f.type === 'noisereduce');
      if (np && n(np.p.profileFrom, -1) >= 0 && n(np.p.profileTo, -1) > n(np.p.profileFrom, -1)) {
        const a = Math.round(n(np.p.profileFrom, 0) * sr), b = Math.round(n(np.p.profileTo, 0) * sr);
        profile = conform(data, want).map((x) => x.slice(a, Math.min(b, x.length)));
      }
      if (clip.reverse) ch = ch.map((x) => x.slice().reverse());
      if (Math.abs(clip.tempo - 1) > 1e-4) ch = ch.map((x) => timeStretch(x, clip.tempo, sr));
      if (Math.abs(clip.pitch) > 1e-3) { const r = 2 ** (clip.pitch / 12); ch = ch.map((x) => { const L = x.length; return fit(timeStretch(resampleBy(x, r), 1 / r, sr), L); }); }
      if (Math.abs(clip.speed - 1) > 1e-4) ch = ch.map((x) => resampleBy(x, clip.speed));
      ch = ch.map((x) => fit(x, len));
    }
  }
  for (const fx of clip.fx) ch = applyFx(fx, ch, sr, { profile }).map((x) => fit(x, len));
  const fi = Math.round(clip.fadeIn * sr), fo = Math.round(clip.fadeOut * sr), useEnv = clip.envelope.length > 0;
  return ch.map((x) => {
    const o = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let g = clip.gain;
      if (fi > 0 && i < fi) g *= fadeShape(clip.fadeCurve, i / fi);
      if (fo > 0 && i > len - fo) g *= fadeShape(clip.fadeCurve, (len - i) / fo);
      if (useEnv) g *= envelopeAt(clip.envelope, i / sr);
      o[i] = x[i] * g;
    }
    return o;
  });
}

export const trackAudible = (p: Project, t: Track): boolean => !t.mute && (!p.tracks.some((x) => x.solo) || t.solo);

/** Mixes one track's clips into `want` channels covering [from, to) seconds (no track gain/pan). */
export function renderTrack(p: Project, track: Track, sources: Sources, from = 0, to?: number, cache?: Map<string, Chs>): Chs {
  const sr = p.sampleRate, want = track.kind === 'mono' ? 1 : 2;
  const end = to ?? Math.max(0, ...track.clips.map((c) => c.start + c.duration)), len = Math.max(0, Math.round((end - from) * sr));
  const out: Chs = Array.from({ length: want }, () => new Float32Array(len));
  for (const clip of track.clips) {
    if (clip.start >= end || clip.start + clip.duration <= from) continue;
    const key = cache ? JSON.stringify([clip, want, sr, clip.asset, sources[clip.asset]?.channels[0]?.length ?? 0]) : '';
    let r = cache?.get(key);
    if (!r) { r = renderClip(clip, want, sources, sr); if (cache) { cache.set(key, r); if (cache.size > 60) cache.delete(cache.keys().next().value as string); } }
    const dst = Math.round((clip.start - from) * sr);
    for (let c = 0; c < want; c++) for (let i = 0; i < r[c].length; i++) { const j = dst + i; if (j >= 0 && j < len) out[c][j] += r[c][i]; }
  }
  return out;
}

export interface Mix { sampleRate: number; channels: [Float32Array, Float32Array] }
/** Renders the whole project (or [from, to)) to a stereo mix: track gain and balance, mute/solo, then the master effect chain. */
export function renderProject(p: Project, sources: Sources, opts: { from?: number; to?: number; cache?: Map<string, Chs>; master?: boolean; skipTracks?: boolean } = {}): Mix {
  const sr = p.sampleRate, from = opts.from ?? 0;
  const to = opts.to ?? Math.max(0, ...allClips(p).map((c) => c.start + c.duration));
  const len = Math.max(0, Math.round((to - from) * sr));
  const L = new Float32Array(len), R = new Float32Array(len);
  for (const track of p.tracks) {
    if (!trackAudible(p, track) || track.clips.length === 0) continue;
    const t = renderTrack(p, track, sources, from, to, opts.cache);
    const gl = track.gain * Math.min(1, 1 - track.pan), gr = track.gain * Math.min(1, 1 + track.pan);
    const a = t[0], b = t[1] ?? t[0];
    for (let i = 0; i < len; i++) { L[i] += a[i] * gl; R[i] += b[i] * gr; }
  }
  let out: Chs = [L, R];
  if (opts.master !== false) for (const fx of p.master) out = applyFx(fx, out, sr);
  return { sampleRate: sr, channels: [out[0], out[1]] };
}

/* ---------------------------------------------------------------- WAV */

export type WavBits = 16 | 24 | 32;
/** Decoded audio is held as 32-bit floats; refuse files that would not fit in memory. */
export const MAX_DECODED_BYTES = 1_600_000_000;
/** Encodes channels as a RIFF/WAVE file: 16- or 24-bit PCM (TPDF dither when reducing to 16) or 32-bit float. Values beyond ±1 are clipped for PCM. */
export function encodeWav(ch: Chs, sr: number, bits: WavBits = 16, dither = bits === 16): Uint8Array {
  const frames = ch[0]?.length ?? 0, nch = ch.length, bytes = bits / 8, dataLen = frames * nch * bytes;
  const buf = new ArrayBuffer(44 + dataLen), v = new DataView(buf);
  const tag = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nch * bytes, true); v.setUint16(32, nch * bytes, true); v.setUint16(34, bits, true);
  tag(36, 'data'); v.setUint32(40, dataLen, true);
  const rnd = prng(7); let o = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) {
    const x = ch[c][i];
    if (bits === 32) v.setFloat32(o, x, true);
    else if (bits === 24) { const s = Math.round(clamp(x, -1, 1) * 8388607); v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); }
    else { const d = dither ? (rnd() - rnd()) / 32768 : 0; v.setInt16(o, Math.round(clamp(x + d, -1, 1) * 32767), true); }
    o += bytes;
  }
  return new Uint8Array(buf);
}
export function decodeWav(data: Uint8Array): Source {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (o: number): string => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (data.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, fmt = 1, nch = 2, sr = 44100, bits = 16, dataAt = -1, dataLen = 0;
  while (o + 8 <= data.length) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') { fmt = v.getUint16(o + 8, true); nch = v.getUint16(o + 10, true); sr = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true); if (fmt === 0xfffe && size >= 26) fmt = v.getUint16(o + 32, true); }
    else if (id === 'data') { dataAt = o + 8; dataLen = Math.min(size, data.length - dataAt); break; }
    o += 8 + size + (size & 1);
  }
  if (dataAt < 0) throw new Error('WAV has no data chunk');
  if (![1, 3].includes(fmt)) throw new Error(`unsupported WAV format ${fmt}`);
  const bytes = bits / 8, frames = Math.floor(dataLen / (bytes * nch));
  const memory = frames * Math.min(nch, 2) * 4;
  if (memory > MAX_DECODED_BYTES) throw new Error(`this WAV is ${(frames / sr / 60).toFixed(0)} minutes long and would need about ${(memory / 1e9).toFixed(1)} GB of memory to edit (limit ${(MAX_DECODED_BYTES / 1e9).toFixed(1)} GB) — trim it in another tool or use a lower sample rate / mono`);
  const ch = Array.from({ length: Math.min(nch, 2) }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < ch.length; c++) {
    const p = dataAt + (i * nch + c) * bytes;
    ch[c][i] = fmt === 3 ? (bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true)) : bits === 8 ? (v.getUint8(p) - 128) / 128 : bits === 16 ? v.getInt16(p, true) / 32768 : bits === 24 ? (((v.getUint8(p + 2) << 24) | (v.getUint8(p + 1) << 16) | (v.getUint8(p) << 8)) >> 8) / 8388608 : v.getInt32(p, true) / 2147483648;
  }
  return { sampleRate: sr, channels: ch };
}
