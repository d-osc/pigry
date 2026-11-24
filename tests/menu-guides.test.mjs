import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspaceNav } from '../src/app/navigation.ts';
import { MENU_GUIDES } from '../src/lib/menuGuides.ts';

test('every workspace menu has a guide (plus Extensions), and no guide is left without a menu', () => {
  assert.deepEqual(Object.keys(MENU_GUIDES).sort(), [...workspaceNav.map(({ id }) => id), 'extensions'].sort());
});

test('every guide is complete: overview, features, a tutorial, tips, cautions and a screenshot', () => {
  for (const id of Object.keys(MENU_GUIDES)) {
    const guide = MENU_GUIDES[id];
    assert.ok(guide.summary.length > 30, `${id}: summary`);
    assert.ok(guide.overview.length >= 2, `${id}: overview paragraphs`);
    assert.ok(guide.features.length >= 4, `${id}: features`);
    assert.ok(guide.tutorial.length >= 4, `${id}: tutorial steps`);
    assert.ok(guide.tips.length >= 2, `${id}: tips`);
    assert.ok(guide.cautions.length >= 2, `${id}: cautions`);
    assert.ok(guide.shots.length >= 1, `${id}: screenshots`);
    for (const item of [...guide.features, ...guide.tutorial]) assert.ok(item.title && item.text, `${id}: empty item`);
    if (id === 'extensions') assert.equal(guide.agents, undefined, 'the Extensions menu has no agent panel');
    else {
      assert.match(guide.agents.default, /^[a-z][a-z0-9-]*$/, `${id}: default agent handle`);
      assert.match(guide.agents.base, /^[a-z][a-z0-9-]*$/, `${id}: base agent handle`);
    }
  }
});

test('every screenshot a guide mentions exists in public/help', () => {
  for (const id of Object.keys(MENU_GUIDES)) {
    for (const shot of MENU_GUIDES[id].shots) {
      assert.ok(fs.existsSync(`public/help/${shot.file}`), `${id}: missing public/help/${shot.file} (run npm run help:screenshots)`);
      assert.ok(shot.caption.length > 20, `${id}: caption`);
    }
  }
});
