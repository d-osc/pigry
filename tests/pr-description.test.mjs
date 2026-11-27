import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrDescriptionPrompt, detectLanguage, insertDescription, isNoiseFile, isTestFile, parsePrDescriptionReply, patchBody, trimDiff, trimPatch,
} from '../src/lib/prDescription.ts';

const patch = (path, lines) => [
  `diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`,
  `@@ -1,${lines} +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+line ${i} of ${path}`), '',
].join('\n');
const file = (path, lines, extra = {}) => ({ path, status: 'M', additions: lines, deletions: 0, binary: false, patch: patch(path, lines), truncated: false, ...extra });

test('the patch body drops git headers and keeps the hunks', () => {
  const body = patchBody(patch('a.ts', 2));
  assert.equal(body, '@@ -1,2 +1,2 @@\n+line 0 of a.ts\n+line 1 of a.ts');
});

test('a long patch is cut on a line boundary and says how much is left', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
  const cut = trimPatch(text, 20);
  assert.match(cut, /^line 0\nline 1\n… \(8 more lines not shown\)$/);
  assert.equal(trimPatch('short', 20), 'short');
});

test('lockfiles, build output and tests are recognised', () => {
  assert.ok(isNoiseFile('package-lock.json'));
  assert.ok(isNoiseFile('src-tauri/Cargo.lock'));
  assert.ok(isNoiseFile('dist/index.js'));
  assert.ok(isNoiseFile('web/app.min.js'));
  assert.ok(!isNoiseFile('src/lib/build.ts'));
  assert.ok(isTestFile('src/app/address-list.component.spec.ts'));
  assert.ok(isTestFile('tests/ui/foo.spec.mjs'));
  assert.ok(isTestFile('pkg/handler_test.go'));
  assert.ok(!isTestFile('src/latest.ts'));
});

test('small diffs are shown whole', () => {
  const result = trimDiff([file('a.ts', 3), file('b.ts', 2)], 10_000);
  assert.equal(result.cut, false);
  assert.equal(result.shown, 2);
  assert.match(result.text, /--- a\.ts \(M, \+3 −0\)\n@@/);
  assert.match(result.text, /\+line 1 of b\.ts/);
});

test('a large diff fits the budget: small files stay whole, the big one is cut, noise is only named', () => {
  const files = [
    file('src/big.ts', 2000),
    file('src/small.ts', 3),
    file('package-lock.json', 500),
    { ...file('logo.png', 0), binary: true, patch: '' },
  ];
  const budget = 4000;
  const result = trimDiff(files, budget);
  assert.ok(result.text.length <= budget + 400, `length ${result.text.length}`);
  assert.equal(result.cut, true);
  assert.match(result.text, /\+line 2 of src\/small\.ts/);
  assert.match(result.text, /more lines not shown/);
  assert.match(result.text, /package-lock\.json .*generated or lock file, not shown/);
  assert.match(result.text, /logo\.png .*binary file, not shown/);
  assert.doesNotMatch(result.text, /line 0 of package-lock/);
  assert.equal(result.shown, 2);
  assert.equal(result.omitted, 2);
});

test('with many files and a tiny budget, files past the budget are listed without a patch', () => {
  const files = Array.from({ length: 50 }, (_, i) => file(`src/f${i}.ts`, 40));
  const result = trimDiff(files, 3000);
  assert.ok(result.text.length < 6000);
  assert.match(result.text, /left out to keep the diff short/);
});

test('the language follows the commit messages, English by default', () => {
  assert.equal(detectLanguage(['fix: keep the checked box', 'feat: add deploy matrix']), 'English');
  assert.equal(detectLanguage(['fix: แก้ไขกล่องเลือกที่อยู่ให้ถูกต้อง', 'chore: อัปเดตเวอร์ชัน']), 'Thai');
  assert.equal(detectLanguage(['修正: 住所リストのチェックボックス']), 'Japanese');
  assert.equal(detectLanguage(['修复地址列表复选框']), 'Chinese');
  assert.equal(detectLanguage(['feat: add `วันที่` field to src/a.ts']), 'English');
  assert.equal(detectLanguage([]), 'English');
});

const CONTEXT = {
  mergeBaseOid: 'a'.repeat(40),
  commits: [
    { shortOid: '1253211', message: 'chore: update address-change-history.component.spec.ts' },
    { shortOid: '16f0a81', message: 'fix(ci): publish built packages from local artifact paths\n\nThe workflow used the registry path.' },
  ],
  files: [file('src/address-list.component.ts', 4), file('src/address-list.component.spec.ts', 3)],
  template: null,
};

test('the prompt asks for Summary, Changes and Testing when tests changed', () => {
  const prompt = buildPrDescriptionPrompt({ base: 'cloud-release', compare: 'fix/billing', title: 'Fix/billing', context: CONTEXT });
  assert.match(prompt, /merges "fix\/billing" into "cloud-release"/);
  assert.match(prompt, /Write it in English/);
  assert.match(prompt, /## Summary/);
  assert.match(prompt, /## Changes/);
  assert.match(prompt, /## Testing/);
  assert.match(prompt, /TITLE:/);
  assert.match(prompt, /16f0a81 fix\(ci\): publish built packages[\s\S]*The workflow used the registry path\./);
  assert.match(prompt, /\+line 0 of src\/address-list\.component\.ts/);

  const noTests = buildPrDescriptionPrompt({ base: 'main', compare: 'x', title: '', context: { ...CONTEXT, files: [CONTEXT.files[0]] } });
  assert.doesNotMatch(noTests, /## Testing/);
  assert.match(noTests, /Leave out a Testing section/);
});

test('a pull request template replaces the default layout', () => {
  const prompt = buildPrDescriptionPrompt({
    base: 'main', compare: 'x', title: '',
    context: { ...CONTEXT, template: { path: '.github/pull_request_template.md', content: '## What\n<!-- describe -->\n- [ ] Tested' } },
  });
  assert.match(prompt, /pull request template \(\.github\/pull_request_template\.md\)/);
  assert.match(prompt, /<<<TEMPLATE\n## What\n<!-- describe -->\n- \[ \] Tested\nTEMPLATE>>>/);
  assert.doesNotMatch(prompt, /## Summary/);
});

test('the prompt is written in the language of Thai commits', () => {
  const prompt = buildPrDescriptionPrompt({
    base: 'main', compare: 'x', title: '',
    context: { ...CONTEXT, commits: [{ shortOid: 'abc1234', message: 'แก้ไขกล่องเลือกที่อยู่สำหรับออกบิล' }] },
  });
  assert.match(prompt, /Write it in Thai/);
});

test('the reply gives a title and a body; fences and reasoning are removed', () => {
  assert.deepEqual(parsePrDescriptionReply('TITLE: Fix the billing address checkbox\n---\n## Summary\n- Fixes it'), {
    title: 'Fix the billing address checkbox', body: '## Summary\n- Fixes it',
  });
  assert.deepEqual(parsePrDescriptionReply('<think>hmm</think>\n```markdown\n**Title:** "Better"\n---\n## Summary\n- x\n```'), {
    title: 'Better', body: '## Summary\n- x',
  });
  assert.deepEqual(parsePrDescriptionReply('## Summary\n- only a body'), { title: null, body: '## Summary\n- only a body' });
});

test('the result replaces, goes below, or goes in at the cursor', () => {
  assert.equal(insertDescription('', 'NEW', 'cursor'), 'NEW');
  assert.equal(insertDescription('old', ' NEW \n', 'replace'), 'NEW');
  assert.equal(insertDescription('old\n\n', 'NEW', 'append'), 'old\n\nNEW');
  assert.equal(insertDescription('Fixes #12\nCloses #13', 'NEW', 'cursor', 'Fixes #12\n'.length), 'Fixes #12\n\nNEW\n\nCloses #13');
  assert.equal(insertDescription('Fixes #12', 'NEW', 'cursor', 0), 'NEW\n\nFixes #12');
});
