import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_REF, assetNameOf, assetRefsIn, assetsDirOf, externalizeMedia, internalizeMedia, toFileJson } from '../src/lib/fileJson.ts';

test('toFileJson round-trips and keeps one field per line', () => {
  const doc = { version: 1, name: 'cat', size: { w: 320, h: 200 }, tags: ['a', 'b'], layers: [{ id: 'l1', name: 'Base', opacity: 1, nested: { deep: [1, { x: 2 }] } }], empty: [], none: {}, skip: undefined };
  const text = toFileJson(doc);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(doc)));
  assert.ok(text.endsWith('\n'));
  assert.match(text, /^ {2}"name": "cat",$/m);
  assert.match(text, /^ {2}"size": \{ "w": 320, "h": 200 \},$/m, 'short plain objects stay on one line');
  assert.match(text, /^ {2}"tags": \["a", "b"\],$/m);
  assert.doesNotMatch(text, /skip/);
  // a one-field edit is a one-line change
  const edited = toFileJson({ ...doc, name: 'dog' }).split('\n');
  const changed = text.split('\n').filter((line, i) => line !== edited[i]);
  assert.equal(changed.length, 1);
});

test('toFileJson wraps long lists of numbers instead of one per line', () => {
  const points = Array.from({ length: 400 }, (_, i) => i * 1.5);
  const text = toFileJson({ points });
  assert.deepEqual(JSON.parse(text).points, points);
  const lines = text.split('\n');
  assert.ok(lines.length < 60, `expected wrapped lines, got ${lines.length}`);
  assert.ok(lines.every((line) => line.length <= 100), 'no line wider than 100');
});

test('externalizeMedia lifts big images into content-addressed side files and internalizeMedia restores them', async () => {
  const big = `data:image/png;base64,${'A'.repeat(6000)}`;
  const small = `data:image/png;base64,${'B'.repeat(100)}`;
  const doc = { layers: [{ png: big }, { png: big }, { png: small }, { png: '' }], note: 'data:image/png;base64, text' };
  const { value, assets } = await externalizeMedia(doc);
  assert.equal(assets.length, 1, 'the same picture is stored once');
  assert.match(assets[0].name, /^[0-9a-f]{20}\.png$/);
  assert.equal(assets[0].base64, 'A'.repeat(6000));
  assert.equal(value.layers[0].png, `${ASSET_REF}${assets[0].name}`);
  assert.equal(value.layers[1].png, value.layers[0].png);
  assert.equal(value.layers[2].png, small, 'small images stay inline');
  assert.deepEqual(assetRefsIn(value), [assets[0].name]);
  // the same content always gets the same name
  assert.equal((await externalizeMedia({ x: big })).assets[0].name, assets[0].name);

  const back = await internalizeMedia(value, async (name) => (name === assets[0].name ? assets[0].base64 : null));
  assert.deepEqual(back, doc);
  // a missing side file keeps its reference rather than inventing data
  const missing = await internalizeMedia(value, async () => null);
  assert.equal(missing.layers[0].png, value.layers[0].png);
});

test('asset references cannot point outside the assets folder', () => {
  assert.equal(assetNameOf(`${ASSET_REF}0123456789abcdef.png`), '0123456789abcdef.png');
  assert.equal(assetNameOf(`${ASSET_REF}../../secret.png`), null);
  assert.equal(assetNameOf(`${ASSET_REF}0123456789abcdef.exe`), null);
  assert.equal(assetNameOf('0123456789abcdef.png'), null);
  assert.equal(assetsDirOf('.pigry/drawings/user/cat.drawing.json'), '.pigry/drawings/user/cat.drawing.assets/');
});
