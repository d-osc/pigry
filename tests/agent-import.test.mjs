import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, buildPlan, digestOf, instructionBlock, parseFrontmatter, parseToml, statusOf } from '../src/lib/agentImport.ts';

let n = 0;
const opts = (extra = {}) => ({ overwrite: false, makeId: () => `id${++n}`, now: 1, ...extra });

test('frontmatter is read and removed', () => {
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: "does y"\n---\nbody\n'), { data: { name: 'x', description: 'does y' }, body: 'body\n' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), { data: {}, body: 'no frontmatter' });
});

test('the TOML reader handles Codex MCP tables, inline tables, multi-line arrays and quoted names', () => {
  const t = parseToml([
    'model = "gpt-6"',
    '[mcp_servers.node_repl]',
    'command = "node"',
    'args = ["a.js", "--flag"]  # comment',
    '[mcp_servers.node_repl.env]',
    'NODE_ENV = "dev"',
    'API_TOKEN = "secret"',
    '[mcp_servers."my-http"]',
    'url = "https://example.com/mcp"',
    'http_headers = { Authorization = "Bearer x", "X-Other" = "1" }',
    '[mcp_servers.multi]',
    'command = "py"',
    'args = [',
    '  "-m",',
    '  "srv",',
    ']',
  ].join('\n'));
  assert.equal(t.model, 'gpt-6');
  assert.deepEqual(t.mcp_servers.node_repl.args, ['a.js', '--flag']);
  assert.equal(t.mcp_servers.node_repl.env.NODE_ENV, 'dev');
  assert.equal(t.mcp_servers['my-http'].http_headers.Authorization, 'Bearer x');
  assert.deepEqual(t.mcp_servers.multi.args, ['-m', 'srv']);
});

test('Codex: instructions, memories, skills and MCP servers become plan items; secrets are left out and reported', () => {
  const toml = [
    '[mcp_servers.s]', 'command = "node"', 'args = ["a b.js"]', '[mcp_servers.s.env]', 'A = "1"', 'GITHUB_TOKEN = "t"',
    '[mcp_servers.h]', 'url = "https://x.test/mcp?key=abc&q=1"', 'http_headers = { Authorization = "Bearer z" }',
  ].join('\n');
  const plan = buildPlan('codex', [
    { path: '.codex/AGENTS.md', text: 'Use tabs.' },
    { path: '.codex/memories/a.md', text: 'remember x' },
    { path: '.codex/skills/lint/SKILL.md', text: '---\ndescription: Lints code\n---\n# Lint\nrun it' },
    { path: '.codex/config.toml', text: toml },
  ], ['skill lint: 1 supporting file(s) are not imported']);
  assert.deepEqual(plan.items.map((i) => i.kind), ['instructions', 'instructions', 'skill', 'mcp', 'mcp']);
  const skill = plan.items.find((i) => i.kind === 'skill');
  assert.equal(skill.id, 'codex-lint');
  assert.equal(skill.description, 'Lints code');
  assert.ok(skill.markdown.startsWith('---\nname: lint\ndescription: Lints code\n---'));
  const s = plan.items.find((i) => i.name === 's');
  assert.equal(s.command, 'node'); assert.equal(s.args, '"a b.js"'); assert.equal(s.env, 'A=1'); assert.deepEqual(s.stripped, ['GITHUB_TOKEN']);
  const h = plan.items.find((i) => i.name === 'h');
  assert.equal(h.transport, 'http'); assert.ok(!h.url.includes('abc') && h.url.includes('q=1'));
  assert.ok(h.stripped.includes('header Authorization') && h.stripped.includes('url parameter key'));
  assert.ok(plan.notes.some((x) => x.includes('GITHUB_TOKEN') && x.includes('header Authorization')));
  assert.ok(plan.notes.some((x) => x.includes('switched off')));
  assert.ok(plan.notes.includes('skill lint: 1 supporting file(s) are not imported'));
});

test('Claude Code and Antigravity sources', () => {
  const claude = buildPlan('claude-code', [
    { path: '.claude/CLAUDE.md', text: 'Be brief.' },
    { path: '.claude/settings.json', text: JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(.env)'] }, mcpServers: { files: { command: 'npx', args: ['-y', 'srv'], env: { ROOT: '/x', API_KEY: 'k' } } } }) },
    { path: '.claude.json', text: JSON.stringify({ mcpServers: { web: { type: 'http', url: 'https://w.test/mcp', headers: { Authorization: 'Bearer q' } } }, projects: {} }) },
    { path: '.claude/skills/review/SKILL.md', text: '---\nname: Code review\ndescription: Reviews diffs\n---\nSteps' },
  ]);
  assert.deepEqual(claude.items.map((i) => i.kind), ['instructions', 'mcp', 'mcp', 'skill']);
  assert.ok(claude.notes.some((x) => x.startsWith('2 permission rule(s)')));
  assert.equal(claude.items.find((i) => i.name === 'files').env, 'ROOT=/x');
  const agy = buildPlan('antigravity', [
    { path: '.gemini/GEMINI.md', text: 'g' },
    { path: '.gemini/config/rules/style.md', text: '---\ntrigger: always_on\n---\nuse tabs' },
    { path: '.gemini/config/mcp_config.json', text: JSON.stringify({ mcpServers: { a: { command: 'node', args: ['x.js'], env: { P: '1' } }, b: { serverUrl: 'https://b.test/mcp', headers: { Authorization: 'Bearer z' } } } }) },
    { path: '.gemini/config/skills/lint/SKILL.md', text: '---\ndescription: d\n---\nb' },
    { path: '.gemini/antigravity-cli/settings.json', text: JSON.stringify({ permissions: { allow: ['command(git)'] } }) },
  ]);
  assert.deepEqual(agy.items.map((i) => i.kind), ['instructions', 'instructions', 'mcp', 'mcp', 'skill']);
  assert.equal(agy.items.find((i) => i.title.includes('style.md')).text, 'use tabs');
  assert.equal(agy.items.find((i) => i.name === 'b').transport, 'http');
  assert.equal(agy.items.find((i) => i.kind === 'skill').id, 'antigravity-lint');
  assert.ok(agy.notes.some((x) => x.startsWith('1 permission rule(s)')));
});

test('importing is additive: instructions go into marked blocks, skills into files, MCP servers come in switched off', () => {
  const plan = buildPlan('codex', [{ path: '.codex/AGENTS.md', text: 'Use tabs.' }, { path: '.codex/skills/lint/SKILL.md', text: '---\ndescription: d\n---\nbody' }, { path: '.codex/config.toml', text: '[mcp_servers.s]\ncommand = "node"\n' }]);
  const target = { instructions: '# Mine\n\nKeep this.', skills: {}, mcp: [] };
  const r = applyPlan(plan, target, 'D1', undefined, opts());
  assert.equal(r.imported, 3);
  assert.ok(r.instructions.startsWith('# Mine\n\nKeep this.\n\n<!-- pigry-import:codex:instructions:.codex/AGENTS.md -->'));
  assert.ok(r.instructions.includes('Use tabs.'));
  assert.deepEqual(r.skillWrites.map((w) => w.path), ['.pigry/skills/codex-lint.md']);
  assert.equal(r.mcp.length, 1); assert.equal(r.mcp[0].enabled, false); assert.equal(r.mcp[0].name, 's');
  assert.equal(r.record.digest, 'D1');
});

test('running the import again changes nothing; a changed source updates untouched copies; edited copies are left alone unless replacing is on', () => {
  const files = (text, skill) => [{ path: '.codex/AGENTS.md', text }, { path: '.codex/skills/lint/SKILL.md', text: '---\ndescription: d\n---\n' + skill }];
  const first = buildPlan('codex', files('v1', 'one'));
  let target = { instructions: '', skills: {}, mcp: [] };
  const r1 = applyPlan(first, target, 'D1', undefined, opts());
  target = { instructions: r1.instructions, skills: { 'codex-lint': r1.skillWrites[0].content }, mcp: [] };
  const again = applyPlan(first, target, 'D1', r1.record, opts());
  assert.equal(again.unchanged, 2); assert.equal(again.imported + again.updated + again.skipped, 0); assert.equal(again.instructions, null); assert.deepEqual(again.skillWrites, []);
  const next = buildPlan('codex', files('v2', 'two'));
  assert.deepEqual(next.items.map((i) => statusOf('codex', i, target, r1.record)), ['update', 'update']);
  const r2 = applyPlan(next, target, 'D2', r1.record, opts());
  assert.equal(r2.updated, 2); assert.ok(r2.instructions.includes('v2') && !r2.instructions.includes('v1')); assert.ok(r2.skillWrites[0].content.includes('two'));
  const edited = { ...target, skills: { 'codex-lint': 'my own version' } };
  assert.equal(statusOf('codex', next.items[1], edited, r1.record), 'conflict');
  const r3 = applyPlan(next, edited, 'D2', r1.record, opts());
  assert.equal(r3.skipped, 1); assert.deepEqual(r3.skillWrites, []);
  assert.ok(r3.lines.some((l) => l.includes('Skipped skill codex-lint')));
  const r4 = applyPlan(next, edited, 'D2', r1.record, opts({ overwrite: true }));
  assert.equal(r4.skillWrites.length, 1);
  assert.equal(statusOf('codex', next.items[1], { ...target, skills: { 'codex-lint': 'foreign' } }, undefined), 'conflict');
});

test('an MCP server with the same name is kept unless replacing, and extension servers are never touched', () => {
  const plan = buildPlan('codex', [{ path: '.codex/config.toml', text: '[mcp_servers.s]\ncommand = "node"\nargs = ["new.js"]\n' }]);
  const mine = { id: 'm1', name: 's', transport: 'stdio', command: 'python', args: '', url: '', env: '', enabled: true };
  const ext = { id: 'm2', name: 's', transport: 'stdio', command: 'ext', args: '', url: '', env: '', enabled: true, extensionId: 'pigry.x' };
  const kept = applyPlan(plan, { instructions: '', skills: {}, mcp: [mine] }, 'D', undefined, opts());
  assert.equal(kept.skipped, 1); assert.equal(kept.mcp, null);
  const replaced = applyPlan(plan, { instructions: '', skills: {}, mcp: [mine] }, 'D', undefined, opts({ overwrite: true }));
  assert.equal(replaced.mcp[0].command, 'node'); assert.equal(replaced.mcp[0].id, 'm1'); assert.equal(replaced.mcp[0].enabled, true, 'a server the user enabled stays enabled');
  const withExt = applyPlan(plan, { instructions: '', skills: {}, mcp: [ext] }, 'D', undefined, opts());
  assert.equal(withExt.mcp.length, 2); assert.ok(withExt.mcp.some((s) => s.extensionId === 'pigry.x' && s.command === 'ext'));
});

test('the digest changes with the content, not with the order', () => {
  const a = { path: 'a', text: '1' }, b = { path: 'b', text: '2' };
  assert.equal(digestOf([a, b]), digestOf([b, a]));
  assert.notEqual(digestOf([a, b]), digestOf([a, { path: 'b', text: '3' }]));
  assert.ok(instructionBlock('codex', { kind: 'instructions', key: 'k', title: 't', text: 'x' }).endsWith('<!-- /pigry-import -->'));
});
