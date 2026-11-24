import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, applyModelOp, applyModelOps, checkModel, emptyModel, findObject, makeObject, normalizeColor, normalizeModel, parseModelJson, parseOps, sceneBounds, starterModel,
  summarizeModel, triangleCount, uniqueName, validateOp, worldBounds, descendantsOf,
} from '../src/extensions/model3d/model3d.ts';

const build = (ops, model = emptyModel('t')) => {
  const result = applyModelOps(model, ops);
  assert.equal(result.error, undefined, result.error);
  return model;
};

test('colours are normalised from hex and names', () => {
  assert.equal(normalizeColor('#F80'), '#ff8800');
  assert.equal(normalizeColor('Orange'), '#ffa500');
  assert.equal(normalizeColor('#12345'), null);
  assert.equal(normalizeColor(5), null);
});

test('objects get Blender-style unique names and sensible defaults', () => {
  const m = emptyModel();
  assert.equal(uniqueName(m.objects, 'Cube'), 'Cube');
  m.objects.push(makeObject('box', m.objects, {}));
  m.objects.push(makeObject('box', m.objects, {}));
  m.objects.push(makeObject('box', m.objects, {}));
  assert.deepEqual(m.objects.map((o) => o.name), ['Cube', 'Cube.001', 'Cube.002']);
  assert.deepEqual(m.objects.map((o) => o.id), ['o1', 'o2', 'o3']);
  const plane = makeObject('plane', m.objects, {});
  assert.deepEqual(plane.rotation, [-90, 0, 0], 'a plane lies flat');
  const sun = makeObject('light', m.objects, { light: { type: 'sun' } });
  assert.equal(sun.name, 'Sun light');
  assert.equal(sun.light.intensity, 3);
  assert.deepEqual(sun.position, [0, 3, 0]);
  const cam = makeObject('camera', m.objects, { lookAt: [0, 1, 0] });
  assert.deepEqual(cam.lookAt, [0, 1, 0]);
  assert.equal(cam.camera.fov, 50);
  for (const kind of KINDS) assert.ok(makeObject(kind, [], {}).id);
});

test('parameters, materials and scale are clamped to valid values', () => {
  const o = makeObject('sphere', [], { params: { radius: -5, segments: 9999 }, material: { metalness: 7, roughness: -1, color: 'nonsense', opacity: 2 }, scale: 2 });
  assert.equal(o.params.radius, 0.001);
  assert.equal(o.params.segments, 128);
  assert.equal(o.material.metalness, 1);
  assert.equal(o.material.roughness, 0);
  assert.equal(o.material.opacity, 1);
  assert.equal(o.material.color, '#c8c8c8', 'an invalid colour keeps the default');
  assert.deepEqual(o.scale, [2, 2, 2]);
  assert.deepEqual(makeObject('empty', [], { params: { radius: 3 } }).params, {});
});

test('a saved model is repaired on load', () => {
  const { model, warnings } = normalizeModel({
    title: '  Room  ',
    world: { background: 'bad', ambient: 99 },
    objects: [
      { id: 'a', name: 'Floor', kind: 'plane' },
      { id: 'a', name: 'Dup', kind: 'box', parent: 'ghost' },
      { id: 'c', kind: 'dragon' },
      'junk',
      { id: 'd', name: 'D', kind: 'box', parent: 'e' },
      { id: 'e', name: 'E', kind: 'box', parent: 'd' },
    ],
  });
  assert.equal(model.title, 'Room');
  assert.equal(model.world.ambient, 10);
  assert.equal(model.world.background, '#2b2f36');
  assert.equal(model.objects.length, 4);
  assert.deepEqual(model.objects[0].rotation, [-90, 0, 0]);
  assert.notEqual(model.objects[1].id, 'a');
  assert.equal(model.objects[1].parent, null, 'a parent that does not exist is dropped');
  assert.ok(model.objects.filter((o) => o.id === 'd' || o.id === 'e').some((o) => o.parent === null), 'a parent cycle is broken');
  assert.ok(warnings.length >= 4);
  assert.equal(parseModelJson('{broken', 'x').model.title, 'x');
});

test('the starter scene has a ground, a cube, a sun and a camera', () => {
  const m = starterModel('Demo');
  assert.deepEqual(m.objects.map((o) => o.name), ['Ground', 'Cube', 'Sun light'.replace(' light', ''), 'Camera']);
  assert.equal(m.objects.filter((o) => o.kind === 'light').length, 1);
  assert.equal(checkModel(m).filter((i) => i.severity !== 'info').length, 0);
});

test('operations add and edit objects, and objects are found by id, name or position', () => {
  const m = build([
    { op: 'add', kind: 'box', name: 'Body', position: [0, 0.5, 0], params: { width: 2, height: 1, depth: 4 }, material: { color: 'red', metalness: 0.8 } },
    { op: 'add', kind: 'cylinder', name: 'Wheel', rotation: [90, 0, 0], params: { radiusTop: 0.35, radiusBottom: 0.35, height: 0.25 } },
    { op: 'move', target: 'Wheel', to: [1, 0.35, 1.5] },
    { op: 'move', target: 'Wheel', by: [0, 0.65, 0] },
    { op: 'scale', target: 'Body', by: [1, 2, 1] },
    { op: 'rotate', target: 2, by: [0, 45, 0] },
    { op: 'material', target: 'Body', roughness: 0.2, emissive: '#ff0000', emissiveIntensity: 2 },
  ]);
  assert.equal(findObject(m.objects, 'body').id, 'o1');
  assert.equal(findObject(m.objects, 2).name, 'Wheel');
  assert.equal(findObject(m.objects, 'nope'), undefined);
  assert.deepEqual(m.objects[1].position, [1, 1, 1.5]);
  assert.deepEqual(m.objects[0].scale, [1, 2, 1]);
  assert.deepEqual(m.objects[1].rotation, [90, 45, 0]);
  assert.equal(m.objects[0].material.color, '#ff0000');
  assert.equal(m.objects[0].material.roughness, 0.2);
  assert.equal(m.objects[0].material.emissiveIntensity, 2);
});

test('update merges params, material and light settings', () => {
  const m = build([
    { op: 'add', kind: 'box', name: 'Box' },
    { op: 'update', target: 'Box', params: { width: 3 }, material: { color: '#00ff00' }, visible: false, name: 'Crate' },
    { op: 'add', kind: 'light', light: { type: 'spot', intensity: 100 } },
    { op: 'update', target: 'Spot light', light: { angle: 30 }, lookAt: [0, 0, 0] },
  ]);
  assert.equal(m.objects[0].name, 'Crate');
  assert.equal(m.objects[0].params.width, 3);
  assert.equal(m.objects[0].params.height, 1, 'other params keep their values');
  assert.equal(m.objects[0].material.color, '#00ff00');
  assert.equal(m.objects[0].visible, false);
  assert.equal(m.objects[1].light.angle, 30);
  assert.equal(m.objects[1].light.intensity, 100);
});

test('parenting, duplicating and removing keep the hierarchy consistent', () => {
  const m = build([
    { op: 'add', kind: 'empty', name: 'Car' },
    { op: 'add', kind: 'box', name: 'Body', parent: 'Car' },
    { op: 'add', kind: 'sphere', name: 'Wheel', parent: 'Body' },
    { op: 'duplicate', target: 'Car', offset: [5, 0, 0] },
  ]);
  assert.equal(m.objects.length, 6);
  const copy = m.objects.find((o) => o.name === 'Car.001');
  assert.deepEqual(copy.position, [5, 0, 0]);
  assert.equal(m.objects.filter((o) => o.parent === copy.id).length, 1, 'the copy has its own body');
  const body2 = m.objects.find((o) => o.parent === copy.id);
  assert.equal(m.objects.filter((o) => o.parent === body2.id).length, 1, 'and its own wheel');
  assert.equal(descendantsOf(m, 'o1').length, 2);
  assert.throws(() => applyModelOp(m, { op: 'parent', target: 'Car', to: 'Wheel' }), /parent of itself/);
  applyModelOp(m, { op: 'parent', target: 'Wheel', to: null });
  assert.equal(findObject(m.objects, 'Wheel').parent, null);
  applyModelOp(m, { op: 'remove', target: 'Car.001' });
  assert.equal(m.objects.length, 3, 'removing a parent removes its children');
});

test('modifiers: mirror and array change the triangle count and are limited', () => {
  const m = build([{ op: 'add', kind: 'box', name: 'Post' }]);
  assert.equal(triangleCount(m), 12);
  applyModelOp(m, { op: 'modifier', target: 'Post', type: 'array', count: 5, offset: [2, 0, 0] });
  applyModelOp(m, { op: 'modifier', target: 'Post', type: 'mirror', axis: 'z' });
  assert.equal(triangleCount(m), 12 * 5 * 2);
  assert.deepEqual(m.objects[0].modifiers.map((x) => x.type), ['array', 'mirror']);
  applyModelOp(m, { op: 'modifier', target: 'Post', type: 'array', count: 5000, clear: true });
  assert.equal(m.objects[0].modifiers[0].count, 100, 'the array is capped');
  assert.match(summarizeModel(m), /array ×100/);
});

test('align puts objects on the ground and next to each other', () => {
  const m = build([
    { op: 'add', kind: 'box', name: 'A', position: [0, 3, 0] },
    { op: 'add', kind: 'sphere', name: 'B', position: [4, 5, 0], params: { radius: 1 } },
    { op: 'align', target: 'A', ground: true },
    { op: 'align', target: 'B', ground: true },
  ]);
  assert.equal(worldBounds(m, m.objects[0]).min[1], 0);
  assert.equal(worldBounds(m, m.objects[1]).min[1], 0);
  applyModelOp(m, { op: 'align', target: 'B', to: 'A', axis: 'x' });
  assert.equal(m.objects[1].position[0], 0);
  applyModelOp(m, { op: 'add', kind: 'box', name: 'C', position: [0, 0.5, 9] });
  applyModelOp(m, { op: 'arrange', targets: ['A', 'C'], axis: 'x', gap: 1 });
  const a = worldBounds(m, findObject(m.objects, 'A')), c = worldBounds(m, findObject(m.objects, 'C'));
  assert.ok(Math.abs(c.min[0] - a.max[0] - 1) < 1e-6, 'one metre between the boxes');
  assert.throws(() => applyModelOp(m, { op: 'align', target: 'Nope', ground: true }), /no object "Nope"/);
});

test('bounds follow rotation, scale and parents', () => {
  const m = build([
    { op: 'add', kind: 'box', name: 'Plank', params: { width: 2, height: 0.2, depth: 0.2 }, rotation: [0, 0, 90] },
    { op: 'add', kind: 'box', name: 'Child', parent: 'Plank', position: [1, 0, 0] },
  ]);
  const b = worldBounds(m, m.objects[0]);
  assert.ok(Math.abs(b.max[1] - 1) < 1e-6 && Math.abs(b.max[0] - 0.1) < 1e-6, 'a plank rotated 90° about Z stands upright');
  const child = worldBounds(m, m.objects[1]);
  assert.ok(Math.abs((child.min[1] + child.max[1]) / 2 - 1) < 1e-6, 'a child at +x of a plank that stands up is raised');
  assert.ok(sceneBounds(m));
  assert.equal(sceneBounds(emptyModel()), null);
  assert.equal(worldBounds(m, makeObject('light', [], {})), null);
});

test('operations are validated with readable errors', () => {
  assert.equal(validateOp({ op: 'add', kind: 'box' }), null);
  assert.match(validateOp({ op: 'sparkle' }), /unknown op/);
  assert.match(validateOp({ op: 'add' }), /needs "kind"/);
  assert.match(validateOp({ op: 'add', kind: 'dragon' }), /kind must be one of/);
  assert.match(validateOp({ op: 'add', kind: 'box', position: [1, 2] }), /\[x, y, z\]/);
  assert.match(validateOp({ op: 'move', target: 'A', by: 'far' }), /"by" must be/);
  assert.match(validateOp({ op: 'world', background: 'notacolour' }), /must be a colour/);
  assert.match(validateOp({ op: 'modifier', target: 'A', type: 'twist' }), /mirror or array/);
  assert.match(validateOp(null), /must be an object/);
  const { ops, errors } = parseOps('[{"op":"add","kind":"box"},{"op":"remove"}]');
  assert.equal(ops.length, 1);
  assert.match(errors[0], /^op 2:/);
  assert.equal(parseOps({ op: 'clear' }).ops.length, 1);
  assert.match(parseOps('nope').errors[0], /not valid JSON/);
});

test('a failing operation stops the list and says which one', () => {
  const m = emptyModel();
  const result = applyModelOps(m, [{ op: 'add', kind: 'box', name: 'A' }, { op: 'move', target: 'Missing', by: [1, 0, 0] }, { op: 'add', kind: 'sphere' }]);
  assert.match(result.error, /^op 2 \(move\): no object "Missing"/);
  assert.equal(result.log.length, 1);
  assert.equal(m.objects.length, 1, 'the third operation did not run');
});

test('the review finds a missing light, zero scale and heavy scenes', () => {
  const m = build([{ op: 'add', kind: 'box', name: 'Wall', scale: [1, 0, 1] }, { op: 'world', ambient: 0.1 }]);
  const messages = checkModel(m).map((i) => i.message).join('\n');
  assert.match(messages, /no light/);
  assert.match(messages, /scale of zero/);
  const heavy = emptyModel();
  applyModelOp(heavy, { op: 'add', kind: 'icosphere', params: { detail: 5 } });
  applyModelOp(heavy, { op: 'modifier', target: 1, type: 'array', count: 100 });
  assert.match(checkModel(heavy).map((i) => i.message).join('\n'), /triangles/);
  assert.equal(triangleCount(emptyModel()), 0);
});

test('the summary lists every object under its parent', () => {
  const m = build([
    { op: 'add', kind: 'empty', name: 'Rig' },
    { op: 'add', kind: 'box', name: 'Arm', parent: 'Rig', material: { color: '#336699' } },
    { op: 'add', kind: 'light', light: { type: 'sun' }, lookAt: [0, 0, 0] },
  ]);
  const lines = summarizeModel(m).split('\n');
  assert.match(lines[0], /3 objects/);
  assert.ok(lines.some((l) => /^- o1 "Rig"/.test(l)));
  assert.ok(lines.some((l) => /^ {2}- o2 "Arm".*#336699/.test(l)), 'children are indented');
  assert.ok(lines.some((l) => /sun light 3/.test(l)));
});
