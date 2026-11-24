/** The Extension Store's catalog: packs that ship with Pigry and can be installed from the store. They add agents and
 * skills only (no hooks and no MCP servers), so installing them never runs anything on the computer. */
import { EXTENSION_MANIFEST_VERSION, type ExtensionManifest } from './extensionManifest.ts';

const base = { pigryExtension: EXTENSION_MANIFEST_VERSION } as const;

/** Written as plain manifests, exactly the shape a downloaded .json extension has. */
export const CATALOG_MANIFESTS: Array<typeof base & ExtensionManifest> = [
  {
    ...base,
    id: 'pigry.code-quality',
    name: 'Code Quality Pack',
    version: '1.0.0',
    author: 'Pigry',
    description: 'A lint coach and a test-gap finder, with a checklist for reviewing tests.',
    agents: [
      {
        username: 'lint-coach', name: 'Lint Coach', role: 'Code style reviewer', emoji: '🧹', team: undefined,
        description: 'Finds style, naming and dead-code problems in the files you point at and suggests small, safe fixes.',
        tools: ['read_file', 'list_files', 'search_code', 'read_diff'], skills: ['test-review-checklist'], mcpServers: [],
      },
      {
        username: 'test-gap-finder', name: 'Test Gap Finder', role: 'Test coverage reviewer', emoji: '🧪', team: undefined,
        description: 'Reads a change and lists the behaviours that no test covers, then proposes the cases to add.',
        tools: ['read_file', 'list_files', 'search_code', 'read_diff', 'read_history'], skills: ['test-review-checklist'], mcpServers: [],
      },
    ],
    skills: [
      {
        id: 'test-review-checklist', name: 'Test review checklist', description: 'What to check when reviewing tests for a change.',
        content: [
          '# Test review checklist',
          '',
          '- Read the change with read_diff first, then the tests that touch the same files.',
          '- For each changed behaviour, find the test that would fail if it broke. If there is none, list it as a gap.',
          '- Check the edges: empty input, one item, many items, invalid input, and errors from outside (network, disk).',
          '- A test that only checks that code runs without checking a result does not count as coverage.',
          '- Report gaps as a short list: behaviour, why it matters, the test case to add.',
        ].join('\n'),
      },
    ],
    hooks: [],
    mcpServers: [],
  },
  {
    ...base,
    id: 'pigry.documentation',
    name: 'Documentation Pack',
    version: '1.0.0',
    author: 'Pigry',
    description: 'A README writer and a changelog writer that follow one documentation style.',
    agents: [
      {
        username: 'readme-writer', name: 'README Writer', role: 'Technical writer', emoji: '📘', team: undefined,
        description: 'Writes and updates README files from the code: what it is, how to install and run it, how to contribute.',
        tools: ['read_file', 'list_files', 'search_code', 'write_file'], skills: ['docs-style-guide'], mcpServers: [],
      },
      {
        username: 'changelog-writer', name: 'Changelog Writer', role: 'Release notes writer', emoji: '🗒️', team: undefined,
        description: 'Turns the commits since the last release into a changelog grouped by Added, Changed and Fixed.',
        tools: ['read_history', 'read_commit', 'read_diff', 'read_file', 'write_file'], skills: ['docs-style-guide'], mcpServers: [],
      },
    ],
    skills: [
      {
        id: 'docs-style-guide', name: 'Documentation style guide', description: 'One voice for READMEs and changelogs.',
        content: [
          '# Documentation style guide',
          '',
          '- Start with one sentence that says what the project or change is, in plain words.',
          '- Prefer short sentences and the present tense. Use the same word for the same thing everywhere.',
          '- Show a command or a code sample for every instruction; keep each one copy-pasteable.',
          '- A changelog groups entries under Added, Changed and Fixed, newest release first, one line per change.',
          '- Never invent facts: if something is not in the code or the history, leave it out and say what is missing.',
        ].join('\n'),
      },
    ],
    hooks: [],
    mcpServers: [],
  },
  {
    ...base,
    id: 'pigry.release-safety',
    name: 'Release Safety Pack',
    version: '1.0.0',
    author: 'Pigry',
    description: 'A release guard agent and the checklist it uses before you tag a version.',
    agents: [
      {
        username: 'release-guard', name: 'Release Guard', role: 'Release readiness reviewer', emoji: '🚦', team: undefined,
        description: 'Checks that a release is ready: clean tree, version numbers agree, notes written, nothing risky unreviewed.',
        tools: ['git_status', 'read_history', 'read_file', 'list_files', 'search_code', 'read_diff'], skills: ['release-readiness'], mcpServers: [],
      },
    ],
    skills: [
      {
        id: 'release-readiness', name: 'Release readiness', description: 'The checks to pass before tagging a version.',
        content: [
          '# Release readiness',
          '',
          '- git_status: the working tree must be clean and you must be on the release branch.',
          '- The version number is the same in every file that carries it (package files, app config, lock files).',
          '- read_history since the last tag: every user-visible change has a line in the release notes.',
          '- Search the diff for debug code, TODOs, hard-coded credentials and disabled tests.',
          '- Finish with a verdict: ready, or a list of what must be fixed first.',
        ].join('\n'),
      },
    ],
    hooks: [],
    mcpServers: [],
  },
];

type Row = [username: string, name: string, role: string, emoji: string, description: string, tools: string[]];

/** Builds a one-skill pack in the manifest shape; every agent of the pack uses the pack's skill. */
function pack(
  id: string, name: string, description: string,
  agents: Row[],
  skill: { id: string; name: string; description: string; lines: string[] },
): typeof base & ExtensionManifest {
  return {
    ...base, id, name, version: '1.0.0', author: 'Pigry', description,
    agents: agents.map(([username, agentName, role, emoji, agentDescription, tools]) => ({
      username, name: agentName, role, emoji, team: undefined, description: agentDescription, tools, skills: [skill.id], mcpServers: [],
    })),
    skills: [{ id: skill.id, name: skill.name, description: skill.description, content: skill.lines.join('\n') }],
    hooks: [],
    mcpServers: [],
  };
}

const READ = ['read_file', 'list_files', 'search_code'];

CATALOG_MANIFESTS.push(
  pack('pigry.security-review', 'Security Review Pack', 'A threat modeler and a secrets hunter, with the checklist they review code against.', [
    ['threat-modeler', 'Threat Modeler', 'Threat modeling reviewer', '🛡️', 'Walks through a feature or a diff and lists what an attacker could do, what the code already prevents and what is missing.', [...READ, 'read_diff']],
    ['secrets-hunter', 'Secrets Hunter', 'Credential leak reviewer', '🔑', 'Searches the working tree and the recent history for keys, tokens, passwords and connection strings that should not be there.', [...READ, 'read_history']],
  ], {
    id: 'security-checklist', name: 'Security checklist', description: 'What to check when reviewing code for security problems.',
    lines: [
      '# Security checklist',
      '',
      '- Trace every input from where it enters (request, file, command line, environment) to where it is used.',
      '- Look for injection: SQL, shell commands, paths, templates, HTML. Untrusted data must be escaped or parameterised.',
      '- Check who is allowed to do what: authentication on every entry point, authorisation on every object.',
      '- Search for secrets: keys, tokens, passwords and private URLs in code, config and history. Report where, never print the value.',
      '- Check what is logged and what errors reveal. Report findings with file, line, impact and a concrete fix.',
    ],
  }),
  pack('pigry.refactoring', 'Refactoring Pack', 'A refactor planner and a dead-code finder that keep every change small and safe.', [
    ['refactor-planner', 'Refactor Planner', 'Refactoring strategist', '🧭', 'Turns a messy module into an ordered list of small, individually safe steps, each with the check that proves it did not break anything.', [...READ, 'read_diff']],
    ['dead-code-finder', 'Dead Code Finder', 'Unused code reviewer', '🧹', 'Finds functions, exports, files and options that nothing uses, and says how sure it is before you delete them.', [...READ, 'read_history']],
  ], {
    id: 'safe-refactoring', name: 'Safe refactoring', description: 'How to change structure without changing behaviour.',
    lines: [
      '# Safe refactoring',
      '',
      '- Make sure there is a test or another check that proves the behaviour before you touch the structure.',
      '- One kind of change per step: rename, move, extract, inline. Never mix a refactor with a behaviour change.',
      '- Search for every use of a name before changing it, including strings, config and docs.',
      '- Before deleting code, search for dynamic uses (reflection, string lookups, exports used by other packages).',
      '- Finish each step with the tests passing so any step can be committed or reverted on its own.',
    ],
  }),
  pack('pigry.api-design', 'API Design Pack', 'An API reviewer and an OpenAPI writer that agree on one set of conventions.', [
    ['api-reviewer', 'API Reviewer', 'API design reviewer', '🔌', 'Reviews endpoints, request and response shapes, errors and versioning against the conventions, and flags breaking changes.', [...READ, 'read_diff']],
    ['openapi-writer', 'OpenAPI Writer', 'API documentation writer', '📑', 'Reads the routes and handlers and writes or updates an OpenAPI description with examples for every response.', [...READ, 'write_file']],
  ], {
    id: 'api-conventions', name: 'API conventions', description: 'Naming, errors, versioning and compatibility rules for HTTP APIs.',
    lines: [
      '# API conventions',
      '',
      '- Name resources with plural nouns and let the HTTP method carry the verb.',
      '- Return one error shape everywhere: a machine-readable code, a human message and, when useful, the field at fault.',
      '- Use the right status codes: 400 for bad input, 401 or 403 for access, 404 for missing, 409 for conflicts, 429 for limits.',
      '- Adding an optional field is compatible; removing or renaming a field, or making one required, is a breaking change.',
      '- Document every endpoint with an example request and an example response for success and for each error.',
    ],
  }),
  pack('pigry.git-hygiene', 'Git Hygiene Pack', 'A commit message coach and a branch cleaner for a tidy history.', [
    ['commit-message-coach', 'Commit Message Coach', 'Commit message reviewer', '✍️', 'Reads your staged changes and proposes a commit message that says what changed and why, in the repository\'s own style.', ['git_status', 'read_diff', 'read_history']],
    ['branch-cleaner', 'Branch Cleaner', 'Branch housekeeping assistant', '🌿', 'Lists branches that are merged, stale or abandoned and tells you which ones are safe to delete.', ['git_status', 'read_history', 'list_files']],
  ], {
    id: 'commit-conventions', name: 'Commit conventions', description: 'How to write commits and keep branches tidy.',
    lines: [
      '# Commit conventions',
      '',
      '- The first line is a short summary in the imperative mood (Add, Fix, Remove), without a trailing full stop.',
      '- Say why the change was made in the body, not only what changed; the diff already shows what.',
      '- One purpose per commit. If the message needs the word "and", consider two commits.',
      '- Look at read_history first and follow the style the repository already uses.',
      '- A branch is safe to delete when everything on it is already in the main branch; check before you delete.',
    ],
  }),
  pack('pigry.accessibility', 'Accessibility Pack', 'An accessibility reviewer that checks screens against a short, practical checklist.', [
    ['a11y-reviewer', 'Accessibility Reviewer', 'Accessibility reviewer', '♿', 'Reads components and styles and reports what a keyboard user, a screen reader user or someone with low vision would struggle with.', [...READ, 'read_diff']],
  ], {
    id: 'a11y-checklist', name: 'Accessibility checklist', description: 'The basics every screen should pass.',
    lines: [
      '# Accessibility checklist',
      '',
      '- Everything that can be clicked can also be reached and used with the keyboard, in a sensible order, with a visible focus.',
      '- Every image, icon button and form field has a text label that a screen reader can read.',
      '- Text and controls have enough contrast against their background; meaning is never carried by colour alone.',
      '- Use real buttons, links, headings and lists instead of styled generic elements.',
      '- Dialogs trap focus, close with Escape and give focus back; errors are announced and tied to their field.',
    ],
  }),
  pack('pigry.performance', 'Performance Pack', 'A profiler guide and a bundle auditor for finding what makes the app slow.', [
    ['perf-profiler', 'Performance Profiler', 'Performance investigator', '⏱️', 'Finds the likely hot spots in code you point at (loops, repeated work, needless re-renders, slow queries) and proposes how to measure them.', [...READ, 'read_diff']],
    ['bundle-auditor', 'Bundle Auditor', 'Bundle size reviewer', '📦', 'Reads the dependencies and imports and lists what makes the build larger than it needs to be.', [...READ]],
  ], {
    id: 'perf-playbook', name: 'Performance playbook', description: 'Measure first, then fix the biggest cost.',
    lines: [
      '# Performance playbook',
      '',
      '- Measure before changing anything: say what is slow, how slow, and how it will be measured again afterwards.',
      '- Fix the biggest cost first; a 5% gain in the wrong place is worth nothing.',
      '- Look for work done repeatedly that could be done once: loops inside loops, queries in loops, recomputed values.',
      '- Look at what is loaded that is not needed yet: large dependencies, unused imports, assets loaded eagerly.',
      '- Report each finding with where it is, why it costs time and the smallest change that removes it.',
    ],
  }),
  pack('pigry.onboarding', 'Onboarding Pack', 'A repository tour guide that helps a newcomer find their way around.', [
    ['repo-tour-guide', 'Repo Tour Guide', 'Onboarding guide', '🗺️', 'Explains how the repository is organised, where to start reading, how to run it and who to ask, using only what is in the code.', [...READ, 'read_history']],
  ], {
    id: 'onboarding-guide', name: 'Onboarding guide', description: 'What a newcomer needs to know first.',
    lines: [
      '# Onboarding guide',
      '',
      '- Start with the README and the package or project files: what it is, how to install and run it.',
      '- Describe the folders in one line each and point to the entry points to read first.',
      '- Explain how to run the tests and the checks that must pass before a change is merged.',
      '- Use read_history to find which parts change most and who has worked on them recently.',
      '- Never invent facts: if the answer is not in the repository, say what is missing.',
    ],
  }),
);

/** How the store groups packs, and the words (besides the manifest) that find them. */
export interface StoreEntry {
  manifest: ExtensionManifest;
  category: string;
  tags: string[];
}

const META: Record<string, { category: string; tags: string[] }> = {
  'pigry.code-quality': { category: 'Code quality', tags: ['lint', 'style', 'tests', 'review'] },
  'pigry.documentation': { category: 'Documentation', tags: ['readme', 'changelog', 'docs', 'writing'] },
  'pigry.release-safety': { category: 'Release', tags: ['release', 'tag', 'version', 'checklist'] },
  'pigry.security-review': { category: 'Security', tags: ['security', 'secrets', 'threat', 'vulnerability', 'audit'] },
  'pigry.refactoring': { category: 'Code quality', tags: ['refactor', 'cleanup', 'dead code', 'maintainability'] },
  'pigry.api-design': { category: 'API', tags: ['api', 'rest', 'openapi', 'endpoints', 'http'] },
  'pigry.git-hygiene': { category: 'Git', tags: ['git', 'commit', 'branch', 'history'] },
  'pigry.accessibility': { category: 'UI', tags: ['a11y', 'accessibility', 'screen reader', 'keyboard', 'contrast'] },
  'pigry.performance': { category: 'Performance', tags: ['performance', 'speed', 'bundle', 'profiling', 'slow'] },
  'pigry.onboarding': { category: 'Documentation', tags: ['onboarding', 'newcomer', 'tour', 'getting started'] },
};

export const STORE_CATALOG: StoreEntry[] = CATALOG_MANIFESTS.map((manifest) => ({
  manifest, category: META[manifest.id]?.category ?? 'Other', tags: META[manifest.id]?.tags ?? [],
}));

export const STORE_CATEGORIES: string[] = [...new Set(STORE_CATALOG.map((entry) => entry.category))].sort();

/** Packs that match every word of the query (name, author, description, category, tags, agents and skills) and the category. */
export function searchStore(entries: StoreEntry[], query: string, category = ''): StoreEntry[] {
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.replace(/^[@#]/, '')).filter(Boolean);
  const scored = entries
    .filter((entry) => !category || entry.category === category)
    .map((entry) => {
      const { manifest } = entry;
      const text = [
        manifest.name, manifest.id, manifest.author, manifest.description, entry.category, ...entry.tags,
        ...manifest.agents.flatMap((agent) => [agent.username, agent.name, agent.role, agent.description]),
        ...manifest.skills.flatMap((skill) => [skill.id, skill.name, skill.description]),
      ].join(' ').toLowerCase();
      if (!terms.every((term) => text.includes(term))) return null;
      const name = manifest.name.toLowerCase();
      return { entry, rank: terms.every((term) => name.includes(term)) ? 0 : 1 };
    })
    .filter((item): item is { entry: StoreEntry; rank: number } => item !== null);
  return scored.sort((a, b) => a.rank - b.rank || a.entry.manifest.name.localeCompare(b.entry.manifest.name)).map((item) => item.entry);
}
