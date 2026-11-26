import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so documents, side files and exports persist. */
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
      if (cmd === 'delete_worktree_file') { files.delete(args.path); window.__binary.delete(args.path); return null; }
      return invoke(cmd, args);
    };
  });
}

async function setup(page) {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Docs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Docs', level: 2 })).toBeVisible();
}

async function createDoc(page, name, template = 'Blank') {
  await page.getByRole('button', { name: 'New document' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await dialog.getByLabel('Document name').fill(name);
  await dialog.getByRole('radio', { name: template }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(surface(page)).toBeVisible();
}

const surface = (page) => page.getByTestId('docs-surface');
const stored = async (page, slug, owner = 'user') => JSON.parse(await page.evaluate(([s, o]) => window.__worktree.get(`.pigry/docs/${o}/${s}.doc.json`) ?? 'null', [slug, owner]));
const texts = (doc) => (doc?.blocks ?? []).filter((b) => b.type === 'p').map((b) => b.runs.map((r) => r.t ?? '').join(''));
const menu = async (page, top, item, sub) => {
  await page.getByRole('navigation', { name: 'Docs menu' }).getByRole('button', { name: top, exact: true }).click();
  const popup = page.getByRole('menu', { name: top });
  if (!sub) return popup.getByRole('menuitem', { name: item });
  await popup.getByRole('menuitem', { name: item }).click();
  return page.getByRole('menu', { name: item }).getByRole('menuitem', { name: sub, exact: true }).or(page.getByRole('menu', { name: item }).getByRole('menuitemcheckbox', { name: sub, exact: true }));
};
/** Selects text in the editor (it may span formatted pieces); with `caret`, puts the caret right after it. */
async function selectText(page, text, caret = false) {
  await page.evaluate(([t, atEnd]) => {
    const root = document.querySelector('[data-testid="docs-surface"]');
    root.focus();
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    const all = nodes.map((n) => n.data).join('');
    const i = all.indexOf(t);
    if (i < 0) throw new Error(`text not found: ${t}`);
    const point = (off) => { let at = 0; for (const n of nodes) { if (off <= at + n.data.length) return [n, off - at]; at += n.data.length; } const last = nodes[nodes.length - 1]; return [last, last.data.length]; };
    const r = document.createRange();
    const [sn, so] = point(atEnd ? i + t.length : i);
    const [en, eo] = point(i + t.length);
    r.setStart(sn, so); r.setEnd(en, eo);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, [text, caret]);
  await page.waitForTimeout(60);
}
const caretAfter = (page, text) => selectText(page, text, true);

test('Docs is a built-in extension menu with an empty state and templates', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('Documents the Google Docs way')).toBeVisible();
  for (const t of ['Blank', 'Meeting notes', 'Project proposal', 'Report']) await expect(page.getByRole('button', { name: `New ${t} document` })).toBeVisible();
  await page.getByRole('button', { name: 'New Meeting notes document' }).click();
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await expect(dialog.getByRole('radio', { name: 'Meeting notes' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByLabel('Document name').fill('sync');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(surface(page).locator('[data-style="title"]')).toHaveText('sync');
  const outline = page.getByRole('complementary', { name: 'Document outline' });
  await expect(outline.getByRole('button', { name: 'Action items' })).toBeVisible();
  await expect(surface(page).locator('[data-list="check"]').first()).toBeVisible();
  const doc = await stored(page, 'sync');
  expect(doc.kind).toBe('pigry-doc');
  expect(doc.blocks[0].style).toBe('title');
});

test('typing, Enter, styles, lists and undo are saved to the file', async ({ page }) => {
  await setup(page);
  await createDoc(page, 'notes');
  await surface(page).click();
  await page.keyboard.type('Hello world');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  await expect.poll(async () => texts(await stored(page, 'notes')).slice(0, 2)).toEqual(['Hello world', 'Second line']);
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  // heading by shortcut, then Enter after a heading gives normal text
  await caretAfter(page, 'Hello world');
  await page.keyboard.press('Control+Alt+1');
  await expect(surface(page).locator('h1')).toHaveText('Hello world');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Body');
  await expect.poll(async () => (await stored(page, 'notes')).blocks.map((b) => b.style ?? 'normal').slice(0, 3)).toEqual(['h1', 'normal', 'normal']);
  await expect(page.getByRole('complementary', { name: 'Document outline' }).getByRole('button', { name: 'Hello world' })).toBeVisible();
  // bold a selection with Ctrl+B
  await selectText(page, 'Second');
  await page.keyboard.press('Control+b');
  await expect(surface(page).locator('b')).toHaveText('Second');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // bulleted list with Ctrl+Shift+8, then Enter continues the list
  await caretAfter(page, 'line');
  await page.keyboard.press('Control+Shift+8');
  await expect(surface(page).locator('[data-list="bullet"]')).toHaveCount(1);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Item two');
  await expect(surface(page).locator('[data-list="bullet"]')).toHaveCount(2);
  await expect.poll(async () => (await stored(page, 'notes')).blocks.filter((b) => b.list === 'bullet').length).toBe(2);
  // undo the last changes, redo one
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(surface(page).locator('[data-list="bullet"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(surface(page).locator('[data-list="bullet"]')).toHaveCount(2);
});

test('toolbar formatting: style picker, colour, alignment, line spacing and clear formatting', async ({ page }) => {
  await setup(page);
  await createDoc(page, 'fmt');
  await surface(page).click();
  await page.keyboard.type('Plain words here');
  await selectText(page, 'words');
  await page.getByRole('button', { name: 'Text colour' }).click();
  await page.getByRole('button', { name: 'Text #ff0000' }).click();
  await expect(surface(page).locator('span[style*="color"]')).toHaveText('words');
  await page.getByRole('button', { name: 'Center align' }).click();
  await page.getByRole('button', { name: 'Styles' }).click();
  await page.getByRole('menu', { name: 'Styles' }).getByRole('menuitemradio', { name: 'Heading 2' }).click();
  await expect(surface(page).locator('h2')).toHaveText('Plain words here');
  await page.getByRole('button', { name: 'Line & paragraph spacing' }).click();
  await page.getByRole('menu', { name: 'Spacing' }).getByRole('menuitemradio', { name: 'Double' }).click();
  await expect.poll(async () => { const d = await stored(page, 'fmt'); return [d.blocks[0].style, d.blocks[0].align, d.blocks[0].lh, d.blocks[0].runs.find((r) => r.t === 'words')?.color]; }).toEqual(['h2', 'center', 2, '#ff0000']);
  await selectText(page, 'Plain words here');
  await page.getByRole('button', { name: 'Clear formatting' }).click();
  await expect.poll(async () => { const d = await stored(page, 'fmt'); return [d.blocks[0].style ?? 'normal', d.blocks[0].runs.length]; }).toEqual(['normal', 1]);
});

test('tables: insert from the grid, Tab between cells, rows from the context menu and merge', async ({ page }) => {
  await setup(page);
  await createDoc(page, 'tables');
  await surface(page).click();
  await page.getByRole('button', { name: 'Insert table' }).click();
  await page.getByRole('button', { name: '2 x 3 table' }).click();
  await expect(surface(page).locator('table td')).toHaveCount(6);
  await page.keyboard.type('A');
  await page.keyboard.press('Tab');
  await page.keyboard.type('B');
  await expect.poll(async () => { const t = (await stored(page, 'tables')).blocks.find((b) => b.type === 'table'); return t?.rows[0].map((c) => c.paras[0].runs.map((r) => r.t).join('')); }).toEqual(['A', 'B', '']);
  await surface(page).locator('table td').first().click({ button: 'right' });
  await page.getByRole('menu', { name: 'Context menu' }).getByRole('menuitem', { name: 'Insert row below' }).click();
  await expect(surface(page).locator('table tr')).toHaveCount(3);
  // merge the first two cells of the first row
  await page.evaluate(() => {
    const tds = document.querySelectorAll('[data-testid="docs-surface"] td');
    const r = document.createRange();
    r.setStart(tds[0].querySelector('p').firstChild, 0);
    r.setEnd(tds[1].querySelector('p').firstChild, 1);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.waitForTimeout(60);
  await (await menu(page, 'Format', 'Table', 'Merge cells')).click();
  await expect(surface(page).locator('table td[colspan="2"]')).toHaveCount(1);
  await expect.poll(async () => (await stored(page, 'tables')).blocks.find((b) => b.type === 'table').rows[0][0].cs).toBe(2);
});

test('comments and suggesting mode: add, reply, resolve, accept and reject', async ({ page }) => {
  await setup(page);
  await createDoc(page, 'review');
  await surface(page).click();
  await page.keyboard.type('We utilise many tools daily.');
  await selectText(page, 'many tools');
  await page.keyboard.press('Control+Alt+m');
  const panel = page.getByRole('complementary', { name: 'Comments and suggestions' });
  await panel.getByLabel('Comment text').fill('Which tools?');
  await panel.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(panel.getByTestId('comment-card')).toContainText('Which tools?');
  await expect(surface(page).locator('.dc-c')).toHaveText('many tools');
  await panel.getByTestId('comment-card').click();
  await panel.getByLabel('Reply').fill('Editors and linters');
  await panel.getByLabel('Reply').press('Enter');
  await expect(panel.getByTestId('comment-card')).toContainText('Editors and linters');
  await expect.poll(async () => (await stored(page, 'review')).comments[0]?.replies.length).toBe(1);
  await panel.getByRole('button', { name: /^Resolve comment/ }).click();
  await expect.poll(async () => (await stored(page, 'review')).comments[0]?.resolved).toBe(true);

  // suggesting: typing and deleting become tracked suggestions
  await page.getByRole('button', { name: 'Editing mode' }).click();
  await page.getByRole('menuitemradio', { name: /Suggesting/ }).click();
  await expect(page.getByRole('button', { name: 'Editing mode' })).toContainText('Suggesting');
  await selectText(page, 'utilise');
  await page.keyboard.type('use');
  await expect(surface(page).locator('del[data-s]')).toHaveText('utilise');
  await expect(surface(page).locator('ins[data-s]')).toHaveText('use');
  await caretAfter(page, 'daily');
  await page.keyboard.press('Backspace');
  await expect(surface(page).locator('del[data-s]')).toHaveCount(2);
  await expect.poll(async () => (await stored(page, 'review')).suggestions.length).toBe(3);
  await expect(panel.getByTestId('suggestion-card')).toHaveCount(3);
  // accept the replacement, reject the deletion of "y"
  await panel.getByRole('button', { name: /^Accept suggestion/ }).first().click();
  await panel.getByRole('button', { name: /^Accept suggestion/ }).first().click();
  await panel.getByRole('button', { name: /^Reject suggestion/ }).first().click();
  await expect.poll(async () => texts(await stored(page, 'review'))[0]).toBe('We use many tools daily.');
  await expect.poll(async () => (await stored(page, 'review')).suggestions.length).toBe(0);
});

test('find and replace, word count, page setup, header and footer and the shortcuts window', async ({ page }) => {
  await setup(page);
  await createDoc(page, 'setup');
  await surface(page).click();
  await page.keyboard.type('The colour of the colour wheel.');
  await page.keyboard.press('Control+h');
  const find = page.getByRole('dialog', { name: 'Find and replace' });
  await find.getByLabel('Find', { exact: true }).fill('colour');
  await expect(find.getByTestId('find-status')).toHaveText('2 matches');
  await find.getByLabel('Replace with').fill('color');
  await find.getByRole('button', { name: 'Replace all' }).click();
  await expect(find.getByTestId('find-status')).toHaveText('Replaced 2 matches');
  await find.getByRole('button', { name: 'Close' }).first().click();
  await expect.poll(async () => texts(await stored(page, 'setup'))[0]).toBe('The color of the color wheel.');

  await page.keyboard.press('Control+Shift+c');
  const count = page.getByRole('dialog', { name: 'Word count' });
  await expect(count.getByTestId('count-words')).toHaveText('6');
  await count.getByRole('button', { name: 'Close' }).first().click();

  await (await menu(page, 'File', 'Page setup…')).click();
  const setupDlg = page.getByRole('dialog', { name: 'Page setup' });
  await setupDlg.getByLabel('Paper size').selectOption('a4');
  await setupDlg.getByRole('radio', { name: 'Landscape' }).click();
  await setupDlg.getByLabel('left margin').fill('0.5');
  await setupDlg.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => { const d = await stored(page, 'setup'); return [d.page.size, d.page.orientation, d.page.margins.left]; }).toEqual(['a4', 'landscape', 0.5]);
  await expect(page.getByRole('button', { name: 'Left margin' })).toBeVisible();

  await (await menu(page, 'Insert', 'Headers & footers…')).click();
  const hf = page.getByRole('dialog', { name: 'Headers & footers' });
  await hf.getByLabel('Header text').fill('{title}');
  await hf.getByRole('button', { name: 'Add page numbers' }).click();
  await hf.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('footer-1')).toHaveText('Page 1 of 1');
  await surface(page).click();
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('page-count')).toHaveText('2 pages');
  await expect(page.getByTestId('footer-2')).toHaveText('Page 2 of 2');

  await page.keyboard.press('Control+/');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Docs shortcuts');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Heading 1 … 6');
});

test('paste keeps formatting from HTML, and export / import round-trip through files', async ({ page }) => {
  await setup(page);
  await createDoc(page, 'paste');
  await surface(page).click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<h2>Pasted heading</h2><p>Some <b>bold</b> and <a href="https://x.dev">a link</a></p><ul><li>one</li><li>two</li></ul>');
    dt.setData('text/plain', 'Pasted heading\nSome bold and a link\none\ntwo');
    document.querySelector('[data-testid="docs-surface"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(surface(page).locator('h2')).toHaveText('Pasted heading');
  await expect(surface(page).locator('a[href="https://x.dev"]')).toHaveText('a link');
  await expect(surface(page).locator('[data-list="bullet"]')).toHaveCount(2);
  await expect.poll(async () => (await stored(page, 'paste'))?.blocks.some((b) => b.runs?.some((r) => r.b && r.t === 'bold'))).toBe(true);

  await (await menu(page, 'File', 'Download', 'Microsoft Word (.docx)')).click();
  await expect.poll(() => page.evaluate(() => window.__binary.has('.pigry/docs/user/paste.docx'))).toBe(true);
  await (await menu(page, 'File', 'Download', 'Markdown (.md)')).click();
  await expect.poll(() => page.evaluate(() => window.__worktree.get('.pigry/docs/user/paste.md') ?? '')).toContain('## Pasted heading');

  await page.locator('input[aria-label="Import a Markdown, HTML, Word or text file"]').setInputFiles({ name: 'imported.md', mimeType: 'text/markdown', buffer: Buffer.from('# Imported\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| - | - |\n| 1 | 2 |\n') });
  await expect(surface(page).locator('h1')).toHaveText('Imported');
  await expect(surface(page).locator('[data-list="check"]')).toHaveCount(2);
  await expect(surface(page).locator('table td')).toHaveCount(4);
  expect(await stored(page, 'imported')).not.toBeNull();
});

test('the Writer agent tools write to their own folder and the editor opens their documents', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { DOCS_TOOLS } = await import('/src/extensions/docs/docsTools.ts');
    const { takeImages } = await import('/src/lib/pendingImages.ts');
    const run = (name, input) => DOCS_TOOLS.find((t) => t.name === name).run({ agent: 'writer', ...input });
    const out = {};
    out.names = DOCS_TOOLS.map((t) => t.name);
    out.written = await run('docs_write', { name: 'plan', title: 'Launch plan', markdown: '# Goals\n\nShip the beta.\n\n# Risks\n\nTime is short.' });
    out.dup = await run('docs_write', { name: 'plan' });
    out.other = await run('docs_write', { name: 'user/plan' });
    out.bad = await run('docs_edit', { name: 'plan', ops: [{ op: 'format', find: 'nowhere', bold: true }] });
    out.edited = await run('docs_edit', { name: 'plan', ops: JSON.stringify([{ op: 'suggest', find: 'short', replace: 'tight' }, { op: 'comment', find: 'beta', text: 'Which date?' }, { op: 'table', data: [['Task', 'Owner'], ['Docs', 'Ana']], header: true, under: 'Goals' }]) });
    out.read = await run('docs_read', { name: 'plan' });
    out.preview = await run('docs_preview', { name: 'plan' });
    out.images = takeImages('writer').length;
    out.docx = await run('docs_export', { name: 'plan', format: 'docx' });
    out.md = await run('docs_export', { name: 'plan', format: 'md' });
    out.badPath = await run('docs_export', { name: 'plan', format: 'md', path: '../escape.md' });
    out.list = await run('docs_list', {});
    out.opened = await run('docs_open', { name: 'plan', block: 'Risks' });
    out.files = [...window.__worktree.keys()].filter((k) => k.startsWith('.pigry/docs'));
    return out;
  });
  expect(result.names).toEqual(['docs_list', 'docs_read', 'docs_write', 'docs_edit', 'docs_preview', 'docs_export', 'docs_open']);
  expect(result.written).toContain('saved .pigry/docs/writer/plan.doc.json');
  expect(result.dup).toContain('already exists');
  expect(result.other).toContain('only create documents in your own folder');
  expect(result.bad).toMatch(/error: op 1 \(format\): "nowhere" was not found/);
  expect(result.edited).toMatch(/suggested s\d+, s\d+/);
  expect(result.read).toMatch(/\{--short--\}\[s\d+\]\{\+\+tight\+\+\}/);
  expect(result.read).toContain('Comments:');
  expect(result.read).toMatch(/table 2×2/);
  expect(result.preview).toContain('attached to your next turn');
  expect(result.images).toBe(1);
  expect(result.docx).toContain('saved .pigry/docs/writer/plan.docx');
  expect(result.md).toContain('saved .pigry/docs/writer/plan.md');
  expect(result.badPath).toContain('must stay inside .pigry/');
  expect(result.list).toContain('writer/plan');
  expect(result.files).toContain('.pigry/docs/writer/plan.doc.json');
  await expect(surface(page).locator('[data-style="h1"]').first()).toHaveText('Goals');
  await expect(surface(page).locator('ins[data-s]')).toHaveText('tight');
  await expect(page.getByRole('complementary', { name: 'Comments and suggestions' }).getByTestId('comment-card')).toContainText('Which date?');
});
