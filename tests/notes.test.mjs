import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addNote, convertNote, copyNote, counts, deleteLabel, editedLabel, emptyBook, ensureLabel, findNote, formatReminder, isEmptyNote, isOverdue, masonry, moveItem, moveItemNear,
  moveNote, moveNoteTo, newItem, newNote, nextOccurrence, normalizeBook, parseBookJson, parseReminderAt, pinNote, archiveNote, presetDate, renameLabel, serializeBook,
  setNoteLabel, textToItems, trashNote, visibleNotes, bookToMarkdown, COLORS, BACKGROUNDS,
} from '../src/extensions/notes/notes.ts';
import { applyOps, parseOps, readBook, summarizeBook } from '../src/extensions/notes/notesOps.ts';

const CTX = { author: 'organizer', now: '2026-11-26T10:00:00.000Z' };
const run = (book, ops) => { const r = applyOps(book, ops, CTX); assert.equal(r.error, undefined, r.error); return r.book; };
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const titles = (notes) => notes.map((n) => n.title);

test('new notes go first; copies sit next to the original with fresh ids', () => {
  const b = emptyBook();
  addNote(b, newNote({ title: 'A' }));
  addNote(b, newNote({ title: 'B', items: [newItem('x'), newItem('y', true)] }));
  assert.deepEqual(titles(b.notes), ['B', 'A']);
  assert.equal(b.notes[0].kind, 'checklist');
  const copy = copyNote(b, b.notes[0].id, CTX.now);
  assert.deepEqual(titles(b.notes), ['B', 'B', 'A']);
  assert.notEqual(copy.id, b.notes[1].id);
  assert.notEqual(copy.items[0].id, b.notes[1].items[0].id);
  assert.deepEqual(copy.items.map((i) => [i.text, i.checked]), [['x', false], ['y', true]]);
});

test('checklists: text lines become items, items reorder, and converting back keeps open items first', () => {
  const items = textToItems('- [ ] milk\n[x] eggs\n☑ bread\nbutter\n\n');
  assert.deepEqual(items.map((i) => [i.text, i.checked]), [['milk', false], ['eggs', true], ['bread', true], ['butter', false]]);
  const n = newNote({ body: 'one\ntwo\nthree' });
  convertNote(n, 'checklist');
  assert.equal(n.kind, 'checklist');
  assert.deepEqual(n.items.map((i) => i.text), ['one', 'two', 'three']);
  moveItem(n, n.items[2].id, 0);
  assert.deepEqual(n.items.map((i) => i.text), ['three', 'one', 'two']);
  moveItemNear(n, n.items[0].id, n.items[2].id, true);
  assert.deepEqual(n.items.map((i) => i.text), ['one', 'two', 'three']);
  n.items[0].checked = true;
  convertNote(n, 'text');
  assert.equal(n.body, 'two\nthree\none');
  assert.equal(n.items.length, 0);
});

test('labels: created on demand, renamed and merged on every note, deleted from every note', () => {
  const b = emptyBook();
  const n = addNote(b, newNote({ title: 'Trip', labels: ['travel'] }));
  const m = addNote(b, newNote({ title: 'Work' }));
  assert.deepEqual(b.labels, ['travel']);
  setNoteLabel(b, m, 'Work', true);
  setNoteLabel(b, m, 'work', true); // same label, different case
  assert.deepEqual(m.labels, ['Work']);
  assert.deepEqual(b.labels, ['travel', 'Work']);
  renameLabel(b, 'travel', 'Trips');
  assert.deepEqual(n.labels, ['Trips']);
  renameLabel(b, 'Trips', 'work'); // merges into the existing label
  assert.deepEqual(b.labels, ['work']);
  assert.deepEqual(n.labels, ['work']);
  deleteLabel(b, 'WORK');
  assert.deepEqual(b.labels, []);
  assert.deepEqual(n.labels, []);
  assert.throws(() => ensureLabel(b, '   '), /needs a name/);
});

test('views: pinned first, archive and trash apart, searching covers notes and archive', () => {
  const b = emptyBook();
  const a = addNote(b, newNote({ title: 'Alpha', body: 'apples' }));
  const p = addNote(b, newNote({ title: 'Pinned', body: 'pears' }));
  const ar = addNote(b, newNote({ title: 'Old', body: 'apples again', labels: ['fruit'] }));
  const t = addNote(b, newNote({ title: 'Gone', body: 'apples gone' }));
  pinNote(p);
  archiveNote(ar);
  trashNote(t, CTX.now);
  const v = visibleNotes(b, { kind: 'notes' });
  assert.deepEqual(titles(v.pinned), ['Pinned']);
  assert.deepEqual(titles(v.others), ['Alpha']);
  assert.deepEqual(titles(visibleNotes(b, { kind: 'archive' }).others), ['Old']);
  assert.deepEqual(titles(visibleNotes(b, { kind: 'trash' }).others), ['Gone']);
  assert.deepEqual(titles(visibleNotes(b, { kind: 'notes' }, { query: 'APPLES' }).others), ['Old', 'Alpha']);
  assert.deepEqual(titles(visibleNotes(b, { kind: 'label', label: 'Fruit' }).others), ['Old']); // label views include archived notes, as in Keep
  // pinning an archived note brings it back
  archiveNote(a); pinNote(a);
  assert.equal(a.archived, false);
  const c = counts(b);
  assert.deepEqual([c.notes, c.pinned, c.archive, c.trash], [2, 2, 1, 1]);
});

test('filters: type, colour and label', () => {
  const b = emptyBook();
  addNote(b, newNote({ title: 'List', items: [newItem('a')], color: 'mint' }));
  addNote(b, newNote({ title: 'Pic', images: [{ id: 'm1', src: PNG_1x1, alt: 'receipt' }] }));
  addNote(b, newNote({ title: 'Remind', reminder: { at: '2026-11-27T08:00', repeat: 'none' }, labels: ['home'] }));
  const of = (f) => titles(visibleNotes(b, { kind: 'notes' }, f).others);
  assert.deepEqual(of({ type: 'checklist' }), ['List']);
  assert.deepEqual(of({ type: 'images' }), ['Pic']);
  assert.deepEqual(of({ type: 'reminders' }), ['Remind']);
  assert.deepEqual(of({ color: 'mint' }), ['List']);
  assert.deepEqual(of({ label: 'Home' }), ['Remind']);
  assert.deepEqual(of({ query: 'receipt' }), ['Pic']);
  assert.deepEqual(titles(visibleNotes(b, { kind: 'reminders' }).others), ['Remind']);
});

test('drag to reorder: a note dropped before another takes its place and its pinned state', () => {
  const b = emptyBook();
  for (const t of ['D', 'C', 'B', 'A']) addNote(b, newNote({ title: t }));
  const [A, B, C, D] = b.notes;
  moveNote(b, D.id, B.id);
  assert.deepEqual(titles(b.notes), ['A', 'D', 'B', 'C']);
  moveNote(b, A.id, C.id, true);
  assert.deepEqual(titles(b.notes), ['D', 'B', 'C', 'A']);
  pinNote(C);
  moveNote(b, A.id, C.id);
  assert.equal(A.pinned, true);
  moveNoteTo(b, D.id, 99);
  assert.deepEqual(titles(b.notes.filter((n) => !n.pinned)), ['B', 'D']);
});

test('masonry keeps reading order and balances the columns', () => {
  const notes = [1, 2, 3, 4, 5, 6].map((i) => newNote({ title: `N${i}` }));
  const h = (n) => (n.title === 'N1' ? 500 : 100);
  const cols = masonry(notes, 3, h);
  assert.deepEqual(cols.map((c) => titles(c)), [['N1'], ['N2', 'N4', 'N6'], ['N3', 'N5']]);
  assert.deepEqual(masonry(notes, 1).map((c) => c.length), [6]);
});

test('reminders: parsing, presets, labels, overdue and repeats', () => {
  const now = new Date(2026, 10, 26, 10, 30); // Thu 26 Nov 2026, 10:30 local
  assert.equal(parseReminderAt('2026-11-27 09:15', now), '2026-11-27T09:15');
  assert.equal(parseReminderAt('2026-12-01', now), '2026-12-01T08:00');
  assert.equal(parseReminderAt('tomorrow 9:00', now), '2026-11-27T09:00');
  assert.equal(parseReminderAt('today 6pm', now), '2026-11-26T18:00');
  assert.equal(parseReminderAt('next week', now), '2026-11-30T08:00');
  assert.equal(parseReminderAt('whenever', now), null);
  assert.equal(presetDate('later', now).getHours(), 20);
  assert.equal(presetDate('week', now).getDay(), 1);
  const t = now.getTime();
  assert.equal(formatReminder({ at: '2026-11-26T20:00', repeat: 'none' }, t), 'Today, 8:00 PM');
  assert.equal(formatReminder({ at: '2026-11-27T08:00', repeat: 'weekly' }, t), 'Tomorrow, 8:00 AM · Weekly');
  assert.equal(formatReminder({ at: '2026-12-03T09:05', repeat: 'none' }, t), 'Dec 3, 9:05 AM');
  assert.equal(formatReminder({ at: '2027-01-03T09:05', repeat: 'none' }, 0), 'Jan 3, 2027, 9:05 AM');
  assert.equal(isOverdue({ at: '2026-11-26T09:00', repeat: 'none' }, t), true);
  assert.equal(isOverdue({ at: '2026-11-26T09:00', repeat: 'none' }, 0), false);
  assert.equal(nextOccurrence({ at: '2026-11-20T08:00', repeat: 'weekly' }, t), '2026-11-27T08:00');
  assert.equal(nextOccurrence({ at: '2026-11-20T08:00', repeat: 'none' }, t), null);
  assert.match(editedLabel(new Date(2026, 10, 26, 9, 4).toISOString(), t), /^Edited 9:04 AM$/);
  assert.equal(editedLabel(new Date(2026, 9, 2).toISOString(), t), 'Edited Oct 2');
});

test('files: normalize repairs bad input, keeps labels consistent, and round-trips', () => {
  const { book, warnings } = normalizeBook({
    title: 'Mine', labels: ['b'],
    notes: [
      { id: 'x', title: 'T', body: 'hello', color: 'mint', background: 'travel', labels: ['a', 'A'], pinned: true, reminder: '2026-12-01 10:00' },
      { id: 'x', kind: 'checklist', items: ['one', { text: 'two', checked: true }, 7], color: 'neon' },
      'junk',
    ],
  });
  assert.equal(book.notes.length, 2);
  assert.ok(warnings.some((w) => /duplicate id/.test(w)));
  assert.ok(warnings.some((w) => /unknown colour/.test(w)));
  assert.ok(warnings.some((w) => /dropped/.test(w)));
  assert.deepEqual(book.labels, ['a', 'b']);
  assert.deepEqual(book.notes[0].labels, ['a']);
  assert.deepEqual(book.notes[0].reminder, { at: '2026-12-01T10:00', repeat: 'none' });
  assert.equal(book.notes[1].color, 'default');
  assert.deepEqual(book.notes[1].items.map((i) => [i.text, i.checked]), [['one', false], ['two', true], ['7', false]]);
  const again = parseBookJson(serializeBook(book));
  assert.deepEqual(again.book, book);
  assert.deepEqual(again.warnings, []);
  assert.equal(parseBookJson('{nope', 'fallback').book.title, 'fallback');
  assert.equal(normalizeBook([{ title: 'bare' }]).book.notes[0].title, 'bare');
  assert.ok(isEmptyNote(newNote({ items: [newItem('  ')] })));
  assert.equal(COLORS.length, 12);
  assert.equal(BACKGROUNDS[0].id, 'none');
});

test('ops: add notes and lists, check, move and label items, all-or-nothing with a log', () => {
  let b = run(emptyBook(), [
    { op: 'add', title: 'Groceries', items: ['milk', 'eggs', '[x] bread'], color: 'Mint', labels: 'home, food' },
    { op: 'add', title: 'Trip', body: 'Book flights', pinned: true, reminder: { at: '2026-12-01 09:00', repeat: 'weekly' } },
  ]);
  const g = findNote(b, 'groceries');
  assert.equal(g.kind, 'checklist');
  assert.equal(g.color, 'mint');
  assert.deepEqual(b.labels, ['food', 'home']);
  assert.equal(g.by, 'organizer');
  assert.deepEqual(findNote(b, 'Trip').reminder, { at: '2026-12-01T09:00', repeat: 'weekly' });
  b = run(b, [
    { op: 'check', note: 'Groceries', item: 'milk' },
    { op: 'add_item', note: g.id, text: 'butter', at: 1 },
    { op: 'move_item', note: g.id, item: 'eggs', to: 1 },
    { op: 'label', note: 'Trip', add: ['travel'], remove: 'home' },
    { op: 'convert', note: 'Trip', to: 'checklist' },
    { op: 'append', note: 'Trip', text: 'Pack bags' },
  ]);
  const g2 = findNote(b, g.id);
  assert.deepEqual(g2.items.map((i) => `${i.checked ? 'x' : ' '}${i.text}`), [' eggs', ' butter', 'xmilk', 'xbread']);
  assert.deepEqual(findNote(b, 'Trip').items.map((i) => i.text), ['Book flights', 'Pack bags']);
  assert.deepEqual(findNote(b, 'Trip').labels, ['travel']);
  // a failing op leaves the notebook as it was
  const bad = applyOps(b, [{ op: 'check', note: 'Groceries', item: 'eggs' }, { op: 'check', note: 'Groceries', item: 'caviar' }], CTX);
  assert.match(bad.error, /op 2 \(check\).*no item "caviar"/);
  assert.equal(bad.book, b);
  assert.equal(findNote(b, g.id).items[0].checked, false);
  assert.match(applyOps(b, [{ op: 'set', note: 'Trip', color: 'neon' }], CTX).error, /unknown colour/);
  assert.match(applyOps(b, [{ op: 'remind', note: 'Trip', at: 'someday' }], CTX).error, /cannot read the reminder/);
});

test('ops: pin, archive, trash, restore, delete, copy, move, images, labels and title', () => {
  let b = run(emptyBook(), [
    { op: 'add', title: 'One' }, { op: 'add', title: 'Two' }, { op: 'add', title: 'Three' },
  ]);
  b = run(b, [
    { op: 'pin', note: 'One' }, { op: 'archive', note: 'Two' }, { op: 'trash', note: 'Three' },
    { op: 'copy', note: 'One', title: 'One (copy)' },
    { op: 'add_image', note: 'One', src: PNG_1x1, alt: 'dot' },
    { op: 'create_label', name: 'Work' }, { op: 'label', note: 'One', add: 'Work' }, { op: 'rename_label', from: 'work', to: 'Jobs' },
    { op: 'title', title: 'Personal' },
  ]);
  assert.equal(b.title, 'Personal');
  assert.equal(findNote(b, 'One').pinned, true);
  assert.equal(findNote(b, 'Two').archived, true);
  assert.ok(findNote(b, 'Three').trashed);
  assert.equal(findNote(b, 'One (copy)').pinned, true);
  assert.equal(findNote(b, 'One').images[0].alt, 'dot');
  assert.deepEqual(findNote(b, 'One').labels, ['Jobs']);
  assert.match(applyOps(b, [{ op: 'delete', note: 'One' }], CTX).error, /not in the trash/);
  assert.match(applyOps(b, [{ op: 'add_image', note: 'One', src: 'http://x/y.png' }], CTX).error, /data:image/);
  b = run(b, [{ op: 'restore', note: 'Three' }, { op: 'trash', note: 'Three' }, { op: 'empty_trash' }, { op: 'remove_image', note: 'One', image: 1 }, { op: 'unarchive', note: 'Two' }, { op: 'move', note: 'Two', to: 1 }]);
  assert.equal(findNote(b, 'Three'), undefined);
  assert.equal(findNote(b, 'One').images.length, 0);
  assert.deepEqual(titles(visibleNotes(b, { kind: 'notes' }).others), ['Two']);
  const r = applyOps(b, [{ op: 'add', title: 'New' }], CTX);
  assert.equal(r.created.length, 1);
  assert.ok(r.log[0].includes(r.created[0]));
});

test('parseOps, readBook, summarizeBook and Markdown', () => {
  assert.deepEqual(parseOps({ op: 'pin', note: 'x' }).ops.length, 1);
  assert.match(parseOps([{ op: 'fly' }]).errors[0], /unknown op "fly"/);
  assert.match(parseOps('nope').errors[0], /must be an array/);
  const b = run(emptyBook('Home'), [
    { op: 'add', title: 'Groceries', items: ['milk', '[x] eggs'], labels: ['home'] },
    { op: 'add', title: 'Idea', body: 'A garden', color: 'sand', pinned: true },
    { op: 'add', title: 'Old', body: 'archived thing', archived: true },
  ]);
  const text = readBook(b);
  assert.match(text, /"Home": 2 note\(s\) \(1 pinned\), 1 archived/);
  assert.ok(text.indexOf('Idea') < text.indexOf('Groceries'), 'pinned first');
  assert.match(text, /1\. \[ \] milk/);
  assert.match(text, /2\. \[x\] eggs/);
  assert.match(readBook(b, { include: 'archive' }), /Old/);
  assert.doesNotMatch(readBook(b, { include: 'notes' }), /archived thing/);
  assert.match(readBook(b, { query: 'zebra' }), /no notes match/);
  assert.match(summarizeBook(b), /labels: home \(1\)/);
  const md = bookToMarkdown(b);
  assert.match(md, /^# Home/);
  assert.match(md, /## Groceries\n\n- \[ \] milk\n- \[x\] eggs/);
  assert.match(md, /_Labels: home_/);
});
