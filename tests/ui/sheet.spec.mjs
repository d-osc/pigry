import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so workbooks and exports persist. */
async function installWorktree(page) {
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map();
    window.__worktree = files;
    window.__binary = new Map();
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') {
        const base = await invoke(cmd, args);
        return { ...base, entries: [...base.entries, ...files.keys(), ...window.__binary.keys()] };
      }
      if (cmd === 'read_worktree_file' && files.has(args.path)) {
        return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'json' };
      }
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      if (cmd === 'write_worktree_binary') { window.__binary.set(args.path, args.data); return null; }
      if (cmd === 'read_binary_file' && window.__binary.has(args.path)) {
        const data = window.__binary.get(args.path);
        return { data, mime: 'application/octet-stream', size: data.length };
      }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); return null; }
      return invoke(cmd, args);
    };
  });
}

async function setup(page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Sheet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sheet', level: 2 })).toBeVisible();
}

async function createSheet(page, name, template = 'Blank') {
  await page.getByRole('button', { name: 'New spreadsheet' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New spreadsheet' });
  await dialog.getByLabel('Spreadsheet name').fill(name);
  await dialog.getByRole('radio', { name: template }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('sheet-grid')).toBeVisible();
}

const stored = async (page, slug) => JSON.parse(await page.evaluate((s) => window.__worktree.get(`.pigry/sheets/user/${s}.sheet.json`) ?? 'null', slug));
const cells = async (page, slug, sheet = 0) => (await stored(page, slug))?.sheets[sheet].cells ?? {};
/** Centre of a cell on screen for the default sizes (columns 100 px, rows 21 px, headers 46 × 24). */
async function cellPos(page, a, widths = {}) {
  const m = /^([A-Z]+)(\d+)$/.exec(a);
  let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; c -= 1;
  const r = Number(m[2]) - 1;
  const box = await page.getByTestId('sheet-grid').boundingBox();
  let x = 46; for (let i = 0; i < c; i++) x += widths[i] ?? 100;
  return { x: box.x + x + (widths[c] ?? 100) / 2, y: box.y + 24 + r * 21 + 10 };
}
async function clickCell(page, a, opts = {}) {
  const p = await cellPos(page, a);
  const mods = opts.modifiers ?? [];
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y, { button: opts.button });
  for (const m of mods) await page.keyboard.up(m);
}
async function typeIn(page, a, text) { await clickCell(page, a); await page.keyboard.type(text); await page.keyboard.press('Enter'); }
const active = (page) => page.getByTestId('active-cell');
const formulaBar = (page) => page.getByLabel('Formula bar');
const menu = async (page, top, item) => {
  await page.getByRole('navigation', { name: 'Sheet menu' }).getByRole('button', { name: top, exact: true }).click();
  return page.getByRole('menu', { name: top }).getByRole('menuitem', { name: item });
};

test('Sheet is a built-in extension menu', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.getByRole('button', { name: 'Sheet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sheet', level: 2 })).toBeVisible();
  await expect(page.getByText('Spreadsheets the Google Sheets way')).toBeVisible();
});

test('typing values and formulas: Enter and Tab move, results recalculate and are saved', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'calc');
  await clickCell(page, 'A1');
  await page.keyboard.type('10'); await page.keyboard.press('Enter');
  await page.keyboard.type('20'); await page.keyboard.press('Enter');
  await page.keyboard.type('12.5%'); await page.keyboard.press('Tab');
  await expect(page.getByLabel('Name box')).toHaveValue('B3');
  await typeIn(page, 'B1', '=SUM(A1:A2)*2');
  await expect.poll(async () => (await cells(page, 'calc')).B1?.f).toBe('=SUM(A1:A2)*2');
  await clickCell(page, 'B1');
  await expect(active(page)).toHaveText('B1: 60');
  await expect(formulaBar(page)).toHaveValue('=SUM(A1:A2)*2');
  // changing an input recalculates the dependent formula
  await typeIn(page, 'A1', '15');
  await clickCell(page, 'B1');
  await expect(active(page)).toHaveText('B1: 70');
  const c = await cells(page, 'calc');
  expect(c.A3).toEqual({ v: 0.125, s: { nf: '0.00%' } });
  // a missing closing parenthesis is added like Sheets
  await typeIn(page, 'C1', '=ROUND(A3*100');
  await expect.poll(async () => (await cells(page, 'calc')).C1?.f).toBe('=ROUND(A3*100)');
  // the status bar sums the selection
  await clickCell(page, 'A1'); await clickCell(page, 'A2', { modifiers: ['Shift'] });
  await expect(page.getByTestId('selection-stats')).toContainText('Sum: 35');
  await expect(page.getByTestId('selection-stats')).toContainText('Count: 2');
});

test('formula suggestions, F2 editing, the formula bar and Escape', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'suggest');
  await typeIn(page, 'A1', '4'); await page.keyboard.type('6'); await page.keyboard.press('Enter');
  await clickCell(page, 'B1');
  await page.keyboard.type('=AVER');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await expect(list.getByRole('option').first()).toContainText('AVERAGE');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Cell editor')).toHaveValue('=AVERAGE(');
  await expect(page.getByRole('note')).toContainText('AVERAGE(value1');
  await page.keyboard.type('A1:A2)');
  await page.keyboard.press('Enter');
  await clickCell(page, 'B1');
  await expect(active(page)).toHaveText('B1: 5');
  // F2 edits the existing formula, Escape cancels
  await page.keyboard.press('F2');
  await expect(page.getByLabel('Cell editor')).toHaveValue('=AVERAGE(A1:A2)');
  await page.keyboard.type('+1');
  await page.keyboard.press('Escape');
  await expect(active(page)).toHaveText('B1: 5');
  // edit through the formula bar
  await formulaBar(page).click();
  await formulaBar(page).fill('=MAX(A1:A2)');
  await formulaBar(page).press('Enter');
  await expect.poll(async () => (await cells(page, 'suggest')).B1?.f).toBe('=MAX(A1:A2)');
  // clicking a cell while typing a formula inserts its reference
  await clickCell(page, 'C1');
  await page.keyboard.type('=');
  await clickCell(page, 'A2');
  await page.keyboard.type('*10');
  await expect(page.getByLabel('Cell editor')).toHaveValue('=A2*10');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await cells(page, 'suggest')).C1?.f).toBe('=A2*10');
});

test('copy and paste shift relative references; cut keeps them pointing; undo and redo', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'clip');
  await typeIn(page, 'A1', '1'); await page.keyboard.type('2'); await page.keyboard.press('Enter');
  await typeIn(page, 'B1', '=A1*10');
  await clickCell(page, 'B1');
  await page.keyboard.press('Control+c');
  await clickCell(page, 'B2');
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await cells(page, 'clip')).B2?.f).toBe('=A2*10');
  await clickCell(page, 'B2');
  await expect(active(page)).toHaveText('B2: 20');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await cells(page, 'clip')).B2).toBeUndefined();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await cells(page, 'clip')).B2?.f).toBe('=A2*10');
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await cells(page, 'clip')).B2).toBeUndefined();
  // cut A1 to D5: B1 follows it
  await clickCell(page, 'A1');
  await page.keyboard.press('Control+x');
  await clickCell(page, 'D5');
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await cells(page, 'clip')).B1?.f).toBe('=D5*10');
  expect((await cells(page, 'clip')).D5.v).toBe(1);
  // tab-separated text from another program pastes into a block
  await clickCell(page, 'F1');
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'x\t1\ny\t2');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => { const c = await cells(page, 'clip'); return [c.F1?.v, c.G1?.v, c.F2?.v, c.G2?.v]; }).toEqual(['x', 1, 'y', 2]);
});

test('the fill handle continues a series and copies formulas', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'fill');
  await typeIn(page, 'A1', '1'); await page.keyboard.type('3'); await page.keyboard.press('Enter');
  await typeIn(page, 'B1', 'Jan');
  await typeIn(page, 'C1', '=A1*2');
  await clickCell(page, 'A1'); await clickCell(page, 'C2', { modifiers: ['Shift'] });
  const grid = await page.getByTestId('sheet-grid').boundingBox();
  const hx = grid.x + 46 + 300, hy = grid.y + 24 + 42;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx, hy + 21 * 3, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => { const c = await cells(page, 'fill'); return [c.A3?.v, c.A5?.v, c.B3?.v, c.B4?.v, c.C5?.f]; }).toEqual([5, 9, 'Jan', undefined, '=A5*2']); // a Jan/blank pattern repeats, like Sheets
  // Ctrl+D copies the top cell down (no series), like Sheets
  await clickCell(page, 'D1'); await page.keyboard.type('Jan'); await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+d');
  await expect.poll(async () => { const c = await cells(page, 'fill'); return [c.D2?.v, c.D3?.v]; }).toEqual(['Jan', 'Jan']);
  // Ctrl+D fills down from the cell above
  await clickCell(page, 'C6');
  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await cells(page, 'fill')).C6?.f).toBe('=A6*2');
});

test('toolbar formatting is stored: bold, currency, fill colour, borders, merge and wrap', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'fmt');
  await typeIn(page, 'A1', '1234.5');
  await clickCell(page, 'A1');
  const bar = page.getByRole('toolbar', { name: 'Formatting toolbar' });
  await bar.getByRole('button', { name: 'Bold' }).click();
  await bar.getByRole('button', { name: 'Format as currency' }).click();
  await bar.getByLabel('Fill colour').fill('#ffff00');
  await expect.poll(async () => (await cells(page, 'fmt')).A1?.s).toEqual({ b: true, nf: '$#,##0.00', fill: '#ffff00' });
  await expect(active(page)).toHaveText('A1: 1234.5');
  await bar.getByRole('button', { name: 'Increase decimal places' }).click();
  await expect.poll(async () => (await cells(page, 'fmt')).A1?.s.nf).toBe('$#,##0.000');
  await clickCell(page, 'A2'); await clickCell(page, 'B3', { modifiers: ['Shift'] });
  await bar.getByRole('button', { name: 'Borders' }).click();
  await page.getByRole('menuitem', { name: 'Outer borders' }).click();
  await bar.getByRole('button', { name: 'Merge cells' }).click();
  await page.getByRole('menuitem', { name: 'Merge all' }).click();
  await bar.getByRole('button', { name: 'Wrap text' }).click();
  await expect.poll(async () => (await stored(page, 'fmt')).sheets[0].cells.A2?.s?.wrap).toBe('wrap');
  const s = (await stored(page, 'fmt')).sheets[0];
  expect(s.merges).toEqual(['A2:B3']);
  expect(s.cells.A2.s.bt).toBe('solid #000000');
  expect(s.cells.B3.s.br).toBe('solid #000000');
  expect(s.cells.A2.s.wrap).toBe('wrap');
  // keyboard shortcuts for formats
  await clickCell(page, 'D1');
  await page.keyboard.press('Control+i');
  await page.keyboard.press('Control+Shift+5');
  await expect.poll(async () => (await cells(page, 'fmt')).D1?.s).toEqual({ i: true, nf: '0.00%' });
});

test('rows and columns: insert from the context menu updates formulas; resize a column by dragging', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'rows');
  await typeIn(page, 'A1', '5'); await page.keyboard.type('7'); await page.keyboard.press('Enter');
  await typeIn(page, 'B1', '=A1+A2');
  const p = await cellPos(page, 'A2');
  const box = await page.getByTestId('sheet-grid').boundingBox();
  await page.mouse.click(box.x + 20, p.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await expect.poll(async () => (await cells(page, 'rows')).B1?.f).toBe('=A1+A3');
  await page.mouse.click(box.x + 20, (await cellPos(page, 'A2')).y, { button: 'right' });
  await page.getByRole('menuitem', { name: /Delete row 2/ }).click();
  await expect.poll(async () => (await cells(page, 'rows')).B1?.f).toBe('=A1+A2');
  // drag the right edge of column A's header
  const edge = { x: box.x + 46 + 100, y: box.y + 12 };
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 60, edge.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await stored(page, 'rows')).sheets[0].colW['0']).toBe(160);
  // freeze from the View menu
  await (await menu(page, 'View', 'Freeze')).click();
  await page.getByRole('menuitem', { name: '1 row', exact: true }).click();
  await expect.poll(async () => (await stored(page, 'rows')).sheets[0].frozenRows).toBe(1);
});

test('sheet tabs: add, rename, cross-sheet formulas follow the rename', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'tabs');
  await page.getByRole('button', { name: 'Add sheet' }).click();
  const tabs = page.getByRole('tablist', { name: 'Sheets' });
  await expect(tabs.getByRole('tab', { name: /Sheet2/ })).toHaveAttribute('aria-selected', 'true');
  await typeIn(page, 'A1', '42');
  await tabs.getByRole('tab', { name: /Sheet1/ }).click();
  await typeIn(page, 'A1', '=Sheet2!A1*2');
  await clickCell(page, 'A1');
  await expect(active(page)).toHaveText('A1: 84');
  await tabs.getByRole('tab', { name: /Sheet2/ }).dblclick();
  await page.getByLabel('Sheet name').fill('Data 2026');
  await page.getByLabel('Sheet name').press('Enter');
  await expect.poll(async () => (await cells(page, 'tabs')).A1?.f).toBe("='Data 2026'!A1*2");
  const wb = await stored(page, 'tabs');
  expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Data 2026']);
});

test('data validation: dropdown list and checkboxes', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'valid');
  await clickCell(page, 'A1'); await clickCell(page, 'A5', { modifiers: ['Shift'] });
  await (await menu(page, 'Data', 'Data validation…')).click();
  const dialog = page.getByRole('dialog', { name: 'Data validation' });
  await dialog.getByLabel('Items').fill('Open, Closed');
  await dialog.getByRole('button', { name: 'Done' }).click();
  // pick from the dropdown arrow
  const p = await cellPos(page, 'A2');
  await page.mouse.click(p.x + 42, p.y);
  await page.getByRole('listbox', { name: 'Choose a value' }).getByRole('option', { name: 'Closed' }).click();
  await expect.poll(async () => (await cells(page, 'valid')).A2?.v).toBe('Closed');
  // typing something else is rejected
  await typeIn(page, 'A3', 'Maybe');
  await expect(page.getByText(/Invalid: Choose one of/)).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await cells(page, 'valid')).A3).toBeUndefined();
  // checkboxes
  await clickCell(page, 'C1');
  await (await menu(page, 'Insert', 'Checkbox')).click();
  await expect.poll(async () => (await cells(page, 'valid')).C1?.v).toBe(false);
  await clickCell(page, 'C1');
  await expect.poll(async () => (await cells(page, 'valid')).C1?.v).toBe(true);
  await page.keyboard.press(' ');
  await expect.poll(async () => (await cells(page, 'valid')).C1?.v).toBe(false);
});

test('filter, sort and find & replace on a table', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'table');
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'Name\tScore\ncara\t7\nabe\t9\nbea\t3');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await cells(page, 'table')).B4?.v).toBe(3);
  await clickCell(page, 'A2');
  await page.getByRole('toolbar', { name: 'Formatting toolbar' }).getByRole('button', { name: 'Create a filter' }).click();
  await expect.poll(async () => (await stored(page, 'table')).sheets[0].filter?.range).toBe('A1:B4');
  // open the filter menu of column B and keep scores > 5
  const b1 = await cellPos(page, 'B1');
  await page.mouse.click(b1.x + 50 - 10, b1.y);
  const fm = page.getByRole('dialog', { name: 'Filter column B' });
  await fm.getByLabel('Filter condition').selectOption('gt');
  await fm.getByLabel('Condition value').fill('5');
  await fm.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await stored(page, 'table')).sheets[0].filter?.cond['1']).toEqual({ type: 'gt', value: 5, value2: '' });
  // sort by score Z → A from the column's filter menu
  await page.mouse.click(b1.x + 40, b1.y);
  await page.getByRole('dialog', { name: 'Filter column B' }).getByRole('button', { name: 'Sort Z → A' }).click();
  await expect.poll(async () => { const c = await cells(page, 'table'); return [c.A2?.v, c.A3?.v, c.A4?.v]; }).toEqual(['abe', 'cara', 'bea']);
  // find and replace
  await clickCell(page, 'D1');
  await page.keyboard.press('Control+h');
  const fr = page.getByRole('dialog', { name: 'Find and replace' });
  await fr.getByLabel('Find', { exact: true }).fill('a');
  await fr.getByLabel('Replace with').fill('A');
  await fr.getByLabel('Match case').check();
  await fr.getByRole('button', { name: 'Replace all' }).click();
  await expect(fr.getByRole('status')).toContainText('Replaced');
  await expect.poll(async () => (await cells(page, 'table')).A2?.v).toBe('Abe');
});

test('conditional formatting, a chart and a pivot table from the menus', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'viz');
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'Region\tSales\nNorth\t10\nSouth\t30\nNorth\t5\nEast\t20');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await cells(page, 'viz')).B5?.v).toBe(20);
  await clickCell(page, 'B2'); await clickCell(page, 'B5', { modifiers: ['Shift'] });
  await (await menu(page, 'Format', 'Conditional formatting')).click();
  const cf = page.getByRole('dialog', { name: 'Conditional format rules' });
  await cf.getByLabel('Condition').selectOption('gt');
  await cf.getByLabel('Rule value').fill('15');
  await cf.getByRole('button', { name: 'Add rule' }).click();
  await expect.poll(async () => (await stored(page, 'viz')).sheets[0].condFormats.map((c) => [c.range, c.type, c.value])).toEqual([['B2:B5', 'gt', 15]]);
  await cf.getByRole('button', { name: 'Close' }).click();
  // chart
  await clickCell(page, 'A1');
  await (await menu(page, 'Insert', 'Chart')).click();
  const ch = page.getByRole('dialog', { name: 'Insert chart' });
  await expect(ch.getByLabel('Data range')).toHaveValue('A1:B5');
  await ch.getByLabel('Chart type').selectOption('pie');
  await ch.getByLabel('Chart title').fill('Share');
  await ch.getByRole('button', { name: 'Insert' }).click();
  await expect(page.getByRole('figure', { name: 'Chart Share' })).toBeVisible();
  await expect.poll(async () => (await stored(page, 'viz')).sheets[0].charts.map((c) => [c.type, c.range, c.title])).toEqual([['pie', 'A1:B5', 'Share']]);
  // pivot
  await clickCell(page, 'A2');
  await (await menu(page, 'Insert', 'Pivot table')).click();
  const pv = page.getByRole('dialog', { name: 'Pivot table' });
  await pv.getByRole('button', { name: 'Create' }).click();
  const tabs = page.getByRole('tablist', { name: 'Sheets' });
  await expect(tabs.getByRole('tab', { name: /Pivot table/ })).toHaveAttribute('aria-selected', 'true');
  await clickCell(page, 'B3');
  await expect(active(page)).toHaveText('B3: 15');
});

test('import CSV into a new sheet and export XLSX and CSV', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'io');
  await (await menu(page, 'File', 'Import…')).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('dialog', { name: 'Import a file' }).getByRole('radio', { name: /Insert new sheet/ }).click();
  await (await chooser).setFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('name,age,joined\nAnn,31,2026-01-05\n"Lee, J",45,2025-11-30\n') });
  const tabs = page.getByRole('tablist', { name: 'Sheets' });
  await expect(tabs.getByRole('tab', { name: /people/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await stored(page, 'io')).sheets.length).toBe(2);
  const wb = await stored(page, 'io');
  expect(wb.sheets[1].cells.A3.v).toBe('Lee, J');
  expect(wb.sheets[1].cells.B2.v).toBe(31);
  expect(wb.sheets[1].cells.C2.s.nf).toBe('yyyy-mm-dd');
  await (await menu(page, 'File', 'Download')).hover();
  await page.getByRole('menuitem', { name: /Microsoft Excel/ }).click();
  await expect.poll(() => page.evaluate(() => [...window.__binary.keys()])).toContain('.pigry/sheets/user/io.xlsx');
  const signature = await page.evaluate(() => atob(window.__binary.get('.pigry/sheets/user/io.xlsx')).slice(0, 2));
  expect(signature).toBe('PK');
  await (await menu(page, 'File', 'Download')).hover();
  await page.getByRole('menuitem', { name: /Comma-separated/ }).click();
  await expect.poll(() => page.evaluate(() => window.__worktree.get('.pigry/sheets/user/io-people.csv'))).toBe('name,age,joined\r\nAnn,31,2026-01-05\r\n"Lee, J",45,2025-11-30\r\n');
});

test('a large sheet scrolls and the keyboard jumps to the end of the data', async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const { SHEET_TOOLS } = await import('/src/extensions/sheet/sheetTools.ts');
    const run = (name, input) => SHEET_TOOLS.find((t) => t.name === name).run({ agent: 'user', ...input });
    const data = [['n', 'square']];
    for (let i = 1; i <= 5000; i++) data.push([i, `=A${i + 1}^2`]);
    await run('sheet_write', { name: 'big', data });
    await run('sheet_open', { name: 'big' });
  });
  await expect(page.getByLabel('Name box')).toHaveValue('A1');
  await clickCell(page, 'A2');
  await page.keyboard.press('Control+ArrowDown');
  await expect(page.getByLabel('Name box')).toHaveValue('A5001');
  await page.keyboard.press('ArrowRight');
  await expect(active(page)).toHaveText('B5001: 25000000');
  const scrolled = await page.getByTestId('sheet-grid').evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(100000);
  await page.keyboard.press('Control+Home');
  await expect(page.getByLabel('Name box')).toHaveValue('A1');
});

test('the shortcuts window lists the spreadsheet keys', async ({ page }) => {
  await setup(page);
  await createSheet(page, 'keys');
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByText('Fill the selection with the entry')).toBeVisible();
});

test('the Data Analyst agent has the tools, skills and the guide entry', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { SHEET_TOOLS } = await import('/src/extensions/sheet/sheetTools.ts');
    const { takeImages } = await import('/src/lib/pendingImages.ts');
    const run = (name, input) => SHEET_TOOLS.find((t) => t.name === name).run({ agent: 'tester', ...input });
    const out = {};
    out.names = SHEET_TOOLS.map((t) => t.name);
    out.written = await run('sheet_write', {
      name: 'budget', template: 'budget', ops: [{ op: 'set', range: 'G1', value: 'Checked' }],
    });
    out.dup = await run('sheet_write', { name: 'budget' });
    out.bad = await run('sheet_edit', { name: 'budget', ops: [{ op: 'format', range: 'A1', color: 'nope!' }] });
    out.read = await run('sheet_read', { name: 'budget', range: 'A3:E6' });
    out.edited = await run('sheet_edit', { name: 'budget', ops: JSON.stringify([{ op: 'set', range: 'C6', value: 700 }, { op: 'insert_rows', at: 5 }]) });
    out.query = await run('sheet_query', { name: 'budget', formulas: ['=SUM(C6:C12)', '=SORT({3;1;2})'], range: 'A3:B5', trace: 'D14' });
    out.preview = await run('sheet_preview', { name: 'budget' });
    out.images = takeImages('tester').length;
    out.csv = await run('sheet_export', { name: 'budget', format: 'csv' });
    out.xlsx = await run('sheet_export', { name: 'budget', format: 'xlsx' });
    out.html = await run('sheet_export', { name: 'budget', format: 'html' });
    out.badPath = await run('sheet_export', { name: 'budget', format: 'csv', path: '../escape.csv' });
    out.other = await run('sheet_write', { name: 'someone/x' });
    out.imported = await run('sheet_write', { name: 'fromxlsx', import: '.pigry/sheets/tester/budget.xlsx' });
    out.opened = await run('sheet_open', { name: 'budget', cell: 'C7' });
    out.list = await run('sheet_list', {});
    out.files = [...window.__worktree.keys()].filter((k) => k.startsWith('.pigry/sheets'));
    out.binaries = [...window.__binary.keys()];
    return out;
  });
  expect(result.names).toEqual(['sheet_list', 'sheet_read', 'sheet_write', 'sheet_edit', 'sheet_query', 'sheet_preview', 'sheet_export', 'sheet_open']);
  expect(result.written).toContain('saved .pigry/sheets/tester/budget.sheet.json');
  expect(result.dup).toContain('already exists');
  expect(result.bad).toMatch(/error: op 1 \(format\): color/);
  expect(result.read).toContain('A4=Rent');
  expect(result.read).toContain('D5=55.00 ‹=C5-B5›');
  expect(result.edited).toContain('inserted 1 row(s) at 5');
  expect(result.query).toContain('=SUM(C6:C12) →');
  expect(result.query).toMatch(/=SORT\(\{3;1;2\}\) →\n1\n2\n3/);
  expect(result.query).toContain('D14 reads:');
  expect(result.preview).toContain('attached to your next turn');
  expect(result.images).toBe(1);
  expect(result.csv).toContain('saved .pigry/sheets/tester/budget-Budget.csv');
  expect(result.xlsx).toContain('saved .pigry/sheets/tester/budget.xlsx');
  expect(result.html).toContain('saved .pigry/sheets/tester/budget.html');
  expect(result.badPath).toContain('must stay inside .pigry/');
  expect(result.other).toMatch(/error: .*own folder/);
  expect(result.imported).toContain('imported .pigry/sheets/tester/budget.xlsx');
  expect(result.opened).toContain('opened "tester/budget"');
  expect(result.list).toContain('tester/budget');
  expect(result.files).toEqual(expect.arrayContaining(['.pigry/sheets/tester/budget.sheet.json', '.pigry/sheets/tester/fromxlsx.sheet.json', '.pigry/sheets/tester/budget-Budget.csv', '.pigry/sheets/tester/budget.html']));
  // the editor shows what the agent built, with the requested cell selected
  await expect(page.getByLabel('Name box')).toHaveValue('C7');
  await expect(page.getByLabel('Spreadsheet title')).toHaveValue('Monthly budget');
  await expect(page.getByRole('figure', { name: 'Chart Planned vs actual spending' })).toBeVisible();
});
