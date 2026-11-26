import { expect, test } from '@playwright/test';
import { CLI_PROVIDERS_ENABLED } from '../../src/lib/featureFlags.ts';
import { demoTree } from '../../src/lib/demoWorkspace.ts';
import { installBackend, openFixture } from './backend.mjs';

for (const [team, prefix] of [['Explorer', ''], ['Copilot', 'copilot-']]) {
  test(`${team}: development base agents are selectable and load their assigned skills`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pigry:ai-providers', JSON.stringify([{
        id: 'development-fixture',
        name: 'Development fixture',
        type: 'custom',
        apiFormat: 'openai',
        baseUrl: 'https://fixture.invalid/v1/chat/completions',
        apiKey: 'fixture',
        enabled: true,
        model: 'fixture-model',
        models: [{ id: 'fixture-model', name: 'fixture-model', enabled: true }],
      }]));
    });
    await installBackend(page);
    await openFixture(page);
    if (team === 'Copilot') {
      await page.locator('.nav-item').filter({ hasText: 'Copilot' }).click();
    }
    const composer = page.getByRole('textbox', { name: 'Ask AI' });
    if (team === 'Explorer' && await composer.count() === 0) {
      await page.locator('.ai-rail-strip').click();
    }
    const specialists = [
      ['coder', 'code-implementation', ['write_file', 'run_command']],
      ['debugger', 'unit-testing-and-bug-reporting', ['write_file', 'run_command']],
      ['qa', 'qa-test-cases-and-e2e', ['write_file', 'run_command', 'browser_e2e']],
      ['white-hat', 'defensive-security-report', ['read_file', 'write_file', 'github_security']],
    ];
    const responses = page.getByText('Test model reply', { exact: true });
    const existing = await responses.count();
    for (const [index, [handle, skill, expectedTools]] of specialists.entries()) {
      const username = prefix + handle;
      await composer.fill(`@${username}`);
      const option = page.getByRole('listbox', { name: 'Mention an agent' })
        .getByRole('option', { name: new RegExp(`@${username}\\b`) });
      await expect(option).toContainText(team);
      await option.click();
      await expect(composer).toHaveValue(`@${username} `);
      await composer.fill(`@${username} Describe your role and how you report results.`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(responses).toHaveCount(existing + index + 1);

      const payload = await page.evaluate(() => {
        const call = window.testBackend.calls.filter(({ cmd }) => cmd === 'ai_chat').at(-1);
        return JSON.parse(call.args.body);
      });
      expect(JSON.stringify(payload.messages)).toContain(`[Skill: ${skill}]`);
      const tools = payload.tools.map(({ function: tool }) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(expectedTools));
      if (handle === 'white-hat') {
        expect(tools).not.toContain('run_command');
        expect(tools).not.toContain('browser_e2e');
        expect(tools).not.toContain('agent_message');
      }
    }
  });
}

// The codex variant chats through the Codex CLI provider, which is switched off for now (src/lib/featureFlags.ts).
for (const providerType of CLI_PROVIDERS_ENABLED ? ['custom', 'codex'] : ['custom']) {
  test(`${providerType}: assigned and tagged skills use the current project override once`, async ({ page }) => {
    await page.addInitScript((type) => {
      localStorage.setItem('pigry:ai-providers', JSON.stringify([{
        id: 'skill-fixture',
        name: 'Skill fixture',
        type,
        apiFormat: 'openai',
        baseUrl: 'https://fixture.invalid/v1/chat/completions',
        apiKey: 'fixture',
        enabled: true,
        model: 'skill-model',
        models: [{ id: 'skill-model', name: 'skill-model', enabled: true }],
      }]));
    }, providerType);
    const skillPath = '.pigry/skills/edit-commit.md';
    const projectPath = '.pigry/skills/team-workflow.md';
    await installBackend(page, { entries: [...demoTree.entries, skillPath, projectPath] });
    await openFixture(page);
    await page.evaluate(({ skillPath, projectPath, providerType }) => {
      const bridge = window.__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      window.testBackend.skillVersion = 'first';
      bridge.invoke = async (cmd, args) => {
        const result = await invoke(cmd, args);
        if (cmd === 'cli_detect' && providerType === 'codex') return { ...result, codex: true };
        if (cmd === 'cli_chat') return JSON.stringify({ text: 'Test skill reply', isError: false, inputTokens: 10, outputTokens: 3 });
        if (cmd === 'read_worktree_file' && args.path === skillPath) {
          return { ...result, content: `# Team commit editing\n\nProject override version ${window.testBackend.skillVersion}` };
        }
        if (cmd === 'read_worktree_file' && args.path === projectPath) {
          return { ...result, content: '# Team workflow\n\nIndependent project instructions' };
        }
        return result;
      };
    }, { skillPath, projectPath, providerType });

    await page.locator('.nav-item').filter({ hasText: 'Edit commit' }).click();
    await page.locator('.ai-rail-strip').click();
    const composer = page.getByRole('textbox', { name: 'Ask AI' });
    await composer.fill('#edit-commit');
    await page.getByRole('listbox', { name: 'Use a skill' })
      .getByRole('option', { name: /Team commit editing/ }).click();
    await expect(composer).toHaveValue('#edit-commit ');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const response = page.getByText(providerType === 'codex' ? 'Test skill reply' : 'Test model reply', { exact: true });
    await expect(response).toHaveCount(1);

    await page.evaluate(() => { window.testBackend.skillVersion = 'updated'; });
    await composer.fill('@amend-reviewer Check this commit #edit-commit #pull-review');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(response).toHaveCount(2);

    const prompts = await page.evaluate(() => window.testBackend.calls
      .filter(({ cmd }) => cmd === 'cli_chat' || cmd === 'ai_chat')
      .map(({ cmd, args }) => cmd === 'cli_chat' ? JSON.parse(args.message).prompt : JSON.parse(args.body).messages.at(-1).content));
    expect(prompts).toHaveLength(2);
    for (const [prompt, version] of [[prompts[0], 'first'], [prompts[1], 'updated']]) {
      expect(prompt.match(/\[Skill: edit-commit\]/g)).toHaveLength(1);
      expect(prompt.match(/\[Skill: working-changes-review\]/g)).toHaveLength(1);
      expect(prompt.match(/Project override version/g)).toHaveLength(1);
      expect(prompt).toContain(`Project override version ${version}`);
      expect(prompt).toContain('Independent project instructions');
      expect(prompt).not.toContain('Choose the commit in Edit commit and select Start editing');
    }
    expect(prompts[1]).toContain('[Skill: pull-review]');
    expect(prompts[1]).toContain('preview_sync_commits with direction=pull');
  });
}
