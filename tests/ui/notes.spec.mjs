import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so notebooks and their image side files persist. */
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
  await page.setViewportSize({ width: 1500, height: 950 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible();
  await expect(page.getByText('Notes that you add appear here')).toBeVisible();
}
const stored = async (page, slug = 'notes', owner = 'user') => JSON.parse(await page.evaluate(([s, o]) => window.__worktree.get(`.pigry/notes/${o}/${s}.notes.json`) ?? 'null', [slug, owner]));
const saved = (page, fn, slug) => expect.poll(async () => { try { return fn(await stored(page, slug)); } catch { return undefined; } }, { timeout: 6000 });
const cards = (page) => page.getByTestId('note-card');
const card = (page, text) => cards(page).filter({ hasText: text });
const composer = (page) => page.getByTestId('note-composer');
const editor = (page) => page.getByRole('dialog', { name: 'Edit note' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function takeNote(page, title, body) {
  await page.getByRole('button', { name: 'Take a note…' }).click();
  await composer(page).getByLabel('Title', { exact: true }).fill(title);
  await composer(page).getByRole('textbox', { name: 'Note', exact: true }).fill(body);
  await composer(page).getByRole('button', { name: 'Close' }).click();
  await expect(card(page, title)).toBeVisible();
}
async function takeList(page, title, items) {
  await page.getByRole('button', { name: 'New list' }).click();
  await composer(page).getByLabel('Title', { exact: true }).fill(title);
  await composer(page).getByLabel('New list item').pressSequentially(items[0]);
  for (const item of items.slice(1)) { await page.keyboard.press('Enter'); await page.keyboard.type(item); }
  await composer(page).getByRole('button', { name: 'Close' }).click();
  await expect(card(page, title)).toBeVisible();
}

test('take a note and a list, then edit, copy and save them to the user notebook', async ({ page }) => {
  await setup(page);
  await takeNote(page, 'Lisbon trip', 'Tram 28\nTime Out Market');
  await takeList(page, 'Groceries', ['milk', 'eggs', 'bread']);
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).first()).toContainText('Groceries'); // newest first
  await saved(page, (b) => b.notes.map((n) => [n.title, n.kind, n.kind === 'checklist' ? n.items.map((i) => i.text) : n.body])).toEqual([
    ['Groceries', 'checklist', ['milk', 'eggs', 'bread']],
    ['Lisbon trip', 'text', 'Tram 28\nTime Out Market'],
  ]);
  // an empty composer adds nothing; clicking outside closes and keeps a typed note
  await page.getByRole('button', { name: 'Take a note…' }).click();
  await page.getByTestId('notes-content').click({ position: { x: 20, y: 600 } });
  await expect(cards(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Take a note…' }).click();
  await composer(page).getByRole('textbox', { name: 'Note', exact: true }).fill('Quick thought');
  await page.getByTestId('notes-content').click({ position: { x: 20, y: 600 } });
  await expect(cards(page)).toHaveCount(3);

  // clicking a card opens the editor; edits save as you type
  await card(page, 'Lisbon trip').click();
  await expect(editor(page)).toBeVisible();
  await editor(page).getByLabel('Title', { exact: true }).fill('Lisbon weekend');
  await expect(editor(page)).toContainText(/Edited/);
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  await expect(card(page, 'Lisbon weekend')).toBeVisible();
  await saved(page, (b) => b.notes.some((n) => n.title === 'Lisbon weekend')).toBe(true);

  // More ▸ Make a copy
  await card(page, 'Lisbon weekend').hover();
  await card(page, 'Lisbon weekend').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Make a copy' }).click();
  await expect(card(page, 'Lisbon weekend')).toHaveCount(2);
  await saved(page, (b) => b.notes.filter((n) => n.title === 'Lisbon weekend').length).toBe(2);
});

test('checklists: add with Enter, check into Checked items, reorder, delete and show or hide checkboxes', async ({ page }) => {
  await setup(page);
  await takeList(page, 'Packing', ['socks', 'passport', 'charger']);
  // tick from the card
  await card(page, 'Packing').getByRole('checkbox', { name: 'Check passport' }).click(); // it moves under the checked items, so check() could not see it checked
  await expect(card(page, 'Packing').getByTestId('checked-count')).toHaveText('+ 1 checked item');
  await saved(page, (b) => b.notes[0].items.map((i) => `${i.checked ? 'x' : '-'}${i.text}`)).toEqual(['-socks', 'xpassport', '-charger']);

  await card(page, 'Packing').click();
  const ed = editor(page);
  const toggle = ed.getByRole('button', { name: '1 Checked item' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(ed.getByLabel('List item', { exact: true })).toHaveCount(2);
  await toggle.click();
  await expect(ed.getByLabel('List item', { exact: true })).toHaveCount(3);
  // Enter in the middle of an item splits it; Backspace at the start joins it back
  const socks = ed.getByLabel('List item', { exact: true }).first();
  await socks.click();
  await socks.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('toothbrush');
  await expect(ed.getByLabel('List item', { exact: true })).toHaveCount(4);
  await expect(ed.getByLabel('List item', { exact: true }).nth(1)).toHaveValue('toothbrush');
  // Alt+↑ moves the item up
  await page.keyboard.press('Alt+ArrowUp');
  await saved(page, (b) => b.notes[0].items.filter((i) => !i.checked).map((i) => i.text)).toEqual(['toothbrush', 'socks', 'charger']);
  // drag the handle of charger above toothbrush
  await ed.getByLabel('Drag charger').dragTo(ed.getByTestId('checklist-item').first(), { targetPosition: { x: 40, y: 4 } });
  await saved(page, (b) => b.notes[0].items.filter((i) => !i.checked).map((i) => i.text)).toEqual(['charger', 'toothbrush', 'socks']);
  // uncheck passport, delete socks
  await ed.getByRole('checkbox', { name: 'Uncheck passport' }).click();
  await expect(ed.getByRole('button', { name: /Checked item/ })).toHaveCount(0);
  await ed.getByRole('button', { name: 'Delete socks' }).click();
  await saved(page, (b) => b.notes[0].items.map((i) => i.text)).toEqual(['charger', 'toothbrush', 'passport']);
  // Hide checkboxes turns it into text and back
  await ed.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Hide checkboxes' }).click();
  await expect(ed.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue('charger\ntoothbrush\npassport');
  await ed.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Show checkboxes' }).click();
  await expect(ed.getByLabel('List item', { exact: true })).toHaveCount(3);
  await saved(page, (b) => b.notes[0].kind).toBe('checklist');
});

test('colours, backgrounds, labels and reminders show on the card and in the file', async ({ page }) => {
  await setup(page);
  await takeNote(page, 'Dentist', 'Move the check-up');
  const c = card(page, 'Dentist');
  await c.hover();
  await c.getByRole('button', { name: 'Background options' }).click();
  await page.getByRole('radiogroup', { name: 'Colour' }).getByRole('radio', { name: 'Coral' }).click();
  await page.getByRole('radiogroup', { name: 'Background' }).getByRole('radio', { name: 'Travel' }).click();
  await saved(page, (b) => [b.notes[0].color, b.notes[0].background]).toEqual(['coral', 'travel']);
  await expect(c).toHaveClass(/nt-card--bg/);

  // labels: create from the label picker
  await c.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Add label' }).click();
  const picker = page.getByRole('dialog', { name: 'Label note' });
  await picker.getByLabel('Enter label name').fill('Health');
  await picker.getByRole('button', { name: 'Create "Health"' }).click();
  await expect(picker.getByRole('checkbox', { name: 'Health' })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByTestId('notes-content').click({ position: { x: 20, y: 700 } });
  await expect(c.getByTestId('label-chip')).toHaveText('Health');
  await expect(page.getByRole('navigation', { name: 'Notes views' }).getByRole('button', { name: /Health/ })).toBeVisible();
  await saved(page, (b) => [b.labels, b.notes[0].labels]).toEqual([['Health'], ['Health']]);

  // reminder: Tomorrow, 8:00 AM, then a custom date with a repeat
  await c.hover();
  await c.getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('dialog', { name: 'Remind me' }).getByRole('button', { name: /Tomorrow/ }).click();
  await expect(c.getByTestId('reminder-chip')).toContainText('Tomorrow, 8:00 AM');
  await c.hover();
  await c.getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('dialog', { name: 'Remind me' }).getByRole('button', { name: /Pick date/ }).click();
  await page.getByLabel('Reminder date and time').fill('2031-03-04T09:30');
  await page.getByLabel('Repeat').selectOption('weekly');
  await page.getByRole('dialog', { name: 'Remind me' }).getByRole('button', { name: 'Save' }).click();
  await expect(c.getByTestId('reminder-chip')).toContainText('Mar 4, 2031, 9:30 AM · Weekly');
  await saved(page, (b) => b.notes[0].reminder).toEqual({ at: '2031-03-04T09:30', repeat: 'weekly' });
  await page.getByRole('navigation', { name: 'Notes views' }).getByRole('button', { name: /Reminders/ }).click();
  await expect(cards(page)).toHaveCount(1);
  // remove the reminder from the chip
  await c.getByTestId('reminder-chip').hover();
  await c.getByRole('button', { name: 'Remove reminder' }).click();
  await expect(page.getByText('Notes with upcoming reminders appear here')).toBeVisible();

  // Edit labels: rename and delete
  await page.getByRole('navigation', { name: 'Notes views' }).getByRole('button', { name: 'Edit labels' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit labels' });
  await dlg.getByLabel('Rename label Health').fill('Doctor');
  await dlg.getByLabel('Rename label Health').press('Enter');
  await expect(dlg.getByLabel('Rename label Doctor')).toBeVisible();
  await dlg.getByLabel('Create new label').fill('Errands');
  await dlg.getByLabel('Create new label').press('Enter');
  await dlg.getByRole('button', { name: 'Delete label Errands' }).click();
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  await saved(page, (b) => [b.labels, b.notes[0].labels]).toEqual([['Doctor'], ['Doctor']]);
});

test('pin, archive, trash with undo, restore, delete forever and empty trash', async ({ page }) => {
  await setup(page);
  await takeNote(page, 'Alpha', 'a');
  await takeNote(page, 'Beta', 'b');
  await takeNote(page, 'Gamma', 'c');
  await card(page, 'Alpha').hover();
  await card(page, 'Alpha').getByRole('button', { name: 'Pin note' }).click();
  await expect(page.getByRole('region', { name: 'Pinned' }).getByTestId('note-card')).toHaveText(/Alpha/);
  await expect(page.getByRole('region', { name: 'Others' }).getByTestId('note-card')).toHaveCount(2);

  // archive with undo
  await card(page, 'Beta').hover();
  await card(page, 'Beta').getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note archived' })).toBeVisible();
  await expect(card(page, 'Beta')).toHaveCount(0);
  await page.locator('.nt-snack').getByRole('button', { name: 'Undo' }).click();
  await expect(card(page, 'Beta')).toBeVisible();
  await card(page, 'Beta').focus();
  await page.keyboard.press('e'); // keyboard: archive the selected note
  await expect(card(page, 'Beta')).toHaveCount(0);
  const views = page.getByRole('navigation', { name: 'Notes views' });
  await views.getByRole('button', { name: /Archive/ }).click();
  await expect(cards(page)).toHaveCount(1);
  await card(page, 'Beta').hover();
  await card(page, 'Beta').getByRole('button', { name: 'Unarchive' }).click();
  await expect(page.getByText('Your archived notes appear here')).toBeVisible();

  // delete → trash → restore, then delete forever and empty trash
  await views.getByRole('button', { name: /^Notes/ }).click();
  for (const t of ['Gamma', 'Beta']) {
    await card(page, t).hover();
    await card(page, t).getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Delete note' }).click();
    await expect(card(page, t)).toHaveCount(0);
  }
  await views.getByRole('button', { name: /Trash/ }).click();
  await expect(cards(page)).toHaveCount(2);
  await card(page, 'Gamma').click();
  await expect(editor(page)).toContainText("Can't edit in Trash");
  await editor(page).getByRole('button', { name: 'Restore' }).click();
  await expect(editor(page)).toHaveCount(0);
  await card(page, 'Beta').hover();
  await card(page, 'Beta').getByRole('button', { name: 'Delete forever' }).click();
  await expect(page.getByText('No notes in Trash')).toBeVisible();
  await saved(page, (b) => b.notes.map((n) => [n.title, !!n.trashed, n.pinned]).sort()).toEqual([['Alpha', false, true], ['Gamma', false, false]]);
  await views.getByRole('button', { name: /^Notes/ }).click();
  await card(page, 'Gamma').hover();
  await card(page, 'Gamma').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete note' }).click();
  await views.getByRole('button', { name: /Trash/ }).click();
  await page.getByRole('button', { name: 'Empty Trash' }).click();
  await saved(page, (b) => b.notes.map((n) => n.title)).toEqual(['Alpha']);
});

test('search and filter by text, type, label and colour; grid and list view', async ({ page }) => {
  await setup(page);
  await takeNote(page, 'Recipe', 'Pancakes with blueberries');
  await takeList(page, 'Shopping', ['flour', 'blueberries']);
  await takeNote(page, 'Meeting', 'Quarterly plan');
  await card(page, 'Meeting').hover();
  await card(page, 'Meeting').getByRole('button', { name: 'Background options' }).click();
  await page.getByRole('radio', { name: 'Sage' }).click();
  await page.getByTestId('notes-content').click({ position: { x: 20, y: 700 } });

  const search = page.getByLabel('Search notes');
  await search.fill('blueberries');
  await expect(cards(page)).toHaveCount(2);
  await page.getByLabel('Filter by type').selectOption('checklist');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Shopping');
  await search.fill('');
  await page.getByLabel('Filter by type').selectOption('any');
  await page.getByLabel('Filter by colour').selectOption('sage');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Meeting');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(cards(page)).toHaveCount(3);
  await search.fill('nothing like this');
  await expect(page.getByText('No matching results.')).toBeVisible();
  await search.press('Escape');
  await expect(cards(page)).toHaveCount(3);

  // "/" focuses search, Ctrl+G switches to the list view and back
  await page.getByTestId('notes-content').click({ position: { x: 20, y: 700 } });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.blur();
  await expect(page.locator('.nt-grid--grid')).toHaveCount(1);
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.nt-grid--list')).toHaveCount(1);
  await expect(page.locator('.nt-grid--list .nt-col')).toHaveCount(1);
  await page.keyboard.press('Control+g');
  await expect(page.locator('.nt-grid--grid')).toHaveCount(1);
});

test('drag cards to reorder, and drop one among the pinned notes to pin it', async ({ page }) => {
  await setup(page);
  for (const t of ['One', 'Two', 'Three']) await takeNote(page, t, `${t} body`);
  await page.getByRole('button', { name: 'List view' }).click(); // one column: order top to bottom
  await expect(cards(page)).toHaveText([/Three/, /Two/, /One/]);
  await card(page, 'One').dragTo(card(page, 'Three'), { targetPosition: { x: 60, y: 6 } });
  await expect(cards(page)).toHaveText([/One/, /Three/, /Two/]);
  await saved(page, (b) => b.notes.map((n) => n.title)).toEqual(['One', 'Three', 'Two']);
  await card(page, 'Two').hover();
  await card(page, 'Two').getByRole('button', { name: 'Pin note' }).click();
  await card(page, 'Three').dragTo(card(page, 'Two'), { targetPosition: { x: 60, y: 6 } });
  await expect(page.getByRole('region', { name: 'Pinned' }).getByTestId('note-card')).toHaveText([/Three/, /Two/]);
  await saved(page, (b) => b.notes.filter((n) => n.pinned).map((n) => n.title)).toEqual(['Three', 'Two']);
});

test('images are added to notes and saved as side files next to the notebook', async ({ page }) => {
  await setup(page);
  await takeNote(page, 'Whiteboard', 'Photo of the plan');
  await card(page, 'Whiteboard').hover();
  const chooser = page.waitForEvent('filechooser');
  await card(page, 'Whiteboard').getByRole('button', { name: 'Add image' }).click();
  await (await chooser).setFiles({ name: 'plan.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.alloc(6000)]) });
  await expect(card(page, 'Whiteboard').locator('img')).toHaveCount(1);
  await page.getByLabel('Filter by type').selectOption('images');
  await expect(cards(page)).toHaveCount(1);
  await page.getByLabel('Filter by type').selectOption('any');
  // the file keeps a pigry-asset reference and the bytes are a side file
  await saved(page, (b) => /^pigry-asset:/.test(b.notes[0].images[0].src)).toBe(true);
  const sideFiles = await page.evaluate(() => [...window.__binary.keys()]);
  expect(sideFiles.some((p) => p.startsWith('.pigry/notes/user/notes.notes.assets/'))).toBe(true);
  // the composer's image button starts a note with a picture
  const chooser2 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'New note with image' }).click();
  await (await chooser2).setFiles({ name: 'cat.png', mimeType: 'image/png', buffer: PNG });
  await expect(composer(page).locator('img')).toHaveCount(1);
  await composer(page).getByLabel('Title', { exact: true }).fill('Cat');
  await composer(page).getByRole('button', { name: 'Close' }).click();
  await expect(card(page, 'Cat').locator('img')).toHaveCount(1);
  // remove the image in the editor
  await card(page, 'Whiteboard').click();
  await editor(page).locator('.nt-image').hover();
  await editor(page).getByRole('button', { name: 'Remove image' }).click();
  await page.keyboard.press('Escape');
  await expect(card(page, 'Whiteboard').locator('img')).toHaveCount(0);
});

test('agent tools write notes into the agent folder, and notes_open shows them', async ({ page }) => {
  await setup(page);
  await takeNote(page, 'Mine', 'my own note');
  const result = await page.evaluate(async () => {
    const { NOTES_TOOLS } = await import('/src/extensions/notes/notesTools.ts');
    const { withCaller } = await import('/src/lib/ownedFiles.ts');
    const tool = (name) => NOTES_TOOLS.find((t) => t.name === name);
    const call = (name, input) => tool(name).run(withCaller(name, input, 'organizer'));
    const edit = await call('notes_edit', { ops: [{ op: 'add', title: 'Standup', items: ['Demo the search', '[x] Update tickets'], labels: ['Work'], pinned: true }] });
    const user = await call('notes_edit', { name: 'user/notes', ops: [{ op: 'add', title: 'From the agent', body: 'Hello', color: 'sand' }] });
    const list = await call('notes_list', {});
    const read = await call('notes_read', { name: 'user/notes' });
    const search = await call('notes_search', { query: 'search' });
    const bad = await call('notes_edit', { name: 'user/notes', ops: [{ op: 'pin', note: 'does-not-exist' }] });
    const open = await call('notes_open', { name: 'organizer/notes', note: 'Standup' });
    return { edit, user, list, read, search, bad, open };
  });
  expect(result.edit).toContain('saved .pigry/notes/organizer/notes.notes.json');
  expect(result.list).toMatch(/organizer\/notes/);
  expect(result.list).toMatch(/user\/notes/);
  expect(result.read).toMatch(/From the agent/);
  expect(result.read).toMatch(/Mine/);
  expect(result.search).toMatch(/organizer\/notes .*Standup/);
  expect(result.bad).toMatch(/^error: op 1 \(pin\): no note "does-not-exist"/);
  expect(result.open).toMatch(/opened "organizer\/notes"/);
  // the agent's notebook is open with the note in the editor
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('Standup');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Pinned' }).getByTestId('note-card')).toContainText('Demo the search');
  await saved(page, (b) => b.notes[0].by, 'notes').toBe('organizer');
  await saved(page, (b) => b.notes.map((n) => n.title), 'notes').toEqual(['From the agent', 'Mine']);
  const agentBook = JSON.parse(await page.evaluate(() => window.__worktree.get('.pigry/notes/organizer/notes.notes.json')));
  expect(agentBook.notes[0].items.map((i) => i.checked)).toEqual([false, true]);
});
