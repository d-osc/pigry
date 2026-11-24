import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import { createEngine } from '../src/extensions/gameengine/engineRuntime.js';
import {
  NODE_TYPES, applyGameOp, applyGameOps, checkGame, cleanProps, emptyGame, findNode, normalizeGame, parseExports, parseGameJson, parseOps, propsOf, scriptBase, summarizeGame, validateOp,
} from '../src/extensions/gameengine/game.ts';
import { templateGame } from '../src/extensions/gameengine/gameTemplates.ts';

/** TypeScript → the CommonJS the engine loads (the editor uses the Monaco TypeScript service for this). */
const compile = (code) => stripTypeScriptTypes(code).replace('export default', 'exports.default =');

function boot(game, scripts = {}, opts = {}) {
  const logs = [];
  const engine = createEngine(THREE, { onLog: (level, text) => logs.push(`${level}:${text}`), random: () => 0.5, ...opts });
  engine.load(game);
  engine.loadScripts(Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, compile(v)])));
  engine.start();
  return { engine, logs };
}
const compiledScripts = (game) => Object.fromEntries(Object.entries(game.scripts).map(([k, v]) => [k, v.code]));
const row = (engine, path) => engine.snapshot().find((r) => r.path === path || r.path === `Main/${path}`);

test('the node catalogue is consistent: bases exist, defaults are valid and property specs inherit', () => {
  for (const [name, spec] of Object.entries(NODE_TYPES)) {
    if (spec.base) assert.ok(NODE_TYPES[spec.base], `${name} base ${spec.base}`);
    for (const [key, p] of Object.entries(propsOf(name))) {
      assert.ok(p.type, `${name}.${key}`);
      if (p.type === 'enum') assert.ok(p.options.includes(p.default), `${name}.${key} default is an option`);
    }
  }
  assert.ok('position' in propsOf('CharacterBody3D'), 'inherits Node3D properties');
  assert.ok('floorMaxAngle' in propsOf('CharacterBody3D'));
  assert.ok(Object.keys(NODE_TYPES).length >= 30, `${Object.keys(NODE_TYPES).length} node types`);
});

test('properties are validated and coerced per type', () => {
  const ok = cleanProps('MeshInstance3D', { mesh: 'sphere', size: [2, 2, 2], material: { color: '#ff0000', roughness: 9 } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.props.material.roughness, 1);
  const bad = cleanProps('MeshInstance3D', { mesh: 'dragon', size: 'big', colour: 1, position: [0, 1] });
  assert.equal(bad.errors.length, 4);
  assert.match(bad.errors.join('\n'), /has no property "colour"/);
  assert.match(bad.errors.join('\n'), /is not a valid enum \(box, sphere/);
  assert.deepEqual(cleanProps('Node2D', { position: 5 }).props.position, [5, 5]);
});

test('a saved game is repaired on load', () => {
  const { game, warnings } = normalizeGame({
    title: ' Test ', settings: { width: 99999, mainScene: 'nope', inputMap: { jump: ['Space'], 'bad name': ['A'] }, autoloads: [{ name: 'G', script: '../x.ts' }] },
    scenes: { main: { root: { name: 'a/b', type: 'Node3D', children: [{ name: 'X', type: 'Dragon' }, { name: 'Y', type: 'Node3D' }, { name: 'Y', type: 'Node3D' }] } }, 'bad name!': { root: { name: 'x', type: 'Node' } } },
    scripts: { 'scripts/ok.ts': { code: 'export default class A extends Node {}' }, '../evil.ts': { code: 'x' } },
  });
  assert.equal(game.title, 'Test');
  assert.equal(game.settings.width, 7680);
  assert.equal(game.settings.mainScene, 'main');
  assert.deepEqual(Object.keys(game.settings.inputMap), ['jump']);
  assert.equal(game.settings.autoloads.length, 0);
  assert.equal(game.scenes.main.root.name, 'a_b');
  assert.deepEqual(game.scenes.main.root.children.map((c) => c.name), ['Y', 'Y2'], 'unknown types are dropped and sibling names made unique');
  assert.deepEqual(Object.keys(game.scripts), ['scripts/ok.ts']);
  assert.ok(warnings.length >= 4);
  assert.equal(parseGameJson('{bad', 't').game.title, 't');
  assert.equal(Object.keys(normalizeGame({ scenes: {} }).game.scenes).length, 1);
});

test('operations edit scenes, nodes, scripts, signals and settings', () => {
  const g = emptyGame('t');
  const res = applyGameOps(g, [
    { op: 'add_node', type: 'StaticBody3D', name: 'Ground', props: { position: [0, -0.5, 0] } },
    { op: 'add_node', parent: 'Ground', type: 'CollisionShape3D', name: 'Shape', props: { shape: 'box', size: [10, 1, 10] } },
    { op: 'set_script', path: 'scripts/p.ts', code: 'export default class P extends CharacterBody3D {}' },
    { op: 'add_node', type: 'CharacterBody3D', name: 'Player', script: 'scripts/p.ts', groups: ['player'], props: { position: [0, 1, 0] } },
    { op: 'duplicate_node', node: 'Player', name: 'Player2' },
    { op: 'move_node', node: 'Player2', to: 'Ground' },
    { op: 'connect', from: 'Player', signal: 'died', to: '.', method: 'onDied' },
    { op: 'input_action', name: 'shoot', keys: ['KeyF', 'Mouse0'] },
    { op: 'settings', width: 800, height: 600, gravity3d: 20 },
    { op: 'autoload', name: 'Game', script: 'scripts/p.ts' },
    { op: 'add_scene', name: 'enemy', rootType: 'CharacterBody3D' },
    { op: 'add_node', type: 'Node', name: 'Enemy1', instance: 'enemy' },
    { op: 'rename_script', path: 'scripts/p.ts', to: 'scripts/player.ts' },
  ]);
  assert.equal(res.error, undefined, res.error);
  const main = g.scenes.main;
  assert.equal(findNode(main, 'Ground/Shape').node.props.size[0], 10);
  assert.equal(findNode(main, 'Ground/Player2').node.script, 'scripts/player.ts');
  assert.equal(findNode(main, 'Player').node.script, 'scripts/player.ts', 'renaming a script updates its nodes');
  assert.equal(main.connections.length, 1);
  assert.deepEqual(g.settings.inputMap.shoot, ['KeyF', 'Mouse0']);
  assert.equal(g.settings.gravity3d, 20);
  assert.equal(g.settings.autoloads[0].script, 'scripts/player.ts');
  assert.equal(findNode(main, 'Enemy1').node.type, 'CharacterBody3D', 'an instance shows the root type of its scene');
  assert.match(summarizeGame(g), /instance of "enemy"/);
  applyGameOp(g, { op: 'remove_node', node: 'Player' });
  assert.equal(main.connections.length, 0, 'removing a node removes its connections');
  applyGameOp(g, { op: 'remove_script', path: 'scripts/player.ts' });
  assert.equal(findNode(main, 'Ground/Player2').node.script, undefined);
  assert.equal(g.settings.autoloads.length, 0);
});

test('bad operations fail with readable messages', () => {
  const g = emptyGame('t');
  const err = (op) => { try { applyGameOp(g, op); return ''; } catch (e) { return e.message; } };
  assert.match(err({ op: 'add_node', type: 'Node3D', parent: 'Nope' }), /no parent "Nope"/);
  assert.match(err({ op: 'add_node', type: 'Node3D', props: { colour: 1 } }), /has no property "colour"/);
  assert.match(err({ op: 'add_node', type: 'Node3D', script: 'scripts/x.ts' }), /does not exist yet/);
  assert.match(err({ op: 'remove_node', node: '.' }), /root node cannot be removed/);
  assert.match(err({ op: 'move_node', node: 'A', to: '.' }), /no node "A"/);
  assert.match(err({ op: 'remove_scene', name: 'main' }), /at least one scene/);
  assert.match(err({ op: 'autoload', name: 'G', script: 'scripts/zz.ts' }), /does not exist/);
  assert.match(err({ op: 'animation', node: '.', name: 'a', tracks: [] }), /not an AnimationPlayer/);
  assert.match(validateOp({ op: 'sparkle' }), /unknown op/);
  assert.match(validateOp({ op: 'add_node' }), /needs "type"/);
  assert.match(validateOp({ op: 'add_node', type: 'Dragon' }), /unknown type/);
  assert.match(validateOp({ op: 'set_script', path: '../x.ts', code: 'a' }), /path must look like/);
  assert.match(validateOp({ op: 'settings', background: 'red' }), /must be a colour/);
  const { ops, errors } = parseOps('[{"op":"add_node","type":"Node"},{"op":"remove_node"}]');
  assert.equal(ops.length, 1);
  assert.match(errors[0], /^op 2:/);
  assert.match(parseOps('nope').errors[0], /not valid JSON/);
});

test('the review finds missing scripts, wrong base classes, bodies without shapes and a missing camera', () => {
  const g = emptyGame('t');
  applyGameOps(g, [
    { op: 'set_script', path: 'scripts/a.ts', code: 'export default class A extends Camera3D {}' },
    { op: 'add_node', type: 'CharacterBody3D', name: 'Body', script: 'scripts/a.ts' },
    { op: 'add_node', type: 'Node3D', name: 'Ghost' },
  ]);
  g.scenes.main.root.children.find((n) => n.name === 'Ghost').script = 'scripts/missing.ts';
  const msgs = checkGame(g).map((i) => i.message).join('\n');
  assert.match(msgs, /extends Camera3D but is attached to a CharacterBody3D/);
  assert.match(msgs, /missing script scripts\/missing\.ts/);
  assert.match(msgs, /no CollisionShape child/);
  assert.match(msgs, /no Camera3D or Camera2D/);
  assert.equal(scriptBase('export default class Foo extends CharacterBody2D { }'), 'CharacterBody2D');
  assert.equal(scriptBase('const x = 1;'), null);
});

test('exported variables are read from a script without running it', () => {
  const exp = parseExports(`export default class P extends Node { static exports = { speed: 5.5, jump: { default: 7, min: 0, max: 20 }, tint: '#ff8800', name: 'hero', flag: true, offset: [1, 2, 3] }; }`);
  assert.deepEqual(exp.map((e) => `${e.name}:${e.type}`), ['speed:number', 'jump:number', 'tint:color', 'name:string', 'flag:bool', 'offset:vec3']);
  assert.equal(exp[1].max, 20);
  assert.deepEqual(parseExports('static exports = { a: process.exit() }'), [], 'code is never evaluated');
  assert.deepEqual(parseExports('class A {}'), []);
});

test('the templates are valid, checked and play without errors', () => {
  for (const kind of ['3d', '2d']) {
    const g = templateGame(kind, 'T');
    const { game, warnings } = normalizeGame(JSON.parse(JSON.stringify(g)));
    assert.deepEqual(warnings, [], `${kind} template is already valid`);
    assert.deepEqual(checkGame(game).filter((i) => i.severity === 'error'), [], `${kind} template has no review errors`);
    const { engine, logs } = boot(game, compiledScripts(game));
    engine.stepFrames(90);
    assert.deepEqual(engine.errors, [], `${kind}: ${engine.errors.join(' | ')}`);
    assert.ok(!logs.some((l) => l.startsWith('error')));
    assert.equal(row(engine, 'Player').onFloor, true, `${kind}: the player rests on the floor`);
  }
});

test('3D playground: the player walks with input, jumps and crates settle on the ground', () => {
  const g = templateGame('3d', 'T');
  const { engine } = boot(g, compiledScripts(g));
  engine.stepFrames(30);
  const start = row(engine, 'Player').position;
  engine.input.pressAction('move_right');
  engine.stepFrames(60);
  const moved = row(engine, 'Player').position;
  assert.ok(moved[0] - start[0] > 4, `walked right: ${start[0]} → ${moved[0]}`);
  engine.input.releaseAction('move_right');
  engine.input.pressAction('jump');
  engine.stepFrames(8);
  assert.ok(row(engine, 'Player').position[1] > start[1] + 0.5, 'jumped');
  engine.stepFrames(120);
  assert.equal(row(engine, 'Player').onFloor, true);
  assert.ok(Math.abs(row(engine, 'Crate1').position[1] - 0.5) < 0.15, 'Crate1 rests on the ground');
  const c2 = row(engine, 'Crate2').position[1];
  assert.ok(Math.abs(c2 - 0.5) < 0.15 || Math.abs(c2 - 1.5) < 0.15, `Crate2 rests on the ground or on Crate1 (${c2})`);
  assert.ok(row(engine, 'Ball').position[1] < 3, 'the ball fell');
});

test('2D platformer: the player runs and jumps, coins are collected through signals and groups', () => {
  const g = templateGame('2d', 'T');
  const { engine } = boot(g, compiledScripts(g));
  engine.stepFrames(40);
  const p0 = row(engine, 'Player').position;
  assert.equal(row(engine, 'Player').onFloor, true);
  assert.ok(Math.abs(p0[1] - (-220 + 20 + 24)) < 3, `stands on the ground (y ${p0[1]})`);
  assert.equal(row(engine, 'Hud/Score').text, 'Score: 0');
  // run right: the player passes the coin at the end of the ground floor, then jumps
  engine.input.pressAction('move_right');
  engine.stepFrames(100);
  engine.input.pressAction('jump');
  engine.stepFrames(45);
  engine.input.releaseAction('jump');
  engine.stepFrames(60);
  const p1 = row(engine, 'Player').position;
  assert.ok(p1[0] > p0[0] + 300, 'ran right');
  assert.match(row(engine, 'Hud/Score')?.text ?? '', /Score: [1-3]/, 'a coin was collected');
  assert.ok(engine.snapshot().filter((r) => /^Main\/Coin\d$/.test(r.path)).length < 3, 'collected coins are removed from the tree');
  assert.deepEqual(engine.errors, []);
});

test('rigid bodies fall, bounce and come to rest; areas report bodies entering and leaving', () => {
  const g = emptyGame('t');
  applyGameOps(g, [
    { op: 'add_node', type: 'StaticBody3D', name: 'Floor', props: { position: [0, -0.5, 0] } },
    { op: 'add_node', parent: 'Floor', type: 'CollisionShape3D', props: { shape: 'box', size: [20, 1, 20] } },
    { op: 'add_node', type: 'RigidBody3D', name: 'Ball', props: { position: [0, 4, 0], bounce: 0.8 } },
    { op: 'add_node', parent: 'Ball', type: 'CollisionShape3D', props: { shape: 'sphere', size: [1, 1, 1] } },
    { op: 'add_node', type: 'Area3D', name: 'Zone', props: { position: [0, 0.6, 0] } },
    { op: 'add_node', parent: 'Zone', type: 'CollisionShape3D', props: { shape: 'box', size: [4, 1, 4] } },
  ]);
  const { engine } = boot(g);
  const zone = engine.tree.currentScene.getNode('Zone');
  const events = [];
  zone.connect('bodyEntered', (b) => events.push(`in:${b.name}`));
  zone.connect('bodyExited', (b) => events.push(`out:${b.name}`));
  let minY = 9, maxAfterBounce = 0, bounced = false;
  for (let i = 0; i < 240; i++) {
    engine.step(1 / 60);
    const y = row(engine, 'Main/Ball')?.position[1] ?? row(engine, 'Ball').position[1];
    minY = Math.min(minY, y);
    if (y <= 0.55) bounced = true;
    if (bounced && i > 60) maxAfterBounce = Math.max(maxAfterBounce, y);
  }
  assert.ok(minY >= 0.4, `the ball never sinks into the floor (min y ${minY})`);
  assert.ok(maxAfterBounce > 0.6, 'it bounced');
  assert.ok(events.includes('in:Ball'), `the area saw the ball: ${events}`);
  const ray = engine.physics.raycast(new THREE.Vector3(0, 5, 3), new THREE.Vector3(0, -1, 0), 20);
  assert.ok(ray && ray.collider.name === 'Floor' && Math.abs(ray.position.y) < 1e-6 && ray.normal.y === 1, 'a ray down hits the top of the floor');
  assert.equal(engine.physics.raycast(new THREE.Vector3(0, 5, 3), new THREE.Vector3(0, 1, 0), 20), null);
});

test('scenes: instancing with exported values and groups, scene changes, signal connections and autoloads', () => {
  const g = emptyGame('t');
  applyGameOps(g, [
    { op: 'set_script', path: 'scripts/coin.ts', code: 'export default class Coin extends Node3D { static exports = { value: 1 }; value = 1; ready() { this.addToGroup("coins"); } collect() { this.emitSignal("collected", this.value); this.queueFree(); } }' },
    { op: 'set_script', path: 'scripts/game.ts', code: 'export default class GameState extends Node { score = 0; add(n) { this.score += n; print("score", this.score); } }' },
    { op: 'set_script', path: 'scripts/main.ts', code: 'export default class Main extends Node3D { total = 0; onCollected(v) { this.total += v; Game.add(v); } ready() { print("main ready", this.getChildCount()); } }' },
    { op: 'autoload', name: 'Game', script: 'scripts/game.ts' },
    { op: 'add_scene', name: 'coin', rootType: 'Node3D' },
    { op: 'set', scene: 'coin', node: '.', script: 'scripts/coin.ts' },
    { op: 'add_node', type: 'Node', instance: 'coin', name: 'CoinA', exports: { value: 5 } },
    { op: 'add_node', type: 'Node', instance: 'coin', name: 'CoinB' },
    { op: 'set', node: '.', script: 'scripts/main.ts' },
    { op: 'connect', from: 'CoinA', signal: 'collected', to: '.', method: 'onCollected' },
    { op: 'add_scene', name: 'second', rootType: 'Node' },
  ]);
  const { engine, logs } = boot(g, compiledScripts(g));
  const main = engine.tree.currentScene;
  assert.deepEqual(engine.errors, []);
  assert.equal(engine.tree.getNodesInGroup('coins').length, 2);
  assert.equal(main.getNode('CoinA').value, 5, 'exports are applied to the instance');
  assert.equal(main.getNode('CoinB').value, 1);
  main.getNode('CoinA').collect();
  engine.step(1 / 60);
  assert.equal(main.total, 5);
  assert.equal(engine.tree.autoloads.Game.score, 5);
  assert.equal(engine.tree.getNodesInGroup('coins').length, 1, 'queueFree removed the coin');
  assert.ok(logs.includes('log:score 5'));
  engine.tree.changeScene('second');
  engine.step(1 / 60);
  assert.equal(engine.tree.currentSceneName, 'second');
  assert.equal(engine.tree.getNodesInGroup('coins').length, 0);
});

test('scripts: a wrong base class and exceptions are reported, one broken node does not stop the others', () => {
  const g = emptyGame('t');
  applyGameOps(g, [
    { op: 'set_script', path: 'scripts/bad.ts', code: 'export default class Bad extends Node2D {}' },
    { op: 'set_script', path: 'scripts/boom.ts', code: 'export default class Boom extends Node3D { ready() { throw new Error("boom"); } process() { this.ticks = (this.ticks || 0) + 1; } }' },
    { op: 'set_script', path: 'scripts/ok.ts', code: 'export default class Ok extends Node3D { process() { this.position.x += 1; } }' },
    { op: 'add_node', type: 'Node3D', name: 'A' },
    { op: 'add_node', type: 'Node3D', name: 'B' },
    { op: 'add_node', type: 'Node3D', name: 'C' },
  ]);
  g.scenes.main.root.children.find((n) => n.name === 'A').script = 'scripts/bad.ts';
  g.scenes.main.root.children.find((n) => n.name === 'B').script = 'scripts/boom.ts';
  g.scenes.main.root.children.find((n) => n.name === 'C').script = 'scripts/ok.ts';
  const { engine } = boot(g, compiledScripts(g));
  engine.stepFrames(3);
  const errs = engine.errors.join('\n');
  assert.match(errs, /must extend Node3D/);
  assert.match(errs, /B\.ready: boom/);
  assert.equal(row(engine, 'Main/C').position[0], 3, 'the healthy node kept running');
  assert.equal(engine.tree.currentScene.getNode('B').ticks, 3, 'and so did the one whose ready() failed');
});

test('timers, tweens, animation players and input actions', () => {
  const g = emptyGame('t');
  applyGameOps(g, [
    { op: 'input_action', name: 'go', keys: ['KeyG'] },
    { op: 'set_script', path: 'scripts/t.ts', code: 'export default class T extends Node3D { fired = 0; ready() { this.getNode("Timer").connect("timeout", () => { this.fired++; }); this.createTween().tweenProperty(this, "position:x", 10, 1); } process() { if (Input.isActionJustPressed("go")) this.pressed = (this.pressed || 0) + 1; } }' },
    { op: 'set', node: '.', script: 'scripts/t.ts' },
    { op: 'add_node', type: 'Timer', name: 'Timer', props: { waitTime: 0.5, autostart: true } },
    { op: 'add_node', type: 'AnimationPlayer', name: 'Anim', props: { autoplay: 'spin' } },
    { op: 'animation', node: 'Anim', name: 'spin', length: 2, tracks: [{ node: '', property: 'position:y', keys: [{ t: 0, v: 0 }, { t: 2, v: 4 }] }] },
  ]);
  const { engine } = boot(g, compiledScripts(g));
  engine.stepFrames(60);
  const main = engine.tree.currentScene;
  assert.ok(main.fired >= 1, 'the timer fired');
  assert.ok(Math.abs(main.position.x - 10) < 0.2, `the tween reached its target (${main.position.x})`);
  assert.ok(main.position.y > 1.5 && main.position.y < 2.5, `the animation is half way (${main.position.y})`);
  engine.input.pressAction('go');
  engine.stepFrames(5);
  assert.equal(main.pressed, 1, 'isActionJustPressed is true for one frame only');
  assert.deepEqual(engine.errors, []);
});

test('UI controls update through their properties and 2D camera and sprites are built', () => {
  const g = templateGame('2d', 'T');
  const { engine } = boot(g, compiledScripts(g));
  const label = engine.tree.currentScene.getNode('Hud/Score');
  assert.equal(label.text, 'Score: 0');
  label.text = 'Hello';
  assert.equal(label.text, 'Hello');
  const cam = engine.currentCamera();
  assert.equal(cam.isOrthographicCamera, true, 'a 2D scene uses an orthographic camera');
  engine.stepFrames(3);
  assert.equal(engine.currentCamera().isOrthographicCamera, true);
});

test('the edit-mode engine builds the scene without running scripts', () => {
  const g = templateGame('3d', 'T');
  const engine = createEngine(THREE, { mode: 'edit' });
  engine.load(g);
  const root = engine.editScene('main');
  assert.equal(root.name, 'Main');
  assert.equal(engine.errors.length, 0);
  const player = root.getNode('Player');
  assert.equal(player.constructor.nodeType, 'CharacterBody3D');
  assert.equal(player.scriptPath, 'scripts/player.ts');
  assert.equal(typeof player.physicsProcess, 'undefined', 'the script class is not used in edit mode');
  assert.ok(player.object3d.parent, 'the player is part of the three.js scene');
  assert.ok([...root.walk()].some((n) => n.type === 'CollisionShape3D' && n._dbg), 'collision shapes are drawn in edit mode');
});
