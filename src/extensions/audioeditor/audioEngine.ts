/** Audio Editor engine (browser only): decodes imported files (decodeAudioData), renders the project with audioDsp, plays it through
 * Web Audio with a transport and level meter, records from the microphone, draws waveforms and spectrograms, and exports WAV
 * (PCM 16/24, float 32) or WebM/Opus (MediaRecorder, real time). MP3 and FLAC can be imported (the browser decodes them) but not exported. */
import { isTauri, readBinaryChunked, readBinaryFile } from '../../lib/tauriClient';
import { allClips, projectDuration, type Asset, type Clip, type Project, type Track } from './audio';
import {
  decodeWav, encodeWav, renderClip, renderProject, spectrogram, waveformPeaks, type Mix, type Source, type Sources, type WavBits,
} from './audioDsp';

const bytesOf = (base64: string): Uint8Array => { const bin = atob(base64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
export const blobToBase64 = async (blob: Blob): Promise<string> => bytesToBase64(new Uint8Array(await blob.arrayBuffer()));

/** Decodes any audio file the browser understands (WAV is decoded without Web Audio, so it is bit exact). */
export async function decodeAudioBytes(bytes: Uint8Array): Promise<Source> {
  const riff = bytes.length > 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF';
  if (riff) { try { return decodeWav(bytes); } catch { /* fall through to the browser decoder (e.g. ADPCM WAV) */ } }
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctx(2, 1, 44100);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const buf = await ctx.decodeAudioData(copy);
  return { sampleRate: buf.sampleRate, channels: Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice()) };
}

const decoded = new Map<string, Promise<Source>>();
/** Loads and decodes the workspace file of an asset (cached per path). */
export function loadSource(path: string): Promise<Source> {
  let p = decoded.get(path);
  if (!p) {
    // big files (up to 500 MB) come in 6 MB pieces; small ones and the browser mock use the single call
    const bytes = isTauri() ? readBinaryChunked(path) : readBinaryFile(path).then((f) => bytesOf(f.data));
    p = bytes.then((b) => decodeAudioBytes(b));
    decoded.set(path, p); p.catch(() => decoded.delete(path));
  }
  return p;
}
export const rememberSource = (path: string, source: Source): void => { decoded.set(path, Promise.resolve(source)); };

export async function loadSources(assets: Asset[], onMeta?: (id: string, meta: { duration: number; sampleRate: number; channels: number }) => void): Promise<{ sources: Sources; missing: string[] }> {
  const sources: Sources = {}, missing: string[] = [];
  await Promise.all(assets.map(async (a) => {
    try {
      const s = await loadSource(a.path);
      sources[a.id] = s;
      onMeta?.(a.id, { duration: Math.round((s.channels[0].length / s.sampleRate) * 1000) / 1000, sampleRate: s.sampleRate, channels: s.channels.length });
    } catch { missing.push(a.name); }
  }));
  return { sources, missing };
}

/* ---------------------------------------------------------------- drawing */

/** Colour of a spectrogram cell: dB below full scale → dark purple … orange … white. */
export function heat(db: number, floor = -100): [number, number, number] {
  const v = Math.min(1, Math.max(0, (db - floor) / -floor));
  const stops: [number, number, number, number][] = [[0, 8, 6, 24], [0.3, 64, 18, 110], [0.55, 168, 40, 120], [0.78, 238, 120, 40], [1, 255, 245, 190]];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) { const a = stops[i - 1], b = stops[i], k = (v - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k]; }
  }
  return [255, 245, 190];
}
export function drawWaveform(ctx: CanvasRenderingContext2D, ch: Float32Array[], w: number, h: number, color = '#4fb3ff', bg?: string, showClipping = false): void {
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  const lanes = ch.length, lh = h / lanes;
  ch.forEach((x, i) => {
    const mid = lh * i + lh / 2, peaks = waveformPeaks(x, Math.max(1, Math.floor(w)));
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    for (let px = 0; px < peaks.length / 2; px++) {
      const lo = Math.max(-1, Math.min(1, peaks[px * 2])), hi = Math.max(-1, Math.min(1, peaks[px * 2 + 1]));
      const y1 = mid - hi * (lh / 2 - 1), y2 = mid - lo * (lh / 2 - 1);
      ctx.fillStyle = showClipping && (hi >= 0.999 || lo <= -0.999) ? '#ff3b30' : color;
      ctx.fillRect(px, y1, 1, Math.max(1, y2 - y1));
    }
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  });
}
export function drawSpectrogram(ctx: CanvasRenderingContext2D, x: Float32Array, sr: number, w: number, h: number, maxHz = 12000): void {
  const cols = Math.max(1, Math.min(Math.floor(w), 900)), sg = spectrogram(x, sr, cols, 1024, maxHz);
  const img = ctx.createImageData(cols, sg.bins);
  for (let c = 0; c < cols; c++) for (let k = 0; k < sg.bins; k++) {
    const [r, g, b] = heat(sg.db[c * sg.bins + k]);
    const o = ((sg.bins - 1 - k) * cols + c) * 4; img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  const tmp = document.createElement('canvas'); tmp.width = cols; tmp.height = sg.bins;
  tmp.getContext('2d')?.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(tmp, 0, 0, w, h);
}

/** A picture of the project for the agent: one waveform + spectrogram strip per track on a shared time axis, with labels. */
export function previewImage(project: Project, sources: Sources, opts: { from?: number; to?: number; width?: number } = {}): { dataUrl: string; width: number; height: number } {
  const from = opts.from ?? 0, to = Math.max(from + 0.05, opts.to ?? projectDuration(project)), W = opts.width ?? 1100, left = 120, laneW = W - left - 10;
  const tracks = project.tracks.filter((t) => t.clips.length > 0);
  const strip = 70, spec = 70, gap = 8, head = 22, H = head + tracks.length * (strip + spec + gap) + (project.labels.length ? 20 : 0) + 30;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#12151a'; ctx.fillRect(0, 0, W, H);
  ctx.font = '11px sans-serif'; ctx.textBaseline = 'middle';
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => (to - from) / s <= 12) ?? 120;
  ctx.fillStyle = '#8b94a1'; ctx.strokeStyle = '#2a2f38';
  for (let t = Math.ceil(from / step) * step; t <= to + 1e-6; t += step) { const x = left + ((t - from) / (to - from)) * laneW; ctx.beginPath(); ctx.moveTo(x, head - 4); ctx.lineTo(x, H - 24); ctx.stroke(); ctx.fillText(`${Math.round(t * 100) / 100}s`, x + 3, 10); }
  let y = head;
  tracks.forEach((track) => {
    const sub: Project = { ...project, tracks: [track], master: [] };
    const mix = renderProject(sub, sources, { from, to, master: false });
    const ch = track.kind === 'mono' ? [mix.channels[0]] : [mix.channels[0], mix.channels[1]];
    ctx.fillStyle = '#e8ebf0'; ctx.fillText(track.name.slice(0, 16), 8, y + 12);
    ctx.fillStyle = '#8b94a1'; ctx.fillText(`${track.kind}${track.mute ? ' · muted' : ''}${track.solo ? ' · solo' : ''}`, 8, y + 28);
    ctx.save(); ctx.translate(left, y); ctx.beginPath(); ctx.rect(0, 0, laneW, strip); ctx.clip();
    drawWaveform(ctx, ch, laneW, strip, '#4fb3ff', '#0c0f13'); ctx.restore();
    ctx.save(); ctx.translate(left, y + strip); ctx.beginPath(); ctx.rect(0, 0, laneW, spec); ctx.clip();
    drawSpectrogram(ctx, mix.channels[0], project.sampleRate, laneW, spec, Math.min(12000, project.sampleRate / 2)); ctx.restore();
    y += strip + spec + gap;
  });
  ctx.fillStyle = '#e8ebf0';
  for (const l of project.labels) { if (l.end < from || l.start > to) continue; const x = left + ((l.start - from) / (to - from)) * laneW; ctx.fillStyle = '#ffd166'; ctx.fillRect(x, y, 2, 14); ctx.fillText(l.text.slice(0, 24), x + 5, y + 7); }
  ctx.fillStyle = '#8b94a1'; ctx.fillText('top: waveform · bottom: spectrogram 0–12 kHz (bright = loud)', left, H - 10);
  return { dataUrl: canvas.toDataURL('image/png'), width: W, height: H };
}

/* ---------------------------------------------------------------- engine */

const SEGMENT_SECONDS = 300;
const MAX_EXPORT_BYTES = 500_000_000;
export type MeterListener = (levels: { l: number; r: number }) => void;

export class AudioEngine {
  project: Project;
  sources: Sources = {};
  private cache = new Map<string, Float32Array[]>();
  private ctx: AudioContext | null = null;
  private node: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode[] = [];
  private startedAt = 0;
  private startFrom = 0;
  private endAt = 0;
  private loop = false;
  private rangeStart = 0;
  private override: Project | undefined;
  private raf = 0;
  private mic: { stream: MediaStream; recorder: MediaRecorder; chunks: Blob[]; analyser: AnalyserNode } | null = null;
  playing = false;
  onTime: (t: number) => void = () => undefined;
  onState: (playing: boolean) => void = () => undefined;
  onMeter: MeterListener = () => undefined;

  constructor(project: Project) { this.project = project; }
  setProject(p: Project): void { this.project = p; }
  setHandlers(h: { onTime?: (t: number) => void; onState?: (playing: boolean) => void; onMeter?: MeterListener }): void {
    if (h.onTime) this.onTime = h.onTime;
    if (h.onState) this.onState = h.onState;
    if (h.onMeter) this.onMeter = h.onMeter;
  }
  setSources(s: Sources): void { this.sources = s; }

  async loadAssets(onMeta?: Parameters<typeof loadSources>[1]): Promise<string[]> {
    const { sources, missing } = await loadSources(this.project.assets, onMeta);
    this.sources = sources;
    return missing;
  }

  /** The project (or a part of it) as a stereo mix, exactly what playback and export use. */
  mix(from = 0, to?: number, master = true): Mix { return renderProject(this.project, this.sources, { from, to, master, cache: this.cache }); }
  /** One clip as the editor shows it (all effects applied), cached while the clip is unchanged. */
  clipAudio(track: Track, clip: Clip, sampleRate: number): Float32Array[] {
    const want = track.kind === 'mono' ? 1 : 2;
    const key = JSON.stringify([clip, want, sampleRate, this.sources[clip.asset]?.channels[0]?.length ?? 0]);
    let r = this.cache.get(key);
    if (!r) {
      r = renderClip(clip, want, this.sources, sampleRate);
      // long clips are not kept: a 40-minute clip is ~1 GB and would crowd out everything else
      if (r[0].length <= 20_000_000) { this.cache.set(key, r); if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value as string); }
    }
    return r;
  }

  /** What the editor draws for a clip. A plain clip (no effects, speed, pitch, fades, envelope, gain 1, source at the project rate) is a zero-copy
   * view into the decoded file, so a very long import is drawn without a second copy in memory; anything else is rendered (and cached when small). */
  clipView(track: Track, clip: Clip, sampleRate: number): Float32Array[] {
    const src = this.sources[clip.asset], want = track.kind === 'mono' ? 1 : 2;
    const plain = !!src && !clip.gen && clip.fx.length === 0 && clip.speed === 1 && clip.tempo === 1 && clip.pitch === 0 && !clip.reverse && clip.gain === 1
      && clip.fadeIn === 0 && clip.fadeOut === 0 && clip.envelope.length === 0 && !clip.muted && src.sampleRate === sampleRate;
    if (!plain || !(src.channels.length === want || (src.channels.length === 1 && want === 2))) return this.clipAudio(track, clip, sampleRate);
    const a = Math.round(clip.offset * sampleRate), b = a + Math.round(clip.duration * sampleRate);
    const view = src.channels.map((x) => x.subarray(Math.min(a, x.length), Math.min(b, x.length)));
    return want === 2 && view.length === 1 ? [view[0], view[0]] : view;
  }

  private audioCtx(): AudioContext {
    if (!this.ctx) this.ctx = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ sampleRate: this.project.sampleRate });
    return this.ctx;
  }

  get position(): number {
    if (!this.playing || !this.ctx) return this.startFrom;
    return Math.min(this.endAt, this.startFrom + (this.ctx.currentTime - this.startedAt));
  }

  /** Plays [from, to) (to defaults to the end); loop repeats it. Returns after playback has started. */
  async play(from: number, to?: number, loop = false, override?: Project): Promise<void> {
    this.stop(false);
    const end = to ?? projectDuration(override ?? this.project);
    if (end - from < 0.01) return;
    const ctx = this.audioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    this.override = override; this.rangeStart = from; this.endAt = end;
    this.loop = loop && end - from <= SEGMENT_SECONDS;
    this.playing = true;
    this.onState(true);
    this.playSegment(from);
  }
  /** Renders and plays one piece of at most SEGMENT_SECONDS; long ranges continue with the next piece when this one ends. */
  private playSegment(from: number): void {
    const ctx = this.audioCtx(), end = Math.min(this.endAt, from + SEGMENT_SECONDS), loop = this.loop;
    const mix = this.override ? renderProject(this.override, this.sources, { from, to: end }) : this.mix(from, end);
    const buf = ctx.createBuffer(2, Math.max(1, mix.channels[0].length), mix.sampleRate);
    buf.copyToChannel(mix.channels[0] as Float32Array<ArrayBuffer>, 0); buf.copyToChannel(mix.channels[1] as Float32Array<ArrayBuffer>, 1);
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = loop;
    const split = ctx.createChannelSplitter(2), merger = ctx.createChannelMerger(2);
    this.analyser = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.analyser.forEach((a) => { a.fftSize = 1024; });
    src.connect(split); split.connect(this.analyser[0], 0); split.connect(this.analyser[1], 1);
    split.connect(merger, 0, 0); split.connect(merger, 1, 1); merger.connect(ctx.destination);
    src.onended = () => {
      if (this.node !== src || this.loop) return;
      if (end < this.endAt) this.playSegment(end); else this.stop(true);
    };
    this.node = src; this.startedAt = ctx.currentTime; this.startFrom = from;
    src.start();
    cancelAnimationFrame(this.raf);
    this.tick();
  }
  private tick = (): void => {
    if (!this.playing) return;
    let t = this.position;
    if (this.loop && this.ctx) { const span = this.endAt - this.rangeStart; t = this.rangeStart + (((this.ctx.currentTime - this.startedAt) % span) + span) % span; }
    this.onTime(t);
    const lv = this.analyser.map((a) => { const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m; });
    this.onMeter({ l: lv[0] ?? 0, r: lv[1] ?? 0 });
    this.raf = requestAnimationFrame(this.tick);
  };
  stop(reached = false): void {
    cancelAnimationFrame(this.raf);
    const was = this.playing;
    const at = this.position;
    if (this.node) { this.node.onended = null; try { this.node.stop(); } catch { /* already stopped */ } this.node.disconnect(); this.node = null; }
    this.playing = false; this.loop = false;
    if (was) { this.startFrom = reached ? this.endAt : at; this.onTime(this.startFrom); this.onMeter({ l: 0, r: 0 }); this.onState(false); }
  }

  /* ---- recording ---- */
  get recording(): boolean { return this.mic !== null; }
  async startRecording(): Promise<void> {
    if (this.mic) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This environment has no microphone access.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = this.audioCtx();
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(analyser);
    const recorder = new MediaRecorder(stream), chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start(250);
    this.mic = { stream, recorder, chunks, analyser };
    const meter = (): void => {
      if (!this.mic) return;
      const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v));
      this.onMeter({ l: m, r: m }); requestAnimationFrame(meter);
    };
    meter();
  }
  /** Stops recording and returns the take decoded to PCM (the encoded original is kept in `blob`). */
  async stopRecording(): Promise<{ source: Source; blob: Blob } | null> {
    const mic = this.mic; if (!mic) return null;
    this.mic = null;
    const done = new Promise<void>((resolve) => { mic.recorder.onstop = () => resolve(); });
    mic.recorder.stop(); await done;
    mic.stream.getTracks().forEach((t) => t.stop());
    this.onMeter({ l: 0, r: 0 });
    const blob = new Blob(mic.chunks, { type: mic.recorder.mimeType || 'audio/webm' });
    return { source: await decodeAudioBytes(new Uint8Array(await blob.arrayBuffer())), blob };
  }

  /* ---- export ---- */
  exportWav(bits: WavBits, from = 0, to?: number, dither = true): Uint8Array {
    const mix = this.mix(from, to);
    if (mix.channels[0].length * 2 * (bits / 8) > MAX_EXPORT_BYTES) throw new Error(`the WAV would be over ${MAX_EXPORT_BYTES / 1_000_000} MB — export a shorter range, or use 16-bit`);
    return encodeWav([mix.channels[0], mix.channels[1]], mix.sampleRate, bits, dither && bits === 16);
  }
  /** Records the mix in real time with MediaRecorder (Opus in WebM): takes as long as the audio itself. */
  async exportWebm(from = 0, to?: number, onProgress?: (f: number) => void): Promise<Blob> {
    const mix = this.mix(from, to), ctx = new AudioContext({ sampleRate: mix.sampleRate });
    const buf = ctx.createBuffer(2, Math.max(1, mix.channels[0].length), mix.sampleRate);
    buf.copyToChannel(mix.channels[0] as Float32Array<ArrayBuffer>, 0); buf.copyToChannel(mix.channels[1] as Float32Array<ArrayBuffer>, 1);
    const dest = ctx.createMediaStreamDestination(), src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { void ctx.close(); throw new Error('This browser cannot record WebM/Opus.'); }
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 160000 }), chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const finished = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' })); });
    rec.start(250); src.start();
    const t0 = ctx.currentTime, total = buf.duration;
    await new Promise<void>((resolve) => { const iv = window.setInterval(() => { onProgress?.(Math.min(1, (ctx.currentTime - t0) / total)); }, 150); src.onended = () => { window.clearInterval(iv); resolve(); }; });
    await new Promise((r) => window.setTimeout(r, 200));
    rec.stop();
    const blob = await finished; void ctx.close();
    return blob;
  }

  dispose(): void { this.stop(); void this.mic?.recorder.state; this.mic?.stream.getTracks().forEach((t) => t.stop()); this.mic = null; void this.ctx?.close(); this.ctx = null; this.cache.clear(); }
  /** Number of clips whose asset is not loaded (for status messages). */
  missingAssets(): number { return allClips(this.project).filter((c) => c.asset && !this.sources[c.asset]).length; }
}
