import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestGate } from '../src/lib/latestRequest.ts';

test('slow old file cannot overwrite the newer selection', async () => {
  const gate = createRequestGate(); let view;
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  const isOldCurrent = gate.begin();
  const pending = old.then(value => { if (isOldCurrent()) view = value; });
  const isNewCurrent = gate.begin();
  if (isNewCurrent()) view = 'new file';
  finishOld('old file'); await pending;
  assert.equal(view, 'new file');
});
test('closing a compare or unmounting invalidates pending requests', () => {
  const gate = createRequestGate(); const current = gate.begin();
  gate.invalidate(); assert.equal(current(), false);
  assert.equal(gate.begin()(), true);
});
test('request gates isolate simultaneous detail and file loads', () => {
  const detail = createRequestGate(); const file = createRequestGate();
  const a = detail.begin(); const b = file.begin();
  file.invalidate(); assert.equal(a(), true); assert.equal(b(), false);
});
