import test from 'node:test';import assert from 'node:assert/strict';
import { mayReloadBuffer, savedBufferIsDirty } from '../src/lib/editorBuffer.ts';
test('watcher refresh preserves unsaved edits in the same file',()=>{
 assert.equal(mayReloadBuffer('a.ts','a.ts','unsaved','saved'),false);
 assert.equal(mayReloadBuffer('a.ts','a.ts','saved','saved'),true);
 assert.equal(mayReloadBuffer('b.ts','a.ts','unsaved','saved'),true);
});
test('typing during a save remains dirty after the saved snapshot completes',()=>{
 assert.equal(savedBufferIsDirty('newer draft','written snapshot'),true);
 assert.equal(savedBufferIsDirty('written snapshot','written snapshot'),false);
});
