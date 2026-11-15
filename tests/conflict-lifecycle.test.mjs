import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/editor/conflictMarkers.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { ConflictController } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('closing conflict editors unregisters every global action exactly once', () => {
  const live = new Set();
  let disposed = 0;
  for (let i = 0; i < 20; i++) {
    let close;
    const editor = {
      addAction(action) {
        const key = `${i}:${action.id}`;
        live.add(key);
        return { dispose() { assert.equal(live.delete(key), true); disposed++; } };
      },
      onDidDispose(callback) { close = callback; },
    };
    const monaco = { KeyMod: { CtrlCmd: 1, Alt: 2 }, KeyCode: { Digit1: 3, Digit2: 4, Digit3: 5 } };
    const controller = new ConflictController(editor, monaco);
    assert.equal(live.size, 3);
    close();
    controller.dispose();
    assert.equal(live.size, 0);
  }
  assert.equal(disposed, 60);
});
