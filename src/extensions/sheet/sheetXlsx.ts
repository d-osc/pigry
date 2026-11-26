/** Excel (.xlsx) import and export through SheetJS Community Edition. It carries values, formulas, number formats,
 * merged cells, column widths, row heights, hidden rows/columns, hidden sheets, notes, links and named ranges.
 * SheetJS CE does not write cell styles (bold, colours, borders), conditional formats, data validation or charts —
 * those stay in the .sheet.json file only. */
import { addr, parseAddr, parseRect, rectText } from './formula.ts';
import { Engine } from './engine.ts';
import { emptySheet, normalizeWorkbook, usedRect, type Cell, type Workbook } from './sheet.ts';

type XLSXModule = typeof import('xlsx');
const load = (): Promise<XLSXModule> => import('xlsx');

export async function importXlsx(bytes: Uint8Array, title: string): Promise<{ workbook: Workbook; warnings: string[] }> {
  const X = await load();
  const book = X.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellText: false, cellDates: false });
  const warnings: string[] = [];
  const wb: Workbook = { version: 1, title, sheets: [], names: {}, nextId: 1 };
  book.SheetNames.forEach((name, i) => {
    const ws = book.Sheets[name];
    const s = emptySheet(`s${i + 1}`, name.slice(0, 100));
    const ref = ws['!ref'] ? X.utils.decode_range(ws['!ref']) : null;
    if (ref) { s.rows = Math.max(1000, ref.e.r + 1); s.cols = Math.max(26, ref.e.c + 1); }
    let count = 0;
    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      const p = parseAddr(key);
      const x = ws[key] as { t: string; v?: unknown; f?: string; z?: string; w?: string; c?: { t?: string }[]; l?: { Target?: string } };
      if (!p) continue;
      const cell: Cell = {};
      if (x.f) cell.f = '=' + x.f;
      else if (x.t === 'n' && typeof x.v === 'number') cell.v = x.v;
      else if (x.t === 'b') cell.v = !!x.v;
      else if (x.t === 'e') cell.v = x.w ?? '#N/A';
      else if (x.t === 's' || x.t === 'str') cell.v = String(x.v ?? '');
      else if (x.t === 'd' && x.v instanceof Date) cell.v = (x.v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
      if (x.z && x.z !== 'General') cell.s = { nf: String(x.z) };
      if (x.c?.length) cell.note = x.c.map((c) => c.t ?? '').join('\n').slice(0, 5000);
      if (x.l?.Target && /^(https?:|mailto:)/i.test(x.l.Target)) cell.link = x.l.Target;
      if (cell.f || cell.v !== undefined || cell.s || cell.note) { s.cells[addr(p.r, p.c)] = cell; count++; }
    }
    for (const m of (ws['!merges'] ?? []) as { s: { r: number; c: number }; e: { r: number; c: number } }[]) s.merges.push(rectText({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
    ((ws['!cols'] ?? []) as ({ wpx?: number; wch?: number; hidden?: boolean } | undefined)[]).forEach((c, k) => {
      if (!c) return;
      if (c.hidden) s.hiddenCols.push(k);
      const w = c.wpx ?? (c.wch ? Math.round(c.wch * 7 + 5) : undefined);
      if (w && Math.abs(w - 100) > 2) s.colW[k] = Math.max(16, Math.min(1000, Math.round(w)));
    });
    ((ws['!rows'] ?? []) as ({ hpx?: number; hpt?: number; hidden?: boolean } | undefined)[]).forEach((r, k) => {
      if (!r) return;
      if (r.hidden) s.hiddenRows.push(k);
      const h = r.hpx ?? (r.hpt ? r.hpt * (96 / 72) : undefined);
      if (h && Math.abs(h - 21) > 2) s.rowH[k] = Math.max(8, Math.min(600, Math.round(h)));
    });
    const meta = book.Workbook?.Sheets?.[i];
    if (meta?.Hidden) s.hidden = true;
    if (count === 0 && !ref) warnings.push(`sheet "${name}" is empty`);
    wb.sheets.push(s);
  });
  for (const n of book.Workbook?.Names ?? []) {
    if (!n.Name || !n.Ref || n.Name.startsWith('_xlnm')) continue;
    wb.names[n.Name] = String(n.Ref).replace(/\$/g, '');
  }
  if (wb.sheets.every((s) => s.hidden)) delete wb.sheets[0].hidden;
  const norm = normalizeWorkbook(wb, title);
  return { workbook: norm.workbook, warnings: [...warnings, ...norm.warnings] };
}

export async function exportXlsx(wb: Workbook, engine?: Engine): Promise<Uint8Array> {
  const X = await load();
  const e = engine ?? new Engine(wb);
  const book = X.utils.book_new();
  const names: { Name: string; Ref: string }[] = [];
  for (const s of wb.sheets) {
    const ws: Record<string, unknown> = {};
    const used = usedRect(s) ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
    let r2 = used.r2, c2 = used.c2;
    for (const [a, cell] of Object.entries(s.cells)) {
      const p = parseAddr(a)!;
      const v = e.value(s.id, p.r, p.c);
      const out: Record<string, unknown> = {};
      if (cell.f) out.f = cell.f.slice(1);
      if (typeof v === 'number') { out.t = 'n'; out.v = v; }
      else if (typeof v === 'boolean') { out.t = 'b'; out.v = v; }
      else if (typeof v === 'string') { out.t = cell.f ? 'str' : 's'; out.v = v; }
      else if (v && typeof v === 'object') { out.t = 'e'; out.v = 0x2a; out.w = v.code; }
      else if (cell.f) { out.t = 's'; out.v = ''; }
      else if (!cell.note) continue;
      else { out.t = 's'; out.v = ''; }
      if (cell.s?.nf) out.z = cell.s.nf;
      if (cell.note) out.c = [{ a: 'Pigry', t: cell.note }];
      if (cell.link) out.l = { Target: cell.link };
      ws[a] = out;
      r2 = Math.max(r2, p.r); c2 = Math.max(c2, p.c);
    }
    // spilled values are written as plain values so other programs see them
    for (let r = 0; r <= Math.min(r2 + 200, s.rows - 1); r++) for (let c = 0; c <= Math.min(c2 + 50, s.cols - 1); c++) {
      const a = addr(r, c);
      if (ws[a]) continue;
      const sp = e.spillOf(s.id, r, c);
      if (!sp) continue;
      const v = e.value(s.id, r, c);
      if (v === null) continue;
      ws[a] = typeof v === 'number' ? { t: 'n', v } : typeof v === 'boolean' ? { t: 'b', v } : { t: 's', v: typeof v === 'string' ? v : v.code };
      r2 = Math.max(r2, r); c2 = Math.max(c2, c);
    }
    ws['!ref'] = `A1:${addr(Math.max(0, r2), Math.max(0, c2))}`;
    if (s.merges.length) ws['!merges'] = s.merges.map((m) => { const r = parseRect(m)!; return { s: { r: r.r1, c: r.c1 }, e: { r: r.r2, c: r.c2 } }; });
    const cols: { wpx: number; hidden?: boolean }[] = [];
    for (let c = 0; c <= c2; c++) cols.push({ wpx: s.colW[c] ?? 100, ...(s.hiddenCols.includes(c) ? { hidden: true } : {}) });
    ws['!cols'] = cols;
    const rows: ({ hpx: number; hidden?: boolean } | undefined)[] = [];
    for (let r = 0; r <= r2; r++) rows.push(s.rowH[r] || s.hiddenRows.includes(r) ? { hpx: s.rowH[r] ?? 21, ...(s.hiddenRows.includes(r) ? { hidden: true } : {}) } : undefined);
    ws['!rows'] = rows;
    X.utils.book_append_sheet(book, ws as never, s.name.slice(0, 31).replace(/[[\]*?:\\/]/g, '_'));
  }
  for (const [n, ref] of Object.entries(wb.names)) {
    const bang = ref.lastIndexOf('!');
    const r = parseRect(ref.slice(bang + 1));
    if (!r) continue;
    const abs = `$${rectText(r).replace(/([A-Z]+)(\d+)/g, '$1$$$2').replace(/:/, ':$')}`;
    names.push({ Name: n, Ref: `${ref.slice(0, bang + 1)}${abs}` });
  }
  book.Workbook = { Sheets: wb.sheets.map((s) => ({ Hidden: s.hidden ? 1 : 0 })), Names: names } as never;
  const out = X.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}
