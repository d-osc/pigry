import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyReplyMessage, readChatReply } from '../src/lib/chatReply.ts';

const json = (value) => JSON.stringify(value);

test('OpenAI chat completions: string content, content parts, or legacy text', () => {
  assert.equal(readChatReply(json({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] }), false).text, 'Hello');
  const parts = readChatReply(json({ choices: [{ message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'A' }, { type: 'output_text', text: 'B' }] } }] }), false);
  assert.equal(parts.text, 'AB');
  assert.equal(readChatReply(json({ choices: [{ text: 'legacy' }] }), false).text, 'legacy');
});

test('a reasoning model that used every output token says so', () => {
  const body = json({ choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }] });
  const reply = readChatReply(body, false);
  assert.deepEqual(reply, { text: '', finishReason: 'length', reasoningOnly: true });
  assert.match(emptyReplyMessage('gpt-6.2-sol · medium', reply, body), /^gpt-6\.2-sol · medium ran out of output tokens before it answered \(length\)\. Try a lower effort/);
});

test('reasoning without an answer, and a plain empty reply, are told apart', () => {
  const thinking = readChatReply(json({ choices: [{ message: { content: null, reasoning: 'only this' }, finish_reason: 'stop' }] }), false);
  assert.equal(thinking.reasoningOnly, true);
  assert.match(emptyReplyMessage('m', thinking, ''), /only sent its reasoning and no answer \(stop\)/);
  const body = json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });
  const empty = readChatReply(body, false);
  assert.match(emptyReplyMessage('m', empty, body), /^m returned an empty reply \(content_filter\)\. The provider sent: \{"choices"/);
});

test('Anthropic messages: text blocks, thinking-only and max_tokens', () => {
  assert.equal(readChatReply(json({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }), true).text, 'Hi');
  const cut = readChatReply(json({ content: [{ type: 'thinking', thinking: 'x' }], stop_reason: 'max_tokens' }), true);
  assert.deepEqual(cut, { text: '', finishReason: 'max_tokens', reasoningOnly: true });
  assert.match(emptyReplyMessage('claude', cut, ''), /ran out of output tokens/);
});

test('OpenAI Responses API bodies', () => {
  assert.equal(readChatReply(json({ output_text: 'direct' }), false).text, 'direct');
  const nested = readChatReply(json({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'nested' }] }] }), false);
  assert.equal(nested.text, 'nested');
  const incomplete = readChatReply(json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning' }] }), false);
  assert.deepEqual(incomplete, { text: '', finishReason: 'max_output_tokens', reasoningOnly: true });
});

test('a streamed body is joined even though stream:false was asked for', () => {
  const openai = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ].join('\n');
  assert.deepEqual(readChatReply(openai, false), { text: 'Hello', finishReason: 'stop', reasoningOnly: false });
  const anthropic = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  ].join('\n');
  assert.deepEqual(readChatReply(anthropic, true), { text: 'Hi', finishReason: 'end_turn', reasoningOnly: false });
  assert.equal(readChatReply('not json at all', false).text, '');
});
