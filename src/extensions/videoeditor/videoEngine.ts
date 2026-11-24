/** Video Editor renderer, player and exporter (browser only). Draws the layers `layersAt()` describes onto a 2D canvas,
 * plays video/audio through Web Audio, synthesises generated sound, and records the result to WebM in real time. */
import { readBinaryFile } from '../../lib/tauriClient';
import {
  BLENDS, FONT_STACKS, findAsset, gainAt, layersAt, projectDuration, synthEvents, type Asset, type Clip, type Project, type RenderLayer, type ShapeProps,
} from './video';

interface Loaded { asset: Asset; url: string; image?: HTMLImageElement; missing?: string }
interface Playing { el: HTMLMediaElement; gain?: GainNode; src?: MediaElementAudioSourceNode }
export interface AssetMeta { duration: number; width: number; height: number }

const toBlobUrl = (base64: string, mime: string): string => {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
};
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/* ---------------------------------------------------------------- drawing */

function shapePath(ctx: CanvasRenderingContext2D, s: ShapeProps, w: number, h: number): void {
  const x = -w / 2, y = -h / 2;
  ctx.beginPath();
  switch (s.shape) {
    case 'ellipse': ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'triangle': ctx.moveTo(0, y); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2); ctx.closePath(); break;
    case 'star': {
      for (let i = 0; i < 10; i++) { const r = i % 2 === 0 ? 1 : 0.42, a = -Math.PI / 2 + (i * Math.PI) / 5; const px = Math.cos(a) * r * (w / 2), py = Math.sin(a) * r * (h / 2); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
      ctx.closePath(); break;
    }
    case 'heart': ctx.moveTo(0, h * 0.38); ctx.bezierCurveTo(0, h * 0.1, -w * 0.5, h * 0.05, -w * 0.5, -h * 0.2); ctx.bezierCurveTo(-w * 0.5, -h * 0.5, -w * 0.05, -h * 0.5, 0, -h * 0.22); ctx.bezierCurveTo(w * 0.05, -h * 0.5, w * 0.5, -h * 0.5, w * 0.5, -h * 0.2); ctx.bezierCurveTo(w * 0.5, h * 0.05, 0, h * 0.1, 0, h * 0.38); ctx.closePath(); break;
    case 'arrow': { const head = w * 0.4; ctx.moveTo(x, -h * 0.2); ctx.lineTo(w / 2 - head, -h * 0.2); ctx.lineTo(w / 2 - head, y); ctx.lineTo(w / 2, 0); ctx.lineTo(w / 2 - head, h / 2); ctx.lineTo(w / 2 - head, h * 0.2); ctx.lineTo(x, h * 0.2); ctx.closePath(); break; }
    default: {
      const r = Math.min(w, h) * s.radius;
      if (r > 0) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
  }
}

function fillFor(ctx: CanvasRenderingContext2D, s: ShapeProps, w: number, h: number): string | CanvasGradient {
  if (!s.color2) return s.color;
  const a = (s.angle * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a), len = Math.abs(w * dx) + Math.abs(h * dy);
  const g = ctx.createLinearGradient((-dx * len) / 2, (-dy * len) / 2, (dx * len) / 2, (dy * len) / 2);
  g.addColorStop(0, s.color); g.addColorStop(1, s.color2);
  return g;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

let noiseCanvas: HTMLCanvasElement | null = null;
function noisePattern(): HTMLCanvasElement {
  if (noiseCanvas) return noiseCanvas;
  noiseCanvas = document.createElement('canvas'); noiseCanvas.width = noiseCanvas.height = 160;
  const c = noiseCanvas.getContext('2d')!; const img = c.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  c.putImageData(img, 0, 0);
  return noiseCanvas;
}

type VisualSource = HTMLVideoElement | HTMLImageElement | null;

function drawBody(ctx: CanvasRenderingContext2D, layer: RenderLayer, W: number, H: number, source: VisualSource, project: Project): void {
  const clip = layer.clip;
  if (clip.kind === 'video' || clip.kind === 'image') {
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : 0;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : 0;
    if (!source || !sw || !sh) {
      ctx.fillStyle = '#2b2f36'; ctx.fillRect(-W / 2, -H / 2, W, H);
      ctx.fillStyle = '#9aa3ad'; ctx.font = `${Math.round(H * 0.03)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(findAsset(project, clip.asset)?.name ?? 'media', 0, 0);
      return;
    }
    const k = clip.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    ctx.drawImage(source, (-sw * k) / 2, (-sh * k) / 2, sw * k, sh * k);
  } else if (clip.kind === 'shape' && clip.shape) {
    const s = clip.shape, w = s.w * W, h = s.h * H;
    shapePath(ctx, s, w, h); ctx.fillStyle = fillFor(ctx, s, w, h); ctx.fill();
    if (s.stroke && s.strokeWidth > 0) { ctx.strokeStyle = s.stroke; ctx.lineWidth = s.strokeWidth; ctx.stroke(); }
  } else if (clip.kind === 'sticker') {
    ctx.font = `${Math.round(H * 0.16)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(clip.sticker, 0, 0);
  } else if (clip.kind === 'text' && clip.text) {
    const t = clip.text, px = (t.size / 100) * H;
    ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${px}px ${FONT_STACKS[t.font]}`;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${t.letterSpacing}px`;
    ctx.textBaseline = 'middle'; ctx.textAlign = t.align;
    const shown = t.text.slice(0, Math.ceil(t.text.length * layer.reveal));
    const lines = wrapText(ctx, shown, t.width * W);
    const lh = px * t.lineHeight, total = lines.length * lh;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
    const ax = t.align === 'left' ? -widest / 2 : t.align === 'right' ? widest / 2 : 0;
    if (t.bg) { const pad = px * 0.35; ctx.fillStyle = t.bg; ctx.beginPath(); ctx.roundRect(-widest / 2 - pad, -total / 2 - pad * 0.5, widest + pad * 2, total + pad, px * 0.25); ctx.fill(); }
    lines.forEach((line, i) => {
      const y = -total / 2 + lh * (i + 0.5);
      if (t.shadow && !t.bg) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = px * 0.18; ctx.shadowOffsetY = px * 0.06; }
      if (t.strokeWidth > 0 && t.stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = (t.strokeWidth / 100) * px * 1.5; ctx.strokeStyle = t.stroke; ctx.strokeText(line, ax, y); }
      ctx.fillStyle = t.color; ctx.fillText(line, ax, y);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    });
    (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
  }
}

/** Draws one layer — transform, blend, filter, wipe and the overlay effects — onto the canvas. */
export function drawLayer(ctx: CanvasRenderingContext2D, layer: RenderLayer, W: number, H: number, source: VisualSource, project: Project): void {
  const clip = layer.clip;
  ctx.save();
  if (layer.wipe) {
    const { dir, p } = layer.wipe;
    ctx.beginPath();
    if (dir === 'left') ctx.rect(W * (1 - p), 0, W * p, H); else if (dir === 'right') ctx.rect(0, 0, W * p, H);
    else if (dir === 'up') ctx.rect(0, H * (1 - p), W, H * p); else ctx.rect(0, 0, W, H * p);
    ctx.clip();
  }
  ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity));
  ctx.globalCompositeOperation = (BLENDS[clip.blend] ?? 'source-over') as GlobalCompositeOperation;
  ctx.translate(W / 2 + layer.x * W, H / 2 + layer.y * H);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.scale(layer.scale * (clip.flipX ? -1 : 1), layer.scale * (clip.flipY ? -1 : 1));
  const draw = (css: string, alpha = 1, dx = 0, op?: GlobalCompositeOperation): void => {
    ctx.save(); ctx.filter = css; ctx.globalAlpha *= alpha; if (op) ctx.globalCompositeOperation = op; ctx.translate(dx, 0); drawBody(ctx, layer, W, H, source, project); ctx.restore();
  };
  draw(layer.css);
  if (layer.effect === 'glow') draw(`${layer.css === 'none' ? '' : layer.css + ' '}blur(${Math.round(H * 0.012)}px) brightness(1.4)`.trim(), 0.55 * layer.effectAmount + 0.15, 0, 'screen');
  if ((layer.effect === 'rgb' || layer.effect === 'glitch') && (layer.effect === 'rgb' || layer.fx.dx !== 0)) {
    const off = W * 0.012 * (0.4 + layer.effectAmount);
    draw(`${layer.css === 'none' ? '' : layer.css + ' '}hue-rotate(-60deg) saturate(2)`.trim(), 0.5, -off, 'screen');
    draw(`${layer.css === 'none' ? '' : layer.css + ' '}hue-rotate(120deg) saturate(2)`.trim(), 0.5, off, 'screen');
  }
  ctx.restore();
  const vignette = Math.max(clip.adjust.vignette / 100, layer.effect === 'vignette' ? layer.effectAmount : 0);
  if (vignette > 0 && (clip.kind === 'video' || clip.kind === 'image')) {
    ctx.save(); ctx.globalAlpha = layer.opacity;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.85 * vignette})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
  const grain = Math.max(clip.adjust.grain / 100, layer.effect === 'grain' ? layer.effectAmount : 0);
  if (grain > 0) {
    ctx.save(); ctx.globalAlpha = 0.22 * grain * layer.opacity; ctx.globalCompositeOperation = 'overlay';
    const n = noisePattern(); const ox = Math.floor(Math.random() * 120), oy = Math.floor(Math.random() * 120);
    for (let y = -oy; y < H; y += n.height) for (let x = -ox; x < W; x += n.width) ctx.drawImage(n, x, y);
    ctx.restore();
  }
}

/** The background and every layer of one frame, drawn at the canvas's own resolution. */
export function paintFrame(ctx: CanvasRenderingContext2D, project: Project, t: number, W: number, H: number, sourceOf: (layer: RenderLayer) => VisualSource): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = project.background || '#000'; ctx.fillRect(0, 0, W, H);
  const layers = layersAt(project, t);
  let flash = 0;
  for (const layer of layers) { drawLayer(ctx, layer, W, H, sourceOf(layer), project); flash = Math.max(flash, layer.flash); }
  if (flash > 0.001) { ctx.globalAlpha = Math.min(1, flash * 0.9); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}

/* ---------------------------------------------------------------- engine */

export class VideoEngine {
  project: Project;
  canvas: HTMLCanvasElement;
  time = 0;
  playing = false;
  onTime?: (t: number) => void;
  onState?: (playing: boolean) => void;
  onMeta?: (id: string, meta: AssetMeta) => void;
  private ctx2d: CanvasRenderingContext2D;
  private loaded = new Map<string, Loaded>();
  private loading = new Map<string, Promise<void>>();
  private players = new Map<string, Playing>();
  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private synthNodes: { stop: () => void }[] = [];
  private synthGains = new Map<string, GainNode>();
  private raf = 0;
  private startWall = 0;
  private startT = 0;
  private disposed = false;
  private silent: boolean;

  constructor(project: Project, canvas?: HTMLCanvasElement, silent = false) {
    this.project = project; this.silent = silent;
    this.canvas = canvas ?? document.createElement('canvas');
    this.ctx2d = this.canvas.getContext('2d', { alpha: false })!;
    this.fit();
  }

  /** Canvas pixel size = project size, scaled down to at most `maxSide` for preview. */
  fit(maxSide = 960): void {
    const k = Math.min(1, maxSide / Math.max(this.project.width, this.project.height));
    const w = Math.max(2, Math.round(this.project.width * k)), h = Math.max(2, Math.round(this.project.height * k));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  setProject(project: Project): void {
    const sizeChanged = project.width !== this.project.width || project.height !== this.project.height;
    this.project = project;
    if (sizeChanged) this.fit();
    for (const [id, p] of this.players) { if (!this.findClip(id)) { this.dropPlayer(id, p); } }
    if (this.playing) { this.stopAudio(); this.scheduleAudio(this.time); }
    void this.loadAssets().then(() => { if (!this.playing) this.render(); });
    if (!this.playing) this.render();
  }
  private findClip(id: string): Clip | undefined { for (const t of this.project.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return c; } return undefined; }

  /* ---- media loading ---- */
  loadAssets(): Promise<void> {
    return Promise.all(this.project.assets.map((a) => this.loadAsset(a))).then(() => undefined);
  }
  private loadAsset(asset: Asset): Promise<void> {
    const existing = this.loaded.get(asset.id);
    if (existing && existing.asset.path === asset.path) return Promise.resolve();
    const pending = this.loading.get(asset.id);
    if (pending) return pending;
    const job = (async () => {
      try {
        const file = await readBinaryFile(asset.path);
        const url = toBlobUrl(file.data, file.mime || (asset.kind === 'video' ? 'video/webm' : asset.kind === 'audio' ? 'audio/mpeg' : 'image/png'));
        const entry: Loaded = { asset, url };
        if (asset.kind === 'image') {
          const img = new Image(); img.src = url; await img.decode(); entry.image = img;
          this.onMeta?.(asset.id, { duration: 0, width: img.naturalWidth, height: img.naturalHeight });
        } else {
          const probe = document.createElement(asset.kind === 'video' ? 'video' : 'audio'); probe.preload = 'metadata'; probe.src = url;
          await new Promise<void>((resolve, reject) => { probe.onloadedmetadata = () => resolve(); probe.onerror = () => reject(new Error('the browser cannot decode this media file')); setTimeout(() => reject(new Error('timed out reading the media')), 15000); });
          let duration = probe.duration;
          if (!Number.isFinite(duration)) { // MediaRecorder WebM files report Infinity until the end is seeked
            probe.currentTime = 1e9; await new Promise<void>((r) => { probe.ontimeupdate = () => r(); setTimeout(r, 2000); }); duration = Number.isFinite(probe.duration) ? probe.duration : probe.currentTime;
          }
          this.onMeta?.(asset.id, { duration, width: probe instanceof HTMLVideoElement ? probe.videoWidth : 0, height: probe instanceof HTMLVideoElement ? probe.videoHeight : 0 });
        }
        this.loaded.set(asset.id, entry);
      } catch (error) {
        this.loaded.set(asset.id, { asset, url: '', missing: error instanceof Error ? error.message : String(error) });
      } finally { this.loading.delete(asset.id); }
    })();
    this.loading.set(asset.id, job);
    return job;
  }
  assetError(id: string): string | undefined { return this.loaded.get(id)?.missing; }

  private playerFor(clip: Clip): Playing | null {
    const have = this.players.get(clip.id);
    if (have) return have;
    const entry = this.loaded.get(clip.asset);
    if (!entry || !entry.url || (clip.kind !== 'video' && clip.kind !== 'audio')) return null;
    const el = document.createElement(entry.asset.kind === 'audio' || clip.kind === 'audio' ? 'audio' : 'video') as HTMLMediaElement;
    el.src = entry.url; el.preload = 'auto'; el.crossOrigin = 'anonymous';
    if (this.silent) el.muted = true;
    const player: Playing = { el };
    this.players.set(clip.id, player);
    if (this.audio) this.connect(player);
    return player;
  }
  private connect(player: Playing): void {
    if (!this.audio || !this.master || player.src) return;
    try { player.src = this.audio.createMediaElementSource(player.el); player.gain = this.audio.createGain(); player.src.connect(player.gain); player.gain.connect(this.master); } catch { /* element already routed */ }
  }
  private dropPlayer(id: string, p: Playing): void { p.el.pause(); p.el.removeAttribute('src'); p.el.load(); p.gain?.disconnect(); p.src?.disconnect(); this.players.delete(id); }
  private sourceOf = (layer: RenderLayer): VisualSource => {
    const clip = layer.clip;
    if (clip.kind === 'image') return this.loaded.get(clip.asset)?.image ?? null;
    if (clip.kind !== 'video') return null;
    const p = this.playerFor(clip);
    return p && p.el instanceof HTMLVideoElement && p.el.readyState >= 2 ? p.el : null;
  };

  /* ---- drawing & seeking ---- */
  render(t = this.time): void {
    if (this.disposed) return;
    paintFrame(this.ctx2d, this.project, t, this.canvas.width, this.canvas.height, this.sourceOf);
  }
  /** Moves the playhead; resolves once the video frames for that moment are ready and drawn. */
  async seek(t: number, wait = true): Promise<void> {
    this.time = Math.max(0, t);
    if (this.playing) { this.stopAudio(); this.scheduleAudio(this.time); this.startWall = performance.now(); this.startT = this.time; }
    else await this.syncVideos(this.time, wait);
    this.render(); this.onTime?.(this.time);
  }
  private async syncVideos(t: number, wait: boolean): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const layer of layersAt(this.project, t)) {
      if (layer.clip.kind !== 'video') continue;
      const p = this.playerFor(layer.clip);
      if (!p) continue;
      const target = Math.min(layer.src, (Number.isFinite(p.el.duration) ? p.el.duration : layer.src) - 0.001);
      if (Math.abs(p.el.currentTime - target) < 0.02 && p.el.readyState >= 2) continue;
      p.el.currentTime = Math.max(0, target);
      if (wait) jobs.push(new Promise<void>((resolve) => { const done = (): void => { p.el.removeEventListener('seeked', done); resolve(); }; p.el.addEventListener('seeked', done); setTimeout(done, 1500); }));
    }
    await Promise.all(jobs);
  }

  /* ---- audio ---- */
  private ensureAudio(): void {
    if (this.audio || this.silent) return;
    this.audio = new AudioContext();
    this.master = this.audio.createGain();
    this.master.connect(this.audio.destination);
    for (const p of this.players.values()) this.connect(p);
  }
  private stopAudio(): void {
    for (const n of this.synthNodes) { try { n.stop(); } catch { /* already stopped */ } }
    this.synthNodes = []; this.synthGains.clear();
    for (const p of this.players.values()) p.el.pause();
  }
  private scheduleAudio(from: number): void {
    const ctx = this.audio; if (!ctx || !this.master) return;
    const now = ctx.currentTime + 0.03;
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'synth' || !clip.synth || clip.muted || track.muted) continue;
        const end = clip.start + clip.duration;
        if (end <= from) continue;
        const bus = ctx.createGain(); bus.gain.value = gainAt(clip, Math.max(0, from - clip.start)); bus.connect(this.master);
        this.synthGains.set(clip.id, bus);
        for (const e of synthEvents(clip.synth, clip.duration)) {
          const at = clip.start + e.t, stopAt = Math.min(at + e.dur, end);
          if (stopAt <= from) continue;
          const when = now + Math.max(0, at - from), until = now + (stopAt - from);
          const env = ctx.createGain(); env.connect(bus);
          env.gain.setValueAtTime(0, when); env.gain.linearRampToValueAtTime(e.gain, when + Math.min(0.02, (until - when) / 3)); env.gain.setValueAtTime(e.gain, Math.max(when, until - Math.min(0.08, (until - when) / 2))); env.gain.linearRampToValueAtTime(0, until);
          let node: AudioScheduledSourceNode;
          if (e.kind === 'osc') {
            const o = ctx.createOscillator(); o.type = e.wave; o.frequency.setValueAtTime(e.freq, when); if (e.sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, e.sweepTo), until);
            if (e.lowpass) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = e.lowpass; o.connect(f); f.connect(env); } else o.connect(env);
            node = o;
          } else {
            const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * Math.max(0.05, e.dur)), ctx.sampleRate); const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            const s = ctx.createBufferSource(); s.buffer = buf; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = e.lowpass ?? 8000; s.connect(f); f.connect(env); node = s;
          }
          node.start(when); node.stop(until + 0.05); this.synthNodes.push({ stop: () => node.stop() });
        }
      }
    }
  }
  private tickMedia(t: number): void {
    const ctx = this.audio;
    const active = new Set<string>();
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'synth') { const bus = this.synthGains.get(clip.id); if (bus && ctx) bus.gain.setTargetAtTime(track.muted ? 0 : gainAt(clip, t - clip.start), ctx.currentTime, 0.02); continue; }
        if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
        const hidden = clip.kind === 'video' && track.hidden;
        const inRange = t >= clip.start - 0.001 && t < clip.start + clip.duration;
        const near = t >= clip.start - 1 && t < clip.start + clip.duration + 0.2;
        if (!near) { const p = this.players.get(clip.id); if (p) this.dropPlayer(clip.id, p); continue; }
        const p = this.playerFor(clip);
        if (!p) continue;
        active.add(clip.id);
        const want = clip.offset + (t - clip.start) * clip.speed;
        if (inRange && !hidden || (inRange && clip.kind === 'audio')) {
          p.el.playbackRate = clip.speed;
          if (p.el.paused) { p.el.currentTime = Math.max(0, want); void p.el.play().catch(() => undefined); }
          else if (Math.abs(p.el.currentTime - want) > 0.3) p.el.currentTime = Math.max(0, want);
          if (p.gain && ctx) p.gain.gain.setTargetAtTime(track.muted ? 0 : gainAt(clip, t - clip.start), ctx.currentTime, 0.02);
        } else if (!p.el.paused) p.el.pause();
        else if (t < clip.start && Math.abs(p.el.currentTime - clip.offset) > 0.05) p.el.currentTime = clip.offset; // pre-roll
      }
    }
  }

  /* ---- transport ---- */
  play(): void {
    if (this.playing) return;
    const dur = projectDuration(this.project);
    if (dur <= 0) return;
    if (this.time >= dur - 0.05) this.time = 0;
    this.ensureAudio();
    void this.audio?.resume();
    this.playing = true; this.startWall = performance.now(); this.startT = this.time;
    this.scheduleAudio(this.time);
    this.onState?.(true);
    const loop = (): void => {
      if (!this.playing || this.disposed) return;
      const t = this.startT + (performance.now() - this.startWall) / 1000;
      if (t >= dur) { this.time = dur; this.pause(); this.render(dur - 0.001); this.onTime?.(dur); return; }
      this.time = t; this.tickMedia(t); this.render(t); this.onTime?.(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  pause(): void {
    if (!this.playing) return;
    this.playing = false; cancelAnimationFrame(this.raf);
    this.stopAudio();
    this.onState?.(false);
  }

  /* ---- export ---- */
  /** Plays the whole video once into a MediaRecorder (real time) and returns the WebM. */
  async exportWebM(onProgress?: (fraction: number) => void, opts: { maxSide?: number; bitrate?: number } = {}): Promise<Blob> {
    this.pause();
    const dur = projectDuration(this.project);
    if (dur <= 0) throw new Error('the video is empty');
    if (typeof MediaRecorder === 'undefined') throw new Error('this browser cannot record video (MediaRecorder is missing)');
    const prevSilent = this.silent;
    this.fit(opts.maxSide ?? 1920);
    await this.loadAssets();
    this.ensureAudio();
    await this.audio?.resume();
    this.dest = this.audio!.createMediaStreamDestination();
    this.master!.connect(this.dest);
    const stream = this.canvas.captureStream(this.project.fps);
    for (const track of this.dest.stream.getAudioTracks()) stream.addTrack(track);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate ?? 8_000_000, audioBitsPerSecond: 160_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    await this.seek(0);
    const prev = this.onTime;
    this.onTime = (t) => { onProgress?.(Math.min(1, t / dur)); prev?.(t); };
    rec.start(250);
    const ended = new Promise<void>((resolve) => { const off = this.onState; this.onState = (p) => { off?.(p); if (!p) resolve(); }; });
    this.play();
    await ended;
    await new Promise((r) => setTimeout(r, 250));
    rec.stop();
    const blob = await done;
    this.onTime = prev; this.master?.disconnect(this.dest!); this.dest = null;
    this.silent = prevSilent; this.fit();
    this.render(0);
    return blob;
  }

  /** One finished frame as a PNG/JPEG data URL at the full project size (or capped to maxSide). */
  async still(t: number, type = 'image/png', maxSide = 1920): Promise<string> {
    await this.loadAssets();
    this.fit(maxSide); await this.seek(t); const url = this.canvas.toDataURL(type, 0.92); this.fit(); this.render();
    return url;
  }

  dispose(): void {
    this.disposed = true; this.pause();
    for (const [id, p] of this.players) this.dropPlayer(id, p);
    for (const l of this.loaded.values()) if (l.url) URL.revokeObjectURL(l.url);
    void this.audio?.close();
  }
}

/** A grid of frames (with timestamps) for the agent to look at: renders each time offscreen and returns a PNG data URL. */
export async function contactSheet(project: Project, times: number[], cellWidth = 360): Promise<{ dataUrl: string; width: number; height: number }> {
  const engine = new VideoEngine(project, undefined, true);
  try {
    await engine.loadAssets();
    const cellH = Math.round((cellWidth * project.height) / project.width), label = 22;
    const cols = Math.min(times.length, project.height > project.width ? 6 : 3), rows = Math.ceil(times.length / cols);
    const sheet = document.createElement('canvas'); sheet.width = cols * cellWidth + (cols + 1) * 6; sheet.height = rows * (cellH + label) + (rows + 1) * 6;
    const c = sheet.getContext('2d')!; c.fillStyle = '#15171c'; c.fillRect(0, 0, sheet.width, sheet.height);
    engine.canvas.width = cellWidth; engine.canvas.height = cellH;
    for (const [i, t] of times.entries()) {
      await engine.seek(t);
      const x = 6 + (i % cols) * (cellWidth + 6), y = 6 + Math.floor(i / cols) * (cellH + label + 6);
      c.drawImage(engine.canvas, x, y + label, cellWidth, cellH);
      c.fillStyle = '#e8eaed'; c.font = '14px sans-serif'; c.textBaseline = 'middle'; c.fillText(`${t.toFixed(2)}s`, x + 2, y + label / 2);
    }
    return { dataUrl: sheet.toDataURL('image/png'), width: sheet.width, height: sheet.height };
  } finally { engine.dispose(); }
}
