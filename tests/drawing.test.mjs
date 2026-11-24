import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTERS, applyFilter, bucketFill, combineMasks, ellipseMask, featherMask, fillGradient, fillMask, filterParams, floodMask, growMask, hexOf, hsvToRgb,
  invertMask, makeMask, makePixels, maskBounds, maskEdges, parseColor, polygonMask, rectMask, rgbToHsv, blurPixels,
} from '../src/extensions/drawing/drawingPixels.ts';
import {
  BLEND_MODES, BRUSHES, blendOp, brushById, clampSide, emptyDrawing, findLayer, normalizeDrawing, parseDrawingJson, parseOps, summarizeDrawing, validateOp,
} from '../src/extensions/drawing/drawing.ts';

const solid = (w, h, c) => {
  const px = makePixels(w, h);
  for (let i = 0; i < w * h; i++) px.data.set([c.r, c.g, c.b, c.a ?? 255], i * 4);
  return px;
};
const at = (px, x, y) => [...px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 4)];
const RED = { r: 255, g: 0, b: 0, a: 255 };

test('colours parse from hex, rgb() and names and print back', () => {
  assert.deepEqual(parseColor('#f80'), { r: 255, g: 136, b: 0, a: 255 });
  assert.deepEqual(parseColor('#11223344'), { r: 17, g: 34, b: 51, a: 68 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 128 });
  assert.deepEqual(parseColor('RED'), { r: 255, g: 0, b: 0, a: 255 });
  assert.equal(parseColor('transparent').a, 0);
  assert.equal(parseColor('nope'), null);
  assert.equal(parseColor(5), null);
  assert.equal(hexOf({ r: 255, g: 128, b: 0, a: 255 }), '#ff8000');
  assert.equal(hexOf({ r: 0, g: 0, b: 0, a: 128 }), '#00000080');
});

test('hsv and rgb convert both ways', () => {
  for (const c of [{ r: 255, g: 0, b: 0 }, { r: 12, g: 200, b: 99 }, { r: 80, g: 80, b: 80 }, { r: 250, g: 250, b: 5 }]) {
    const { h, s, v } = rgbToHsv(c.r, c.g, c.b);
    const back = hsvToRgb(h, s, v);
    assert.ok(Math.abs(back.r - c.r) <= 1 && Math.abs(back.g - c.g) <= 1 && Math.abs(back.b - c.b) <= 1, JSON.stringify([c, back]));
  }
  assert.deepEqual(hsvToRgb(120, 1, 1), { r: 0, g: 255, b: 0 });
});

test('flood fill: contiguous areas, tolerance and the whole image', () => {
  // a white 6x4 picture split by a black column at x = 3
  const px = solid(6, 4, { r: 255, g: 255, b: 255 });
  for (let y = 0; y < 4; y++) px.data.set([0, 0, 0, 255], (y * 6 + 3) * 4);
  const left = floodMask(px, 0, 0, 0, true);
  assert.equal(left.filter(Boolean).length, 12);
  assert.equal(left[3], 0);
  assert.equal(floodMask(px, 0, 0, 0, false).filter(Boolean).length, 20, 'non-contiguous takes both white areas');
  assert.equal(floodMask(px, 0, 0, 255, true).filter(Boolean).length, 24, 'a high tolerance floods everything');
  assert.equal(floodMask(px, -1, 0, 0).filter(Boolean).length, 0, 'outside the image selects nothing');
});

test('bucket fill paints the area, respects the selection and soft edges blend', () => {
  const px = solid(4, 4, { r: 255, g: 255, b: 255 });
  const sel = rectMask(4, 4, 0, 0, 2, 4);
  bucketFill(px, 0, 0, RED, 0, true, sel);
  assert.deepEqual(at(px, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(px, 3, 3), [255, 255, 255, 255], 'outside the selection stays');
  const half = makeMask(2, 1, 128);
  const two = solid(2, 1, { r: 0, g: 0, b: 0 });
  fillMask(two, half, { r: 255, g: 255, b: 255, a: 255 });
  assert.ok(Math.abs(at(two, 0, 0)[0] - 128) <= 1);
  const clear = makePixels(1, 1);
  fillMask(clear, makeMask(1, 1, 255), { r: 10, g: 20, b: 30, a: 128 });
  assert.deepEqual(at(clear, 0, 0), [10, 20, 30, 128], 'painting on transparency keeps the colour and alpha');
});

test('selection masks: rectangle, ellipse, polygon, combine, invert, bounds and grow/shrink', () => {
  const rect = rectMask(10, 10, 2, 3, 4, 2);
  assert.equal(rect.filter(Boolean).length, 8);
  assert.deepEqual(maskBounds(rect, 10, 10), { x: 2, y: 3, w: 4, h: 2 });
  assert.equal(maskBounds(makeMask(3, 3), 3, 3), null);
  assert.equal(rectMask(10, 10, 8, 8, 10, 10).filter(Boolean).length, 4, 'a rectangle is cut at the canvas edge');
  const circle = ellipseMask(21, 21, 0, 0, 21, 21);
  assert.equal(circle[10 * 21 + 10], 255);
  assert.equal(circle[0], 0);
  const tri = polygonMask(10, 10, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]);
  assert.equal(tri[1 * 10 + 1], 255);
  assert.equal(tri[9 * 10 + 9], 0);
  assert.equal(polygonMask(5, 5, [{ x: 0, y: 0 }, { x: 1, y: 1 }]).filter(Boolean).length, 0, 'fewer than three points select nothing');
  const a = rectMask(6, 1, 0, 0, 4, 1), b = rectMask(6, 1, 2, 0, 4, 1);
  assert.equal(combineMasks(a, b, 'add').filter(Boolean).length, 6);
  assert.equal(combineMasks(a, b, 'subtract').filter(Boolean).length, 2);
  assert.equal(combineMasks(a, b, 'intersect').filter(Boolean).length, 2);
  assert.equal(combineMasks(null, b, 'subtract'), b, 'with no selection yet the new shape replaces it');
  assert.equal(invertMask(a).filter(Boolean).length, 2);
  const one = rectMask(9, 9, 4, 4, 1, 1);
  assert.equal(growMask(one, 9, 9, 2).filter(Boolean).length, 13, 'grown by 2 pixels (diamond)');
  assert.equal(growMask(rectMask(9, 9, 2, 2, 5, 5), 9, 9, -1).filter(Boolean).length, 9);
  assert.ok(maskEdges(rectMask(5, 5, 1, 1, 3, 3), 5, 5).length > 0);
});

test('feathering softens the edge of a selection', () => {
  const soft = featherMask(rectMask(40, 40, 5, 5, 30, 30), 40, 40, 3);
  assert.equal(soft[20 * 40 + 20], 255);
  assert.ok(soft[20 * 40 + 4] > 0 && soft[20 * 40 + 4] < 255, 'a pixel just outside is half selected');
});

test('gradients run from the first colour to the second and respect the selection', () => {
  const px = makePixels(11, 1);
  fillGradient(px, 0, 0, 11, 0, { r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }, 'linear');
  assert.ok(at(px, 0, 0)[0] < 25 && at(px, 10, 0)[0] > 230);
  assert.ok(at(px, 5, 0)[0] > 100 && at(px, 5, 0)[0] < 155);
  const radial = makePixels(9, 9);
  fillGradient(radial, 4.5, 4.5, 9, 4.5, RED, { r: 0, g: 0, b: 255, a: 255 }, 'radial');
  assert.ok(at(radial, 4, 4)[0] > 240 && at(radial, 0, 0)[2] > 200);
  const part = makePixels(4, 1);
  fillGradient(part, 0, 0, 4, 0, RED, RED, 'linear', rectMask(4, 1, 0, 0, 2, 1));
  assert.deepEqual(at(part, 3, 0), [0, 0, 0, 0]);
});

test('filters change the pixels the way their names say', () => {
  const px = solid(2, 2, { r: 10, g: 100, b: 200 });
  applyFilter(px, 'invert');
  assert.deepEqual(at(px, 0, 0), [245, 155, 55, 255]);
  const gray = solid(1, 1, { r: 255, g: 0, b: 0 });
  applyFilter(gray, 'grayscale');
  assert.ok(gray.data[0] === gray.data[1] && gray.data[1] === gray.data[2]);
  const dark = solid(1, 1, { r: 100, g: 100, b: 100 });
  applyFilter(dark, 'threshold', { level: 128 });
  assert.deepEqual(at(dark, 0, 0), [0, 0, 0, 255]);
  const bright = solid(1, 1, { r: 100, g: 100, b: 100 });
  applyFilter(bright, 'brightness-contrast', { brightness: 50, contrast: 0 });
  assert.ok(bright.data[0] > 200);
  const posterized = solid(1, 1, { r: 130, g: 130, b: 130 });
  applyFilter(posterized, 'posterize', { levels: 2 });
  assert.ok(posterized.data[0] === 0 || posterized.data[0] === 255);
  const hue = solid(1, 1, { r: 255, g: 0, b: 0 });
  applyFilter(hue, 'hue-saturation', { hue: 120 });
  assert.ok(hue.data[1] > 200 && hue.data[0] < 50);
  assert.equal(applyFilter(solid(1, 1, RED), 'does-not-exist'), false);
});

test('a filter only touches the selection and blends softly at feathered edges', () => {
  const px = solid(4, 1, { r: 0, g: 0, b: 0 });
  applyFilter(px, 'invert', {}, rectMask(4, 1, 0, 0, 2, 1));
  assert.deepEqual(at(px, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(at(px, 3, 0), [0, 0, 0, 255]);
  const soft = solid(1, 1, { r: 0, g: 0, b: 0 });
  applyFilter(soft, 'invert', {}, makeMask(1, 1, 128));
  assert.ok(Math.abs(at(soft, 0, 0)[0] - 128) <= 1);
});

test('blur keeps a flat colour, spreads an edge and does not darken transparent edges', () => {
  const flat = solid(8, 8, { r: 50, g: 120, b: 200 });
  blurPixels(flat, 4);
  assert.deepEqual(at(flat, 4, 4), [50, 120, 200, 255]);
  const edge = makePixels(16, 1);
  for (let x = 8; x < 16; x++) edge.data.set([255, 255, 255, 255], x * 4);
  blurPixels(edge, 4);
  assert.ok(at(edge, 7, 0)[3] > 0 && at(edge, 7, 0)[3] < 255, 'the edge becomes translucent');
  assert.ok(at(edge, 7, 0)[0] > 240, 'and stays white, not grey');
});

test('every filter runs, keeps the image size and has valid parameters', () => {
  for (const def of FILTERS) {
    const px = solid(12, 12, { r: 90, g: 140, b: 30 });
    px.data.set([255, 255, 255, 255], 5 * 4);
    assert.ok(applyFilter(px, def.id, {}), def.id);
    assert.equal(px.data.length, 12 * 12 * 4, def.id);
    for (const p of def.params) assert.ok(p.min < p.max && p.value >= p.min && p.value <= p.max, `${def.id}.${p.key}`);
  }
  const blur = FILTERS.find((f) => f.id === 'blur');
  assert.deepEqual(filterParams(blur, { radius: 9999 }), { radius: 60 });
  assert.deepEqual(filterParams(blur, { radius: 'x' }), { radius: 6 });
});

test('drawing documents are repaired on load', () => {
  const { drawing, warnings } = normalizeDrawing({
    title: '  Sky  ', width: 99999, height: 0,
    layers: [{ id: 'a', name: 'One', opacity: 7, blend: 'nope', png: 'http://x/y.png' }, { id: 'a', name: '' }, 'junk'],
  });
  assert.equal(drawing.title, 'Sky');
  assert.equal(drawing.width, 4096);
  assert.equal(drawing.height, 1);
  assert.equal(drawing.layers.length, 2);
  assert.equal(drawing.layers[0].opacity, 1);
  assert.equal(drawing.layers[0].blend, 'normal');
  assert.equal(drawing.layers[0].png, '');
  assert.notEqual(drawing.layers[1].id, 'a');
  assert.ok(warnings.length >= 3);
  assert.equal(normalizeDrawing({ layers: [] }).drawing.layers.length, 1, 'there is always a layer');
  assert.equal(parseDrawingJson('{not json', 'x').drawing.title, 'x');
  assert.equal(normalizeDrawing({ background: null }).drawing.background, null, 'a transparent background is kept');
  assert.equal(clampSide('abc'), 1024);
});

test('layers are found by id, name or position, and described for the agent', () => {
  const d = emptyDrawing('Pic', 200, 100);
  d.layers.push({ ...d.layers[0], id: 'sky', name: 'Sky', visible: false, blend: 'multiply', opacity: 0.5 });
  assert.equal(findLayer(d.layers, 'sky').id, 'sky');
  assert.equal(findLayer(d.layers, 'SKY').id, 'sky');
  assert.equal(findLayer(d.layers, 1).id, 'l1');
  assert.equal(findLayer(d.layers, '2').id, 'sky');
  assert.equal(findLayer(d.layers, 'nope'), undefined);
  const text = summarizeDrawing(d);
  assert.match(text, /200×100/);
  assert.match(text, /"Sky" \(hidden, multiply, 50%, empty\)/);
});

test('brushes and blend modes are consistent', () => {
  assert.equal(brushById('nonsense').id, BRUSHES[0].id);
  assert.equal(brushById('airbrush').hardness, 0);
  for (const b of BRUSHES) assert.ok(b.size > 0 && b.flow > 0 && b.opacity > 0 && b.spacing > 0, b.id);
  assert.equal(new Set(BLEND_MODES.map((m) => m.id)).size, BLEND_MODES.length);
  assert.equal(blendOp('multiply'), 'multiply');
  assert.equal(blendOp('???'), 'source-over');
});

test('operations are validated with readable errors', () => {
  assert.equal(validateOp({ op: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff' }), null);
  assert.match(validateOp({ op: 'sparkle' }), /unknown op/);
  assert.match(validateOp({ op: 'rect', x: 0, y: 0, w: 10 }), /needs "h"/);
  assert.match(validateOp({ op: 'rect', x: 0, y: 0, w: 'big', h: 1 }), /"w" must be a number/);
  assert.match(validateOp({ op: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 'purplish' }), /must be a colour/);
  assert.match(validateOp({ op: 'stroke', points: [], color: 'red' }), /list of \[x, y\]/);
  assert.match(validateOp({ op: 'layer_edit', layer: 1, blend: 'glow' }), /blend must be one of/);
  assert.match(validateOp({ op: 'rotate', degrees: 45 }), /90, 180/);
  assert.match(validateOp({ op: 'canvas_resize', width: 99999, height: 10 }), /between 1 and 4096/);
  assert.match(validateOp({ op: 'select', shape: 'star' }), /shape must be/);
  assert.match(validateOp(null), /must be an object/);
  const { ops, errors } = parseOps('[{"op":"line","x1":0,"y1":0,"x2":5,"y2":5,"color":"red"},{"op":"fill"}]');
  assert.equal(ops.length, 1);
  assert.match(errors[0], /^op 2:/);
  assert.equal(parseOps({ op: 'layer_add' }).ops.length, 1, 'a single operation is accepted');
  assert.match(parseOps('nope').errors[0], /not valid JSON/);
  assert.match(parseOps(5).errors[0], /must be a list/);
});
