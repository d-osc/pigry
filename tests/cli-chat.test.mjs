import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCliRequest, claudeMessageLine, cliOfEndpoint, isCliEndpoint, parseCliReply } from '../src/lib/cliChat.ts';

const tool = (name) => ({ type: 'function', function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { path: { type: 'string' } } } } });

test('a CLI request carries the history, the attached images, the tools and the model', () => {
  const body = {
    model: 'opus', output_config: { effort: 'high' }, tools: [tool('read_file'), tool('model_write')],
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file text' },
    ],
  };
  const req = buildCliRequest(body);
  assert.equal(req.model, 'opus'); assert.equal(req.effort, 'high');
  assert.deepEqual(req.toolNames, ['read_file', 'model_write']);
  assert.deepEqual(req.images, [{ mediaType: 'image/png', data: 'QUJD' }]);
  for (const part of ['[User]\nfirst question', '[Assistant]\nfirst answer', '[image 1 attached]', '"tool_calls"', '[Tool result: read_file]\nfile text', '- model_write:', 'You have NO tools of your own', 'Write the next assistant message now.']) {
    assert.ok(req.prompt.includes(part), `prompt has ${part}`);
  }
  const line = JSON.parse(claudeMessageLine(req));
  assert.equal(line.type, 'user');
  assert.equal(line.message.content[0].type, 'text');
  assert.deepEqual(line.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
});

test('system messages become instructions; a request without tools has no tool protocol', () => {
  const req = buildCliRequest({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }] });
  assert.ok(req.prompt.startsWith('[Instructions]\nBe brief.'));
  assert.ok(!req.prompt.includes('[How tools work here]'));
});

test('tool calls are read from plain JSON, from a code fence and from text around the JSON', () => {
  const names = ['read_file', 'model_write'];
  const plain = parseCliReply('{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}', names);
  assert.equal(plain.tool_calls.length, 1);
  assert.equal(plain.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(plain.tool_calls[0].function.arguments), { path: 'a.txt' });
  assert.equal(plain.content, '');
  const fenced = parseCliReply('I will read it.\n```json\n{"tool_calls":[{"name":"model_write","arguments":{"name":"x","ops":[{"op":"add","text":"}{"}]}}]}\n```', names);
  assert.equal(fenced.tool_calls[0].function.name, 'model_write');
  assert.equal(JSON.parse(fenced.tool_calls[0].function.arguments).ops[0].text, '}{', 'braces inside strings do not confuse the reader');
  assert.equal(fenced.content, 'I will read it.');
  const two = parseCliReply('{"tool_calls":[{"name":"read_file","arguments":{}},{"name":"model_write","arguments":"{\\"a\\":1}"}]}', names);
  assert.equal(two.tool_calls.length, 2);
  assert.equal(two.tool_calls[1].function.arguments, '{"a":1}');
  assert.notEqual(two.tool_calls[0].id, two.tool_calls[1].id);
});

test('ordinary answers, unknown tools and broken JSON stay plain text', () => {
  assert.deepEqual(parseCliReply('Hello there', ['read_file']), { content: 'Hello there' });
  assert.deepEqual(parseCliReply('{"tool_calls":[{"name":"rm_rf","arguments":{}}]}', ['read_file']).tool_calls, undefined);
  assert.equal(parseCliReply('{"tool_calls":[{"name":"read_file"', ['read_file']).tool_calls, undefined);
  assert.equal(parseCliReply('talk about "tool_calls" in words', ['read_file']).tool_calls, undefined);
  assert.equal(parseCliReply('{"tool_calls":[{"name":"read_file","arguments":{}}]}', []).tool_calls, undefined, 'no tools offered, no tool calls');
});

test('cli endpoints', () => {
  assert.ok(isCliEndpoint('cli://claude')); assert.ok(!isCliEndpoint('https://api.openai.com/v1'));
  assert.equal(cliOfEndpoint('cli://claude'), 'claude');
});

import { agyMessageLine } from '../src/lib/cliChat.ts';
import { buildCliEntries } from '../src/lib/cliEntries.ts';
import { isCliProvider, resolveEndpoint } from '../src/lib/aiProviders.ts';

test('Antigravity gets a text-only stream-json message and says when images could not be sent', () => {
  const req = buildCliRequest({ model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] }] });
  const line = JSON.parse(agyMessageLine(req));
  assert.equal(line.event, 'user');
  assert.ok(line.message.content.includes('[User]\nlook'));
  assert.ok(line.message.content.includes('cannot receive images'));
  assert.equal(JSON.parse(agyMessageLine(buildCliRequest({ messages: [{ role: 'user', content: 'hi' }] }))).message.content.includes('cannot receive images'), false);
});

test('a scan with agy lists Antigravity as a CLI provider with its models and routes it to the agy binary', () => {
  const result = {
    claude: false, codex: false, copilot: false, claudeVersion: '', codexVersion: '', copilotVersion: '', claudeModel: '', codexModel: '', claudeProviders: [], desktop: [], chatgptProviders: [], zcodeProviders: [],
    apps: [{ binary: 'agy', name: 'Antigravity', version: '1.5.16', model: '', effort: '', usable: true, models: ['gemini-3.8-flash-high', 'claude-sonnet-4-6'], launchKind: 'cli', launchTarget: 'agy' }],
  };
  const [entry] = buildCliEntries(result);
  assert.equal(entry.id, 'cli-agy');
  assert.equal(entry.name, 'Antigravity · 1.5.16');
  assert.equal(entry.type, 'antigravity');
  assert.deepEqual(entry.models.map((m) => m.name), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
  assert.equal(entry.model, 'gemini-3.8-flash-high');
  assert.ok(isCliProvider(entry));
  assert.equal(resolveEndpoint(entry), 'cli://agy');
});

import { codexMessageLine } from '../src/lib/cliChat.ts';

test('Codex gets the prompt and the images as one JSON request', () => {
  const req = buildCliRequest({ model: 'gpt-x', output_config: { effort: 'low' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }] });
  const sent = JSON.parse(codexMessageLine(req));
  assert.ok(sent.prompt.includes('[User]\nwhat is this'));
  assert.deepEqual(sent.images, [{ mediaType: 'image/jpeg', data: 'QUJD' }]);
  assert.equal(req.effort, 'low');
});
