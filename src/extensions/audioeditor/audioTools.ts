/** Agent tools for the Audio Editor. Projects are plain files (.pigry/audio/<owner>/<name>.audio.json, one folder per agent).
 * The tools create them, apply editing operations (clips, effects, fades, labels, master chain…), analyse loudness / peaks /
 * silence / clipping numerically, show waveform + spectrogram images the agent can look at, export WAV / WebM, and open the editor. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { writeWorktreeBinary, writeWorktreeBinaryChunked } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import { AUDIO_DIR, FX, FX_TYPES, OP_HELP, SAMPLE_RATES, applyOps, checkProject, emptyProject, formatInfo, parseOps, projectDuration, summarizeProject, templateOps, type Project } from './audio';
import { analyze, describeAnalysis, renderProject } from './audioDsp';
import { AudioEngine, previewImage } from './audioEngine';
import { audioPath, flushAudioEditors, listAudioRefs, loadAudio, requestOpenAudio, resolveAudio, saveAudio } from './audioStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.audio ?? '').trim();
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const fail = (message: string): string => `error: ${message}`;
const asList = (value: unknown): unknown => { if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } } return value; };

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; project: Project; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see audio_list)');
  await flushAudioEditors();
  const resolved = await resolveAudio(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see audio_list)`);
  try {
    const { project, warnings } = await loadAudio(resolved.ref);
    return { ref: resolved.ref, project, warnings };
  } catch (error) {
    return fail(`could not read audio project "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exportPath(raw: unknown, fallback: string, exts: string[]): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !exts.some((e) => path.toLowerCase().endsWith(e))) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${exts.join(' or ')}, e.g. ${AUDIO_DIR}podcast/final${exts[0]}` };
  }
  return { path };
}
const rangeOf = (input: Record<string, unknown>, dur: number): [number, number] => {
  const from = Math.max(0, Number(input.from) || 0), to = input.to !== undefined && Number.isFinite(Number(input.to)) ? Math.min(dur, Number(input.to)) : dur;
  return [from, Math.max(from + 0.01, to)];
};

const FX_HELP = FX_TYPES.filter((t) => t !== 'ramp').map((t) => `${t} (${Object.entries(FX[t].params).map(([k, s]) => `${k}${s.unit ? ' ' + s.unit : ''} ${typeof s.def === 'boolean' ? s.def : s.choices ? s.choices.join('|') : `${s.min}…${s.max}, default ${s.def}`}`).join('; ')})`).join('\n');
const OPS_HELP = `Operations (times are seconds on the timeline; track and clip ids come from audio_read; effects are stored on the clips and can be removed again with effect_remove):\n${OP_HELP}\nEffects and their params:\n${FX_HELP}\nSample rates: ${SAMPLE_RATES.join(', ')}. "last" stands for the clip the previous op created.`;
const opsSchema = { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order, all-or-nothing (a JSON string of the array is also accepted)' };

async function mixOf(project: Project): Promise<{ engine: AudioEngine; missing: string[] }> {
  const engine = new AudioEngine(project);
  const missing = await engine.loadAssets();
  return { engine, missing };
}

export const AUDIO_TOOLS: ToolSpec[] = [
  {
    id: 'audio_list',
    name: 'audio_list',
    description: 'List the audio projects saved in the workspace (.pigry/audio/<owner>/) with their length and track count.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushAudioEditors();
      const refs = await listAudioRefs();
      if (refs.length === 0) return 'No audio projects yet. Create one with audio_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try { const { project } = await loadAudio(ref); rows.push(`- ${refKey(ref)}: "${project.title}" (${project.sampleRate} Hz, ${projectDuration(project)}s, ${project.tracks.length} track(s), ${project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips)`); }
        catch { rows.push(`- ${refKey(ref)}: (unreadable file)`); }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'audio_read',
    name: 'audio_read',
    description: 'Read an audio project as text: sample rate, imported files, every track and clip (ids, times, speed/pitch, effect chains), labels, master chain, plus review warnings (overlaps, effect order, missing limiter…). For numbers use audio_analyze, to SEE it use audio_preview.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Audio project name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const warnings = checkProject(opened.project);
      return `${refKey(opened.ref)}\n${summarizeProject(opened.project)}\nFormat: ${formatInfo(opened.project)}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : '\nReview: nothing to flag.'}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'audio_write',
    name: 'audio_write',
    description: `Create a new audio project (or replace your own with overwrite: true), optionally editing it straight away with ops. It is saved in your own folder and shown in the Audio Editor. template: "blank" (one stereo track), "podcast" (Voice mono + Music + Effects tracks and a −1 dB master limiter) or "music" (Drums, Bass, Melody + limiter). You can build sound without any file using generate (tones, chirps, noise, silence, click track); to edit recordings that are already in the workspace (WAV, MP3, FLAC, OGG, M4A, WebM…) register them with asset_add and put them on a track with clip_add. ${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name; becomes .pigry/audio/<you>/<name>.audio.json' },
        title: { type: 'string' },
        sampleRate: { type: 'number', enum: SAMPLE_RATES, description: 'Project rate in Hz (default 44100; 48000 for video work)' },
        template: { type: 'string', enum: ['blank', 'podcast', 'music'] },
        ops: opsSchema,
        overwrite: { type: 'boolean', description: 'Replace an existing project of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('audio_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.audio.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create audio projects in your own folder (${caller}/) — change another owner's project with audio_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushAudioEditors();
      if ((await listAudioRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`audio project "${refKey(ref)}" already exists. Read it with audio_read and change it with audio_edit, or pass overwrite: true to replace it.`);
      }
      const rate = input.sampleRate === undefined ? 44100 : Number(input.sampleRate);
      if (!SAMPLE_RATES.includes(rate)) return fail(`sampleRate must be one of ${SAMPLE_RATES.join(', ')}`);
      const { ops, errors } = input.ops === undefined ? { ops: [], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const template = String(input.template ?? 'blank');
      if (!['blank', 'podcast', 'music'].includes(template)) return fail('template must be blank, podcast or music');
      const base = applyOps(emptyProject(String(input.title ?? name).slice(0, 120), rate), templateOps(template));
      const result = applyOps(base.project, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveAudio(ref, result.project, 'agent');
      const warnings = checkProject(result.project);
      return `saved ${path}\n${summarizeProject(result.project)}${result.log.length ? '\n' + result.log.join('\n') : ''}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : ''}\nCheck it with audio_analyze and audio_preview; show it to the user with audio_open.`;
    },
  },
  {
    id: 'audio_edit',
    name: 'audio_edit',
    description: `Edit an existing audio project with a list of operations, applied in order and saved only if all of them work. Typical order for a recording: select/trim → range_delete the mistakes → effect dehum / noisereduce → eq → compressor → fades → master limiter or loudnorm → audio_analyze. ${OPS_HELP}`,
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Audio project name, or owner/name' }, ops: opsSchema }, required: ['name', 'ops'] },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('audio_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const result = applyOps(opened.project, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ' (these worked: ' + result.log.length + ')' : ''}`);
      const path = await saveAudio(opened.ref, result.project, 'agent');
      const warnings = checkProject(result.project);
      return `saved ${path}\n${result.log.join('\n')}\n${summarizeProject(result.project)}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'audio_preview',
    name: 'audio_preview',
    description: 'Render a picture of the project and attach it to your next turn so you can SEE the audio: one waveform strip and one spectrogram (0–12 kHz, bright = loud) per track on a shared time axis, with labels. Use it to spot clipping, silence, hum lines, hiss, missing highs, bad fades and misplaced clips; then fix with audio_edit. Optional from/to zoom in on a part; save_as keeps the PNG (under .pigry/).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Audio project name, or owner/name' },
        from: { type: 'number', description: 'Start second (default 0)' },
        to: { type: 'number', description: 'End second (default the end)' },
        save_as: { type: 'string', description: 'Optional .png path under .pigry/ to keep the image' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const dur = projectDuration(opened.project);
      if (dur <= 0) return fail('the project is empty — add clips first');
      const [from, to] = rangeOf(input, dur);
      try {
        const { engine, missing } = await mixOf(opened.project);
        const img = previewImage(opened.project, engine.sources, { from, to });
        engine.dispose();
        queueImage(img.dataUrl, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const target = exportPath(input.save_as, '', ['.png']);
          if ('error' in target) return fail(target.error);
          await writeWorktreeBinary(target.path, img.dataUrl.slice(img.dataUrl.indexOf(',') + 1));
          saved = ` and saved to ${target.path}`;
        }
        return `waveform + spectrogram of ${refKey(opened.ref)} (${from.toFixed(2)}–${to.toFixed(2)} s, ${img.width}×${img.height}px) is attached to your next turn${saved}.${missing.length ? ` Could not load: ${missing.join(', ')} (shown silent).` : ''} Look at it, then use audio_analyze for the numbers.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'audio_analyze',
    name: 'audio_analyze',
    description: 'Measure the rendered mix (or one track) numerically: peak and true peak (dBFS / dBTP), RMS, crest factor, DC offset, integrated / short-term / momentary loudness (LUFS, ITU-R BS.1770) and loudness range, noise floor, clipped samples with times, silent ranges, level per frequency band, 50/60 Hz hum detection, with notes on what to fix. Optional target_lufs (e.g. −16 podcast, −14 streaming music), from/to, track, silence_db / min_silence, and label_silence: true to add a label for every silent stretch.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Audio project name, or owner/name' },
        track: { type: 'string', description: 'Analyse only this track id (default: the whole mix incl. master chain)' },
        from: { type: 'number' }, to: { type: 'number' },
        target_lufs: { type: 'number', description: 'Loudness you are aiming for, to report the distance' },
        silence_db: { type: 'number', description: 'Level below which counts as silence (default −50 dBFS)' },
        min_silence: { type: 'number', description: 'Shortest silence to report in seconds (default 0.3)' },
        label_silence: { type: 'boolean', description: 'Also add a "silence" label over each silent range (saved)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const dur = projectDuration(opened.project);
      if (dur <= 0) return fail('the project is empty — add clips first');
      const [from, to] = rangeOf(input, dur);
      try {
        let project = opened.project;
        if (input.track) {
          const t = project.tracks.find((x) => x.id === String(input.track));
          if (!t) return fail(`no track "${String(input.track)}"`);
          project = { ...project, tracks: [{ ...t, solo: false, mute: false }], master: [] };
        }
        const { engine, missing } = await mixOf(project);
        const mix = renderProject(project, engine.sources, { from, to });
        engine.dispose();
        const a = analyze([mix.channels[0], mix.channels[1]], mix.sampleRate, { silenceDb: input.silence_db === undefined ? undefined : Number(input.silence_db), minSilence: input.min_silence === undefined ? undefined : Number(input.min_silence) });
        const target = input.target_lufs === undefined ? undefined : Number(input.target_lufs);
        let extra = '';
        if (input.label_silence === true && a.silences.length) {
          const res = applyOps(opened.project, a.silences.slice(0, 40).map((r) => ({ op: 'label_add', start: r.start + from, end: r.end + from, text: 'silence' })));
          if (res.error) extra = `\n(could not add labels: ${res.error})`;
          else { await saveAudio(opened.ref, res.project, 'agent'); extra = `\nAdded ${Math.min(40, a.silences.length)} silence label(s).`; }
        }
        return `${refKey(opened.ref)}${input.track ? ` track ${String(input.track)}` : ' (mix)'} ${from.toFixed(2)}–${to.toFixed(2)} s\n${describeAnalysis(a, target)}${missing.length ? `\nCould not load: ${missing.join(', ')} (silent).` : ''}${extra}`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'audio_export',
    name: 'audio_export',
    description: 'Export the finished mix (including the master chain). format "wav" writes PCM 16-bit (default, dithered), 24-bit, or 32-bit float via bits; format "webm" records Opus in real time (takes as long as the audio; keep under ~3 minutes). MP3 and FLAC are NOT supported — say so if the user needs them (they can convert the WAV with ffmpeg). Saved under .pigry/ — by default next to the project file. Optional from/to export a range.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Audio project name, or owner/name' },
        format: { type: 'string', enum: ['wav', 'webm'] },
        bits: { type: 'number', enum: [16, 24, 32], description: 'wav only: 16, 24 or 32 (float). Default 16' },
        from: { type: 'number' }, to: { type: 'number' },
        path: { type: 'string', description: 'Optional output path under .pigry/ ending in .wav or .webm' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '');
      if (format !== 'wav' && format !== 'webm') return fail('format must be "wav" or "webm" (MP3 and FLAC export are not supported)');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const dur = projectDuration(opened.project);
      if (dur <= 0) return fail('the project is empty — add clips first');
      const [from, to] = rangeOf(input, dur);
      if (format === 'webm' && to - from > 180) return fail(`webm export records in real time and this is ${Math.round(to - from)} s long — export WAV instead, or a shorter range`);
      const bits = input.bits === undefined ? 16 : Number(input.bits);
      if (![16, 24, 32].includes(bits)) return fail('bits must be 16, 24 or 32');
      const ext = `.${format}`;
      const target = exportPath(input.path, audioPath(opened.ref).replace(/\.audio\.json$/, ext), [ext]);
      if ('error' in target) return fail(target.error);
      const { engine, missing } = await mixOf(opened.project);
      try {
        if (format === 'wav') {
          const bytes = engine.exportWav(bits as 16 | 24 | 32, from, to);
          await writeWorktreeBinaryChunked(target.path, bytes);
          return `saved ${target.path} (${(bytes.length / 1_000_000).toFixed(1)} MB, ${(to - from).toFixed(1)} s, ${opened.project.sampleRate} Hz, stereo, ${bits === 32 ? '32-bit float' : bits + '-bit PCM'}).${missing.length ? ` Missing sources (silent): ${missing.join(', ')}.` : ''} Tell the user where it is.`;
        }
        const blob = await engine.exportWebm(from, to);
        await writeWorktreeBinaryChunked(target.path, new Uint8Array(await blob.arrayBuffer()));
        return `saved ${target.path} (${(blob.size / 1_000_000).toFixed(2)} MB, ${(to - from).toFixed(1)} s, Opus in WebM). For MP3 the user can convert it with ffmpeg.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      } finally { engine.dispose(); }
    },
  },
  {
    id: 'audio_open',
    name: 'audio_open',
    description: 'Open an audio project in the Audio Editor so the user can see it, play it and keep editing.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Audio project name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('audio_open needs a name');
      const resolved = await resolveAudio(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see audio_list)`);
      requestOpenAudio(refKey(resolved.ref));
      return `opened "${refKey(resolved.ref)}" in the Audio Editor`;
    },
  },
];
