/** Skill metadata — id/name/description parsed from the markdown files in
 * .pigry/skills/. The id (file slug) is stable; the name and description
 * come from frontmatter or the body headings. */

import { getFileTree, readWorktreeFile } from './tauriClient';
import type { SkillEntry } from './mentions';

export const SKILLS_DIR = '.pigry/skills/';

/** Parses one skill markdown file into { id, name, description }.
 * Supported shapes: frontmatter (`name:` / `description:`) or a leading
 * `# Title` heading followed by a description paragraph. */
export function parseSkillMeta(id: string, markdown: string): SkillEntry {
  const lines = markdown.split('\n');

  // Frontmatter first — explicit beats inferred.
  let name = '';
  let description = '';
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i += 1) {
      const line = lines[i];
      const nameMatch = line.match(/^name:\s*(.+)$/);
      if (nameMatch) name = nameMatch[1].trim();
      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) description = descMatch[1].trim();
    }
  }

  // Fallback: first `# ` heading is the name; the next paragraph is the
  // description.
  if (!name) {
    for (const line of lines) {
      const heading = line.match(/^#\s+(.+)$/);
      if (heading) {
        name = heading[1].trim();
        break;
      }
    }
  }
  if (!description) {
    let pastTitle = false;
    const collecting: string[] = [];
    for (const line of lines) {
      if (!pastTitle) {
        if (line.startsWith('# ')) pastTitle = true;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === '') {
        if (collecting.length > 0) break;
        continue;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('```')) break;
      collecting.push(trimmed);
      if (collecting.join(' ').length >= 160) break;
    }
    description = collecting.join(' ').slice(0, 200);
  }

  return { id, name: name || id, description };
}

/** BASE SKILLS — hard-coded in the app (tier 1), like the default agents.
 * They ship with pigry, work without any files, and cannot be deleted. */
export interface BaseSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

export const BUILTIN_SKILLS: BaseSkill[] = [
  {
    id: 'database-design',
    name: 'Database design',
    description: 'Design database schemas, constraints, indexes, and migrations based on application requirements.',
    content: [
      '# Database design',
      '',
      '1. Read the existing schema, migrations, and application queries. Identify the database engine, data invariants, and access patterns.',
      '2. Define entities, keys, relationships, nullability, and constraints. Justify indexes by the queries they serve and document assumptions.',
      '3. Plan compatibility with existing data, backfill, validation, and rollback. Flag locking and data-loss risks. Draft migration files when requested and leave execution against shared databases to the operator.',
      '4. Save the design as Markdown under .pigry/reports/<your-username>/ unless the user specifies another path. Include a schema or relationship diagram, migration steps, and verification notes.',
    ].join('\n'),
  },
  {
    id: 'code-implementation',
    name: 'Code implementation',
    description: 'Implement a requested feature or fix and verify it through the existing entry points.',
    content: [
      '# Code implementation',
      '',
      '1. Read project instructions, inspect the working tree and locate the normal entry point and its callers.',
      '2. Edit the repository code to implement the request. Reuse existing types and helpers and preserve user edits and existing behavior outside the scope.',
      '3. Run the smallest relevant tests, type check or build. Add a focused regression test when needed.',
      '4. Summarize the changed paths, behavior and verification results. Report any checks that could not run.',
    ].join('\n'),
  },
  {
    id: 'unit-testing-and-bug-reporting',
    name: 'Unit testing and bug reporting',
    description: 'Write and run unit tests and save a detailed Markdown report on the bug.',
    content: [
      '# Unit testing and bug reporting',
      '',
      '1. Inspect existing tests and isolate the affected unit. Reproduce functional bugs with deterministic fixtures and assertions for the expected result.',
      '2. Add or update focused unit tests using the repository’s framework. Run them and record the command, result and relevant error. Preserve production code unless the user also requests a fix.',
      '3. Use write_file to save a Markdown report at the requested path. Otherwise use a new descriptive file under .pigry/reports/<your-username>/ with a .md extension.',
      '4. Include the environment, affected file and line, preconditions, reproduction for the functional bug, expected and actual results, root cause or hypothesis, impact, and the recommended fix or regression test.',
      '5. Distinguish confirmed bugs, hypotheses and tests that could not run. Link the saved report and changed test files in the reply.',
    ].join('\n'),
  },
  {
    id: 'qa-test-cases-and-e2e',
    name: 'QA test cases and E2E',
    description: 'Write Markdown test cases and verify user workflows end to end.',
    content: [
      '# QA test cases and E2E',
      '',
      '1. Read the acceptance criteria and trace the user workflows. Cover the normal path, expected validation errors and failure recovery relevant to the request.',
      '2. Prefer repeatable Cypress-style specs: write them with e2e_write and run them with e2e_run (see the cypress-e2e-testing skill) — they keep screenshots, per-test network JSON and the command log for you. Use browser_e2e for one-off exploration. Exercise the normal UI in an authorized development or test environment with test data and assert visible outcomes.',
      '3. Evidence is required, in three kinds, all saved under .pigry/reports/<your-username>/evidence/. (a) Video: right after the first browser_e2e goto call browser_e2e action "record_start" with save_as <feature>-e2e-run.webm, and call "record_stop" when all UI cases are done (stop it even if a case fails). (b) Screenshots: for every UI case use browser_screenshot (or browser_e2e "screenshot") with save_as <case-id>-<short-slug>.png at the key point of the case — the state after the action, and for a failure the error state. (c) API/network: after each case call browser_e2e action "network_export" with save_as <case-id>-api.json — it keeps the XHR/fetch calls (method, URL, status, timing, redacted request and response bodies) made since the previous export, taken from the browser DevTools Network panel; use scope "all" only when non-API requests matter. For API-only cases without a UI, run the request with run_command and record the command, status and a redacted response excerpt. Do not claim a case passed without this evidence.',
      '4. Use write_file to save the Markdown test cases at the requested path. Otherwise create a descriptive .md file under .pigry/reports/<your-username>/. Write it AFTER testing, so it holds the observed results.',
      '5. Start the report with a summary table (ID, title, status, evidence). Then give every case its own section containing: ID and title, requirement, preconditions, test data, "What was done" (the numbered steps you actually performed, each with the observed result), expected result, observed result, status (Pass, Fail, Blocked or Not run), the screenshot(s) embedded as ![caption](evidence/<file>.png) using a path relative to the report file, and an "API evidence" table for the case (method, URL, status, time, what the request sent and the response returned) linking the <case-id>-api.json file. Put a link to the recorded video ([Test video](evidence/<file>.webm)) near the top of the report. Explain each case in plain language, in the language the user writes in. Never put secrets, tokens or personal data in the report.',
      '6. Report coverage gaps and reasons for blocked or Not run cases. In the reply, link the saved report and list each case with its status and the evidence file.',
    ].join('\n'),
  },
  {
    id: 'qa-css-style-testing',
    name: 'QA CSS and visual style testing',
    description: 'Verify CSS, layout, responsive behaviour, themes and accessibility of styling in the browser.',
    content: [
      '# QA CSS and visual style testing',
      '',
      'Use browser_e2e in an authorized development or test environment. Test what the user actually sees, not just the stylesheet text.',
      '1. Identify the style requirements: design tokens, spacing, colours, typography, breakpoints, states (hover, focus, disabled, error) and themes. Read the changed CSS/components first so the cases target real selectors.',
      '2. Inspect: browser_e2e "snapshot" for refs, then "styles" (computed styles and box of an element). Use "assert_style" with selector, property and value for exact checks (colours match any CSS notation, px values tolerate 0.5px); use contains for composite values.',
      '3. Responsive: for each relevant breakpoint (for example 1440, 1024, 768, 390 wide) call "set_viewport" (width, height; mobile true only for phone-behaviour tests), then "check_layout" and a screenshot. Call "set_viewport" with width 0 at the end to restore the window.',
      '4. Themes: call "color_scheme" with light and dark (then none) and repeat the key checks and screenshots for both.',
      '5. "check_layout" is a heuristic audit: horizontal scrolling, content wider than the viewport, clipped text without ellipsis, low text contrast (WCAG AA), click targets under 24px, broken images and images without alt. Confirm every finding with a screenshot before reporting it as a defect, and say when something is a false positive.',
      '6. States: trigger hover/focus/error states with the available interactions (click, type, press_key) and assert the resulting styles; check keyboard focus is visible.',
      '7. Evidence: for each case save screenshots with save_as <case-id>-<viewport-or-theme>.png under the evidence folder, and when the issue is visible only in a state, record_start/record_stop around it. Report each case with the selector, property, expected and actual values, viewport/theme, status and the screenshot.',
      '8. Do not edit CSS unless the user asks; report defects with the file and rule most likely responsible and a suggested fix.',
    ].join('\n'),
  },
  {
    id: 'cypress-e2e-testing',
    name: 'Cypress-style E2E testing',
    description: 'Write, run and debug end-to-end specs in the E2E Testing menu with the e2e_* tools and the Cypress API.',
    content: [
      '# Cypress-style E2E testing',
      '',
      'The E2E Testing menu runs Cypress-style specs (plain JavaScript) in the external test browser, with a live command log, DOM snapshots to time-travel through, automatic retries, network stubbing, screenshots, API/network evidence and optional video. Use the e2e_* tools — not hand-edited files — so the editor shows your work.',
      '1. Orient: e2e_list shows specs, fixtures and settings. Check e2e_config: baseUrl must point at the running app (ask the user to start it, or start it with run_command in the background); set it with e2e_config {baseUrl}. Put test accounts and other values in env (Cypress.env("user")) and never write real secrets into specs.',
      '2. Find stable selectors before writing steps: open the page (browser_e2e goto) and use e2e_selector to count matches and get a suggestion. Prefer [data-cy], [data-test], [data-testid], ids and roles/labels; use cy.contains(selector, text) for buttons and links with visible text; avoid brittle nth-child chains and generated class names.',
      '3. Write the spec with e2e_write (your own folder; template starts: smoke, form, api, css). One describe per feature, one it per behaviour, cy.visit in beforeEach. Each test must be independent — tests start with clean cookies/storage and a blank page. Keep tests short and name them as requirements.',
      '4. The API you can rely on: cy.visit/go/reload/url/title/location/viewport(w,h | preset such as iphone-x, ipad-2, macbook-13); queries get, contains, find, filter, not, first, last, eq, children, parent(s), closest, siblings, next/prev, within; actions click, dblclick, rightclick, type (with {enter} {selectall} {backspace} {esc} {leftarrow}…), clear, check, uncheck, select, focus, blur, submit, trigger, scrollTo, scrollIntoView, selectFile; .should/.and with be.visible, be.hidden, exist, not.exist, have.text, contain.text, have.value, have.attr, have.class, have.css, have.length, be.checked, be.disabled, be.enabled, be.focused, be.empty, match, eq, include, have.property, a callback form; then, each, its, invoke, wrap, as, spread; cy.intercept(method, url, response|handler) with .as("name") and cy.wait("@name") then .its("response.statusCode"); cy.request; cy.fixture; cy.readFile/writeFile (under .pigry/); cy.exec; cy.clock/cy.tick; cy.screenshot; cy.getCookie(s)/setCookie/clearCookies, clearAllLocalStorage; cy.session; cy.on("uncaught:exception", () => false), cy.on("window:confirm", () => false); Cypress.env/config/Commands.add; expect/assert. Also available: trusted browser input (click/type/hover/cy.press go through the real browser when the setting is on — use .realHover() for CSS :hover), cy.iframe(selector) and shadow DOM ({includeShadowDom: true} or the setting), cy.mount(html, {styles}) for framework-less component tests, cy.origin, cy.task with Cypress.tasks({...}) handlers, cy.visit({headers, auth, method, body, onBeforeLoad}), cy.screenshot({capture: "fullPage", clip, padding, blackout}) and element screenshots (cy.get(x).screenshot()), httpOnly cookies, throttleKbps on stubs, a support file (.pigry/e2e/support/e2e.js) for custom commands and global hooks, and TypeScript specs (.cy.ts). Also available: import/require of relative modules (helpers, page objects, TypeScript or JSON) from specs, a plugins file or cypress.config.js with setupNodeEvents(on, config) for cy.task handlers and lifecycle events, extra specPattern globs, and component testing: cy.mount({ module: "/src/Button.tsx", export: "Button", props, framework: "react" | "vue" | "custom" }) imports the component from the dev server set in Settings (componentUrl/baseUrl); the headless CLI (npm run e2e -- --component react) starts a Vite dev server itself and writes junit.xml and report.html (--shard i/n splits a suite over machines; --replay embeds Test Replay; --merge combines shard outputs). A self-hosted dashboard, our Cypress Cloud, runs with --serve [port]: machines record runs to it with --record <url> --ci-build-id <id> (--balance hands specs out one at a time, slowest first), and it shows runs, flaky tests across builds, JUnit and Test Replay; --projects <file> gives each project its own record and read keys so teams only see their own runs. Not supported: await on cy commands, installing npm packages inside the in-app runner (the CLI can require them).',
      '5. Wait on the app, never on the clock: assertions and queries retry automatically (default 4s), so write cy.get(".row").should("have.length", 3) instead of cy.wait(2000). For network, alias the request with cy.intercept(...).as("x") and cy.wait("@x"). Use cy.intercept with a static response to test error, empty and slow states without touching the backend.',
      '6. Run with e2e_run {name}. It returns PASS/FAIL per test with the error (e.g. "Timed out retrying after 4000ms: Expected to find element: `.x`, but never found it."), a code frame with the failing line, the last commands, the browser console, a failure screenshot and a network JSON per test. Read the failure first: a wrong selector or a missing wait is a spec bug (fix with e2e_edit and rerun); a wrong value, a console error or a failed API call is an application defect — report it, do not weaken the assertion to make it pass.',
      '7. Debug with e2e_results {name, view: "log", test}, which lists every command with its result, and with e2e_open {name, run: true} so the user can step through the command log and the before/after snapshots. For flaky timing use retries (e2e_run retries or it("x", {retries: 2}, fn)) only after finding the cause.',
      '8. Evidence and report: screenshots on failure, a network JSON per test and (with video: true) a .webm of the run are saved under .pigry/e2e/evidence/<you>/<spec>/. For a written report call e2e_run with report: true — it saves a Markdown file with the steps, errors and linked screenshots under .pigry/reports/<you>/. Add cy.screenshot("<case>") at key moments to document passing cases. Link the report and evidence in your reply and state what was and was not covered.',
      '9. Stabilise before you trust: e2e_stats lists the tests that fail most, the flaky ones (pass only after a retry) and the slowest across runs. Fix flaky tests by waiting for the right signal (an alias, an assertion), not by adding sleeps or retries. The runner also writes JUnit XML next to every result for CI.',
      '10. Only test applications and environments you are authorised to test, with test data. Never run specs against production with real accounts or payments, never put secrets in a spec or report.',
    ].join('\n'),
  },
  {
    id: 'board-editor',
    name: 'Using the Board editor',
    description: 'Create, read, edit, preview and export whiteboards with the board_* tools.',
    content: [
      '# Using the Board editor',
      '',
      'Boards are FigJam-style whiteboards saved as files (.pigry/boards/<your-username>/<name>.board.json — one folder per agent) and edited in the Board menu. Always use the board_* tools — never hand-edit the JSON with write_file — so the file stays valid and the open editor refreshes.',
      '1. board_list first. If the board exists, board_read it (summary) BEFORE changing anything. Never overwrite a board you did not create or one the user has edited — use board_edit.',
      '2. New board: board_write with name, title and items. Structure beats decoration: one SECTION per theme or column, with its sticky notes inside — {type: "section", text: "Went well", color: "green", notes: ["Fast reviews", "Good demo"]}. Sections are placed side by side and the notes are laid out in a grid inside them; you never need x/y.',
      '3. Notes: one idea per sticky (under about 12 words), written in the participants\' own words, colour coded by meaning (not decoration). Use text items for titles and prompts ("How might we …?"), shapes for process steps and decisions, connectors (from/to by id or exact text, with a label) for relations and flows, and stamps (👍 ❓ ⭐ 🔥) for reactions. To bring existing work into the discussion, EMBED it: {type: "diagram", ref: "sa/login-flow"} or {type: "design", ref: "uxui/home", node: "Mobile — Home"} (refs come from diagram_list / design_list). Embeds stay live — when the diagram or design changes the board updates — and double-clicking one opens it in its editor. Put the embed next to the notes that discuss it and connect them with connectors. To discuss code, show it: {type: "code", path: "src/App.tsx", start: 1, end: 10} (only those lines), {type: "compare", base: "main", head: "feature/x", path?} for a diff, or {type: "commit", oid: "1a2b3c4", path?} for a commit — they read the repository live and double-clicking opens the file or commit.',
      '4. Change a board with board_edit operations: add {text, section}, update, remove, move, connect, group {ids, section: "Title"}, arrange {section}, vote {id, by}, duplicate. Batch related operations in one call; items can be addressed by id or exact text. Adding to a section keeps its notes tidy.',
      '5. Facilitate with votes: use vote operations when asked to prioritise, and report the ranking. Keep authorship — notes you add carry your name.',
      '6. ALWAYS look at your work: board_preview attaches an image of the board to your next turn — check for empty sections, overlaps and clutter and fix them with board_edit. board_read lists review warnings (overlaps, empty or over-long notes, notes outside sections).',
      '7. Share the result: board_open shows the board to the user; board_export markdown gives a clean outline (sections → headings, notes sorted by votes, relations) for reports, svg/png save an image under .pigry/ that you can embed. Finish with a short summary: what is on the board, the top themes or votes, and the suggested next steps.',
    ].join('\n'),
  },
  {
    id: 'workshop-facilitation',
    name: 'Workshop facilitation on a board',
    description: 'Brainstorm, retro, affinity mapping, prioritisation and decision workshops — structure, prompts and synthesis.',
    content: [
      '# Workshop facilitation on a board',
      '',
      'Pick the format that matches the goal, set it up with board_write, populate it, then synthesise.',
      '- Brainstorm / How might we: a text prompt on top, sections Ideas, Questions, Next steps. Generate many short ideas first, group related ones with group/arrange, then dot-vote and keep the top 3.',
      '- Retrospective: sections Went well (green), To improve (orange), Action items (blue). Each action item names an owner and a deadline. End with the top voted problems and the actions.',
      '- Affinity mapping: put every raw note on the board, cluster by theme into sections titled with a sentence ("Onboarding is confusing"), note counts and votes per cluster, and call out outliers.',
      '- Prioritisation matrix: four sections (High impact · Low effort = do first; High impact · High effort = plan; Low impact · Low effort = fill-in; Low impact · High effort = avoid). Place each idea by moving it onto the right section; report the do-first list.',
      '- Journey map: one section per stage (Awareness, Consideration, Purchase, Retention), stickies for actions, thoughts, pain points (red) and opportunities (green); connect cause and effect.',
      '- SWOT / pros-cons / 5 whys: one section per quadrant or level; for 5 whys chain connectors from problem to root cause.',
      'Facilitation rules: state the goal and the time-box in a text item; keep one idea per note; separate divergent (collect) from convergent (cluster, vote, decide) work; do not merge or rewrite participants\' notes — add a new note or a connector instead; attribute notes; end with decisions, owners and next steps. Export the outcome with board_export markdown and summarise it in the reply.',
    ].join('\n'),
  },
  {
    id: 'discovery-mapping',
    name: 'Discovery mapping for analysis',
    description: 'Stakeholder maps, as-is/to-be processes, user story maps and event storming on a board, feeding the analysis.',
    content: [
      '# Discovery mapping for analysis',
      '',
      'Use the board to explore the problem space before modelling it formally.',
      '1. Stakeholder map: sections Users, Customers, Operators, Systems, Regulators with stickies per stakeholder (role, goal, concern); connect who depends on whom.',
      '2. As-is process: a left-to-right chain of shapes with connectors; mark pain points with red stickies attached by connectors; then a To-be chain showing the improvements. Hand the agreed flow to diagram_write (flowchart) for the formal version.',
      '3. User story map: top row sections for the user journey steps (backbone), stickies below each for stories ordered by priority; draw release lines as text items; mark must-haves.',
      '4. Event storming: orange stickies for domain events (past tense), blue for commands, yellow for actors, purple for policies/rules, pink for open questions; connect in time order.',
      '5. Requirements capture: sections Functional, Non-functional, Constraints, Open questions with numbered stickies (FR-01 …); vote on priority.',
      '6. Convert: embed the formal diagrams or designs you create next to the notes they came from, summarise the board with board_export markdown, then write the analysis (requirements, use cases, data dictionary) with the system-analysis skill, create the formal diagrams with the diagram tools, and link them to the board file. List open questions that block the next step.',
    ].join('\n'),
  },
  {
    id: 'design-editor',
    name: 'Using the Design editor',
    description: 'Create, read, edit, preview, review and export designs with the design_* tools.',
    content: [
      '# Using the Design editor',
      '',
      'Designs are files (.pigry/designs/<your-username>/<name>.design.json — one folder per agent) edited in the Design menu. Always use the design_* tools — never hand-edit the JSON with write_file — so the file stays valid and the open editor refreshes.',
      '1. design_list first. If the design exists, design_read it (outline) BEFORE changing anything; read a subtree with node. Never overwrite a design you did not create or one the user may have edited — use design_edit.',
      '2. New design: design_write with name, title, tokens {colors} and nodes. Top-level nodes are frames named by screen ("Mobile — Home" 390×844, "Desktop — Dashboard" 1440×900). Build every screen with AUTO LAYOUT frames: layout {dir: "column"|"row", gap, padding, justify, align, hugW/hugH}, children with grow / selfAlign. Positions and text sizes are computed for you — avoid absolute x/y except for overlays and decorations.',
      '3. Node basics: type frame | rect | ellipse | text | line | image; name layers by purpose ("Primary button", "Avatar"); fill is "#hex", "$token", a gradient {from,to,angle} or null; radius, stroke, strokeWidth, shadow {x,y,blur,color}, opacity; text uses text, fontSize, fontWeight, fontFamily, textAlign, lineHeight and autoSize ("w" fits the text, "h" wraps at the given w). A component such as a button is a frame with a text child — build it once, then duplicate.',
      '4. Colours: put the palette in tokens.colors (primary, surface, background, text, muted, border, success, danger …) and use "$name" everywhere so a palette change recolours the whole design.',
      '5. Edit with design_edit operations: add {parent, node}, update {id, …fields}, remove, move {id, parent, index}, duplicate, wrap {ids}, set_tokens, set_meta. Batch related operations in one call. Nodes can be addressed by id or by unique name.',
      '6. ALWAYS look at your work: call design_preview for each screen — the image is attached to your next turn — and fix what looks wrong (spacing, alignment, hierarchy, cut-off text) with design_edit. Then run design_check and fix every error and warning (contrast, tiny text, small touch targets, overflow).',
      '7. Finish with design_open so the user sees it. For hand-off use design_export: html (static HTML + CSS with the tokens as CSS variables), svg or png (saved under .pigry/, viewable with read_image, embeddable in Markdown). Tell the user in two or three sentences what you designed and any assumptions.',
    ].join('\n'),
  },
  {
    id: 'ui-design-system',
    name: 'UI design system and visual design',
    description: 'Spacing, type, colour, components, states and accessibility rules for polished UI.',
    content: [
      '# UI design system and visual design',
      '',
      'Make the interface consistent and legible before making it fancy.',
      '- Grid and spacing: use an 8px scale (4, 8, 12, 16, 24, 32, 48); padding and gaps are multiples of 4. Group related items closer than unrelated ones. Screen padding: 16–24 on mobile, 24–48 on desktop.',
      '- Type: one font family (sans) with a small scale — caption 12, body 14–16, subtitle 18–20, title 24–32, display 40+. Weights 400/500 for text, 600–700 for emphasis. Line height 1.3–1.5 for text. Body text never below 14px on mobile, nothing below 12px.',
      '- Colour: define tokens (primary, primary-dark, surface, background, text, muted, border, success, warning, danger). One primary colour, neutrals for everything else. Text contrast at least 4.5:1 (3:1 for 24px+ or bold 19px+); do not rely on colour alone to show state. Check with design_check.',
      '- Layout: mobile frames 390×844 (or 360×800), tablet 820×1180, desktop 1440×900. Use column/row auto layout, align stretch for full-width children, grow for the element that should fill space, hugW/hugH for buttons and chips. Keep a clear visual hierarchy: one primary action per screen.',
      '- Components: build them once and reuse — Button (primary/secondary/ghost/disabled), Input (default/focus/error), Card, List item, Tab bar, Nav, Badge, Avatar (ellipse). Buttons ≥ 44px tall on mobile (≥ 32 on desktop), radius consistent across the system, 16px horizontal padding.',
      '- States and edge cases: design empty, loading, error and success states for data screens, plus long text and small-screen behaviour.',
      '- Icons and images: there is no icon library — use simple shapes (ellipse, rect, line) or short text glyphs as placeholders, and image frames with a neutral fill labelled by purpose. Never leave default layer names.',
      '- Consistency: reuse the same radius, shadow, border colour and spacing values across screens; change a token rather than editing each node.',
    ].join('\n'),
  },
  {
    id: 'ux-design-process',
    name: 'UX design process',
    description: 'From user goals to flows, wireframes, high-fidelity screens, review and hand-off.',
    content: [
      '# UX design process',
      '',
      'Design for the user\'s goal, then polish.',
      '1. Understand: who the users are, their main goals, context (device, frequency, constraints) and the success criteria. Read existing code, docs and designs (list_files, read_file, design_list). State assumptions and ask the user only when a wrong guess would change the design.',
      '2. Flows: map the key journeys before drawing screens — use diagram_write (type flowchart) for the user flow including errors and edge cases, and diagram_write (type usecase) when roles matter. Keep each flow to the happy path plus the important failures.',
      '3. Wireframe first: low-fidelity frames in neutral greys with real copy (no lorem ipsum) to settle structure, content hierarchy and navigation. Review the layout with design_preview before adding colour.',
      '4. High fidelity: apply the design system (tokens, type scale, components) with the ui-design-system skill; cover the main screens and key states (empty, loading, error, success). Use realistic content.',
      '5. Review against usability heuristics: visibility of status, match with the real world, user control (undo/back), consistency, error prevention and recovery, recognition over recall, minimalism. Run design_check for accessibility and fix every error and warning.',
      '6. Hand off: save a short Markdown spec with write_file under .pigry/reports/<your-username>/ (screens, flows, components, tokens, interaction notes, open questions) that embeds the exported PNGs; export HTML/CSS with design_export for developers; list what is designed and what is not.',
      '7. Report briefly: what you designed (link the design and files), the key decisions and why, assumptions, and what to validate with real users next.',
    ].join('\n'),
  },
  {
    id: 'diagram-editor',
    name: 'Using the Diagram editor',
    description: 'Create, read, edit, export and show diagrams with the diagram_* tools.',
    content: [
      '# Using the Diagram editor',
      '',
      'Diagrams are files (.pigry/diagrams/<your-username>/<name>.diagram.json — one folder per agent, "user" for the person) edited in the Diagram menu. Always use the diagram_* tools — never hand-edit the JSON with write_file — so the file stays valid and the open editor refreshes.',
      '1. Start with diagram_list. If the diagram already exists, diagram_read it (summary format) BEFORE changing anything; never overwrite a diagram the user may have edited.',
      '2. New diagram: diagram_write (saved in your own folder) with name, title, type (flowchart, erd, usecase, architecture or generic), direction (TB or LR) and nodes + edges. Give every node a short unique id and refer to ids in edges. Omit x/y — the layered auto layout places everything. Keep one diagram to about 25 nodes; split bigger systems into several diagrams.',
      '3. Existing diagram: diagram_edit with operations (add_node, update_node, remove_node, add_edge, update_edge, remove_edge, set_meta, layout). Batch related operations in one call. Nodes may be addressed by id or by unique label.',
      '4. Node kinds: process, terminator (start/end), decision, io, database, document, entity (table; fields "name [type] [PK|FK|UK]"), actor, usecase, system (boundary box — children name it as parent), note, cloud (external system), queue. Edge options: label, fromLabel/toLabel (cardinality such as 1, 0..1, N, 1..N), dashed, arrow (end, both, none).',
      '5. After writing or editing, read the tool result: it lists Issues (unknown nodes that were dropped, unconnected nodes, overlaps). Fix them with diagram_edit and re-check with diagram_read.',
      '6. Show the result with diagram_open. For documents, diagram_export format svg saves an image you can embed in Markdown as ![title](path); format mermaid returns text for READMEs and wikis.',
      '7. Keep labels short (2-5 words), use verbs for processes and nouns for entities, and tell the user in one or two sentences what the diagram shows and what you assumed.',
    ].join('\n'),
  },
  {
    id: 'diagram-modeling',
    name: 'Diagram modeling conventions',
    description: 'Notation and layout rules for flowcharts, ER diagrams, use cases and architecture diagrams.',
    content: [
      '# Diagram modeling conventions',
      '',
      'Pick the diagram type that answers the question, then follow its conventions.',
      '- Flowchart (type flowchart, direction TB): one terminator "Start" and at least one "End"; processes are verb phrases; every decision has two or more outgoing edges labelled yes/no (or the condition); show failure and retry paths; no dead ends.',
      '- ER diagram (type erd, direction LR): one entity node per table, label = singular noun; fields as "name type PK|FK|UK" with the primary key first and foreign keys marked FK; one edge per relationship with a verb label and cardinality on both ends (fromLabel "1", toLabel "N"; many-to-many needs a junction entity); include created/updated columns only when they matter.',
      '- Use case (type usecase, direction LR): actors outside, a system boundary node containing the use cases (set parent to the boundary id), actor-to-use-case edges with arrow none, <<include>>/<<extend>> as dashed edges labelled include/extend; use cases are verb + object ("Place order").',
      '- Architecture (type architecture): services as process, datastores as database, third parties as cloud, async channels as queue; label edges with the protocol or data ("HTTPS", "SQL", "events"); dashed edges for optional or async calls; keep it at one level of detail.',
      '- Sequence-like flows: model as a flowchart with actors/systems as swimlane notes or as a numbered edge-label sequence ("1. login", "2. token").',
      'Layout: let auto layout arrange the diagram; use direction LR for wide ER and architecture diagrams and TB for flows. Group related nodes with a system boundary instead of manual coordinates. After a big edit run layout.',
    ].join('\n'),
  },
  {
    id: 'system-analysis',
    name: 'System analysis',
    description: 'Turn requirements into use cases, process flows, an ER model and a documented analysis.',
    content: [
      '# System analysis',
      '',
      'Work like a system analyst: understand first, model second, document third.',
      '1. Gather context: read the relevant code and docs (list_files, search_code, read_file) and the user\'s request. List assumptions and open questions explicitly; ask the user only when a wrong guess would change the design.',
      '2. Identify actors, goals and scope. Write numbered functional requirements (FR-01…) and non-functional ones (NFR-01…) with a measurable criterion each.',
      '3. Model: a use case diagram for scope, a flowchart per important process (including errors and edge cases), an ER diagram for the data, and an architecture diagram when several components interact. Create them with the diagram_* tools — one diagram per concern, named like login-flow, order-erd.',
      '4. Write the analysis as Markdown with write_file under .pigry/reports/<your-username>/ (for example order-analysis.md): summary, scope and actors, requirements table with IDs, use cases (ID, actor, preconditions, main flow, alternative flows, postconditions), process descriptions, data dictionary (entity, field, type, constraints, description), business rules, assumptions and open questions. Export each diagram with diagram_export format svg and embed it with a relative path so the document shows the pictures.',
      '5. Trace everything: each use case lists the requirements it satisfies, each entity says which use cases use it. Flag requirements that no diagram or use case covers.',
      '6. Close with a short summary: what was analysed, which diagrams and files were created (link them), the assumptions you made, and the questions that block the next step. Hand implementation to the coder, schema work to the database designer and test design to QA.',
    ].join('\n'),
  },
  {
    id: 'defensive-security-report',
    name: 'Defensive security reporting',
    description: 'Review authorized repository code and existing alerts, then save findings and mitigations in Markdown.',
    content: [
      '# Defensive security reporting',
      '',
      '1. Review only code, configuration, dependencies and existing alerts for the repository the user authorized. Use source inspection for input handling, authorization, sensitive data exposure, and least privilege.',
      '2. Corroborate observations with repository files and existing alerts when available. Do not generate exploits or payloads, reproduce vulnerabilities, probe live targets, run scans or delegate offensive work.',
      '3. Use write_file only to save a Markdown report at the requested path. Otherwise create a descriptive .md file under .pigry/reports/<your-username>/. Redact secrets and sensitive data.',
      '4. For each finding record severity, confidence, affected file and line, source evidence, potential impact, and a concrete mitigation. Describe safe verification in terms of the expected protective behavior.',
      '5. Separate confirmed findings from items needing review, record the scope and limits, and link the saved report.',
    ].join('\n'),
  },
  {
    id: 'file-navigation',
    name: 'File navigation',
    description: 'Find, read, save and preview repository files.',
    content: [
      '# File navigation',
      '',
      '- Use list_files for paths, search_code for a symbol or literal, and read_file for the surrounding code.',
      '- Open files with Ctrl/Cmd+P in Explorer and save with Ctrl/Cmd+S. Dirty dots mark unsaved edits.',
      '- Use read_image for supported images, read_pdf for PDFs, read_word for DOCX and read_excel for XLSX.',
      '- Use git_status and read_diff to inspect saved worktree changes.',
    ].join('\n'),
  },
  {
    id: 'history-analysis',
    name: 'History analysis',
    description: 'Read the commit graph, lanes and per-commit details.',
    content: [
      '# History analysis',
      '',
      '- Commit graph screen: lanes newest-first, click a commit for its detail panel',
      '- read_history returns commit rows, and read_commit shows a commit’s files or compares a file with its first parent',
      '- Pass ref to read_history for a branch or first_parent=true to follow the main line of that branch.',
      '- Explain which parent and branch are relevant when reviewing merge commits.',
    ].join('\n'),
  },
  {
    id: 'merge-conflict',
    name: 'Merge conflicts',
    description: 'Merge from the Merge branch menu; resolve conflicts inline.',
    content: [
      '# Merge workflow',
      '',
      '- Use git_status to identify the checked-out branch and preview_merge with the source branch to inspect incoming commits and files.',
      '- Choose fast-forward, merge commit or squash based on the intended history.',
      '- For conflicts, review both sides in Working changes, resolve and stage the result, then complete the merge.',
      '- Use Abort merge to restore the pre-merge state when the merge should be cancelled.',
    ].join('\n'),
  },
  {
    id: 'push-review',
    name: 'Push review',
    description: 'Review unpushed commits before pushing upstream.',
    content: [
      '# Push review',
      '',
      '- Use git_status to check the upstream and ahead/behind counts.',
      '- Call preview_sync_commits with direction=push to inspect outgoing commits, then read_commit for a selected file.',
      '- Review unintended files, test coverage and the intended destination before using Push or Publish branch.',
    ].join('\n'),
  },
  {
    id: 'pull-review',
    name: 'Pull review',
    description: 'Review fetched commits and check whether a fast-forward pull can proceed.',
    content: [
      '# Pull review',
      '',
      '- Use git_status to check the current branch, its upstream and ahead/behind counts.',
      '- Call preview_sync_commits with direction=pull to read commits from the locally fetched upstream. Use Fetch in Pull commit to refresh that upstream.',
      '- Open a commit and file in Pull commit or use read_commit with the commit SHA and path. Summarize changes that affect tests, configuration or migrations.',
      '- Use the fast-forward pull action when the local branch is behind without local-only commits. For diverged branches, review both histories before choosing a reconciliation strategy.',
    ].join('\n'),
  },
  {
    id: 'branch-comparison',
    name: 'Branch comparison',
    description: 'Compare branch tips and explain changes by commit and file.',
    content: [
      '# Branch comparison',
      '',
      '- Use git_status to find the Base and Compare refs. Pass full refs such as refs/heads/main and refs/remotes/origin/feature to compare_branches.',
      '- Interpret additions and deletions in the direction from Base to Compare. Report the commit count unique to each side.',
      '- Pass path to compare_branches for the code versions of a changed file. In Compare branch, open the file and choose Split or Unified.',
      '- Focus the review on behavior changes, affected files and tests to run.',
    ].join('\n'),
  },
  {
    id: 'stash-management',
    name: 'Stash management',
    description: 'Stash, apply, pop and drop — keep or discard entries deliberately.',
    content: [
      '# Stash workflow',
      '',
      '- Call preview_stash to list entries and pass index to inspect one entry and its changed files.',
      '- Save a stash with a descriptive message. Check the active branch and working changes before restoring one.',
      '- Apply retains the stash entry. A successful Pop applies and removes it.',
      '- Resolve any conflicts in Working changes. Confirm the intended entry before dropping it.',
    ].join('\n'),
  },
  {
    id: 'cherry-pick-flow',
    name: 'Cherry pick',
    description: 'Pick a commit onto the current branch; conflicts stage for commit.',
    content: [
      '# Cherry-pick flow',
      '',
      '- Use git_status to confirm the checked-out destination, then read_commit to review the selected commit and related changes.',
      '- In Cherry Pick, apply the selected commit to stage its changes on the current branch.',
      '- Resolve conflicts if Git reports them, stage the resolution, and commit the result in Working changes.',
    ].join('\n'),
  },
  {
    id: 'duplicate-commit',
    name: 'Duplicate commit',
    description: 'Check whether a commit can be copied from one local branch to another.',
    content: [
      '# Duplicate commit',
      '',
      '- Identify the local source and destination branches with git_status. Use read_history for the source and read_commit for the selected commit and its file changes.',
      '- Call check_duplicate_commit with source_branch, destination_branch and the full oid. Git includes both exact SHA matches and equivalent changes when checking eligibility.',
      '- An eligible commit shows a green copy icon in Duplicate commit. Use the menu to copy it to the chosen destination while staying on the current branch.',
      '- If Git reports a conflict, inspect the overlapping changes. The destination ref advances only after Git can apply the commit successfully.',
    ].join('\n'),
  },
  {
    id: 'edit-commit',
    name: 'Edit commit',
    description: 'Amend the selected commit and replay the commits that follow it.',
    content: [
      '# Edit commit',
      '',
      '- Use git_status and read_history with first_parent=true to verify the checked-out local branch and find the commit.',
      '- Start with a clean working tree. Choose the commit in Edit commit and select Start editing.',
      '- Save files in Explorer, stage the intended edits in Working changes, and review them with read_diff using staged=true.',
      '- Use Save and continue to amend the selected commit and replay later commits. This rewrites their history. Resolve and stage conflicts before Continue rebase, or use Abort edit to restore the original branch.',
    ].join('\n'),
  },
  {
    id: 'rebase-plan',
    name: 'Rebase plan',
    description: 'Review the target base, replay order and conflict resolution.',
    content: [
      '# Rebase plan',
      '',
      '- Use git_status to confirm the current branch and working changes, and read_history for the branch and proposed base.',
      '- Review the plan in Rebase Branch. Git replays steps from oldest to newest. Keep dependencies before their callers and check what each squash or drop removes.',
      '- If Git pauses on a conflict, inspect and stage the resolution in Working changes, then continue the rebase from the terminal.',
      '- Rebase rewrites the selected history. Use Abort rebase to restore the original branch if the operation should be cancelled.',
    ].join('\n'),
  },
  {
    id: 'working-changes-review',
    name: 'Working changes review',
    description: 'Separate staged and unstaged edits and verify the intended commit.',
    content: [
      '# Working changes review',
      '',
      '- Use git_status to find changed files and distinguish staged, unstaged and untracked entries.',
      '- Use read_diff with staged=true for the index and staged=false for saved working-tree changes.',
      '- Stage only the files, hunks or lines the user wants to include. Recheck the staged diff and note the relevant tests.',
      '- During an active Edit commit session, use Save and continue to complete the amendment.',
    ].join('\n'),
  },
  {
    id: 'branch-ops',
    name: 'Branch operations',
    description: 'Create, checkout and clean up branches; local vs remote symbols.',
    content: [
      '# Branch operations',
      '',
      '- Use git_status to distinguish local refs, remote-tracking refs and the active upstream.',
      '- Read a branch’s history with read_history and compare refs using compare_branches.',
      '- Check the current branch and working changes before creating or checking out a branch in the Branches menu.',
    ].join('\n'),
  },
  {
    id: 'pr-review',
    name: 'Pull request review',
    description: 'Review a PR using its commits, changed files and checks.',
    content: [
      '# Pull request review',
      '',
      '- Call github_pull_requests with action=view and the PR number to inspect the branches, reviewers and checks.',
      '- Use action=file_patches for targeted files and action=commit_diff with a full commit oid for a per-commit diff.',
      '- In the Pull requests screen, expand a file or commit for an inline diff. Use Show more to load the next page.',
      '- Report actionable findings with file or line references, explain the impact and note test gaps. Use github_actions for failed check logs.',
    ].join('\n'),
  },
  {
    id: 'pr-writing',
    name: 'PR writing',
    description: 'Draft pull requests: imperative title, what/why/testing body.',
    content: [
      '# PR writing',
      '',
      '- Title: imperative mood, at most 72 chars',
      '- Body: what changed + why + how it was tested',
      '- Reference related issues with their actual numbers and summarize relevant check results.',
      '- Use github_pull_requests with action=list to check for an existing PR. Submit the reviewed draft in Pull requests.',
    ].join('\n'),
  },
  {
    id: 'issue-triage',
    name: 'Issue triage',
    description: 'Triage and draft issues: reproduce, expected vs actual, labels.',
    content: [
      '# Issue triage',
      '',
      '- Use github_issues with action=list or action=view to find related issues and read their comments.',
      '- Template: steps to reproduce / expected / actual / environment',
      '- One bug per issue; label by area and severity',
      '- Link commits or PRs that reference the issue number',
    ].join('\n'),
  },
  {
    id: 'ci-debugging',
    name: 'CI debugging',
    description: 'Read workflow runs: failed step, logs, rerun after fix.',
    content: [
      '# CI debugging',
      '',
      '- Use github_actions with action=list to find the run, then action=view and run_id to identify the first failing job.',
      '- Use action=logs with run_id and the relevant job_id. Quote the smallest useful error excerpt and name a check that would confirm the cause.',
      '- Use action=artifacts to check build outputs. Rerun workflows from Actions when appropriate.',
    ].join('\n'),
  },
  {
    id: 'project-board',
    name: 'Project boards',
    description: 'Review project board items, status and blockers.',
    content: [
      '# Project boards',
      '',
      '- Use github_projects with action=list to find the board, then action=items with its number.',
      '- Check linked issues and PRs to identify dependencies, blockers and status mismatches. Suggest a concrete next action for each item.',
    ].join('\n'),
  },
  {
    id: 'repo-insights',
    name: 'Repo insights',
    description: 'Read activity, stats and contributor data.',
    content: [
      '# Repo insights',
      '',
      '- Use repo_insights with metric=activity for commit and contributor counts, metric=delivery for PR and issue metrics, or metric=traffic for views and clones.',
      '- State the date range, branch and any differences in coverage before comparing periods.',
      '- Identify missing or partial metrics and base conclusions on the returned data.',
    ].join('\n'),
  },
  {
    id: 'web-research',
    name: 'Web research',
    description: 'web_search first, then playwright to read the best result.',
    content: [
      '# Web research',
      '',
      '- Use web_search to find sources, then open the relevant pages with an available browser tool.',
      '- For a page the user is viewing, use browser_panel to read it. Use playwright for rendered page text when available.',
      '- Cite the pages you used and distinguish observations from inferences.',
    ].join('\n'),
  },
  {
    id: 'workspace-tool-use',
    name: 'Workspace tool use',
    description: 'Choose the available tool that matches the current menu and task.',
    content: [
      '# Workspace tool use',
      '',
      '- Use git_status to identify the repository state and list_files or search_code to find relevant code.',
      '- Prefer tools for the task, such as read_commit for commit content, compare_branches for branch differences, and github_pull_requests for PR details.',
      '- Use agent_contacts to find the menu’s specialist and agent_lookup to check their role.',
      '- Review tool errors, missing permissions or truncated output before drawing conclusions. State what the available data verifies.',
    ].join('\n'),
  },
  {
    id: 'run-tests',
    name: 'Run tests',
    description: 'Find and run the tests relevant to the current repository.',
    content: [
      '# Run tests',
      '',
      '- Read the current repository’s manifests, scripts and contributor instructions to find its test commands.',
      '- Start with the smallest test that exercises the change, then run the relevant build, lint or wider suite.',
      '- Report the commands run, their results and any validation blocked by missing dependencies.',
    ].join('\n'),
  },
  {
    id: 'code-review',
    name: 'Code review',
    description: 'Review checklist: correctness, style, error paths, security.',
    content: [
      '# Code review checklist',
      '',
      '- Correctness first: edge cases, error paths, off-by-one',
      "- Match the file's existing style (naming, comment density, idiom)",
      '- Error handling: no silent catches; user-visible errors are explicit',
      '- Performance: no N+1 loops, no needless clones in Rust',
      '- Security: validate external input; never allow `..` path escapes',
      '- Phrase taste-dependent notes as questions, not demands',
    ].join('\n'),
  },
  {
    id: 'git-commit-style',
    name: 'Git commit style',
    description: 'Conventional commits + deliberate staging for this repo.',
    content: [
      '# Commit style',
      '',
      '- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:` — imperative mood',
      '- Subject at most 72 chars, no trailing period',
      '- Body explains what + why, wrapped around 72 chars',
      '- One logical change per commit; never mix formatting with logic',
      '- Stage deliberately (hunk or line level) and re-read the diff before committing',
    ].join('\n'),
  },
  {
    id: 'bug-triage',
    name: 'Bug triage',
    description: 'Reproduce, locate the true origin, fix the cause, add a regression test.',
    content: [
      '# Bug triage protocol',
      '',
      '1. Reproduce reliably — smallest possible case first',
      '2. Read the error at its true origin, not just the throw site',
      '3. Form ONE hypothesis and verify it with logs or a test before fixing',
      '4. Fix the cause, not the symptom; add a regression test',
      '5. Search for the same pattern elsewhere in the codebase',
    ].join('\n'),
  },
  {
    id: 'refactor-safety',
    name: 'Refactor safety',
    description: 'Behaviour-preserving refactoring in small verified steps.',
    content: [
      '# Refactor safety',
      '',
      '- Behaviour-preserving only: no feature changes mixed into refactors',
      '- Small steps: rename, verify, move, verify',
      '- Keep the public surface stable unless the task says otherwise',
      '- Let existing tests pin behaviour before restructuring',
    ].join('\n'),
  },
  {
    id: 'security-review',
    name: 'Security review',
    description: 'Validate input, protect secrets, least privilege, report with severity.',
    content: [
      '# Security review checklist',
      '',
      '- Use github_security with alert_type=code, dependencies or secrets to inspect repository alerts.',
      '- Validate every external input (paths, URLs, JSON) — no `..` escapes',
      '- Never log or commit secrets/API keys',
      '- Shell commands: quote every argument; no concatenating user data',
      '- Least privilege: tools and agents get the minimum access needed',
      '- Report findings with severity + a concrete fix',
    ].join('\n'),
  },
  {
    id: 'docs-writing',
    name: 'Docs writing',
    description: 'Lead with what, then how; real paths and examples from this repo.',
    content: [
      '# Documentation writing',
      '',
      '- Lead with what it does, then how to use it, then details',
      '- Verify commands and paths against the current repository.',
      '- One idea per paragraph; examples beat abstract description',
      '- Keep the existing document voice and formatting',
    ].join('\n'),
  },
  {
    id: 'wiki-workflow',
    name: 'Wiki workflow',
    description: 'Review GitHub Wiki pages, links and change history.',
    content: [
      '# Wiki workflow',
      '',
      '- Use github_wiki with action=list to find a page, then action=view or history with its file path.',
      '- Sync from the Wiki menu when the local wiki is stale. Check related pages and links before proposing changes.',
      '- Preserve page terminology and links. Use the Wiki editor to save the reviewed update with a descriptive message.',
    ].join('\n'),
  },
  {
    id: 'release-notes',
    name: 'Release notes',
    description: 'Group by Features/Fixes/Internal; one user-visible line per change.',
    content: [
      '# Release notes format',
      '',
      '- Use github_releases with action=list or view to verify tags, release notes and assets. Check linked PRs and commits for changes in scope.',
      '- Group by: Features / Fixes / Internal',
      '- Each bullet: one user-visible change (what + why it matters)',
      '- Reference PR or commit ids in parentheses',
      '- Breaking changes first, clearly marked',
    ].join('\n'),
  },
];

const builtinById = new Map(BUILTIN_SKILLS.map(skill => [skill.id, skill]));

async function projectSkillPaths(): Promise<Map<string, string>> {
  try {
    const tree = await getFileTree();
    return new Map(tree.entries
      .filter(path => path.startsWith(SKILLS_DIR) && path.endsWith('.md'))
      .map(path => [path.slice(SKILLS_DIR.length, -3), path]));
  } catch {
    return new Map();
  }
}

async function readProjectSkill(path: string): Promise<string | undefined> {
  try {
    const file = await readWorktreeFile(path);
    return file.binary || file.tooLarge ? undefined : file.content;
  } catch {
    return undefined;
  }
}

/** Resolve a turn's explicit tags and assigned skills once, with project overrides. */
export async function buildSkillContext(text: string, assigned: string[]): Promise<string> {
  const paths = await projectSkillPaths();
  const tokens = new Set([...text.matchAll(/(?:^|\s)#([\w-]+)/g)].map(match => match[1].toLowerCase()));
  const idsByToken = new Map([...builtinById.keys(), ...paths.keys()].map(id => [id.toLowerCase(), id]));
  const projectReads = new Map<string, Promise<string | undefined>>();
  const read = (id: string, path: string) => {
    const existing = projectReads.get(id) ?? readProjectSkill(path);
    projectReads.set(id, existing);
    return existing;
  };

  // The picker inserts IDs. A typed single-token name also works.
  for (const skill of BUILTIN_SKILLS) {
    const token = skill.name.toLowerCase();
    if (!paths.has(skill.id) && tokens.has(token) && !idsByToken.has(token)) idsByToken.set(token, skill.id);
  }
  if ([...tokens].some(token => !idsByToken.has(token))) {
    for (const [id, path] of paths) {
      const markdown = await read(id, path);
      if (markdown === undefined) continue;
      const name = parseSkillMeta(id, markdown).name.toLowerCase();
      if (tokens.has(name) && !idsByToken.has(name)) idsByToken.set(name, id);
    }
  }

  const tagged = new Set([...tokens].flatMap(token => {
    const id = idsByToken.get(token);
    return id ? [id] : [];
  }));
  const selected = new Set([...tagged, ...assigned]);
  const sections: string[] = [];
  for (const id of selected) {
    const path = paths.get(id);
    const markdown = (path ? await read(id, path) : undefined) ?? builtinById.get(id)?.content;
    if (markdown?.trim()) {
      sections.push(`\n\n[Skill: ${id}]\n${markdown.trim().slice(0, tagged.has(id) ? 4000 : 2000)}`);
    }
  }

  const project: string[] = [];
  for (const [id, path] of [...paths].slice(0, 8)) {
    if (selected.has(id)) continue;
    const markdown = await read(id, path);
    if (markdown?.trim()) project.push(markdown.trim().slice(0, 1200));
  }
  if (project.length > 0) sections.push(`\n\n[Project skills]\n${project.join('\n\n').slice(0, 4000)}`);
  return sections.join('');
}

export async function listSkills(): Promise<SkillEntry[]> {
  const merged = new Map<string, SkillEntry>();
  // Base skills first — hard-coded, always present.
  for (const skill of BUILTIN_SKILLS) {
    merged.set(skill.id, {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      builtIn: true,
    });
  }
  // Extension skills from .pigry/skills/ override same-id built-ins
  // (user customisation wins).
  for (const [id, path] of await projectSkillPaths()) {
    const markdown = await readProjectSkill(path);
    if (markdown !== undefined) {
      merged.set(id, { ...parseSkillMeta(id, markdown), builtIn: false });
    } else if (!merged.has(id)) {
      merged.set(id, { id, name: id, description: '', builtIn: false });
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.builtIn === b.builtIn ? a.id.localeCompare(b.id) : a.builtIn ? -1 : 1,
  );
}


