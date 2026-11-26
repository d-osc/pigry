/** Agent tools for the Sheet menu. Workbooks are plain files (.pigry/sheets/<owner>/<name>.sheet.json, one folder per
 * agent). The tools create them (blank, from a template, from data or by importing CSV/TSV/XLSX), apply editing
 * operations, read values and formulas compactly, evaluate formulas, show a picture of the grid and charts,
 * export CSV/TSV/XLSX/HTML/PNG, and open the editor. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { readBinaryFile, readWorktreeFile, writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import {
  OP_HELP, SHEET_DIR, applyOps, checkWorkbook, emptyWorkbook, findSheet, parseDelimited, parseOps, rangeText, readRange, resolveRange, summarizeWorkbook,
  templateOps, toDelimited, usedRect, type Op, type Workbook,
} from './sheet';
import { Engine } from './engine';
import { FUNCTION_CATS, FUNCTIONS } from './functions';
import { isMatrix, rectText, type Rect } from './formula';
import { displayScalar, formatValue } from './numfmt';
import { chartPng, rangeHtml, renderPreview } from './sheetRender';
import { exportXlsx, importXlsx } from './sheetXlsx';
import { flushSheetEditors, listSheetRefs, loadSheet, requestOpenSheet, resolveSheet, saveSheet, sheetPath } from './sheetStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.sheet_name ?? input.workbook ?? '').trim();
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const fail = (message: string): string => `error: ${message}`;
const asList = (value: unknown): unknown => { if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } } return value; };

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; wb: Workbook; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see sheet_list)');
  await flushSheetEditors();
  const resolved = await resolveSheet(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see sheet_list)`);
  try {
    const { workbook, warnings } = await loadSheet(resolved.ref);
    return { ref: resolved.ref, wb: workbook, warnings };
  } catch (error) {
    return fail(`could not read workbook "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exportPath(raw: unknown, fallback: string, exts: string[]): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !exts.some((e) => path.toLowerCase().endsWith(e))) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${exts.join(' or ')}, e.g. ${SHEET_DIR}reports/sales${exts[0]}` };
  }
  return { path };
}
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pickSheet(wb: Workbook, input: Record<string, unknown>) {
  if (input.sheet === undefined || input.sheet === '') return wb.sheets.find((s) => !s.hidden) ?? wb.sheets[0];
  return findSheet(wb, input.sheet);
}
function pickRange(wb: Workbook, input: Record<string, unknown>, fallbackUsed = true): { sheet: Workbook['sheets'][number]; rect: Rect } | string {
  const s = pickSheet(wb, input);
  if (!s) return fail(`no sheet "${String(input.sheet)}" (sheets: ${wb.sheets.map((x) => x.name).join(', ')})`);
  if (typeof input.range === 'string' && input.range.trim()) {
    const res = resolveRange(wb, input.range, s);
    if (!res) return fail(`"${input.range}" is not a range like A1:D20, C:C or Sheet2!A1:B9`);
    return res;
  }
  const used = usedRect(s);
  if (!used || !fallbackUsed) return { sheet: s, rect: { r1: 0, c1: 0, r2: Math.min(s.rows - 1, 19), c2: Math.min(s.cols - 1, 9) } };
  return { sheet: s, rect: { r1: 0, c1: 0, r2: used.r2, c2: used.c2 } };
}

const FN_HELP = FUNCTION_CATS.map((cat) => `${cat}: ${Object.keys(FUNCTIONS).filter((n) => FUNCTIONS[n].cat === cat).sort().join(', ')}`).join('\n');
const OPS_HELP = `Operations (ranges are A1 notation, optionally with a sheet: "Data!A1:C20"; "sheet" on an op picks the sheet for plain ranges; rows are numbers from 1, columns letters):\n${OP_HELP}`;
const opsSchema = { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order, all-or-nothing (a JSON string of the array is also accepted)' };

async function importFile(path: string, title: string): Promise<{ wb: Workbook; note: string } | string> {
  const p = path.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  if (p.split('/').includes('..') || /^[A-Za-z]:/.test(p)) return fail('import must be a path inside the workspace');
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls') || lower.endsWith('.ods')) {
    const file = await readBinaryFile(p);
    const { workbook, warnings } = await importXlsx(fromBase64(file.data), title);
    return { wb: workbook, note: `imported ${p} (${workbook.sheets.length} sheet(s); values, formulas, number formats, merges and sizes — cell styles, charts and validation are not read from Excel files)${warnings.length ? `; ${warnings.join('; ')}` : ''}` };
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const file = await readWorktreeFile(p);
    if (file.binary || file.tooLarge) return fail(`${p} is not a readable text file`);
    const delim = lower.endsWith('.tsv') || (!lower.endsWith('.csv') && file.content.includes('\t')) ? '\t' : file.content.split('\n')[0].split(';').length > file.content.split('\n')[0].split(',').length ? ';' : ',';
    const grid = parseDelimited(file.content, delim);
    const res = applyOps(emptyWorkbook(title), [{ op: 'set', range: 'A1', values: grid }]);
    if (res.error) return fail(res.error);
    return { wb: res.workbook, note: `imported ${p}: ${grid.length} row(s) × ${Math.max(0, ...grid.map((r) => r.length))} column(s), delimiter ${delim === '\t' ? 'tab' : JSON.stringify(delim)} (numbers, %, currency and dates were recognised)` };
  }
  return fail('import supports .csv, .tsv, .txt, .xlsx, .xlsm, .xls and .ods files');
}

export const SHEET_TOOLS: ToolSpec[] = [
  {
    id: 'sheet_list',
    name: 'sheet_list',
    description: 'List the spreadsheets (workbooks) saved in the workspace (.pigry/sheets/<owner>/) with their sheets and sizes.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushSheetEditors();
      const refs = await listSheetRefs();
      if (refs.length === 0) return 'No spreadsheets yet. Create one with sheet_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try { const { workbook } = await loadSheet(ref); rows.push(`- ${refKey(ref)}: "${workbook.title}" — ${workbook.sheets.map((s) => { const u = usedRect(s); return `${s.name}${u ? ` ${rectText(u)}` : ' (empty)'}`; }).join(', ')}`); }
        catch { rows.push(`- ${refKey(ref)}: (unreadable file)`); }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'sheet_read',
    name: 'sheet_read',
    description: 'Read a workbook compactly: an outline of every sheet (size, used range, frozen panes, validation, conditional formats, filters, charts, named ranges), then the cells of a range as "A1=shown value ‹=FORMULA›" one row per line, plus review warnings (formula errors, numbers stored as text, constants typed inside formulas, odd formulas in a column, validation breaks). Without range it reads the used part of the first visible sheet (up to 2000 cells). formats: true adds each cell\'s format.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workbook name, or owner/name' },
        sheet: { type: 'string', description: 'Sheet name (default: the first visible sheet)' },
        range: { type: 'string', description: 'A1 range such as A1:F30, B:B or Sales!A1:D10' },
        formulas: { type: 'boolean', description: 'Show formulas next to values (default true)' },
        formats: { type: 'boolean', description: 'Show cell formats (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const target = pickRange(opened.wb, input);
      if (typeof target === 'string') return target;
      const engine = new Engine(opened.wb);
      const warnings = checkWorkbook(opened.wb, engine);
      const body = readRange(target.sheet, target.rect, engine, { formulas: input.formulas !== false, formats: input.formats === true });
      return `${refKey(opened.ref)}\n${summarizeWorkbook(opened.wb, engine)}\n\n${target.sheet.name}!${rectText(target.rect)}:\n${body}${warnings.length ? '\n\nReview:\n- ' + warnings.join('\n- ') : '\n\nReview: nothing to flag.'}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'sheet_write',
    name: 'sheet_write',
    description: `Create a new spreadsheet in your own folder (or replace your own with overwrite: true) and optionally edit it straight away with ops. Start from template "blank", "budget" (monthly budget with totals, % of income and a bar chart), "sales" (sales log with revenue formulas, filter, region summary with SUMIFS and a column chart) or "tasks" (checkboxes, status dropdowns with colours and conditional formatting); or pass data: [[…row…], …] for the first sheet; or import: a workspace path to a .csv/.tsv/.xlsx file. Values are read like typing in Google Sheets ("=…" formulas, "12%", "$5", "2026-01-31" dates). It is shown in the Sheet menu.\n${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workbook name; becomes .pigry/sheets/<you>/<name>.sheet.json' },
        title: { type: 'string' },
        template: { type: 'string', enum: ['blank', 'budget', 'sales', 'tasks'] },
        data: { type: 'array', items: { type: 'array' }, description: 'Rows of values for A1 of the first sheet' },
        import: { type: 'string', description: 'Workspace path of a .csv, .tsv or .xlsx file to start from' },
        ops: opsSchema,
        overwrite: { type: 'boolean', description: 'Replace an existing workbook of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('sheet_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.sheet.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create spreadsheets in your own folder (${caller}/) — change another owner's workbook with sheet_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushSheetEditors();
      if ((await listSheetRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`spreadsheet "${refKey(ref)}" already exists. Read it with sheet_read and change it with sheet_edit, or pass overwrite: true to replace it.`);
      }
      const { ops, errors } = input.ops === undefined ? { ops: [] as Op[], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const title = String(input.title ?? name).slice(0, 200);
      const template = String(input.template ?? 'blank');
      if (!['blank', 'budget', 'sales', 'tasks'].includes(template)) return fail('template must be blank, budget, sales or tasks');
      let base: Workbook = emptyWorkbook(title);
      const notes: string[] = [];
      if (typeof input.import === 'string' && input.import.trim()) {
        try {
          const imp = await importFile(input.import.trim(), title);
          if (typeof imp === 'string') return imp;
          base = imp.wb; notes.push(imp.note);
        } catch (error) { return fail(`could not import ${input.import}: ${error instanceof Error ? error.message : String(error)}`); }
      } else if (template !== 'blank') {
        const t = applyOps(base, templateOps(template));
        if (t.error) return fail(t.error);
        base = t.workbook;
        if (input.title) base = { ...base, title };
      }
      const pre: Op[] = [];
      const data = asList(input.data);
      if (Array.isArray(data)) pre.push({ op: 'set', range: 'A1', values: data });
      const result = applyOps(base, [...pre, ...ops]);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveSheet(ref, result.workbook, 'agent');
      const engine = new Engine(result.workbook);
      const warnings = checkWorkbook(result.workbook, engine);
      return `saved ${path}\n${notes.length ? notes.join('\n') + '\n' : ''}${summarizeWorkbook(result.workbook, engine)}${result.log.length ? '\n' + result.log.slice(0, 40).join('\n') : ''}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : ''}\nCheck values with sheet_read / sheet_query and the look with sheet_preview; show it to the user with sheet_open.`;
    },
  },
  {
    id: 'sheet_edit',
    name: 'sheet_edit',
    description: `Edit an existing spreadsheet with a list of operations, applied in order and saved only if all of them work. Formulas everywhere follow inserted/deleted rows and columns, renamed sheets and moved cells. ${OPS_HELP}\nFunctions available in formulas:\n${FN_HELP}`,
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Workbook name, or owner/name' }, sheet: { type: 'string', description: 'Default sheet for ops without a sheet' }, ops: opsSchema }, required: ['name', 'ops'] },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('sheet_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const s = pickSheet(opened.wb, input);
      if (!s) return fail(`no sheet "${String(input.sheet)}"`);
      const result = applyOps(opened.wb, ops, { sheet: s.id });
      if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ` (these worked: ${result.log.length})` : ''}`);
      const path = await saveSheet(opened.ref, result.workbook, 'agent');
      const engine = new Engine(result.workbook);
      const warnings = checkWorkbook(result.workbook, engine);
      return `saved ${path}\n${result.log.slice(0, 60).join('\n')}${result.log.length > 60 ? `\n…${result.log.length - 60} more` : ''}\n${summarizeWorkbook(result.workbook, engine)}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'sheet_query',
    name: 'sheet_query',
    description: 'Compute without changing the file. formula: evaluate one formula (or formulas: a list) as if typed in a cell of the sheet, e.g. "=AVERAGEIFS(F:F,B:B,\\"North\\")" or "=CORREL(B2:B50,C2:C50)" — arrays come back as rows. range: the computed values of a range as tab-separated rows (display text by default, raw: true for numbers as stored). trace: a cell to list what it reads (precedents) and which formulas read it (dependents). Use it to check your work and answer questions about the data.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workbook name, or owner/name' },
        sheet: { type: 'string' },
        formula: { type: 'string' },
        formulas: { type: 'array', items: { type: 'string' } },
        at: { type: 'string', description: 'Cell the formula pretends to be in (for ROW()/relative behaviour), default A1' },
        range: { type: 'string' },
        raw: { type: 'boolean' },
        trace: { type: 'string', description: 'Cell such as D7' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const s = pickSheet(opened.wb, input);
      if (!s) return fail(`no sheet "${String(input.sheet)}"`);
      const engine = new Engine(opened.wb);
      const out: string[] = [];
      const formulas = [...(typeof input.formula === 'string' ? [input.formula] : []), ...(Array.isArray(input.formulas) ? input.formulas.map(String) : [])];
      const at = typeof input.at === 'string' ? resolveRange(opened.wb, input.at, s)?.rect : undefined;
      for (const f of formulas.slice(0, 30)) {
        const v = engine.evalAt(s.id, f, at?.r1 ?? 0, at?.c1 ?? 0);
        if (isMatrix(v)) out.push(`${f} →\n${v.slice(0, 200).map((row) => row.map((x) => (x && typeof x === 'object' ? x.code : displayScalar(x))).join('\t')).join('\n')}${v.length > 200 ? `\n[${v.length - 200} more rows]` : ''}`);
        else if (v && typeof v === 'object') out.push(`${f} → ${v.code}${v.message ? ` (${v.message})` : ''}`);
        else out.push(`${f} → ${displayScalar(v)}${typeof v === 'number' && !Number.isInteger(v) ? ` (≈ ${formatValue(v, '#,##0.####').text})` : ''}`);
      }
      if (typeof input.range === 'string' && input.range.trim()) {
        const res = resolveRange(opened.wb, input.range, s);
        if (!res) return fail(`"${input.range}" is not a range`);
        const rect = { ...res.rect, r2: Math.min(res.rect.r2, (usedRect(res.sheet)?.r2 ?? res.rect.r1) + 0, res.rect.r1 + 999) };
        const rows = input.raw === true
          ? Array.from({ length: rect.r2 - rect.r1 + 1 }, (_, i) => Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, j) => { const v = engine.value(res.sheet.id, rect.r1 + i, rect.c1 + j); return v && typeof v === 'object' ? v.code : v === null ? '' : String(v); }))
          : rangeText(res.sheet, rect, engine);
        out.push(`${res.sheet.name}!${rectText(rect)}:\n${rows.map((r) => r.join('\t')).join('\n')}`);
      }
      if (typeof input.trace === 'string' && input.trace.trim()) {
        const res = resolveRange(opened.wb, input.trace, s);
        if (!res) return fail(`"${input.trace}" is not a cell`);
        const { r1, c1 } = res.rect;
        out.push(`${res.sheet.name}!${input.trace.toUpperCase()} reads: ${engine.precedents(res.sheet.id, r1, c1).join(', ') || 'nothing (not a formula)'}\nread by: ${engine.dependents(res.sheet.id, r1, c1).join(', ') || 'no formula'}`);
      }
      if (!out.length) return fail('give formula, formulas, range or trace');
      return out.join('\n\n');
    },
  },
  {
    id: 'sheet_preview',
    name: 'sheet_preview',
    description: 'Render a picture of a sheet range — the grid as the editor draws it (formats, colours, borders, conditional formatting, checkboxes, dropdown chips) with the charts that sit over it — and attach it to your next turn so you can SEE the result. Optional range (default the used area, capped to about 2400×3000 px), sheet, chart (an id: only that chart), save_as (a .png path under .pigry/).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workbook name, or owner/name' },
        sheet: { type: 'string' },
        range: { type: 'string' },
        chart: { type: 'string', description: 'Chart id from sheet_read' },
        save_as: { type: 'string' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const target = pickRange(opened.wb, input);
      if (typeof target === 'string') return target;
      const engine = new Engine(opened.wb);
      try {
        let url: string, desc: string;
        if (typeof input.chart === 'string' && input.chart) {
          const owner = opened.wb.sheets.find((x) => x.charts.some((c) => c.id === input.chart));
          const ch = owner?.charts.find((c) => c.id === input.chart);
          if (!owner || !ch) return fail(`no chart "${input.chart}" (sheet_read lists chart ids)`);
          url = await chartPng(ch, opened.wb, owner, engine, 1.5);
          desc = `chart ${ch.id} (${ch.type}, ${ch.range})`;
        } else {
          const used = target.rect;
          const rect = { ...used, r2: Math.min(used.r2, used.r1 + 120), c2: Math.min(used.c2, used.c1 + 30) };
          const img = await renderPreview(opened.wb, target.sheet, engine, rect);
          url = img.dataUrl;
          desc = `${target.sheet.name}!${rectText(rect)} (${img.width}×${img.height}px)${rect.r2 < used.r2 || rect.c2 < used.c2 ? ' — cut to the first 121 rows × 31 columns; pass a range for the rest' : ''}`;
        }
        queueImage(url, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const t = exportPath(input.save_as, '', ['.png']);
          if ('error' in t) return fail(t.error);
          await writeWorktreeBinary(t.path, url.slice(url.indexOf(',') + 1));
          saved = ` and saved to ${t.path}`;
        }
        return `picture of ${refKey(opened.ref)} ${desc} is attached to your next turn${saved}. Look at it: alignment, number formats, overflowing text, colours, chart labels; fix with sheet_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'sheet_export',
    name: 'sheet_export',
    description: 'Export a workbook. csv / tsv: one sheet (or a range) as displayed values; xlsx: every sheet with values, formulas, number formats, merges, column widths, row heights, hidden rows/columns/sheets, notes, links and named ranges (cell colours, borders, fonts, conditional formatting, data validation and charts are NOT written — say so); html: a print-friendly page with the formatted table and charts (open it and print to PDF); png: a picture of a range. Saved under .pigry/ — by default next to the workbook.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workbook name, or owner/name' },
        format: { type: 'string', enum: ['csv', 'tsv', 'xlsx', 'html', 'png'] },
        sheet: { type: 'string' },
        range: { type: 'string' },
        formulas: { type: 'boolean', description: 'csv/tsv: write formulas instead of values' },
        path: { type: 'string', description: 'Output path under .pigry/' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '');
      if (!['csv', 'tsv', 'xlsx', 'html', 'png'].includes(format)) return fail('format must be csv, tsv, xlsx, html or png (PDF: export html and print it)');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const target = pickRange(opened.wb, input);
      if (typeof target === 'string') return target;
      const engine = new Engine(opened.wb);
      const base = sheetPath(opened.ref).replace(/\.sheet\.json$/, '');
      const ext = `.${format}`;
      const dest = exportPath(input.path, `${base}${format === 'csv' || format === 'tsv' || format === 'png' ? `-${target.sheet.name.replace(/[^A-Za-z0-9_-]+/g, '_')}` : ''}${ext}`, [ext]);
      if ('error' in dest) return fail(dest.error);
      try {
        if (format === 'csv' || format === 'tsv') {
          const text = toDelimited(rangeText(target.sheet, target.rect, engine, input.formulas === true), format === 'csv' ? ',' : '\t');
          await writeWorktreeFile(dest.path, text + '\r\n');
          return `saved ${dest.path} (${target.sheet.name}!${rectText(target.rect)}, ${target.rect.r2 - target.rect.r1 + 1} rows). Tell the user where it is.`;
        }
        if (format === 'xlsx') {
          const bytes = await exportXlsx(opened.wb, engine);
          await writeWorktreeBinary(dest.path, toBase64(bytes));
          return `saved ${dest.path} (${(bytes.length / 1024).toFixed(1)} KB, ${opened.wb.sheets.length} sheet(s); values, formulas, number formats, merges, sizes, notes and names — cell styles, conditional formatting, validation and charts are not included in the .xlsx).`;
        }
        if (format === 'html') {
          await writeWorktreeFile(dest.path, rangeHtml(opened.wb, target.sheet, target.rect, engine));
          return `saved ${dest.path} — a print-friendly page of ${target.sheet.name}!${rectText(target.rect)} with its charts. The user can open it in a browser and print or save as PDF.`;
        }
        const img = await renderPreview(opened.wb, target.sheet, engine, target.rect, { scale: 2 });
        await writeWorktreeBinary(dest.path, img.dataUrl.slice(img.dataUrl.indexOf(',') + 1));
        return `saved ${dest.path} (${img.width}×${img.height}px).`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'sheet_open',
    name: 'sheet_open',
    description: 'Open a spreadsheet in the Sheet menu so the user can see it and keep editing; optionally jump to a sheet and select a cell or range.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Workbook name, or owner/name' }, sheet: { type: 'string' }, cell: { type: 'string', description: 'Cell or range to select, e.g. B4 or A1:D9' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('sheet_open needs a name');
      const resolved = await resolveSheet(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see sheet_list)`);
      requestOpenSheet(refKey(resolved.ref), typeof input.sheet === 'string' ? input.sheet : undefined, typeof input.cell === 'string' ? input.cell : undefined);
      return `opened "${refKey(resolved.ref)}" in the Sheet menu`;
    },
  },
];
