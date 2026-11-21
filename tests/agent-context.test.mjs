import test from 'node:test';
import assert from 'node:assert/strict';
import { recentChatContext } from '../src/lib/agentContext.ts';

test('replayed chat keeps full requirements and replies inside the history window', () => {
  const old = Array.from({ length: 20 }, () => ({ role: 'user', text: 'Previous task' }));
  const requirements = { role: 'user', text: 'details '.repeat(3000) + 'Preserve backward compatibility.' };
  const reply = { role: 'assistant', text: 'evidence '.repeat(3000) };
  const context = recentChatContext([...old, requirements, reply]);
  assert.equal(context.length, 20);
  assert.deepEqual(context.slice(-2), [
    { role: 'user', content: requirements.text },
    { role: 'assistant', content: reply.text },
  ]);
});
