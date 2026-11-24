import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enabledExtensionSkills, needsTrust, normalizeInstalled, parseExtensionManifest, planInstall, EXTENSIONS_STORAGE_KEY,
} from '../src/lib/extensionManifest.ts';
import { CATALOG_MANIFESTS, searchStore, STORE_CATALOG, STORE_CATEGORIES } from '../src/lib/extensionCatalog.ts';

const valid = () => ({
  pigryExtension: 1, id: 'acme.review-pack', name: 'Review Pack', version: '1.2.0', author: 'Acme', description: 'Reviews things.',
  agents: [{ username: 'reviewer', name: 'Reviewer', role: 'Code reviewer', skills: ['checklist'], tools: ['read_file'] }],
  skills: [{ id: 'checklist', name: 'Checklist', content: '# Checklist\n\n- read the diff' }],
});

test('a valid manifest is accepted and normalised', () => {
  const result = parseExtensionManifest(JSON.stringify(valid()));
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, 'acme.review-pack');
  assert.deepEqual(result.manifest.agents[0].mcpServers, []);
  assert.equal(result.manifest.skills[0].description, '');
  assert.equal(needsTrust(result.manifest), false);
});

test('problems are reported in plain words and nothing throws', () => {
  const cases = [
    ['not json', /Not valid JSON/],
    [JSON.stringify([1, 2]), /must be a JSON object/],
    [JSON.stringify({ ...valid(), pigryExtension: undefined }), /pigryExtension/],
    [JSON.stringify({ ...valid(), id: 'A B' }), /"id" must be/],
    [JSON.stringify({ ...valid(), name: '' }), /"name" is required/],
    [JSON.stringify({ ...valid(), agents: [{ username: 'x', name: 'X' }] }), /username/],
    [JSON.stringify({ ...valid(), agents: [valid().agents[0], valid().agents[0]] }), /duplicate username/],
    [JSON.stringify({ ...valid(), skills: [{ id: 'a', content: '' }] }), /"content" is required/],
    [JSON.stringify({ ...valid(), hooks: [{ event: 'on-save', command: 'x' }] }), /before-send or after-reply/],
    [JSON.stringify({ ...valid(), mcpServers: [{ name: 's', transport: 'stdio' }] }), /needs a "command"/],
    [JSON.stringify({ ...valid(), mcpServers: [{ name: 's', transport: 'http', url: 'ftp://x' }] }), /http\(s\) "url"/],
    [JSON.stringify({ ...valid(), agents: [{ ...valid().agents[0], mcpServers: ['missing'] }] }), /not defined in this extension/],
    [JSON.stringify({ pigryExtension: 1, id: 'acme.empty', name: 'Empty' }), /adds nothing/],
  ];
  for (const [input, message] of cases) {
    const result = parseExtensionManifest(input);
    assert.equal(result.ok, false, input.slice(0, 60));
    assert.match(result.errors.join(' | '), message);
  }
});

test('hooks and MCP servers make an extension need the user\'s trust', () => {
  const withHook = parseExtensionManifest({ ...valid(), hooks: [{ event: 'after-reply', command: 'npm run lint' }] });
  assert.equal(needsTrust(withHook.manifest), true);
  const withServer = parseExtensionManifest({ ...valid(), mcpServers: [{ name: 'files', transport: 'stdio', command: 'npx', args: '-y server' }] });
  assert.equal(needsTrust(withServer.manifest), true);
});

test('planInstall reports handle and server conflicts and renames skills whose id is taken', () => {
  const { manifest } = parseExtensionManifest({ ...valid(), mcpServers: [{ name: 'files', transport: 'stdio', command: 'npx' }] });
  const free = planInstall(manifest, { agentUsernames: new Set(), skillIds: new Set(), mcpNames: new Set() });
  assert.deepEqual(free.conflicts, []);
  assert.equal(free.skills[0].id, 'checklist');

  const taken = planInstall(manifest, { agentUsernames: new Set(['reviewer']), skillIds: new Set(['checklist']), mcpNames: new Set(['files']) });
  assert.equal(taken.conflicts.length, 2);
  assert.match(taken.conflicts.join(' '), /@reviewer/);
  assert.equal(taken.skills[0].id, 'acme-review-pack-checklist');
  assert.deepEqual(taken.agents[0].skills, ['acme-review-pack-checklist'], 'agents follow the renamed skill');
});

test('the stored list is treated as untrusted and only enabled extensions give skills', () => {
  const stored = [
    { id: 'a', name: 'A', enabled: true, skills: [{ id: 's1', content: 'one' }, { id: '', content: 'x' }, { id: 's2' }] },
    { id: 'b', name: 'B', enabled: false, skills: [{ id: 's3', content: 'three' }] },
    { name: 'no id' }, 'junk', null,
  ];
  assert.deepEqual(normalizeInstalled(stored).map((e) => e.id), ['a', 'b']);
  const storage = { getItem: (key) => (key === EXTENSIONS_STORAGE_KEY ? JSON.stringify(stored) : null) };
  assert.deepEqual(enabledExtensionSkills(storage).map((s) => s.id), ['s1']);
  assert.deepEqual(enabledExtensionSkills({ getItem: () => '{broken' }), []);
  assert.deepEqual(enabledExtensionSkills(undefined), []);
});

test('every extension that ships with Pigry is valid and runs nothing', () => {
  for (const entry of CATALOG_MANIFESTS) {
    const result = parseExtensionManifest(entry);
    assert.equal(result.ok, true, `${entry.id}: ${result.errors?.join('; ')}`);
    assert.equal(needsTrust(result.manifest), false, `${entry.id} must not need trust`);
    for (const agent of result.manifest.agents) {
      for (const skill of agent.skills) assert.ok(result.manifest.skills.some((s) => s.id === skill), `${entry.id}: @${agent.username} uses unknown skill ${skill}`);
    }
  }
  assert.equal(new Set(CATALOG_MANIFESTS.map((m) => m.id)).size, CATALOG_MANIFESTS.length);
});

test('the store offers a good range of packs, each in a category, with unique agent handles', () => {
  assert.ok(STORE_CATALOG.length >= 8);
  assert.ok(STORE_CATALOG.every((entry) => entry.category !== 'Other' && entry.tags.length > 0), 'every pack has a category and tags');
  const handles = CATALOG_MANIFESTS.flatMap((manifest) => manifest.agents.map((agent) => agent.username));
  assert.equal(new Set(handles).size, handles.length, 'two packs must not use the same @handle');
  assert.ok(STORE_CATEGORIES.includes('Security') && STORE_CATEGORIES.includes('Git'));
});

test('store search finds packs by name, tags, agents and skills, and ranks name matches first', () => {
  const names = (query, category) => searchStore(STORE_CATALOG, query, category).map((entry) => entry.manifest.name);
  assert.equal(names('').length, STORE_CATALOG.length, 'no query lists everything');
  assert.deepEqual(names('secrets'), ['Security Review Pack']);
  assert.deepEqual(names('@lint-coach'), ['Code Quality Pack'], 'an @handle finds the pack of that agent');
  assert.deepEqual(names('#a11y-checklist'), ['Accessibility Pack'], 'a #skill finds its pack');
  assert.ok(names('openapi').includes('API Design Pack'), 'tags and descriptions count');
  assert.deepEqual(names('SECURITY  review'), ['Security Review Pack'], 'case and extra spaces do not matter');
  assert.deepEqual(names('zzz-nothing'), []);
  assert.deepEqual(names('security', 'Git'), [], 'the category narrows the results');
  assert.ok(names('', 'Documentation').length >= 2);
  // every word must match
  assert.deepEqual(names('security openapi'), []);
  // a name match comes before a description match
  const ranked = names('pack');
  assert.equal(ranked.length, STORE_CATALOG.length);
  assert.deepEqual(names('release')[0], 'Release Safety Pack');
});
