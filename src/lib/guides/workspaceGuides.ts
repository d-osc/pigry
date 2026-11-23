import type { MenuGuide } from '../menuGuides.types.ts';

/** Guides for the menus where files, designs and tests are made: Explorer, Diagram, Design, Board, E2E Testing, Reports, Copilot. */
export const WORKSPACE_GUIDES: Record<'explorer' | 'diagram' | 'design' | 'board' | 'e2e' | 'reports' | 'ai-agent', MenuGuide> = {
  explorer: {
    summary: "Browse the repository's files, edit code, run commands in the terminal and chat with an AI agent that can read and change the same files.",
    overview: [
      "Explorer is the home of the workspace. On the left is the file tree of the repository (tracked and untracked files; ignored files are hidden). The middle is a code editor with tabs, and the AI Agent panel on the right works on the same files you have open.",
      "Files that have uncommitted changes carry a small status chip in the tree (M modified, A added, U untracked, D deleted), so you always see what you have touched before you commit it in Working changes.",
      "The integrated terminal opens at the bottom of the window. It starts in the repository folder, so git, npm, cargo and every other tool run exactly where the code is.",
    ],
    features: [
      { title: "File tree and search", text: "Open folders, search files by name, and press Ctrl/Cmd+P anywhere to jump to a file. The tree refreshes when files change on disk." },
      { title: "Editor with tabs", text: "Each file opens in its own tab with syntax highlighting. Save with Ctrl/Cmd+S. Unsaved files are marked, and Pigry asks before you close or disconnect with unsaved edits." },
      { title: "Integrated terminal", text: "Toggle it with Ctrl/Cmd+` and open another shell with Ctrl/Cmd+Shift+`. Copy and paste work with Ctrl+C/V when text is selected, and Ctrl+F searches the output." },
      { title: "AI Agent panel", text: "Ask questions about the code, request a change, or have an agent run a command. Mention an agent with @, attach a skill with #, and use several agents at once by tagging more than one." },
      { title: "Agent management", text: "From the panel you can add your own agents, choose tools and skills for each one, connect MCP servers, add hooks, and see how much of the model's context is used." },
      { title: "Jump from other menus", text: "Reports, E2E Testing, Board and others can open a file here (Open in Explorer), so a path you read in a report is one click from the code." },
    ],
    tutorial: [
      { title: "Open a file", text: "Click a file in the tree, or press Ctrl/Cmd+P and type part of its name. It opens in a tab." },
      { title: "Edit and save", text: "Change the code, then press Ctrl/Cmd+S. The file's chip in the tree turns to M (modified)." },
      { title: "Run it in the terminal", text: "Press Ctrl/Cmd+` and run your tests or build, for example npm test. The output stays in the terminal tab." },
      { title: "Ask an agent for help", text: "In the AI Agent panel type: 'explain what this function does' or '@refactorer split this file into two modules'. Watch the live work log to see which files it reads and writes." },
      { title: "Review what changed", text: "Open Working changes to see the diff of every edited file, stage what you want and write the commit." },
    ],
    tips: [
      "Select code in the editor before asking an agent about it; the selection is sent with your question so you do not have to paste it.",
      "Ask an agent to explain the failing output of the terminal instead of reading it yourself: copy the error into the panel.",
      "Tag two agents in one message (for example a coder and a QA agent) to have them work in parallel. If both want the same file, the second one waits for the first one's write and re-reads the file before changing it.",
      "Use the Command palette (Ctrl/Cmd+K) to jump between menus and files quickly.",
    ],
    cautions: [
      "Agents write real files in your working tree. Check Working changes before committing and use git to undo anything you do not want.",
      "Closing a tab with unsaved edits, or disconnecting an SSH workspace, can lose those edits; save first.",
      "A command an agent runs in the terminal has the same power as one you type. Read what it is about to run, especially anything that deletes, resets or pushes.",
      "Large or binary files are not shown in the editor; open them with a dedicated tool instead.",
    ],
    agents: { default: "explorer", base: "refactorer" },
    shots: [{ file: "explorer.jpg", caption: "Left: file tree with change chips. Middle: editor tabs and the open file. Right: the AI Agent panel. Bottom: status bar with the terminal toggle." }],
  },

  diagram: {
    summary: "Draw flowcharts, ER diagrams, use cases and architecture diagrams, and let agents draw them from a description or from your code.",
    overview: [
      "Diagram is a visual editor. Every diagram is saved as a plain file in the repository, .pigry/diagrams/<owner>/<name>.diagram.json, where the owner is you or the agent that drew it. That means diagrams are versioned with git like the rest of your code.",
      "You can build a diagram by hand with shapes and connectors, pick a template, or ask the Diagram agent to draw one from a text description or from the structure of the code. Anything an agent draws appears live in the editor.",
    ],
    features: [
      { title: "Diagram list and templates", text: "Create a new diagram from a template (flowchart, ER, use case, architecture…), rename it or delete it. Diagrams of different owners are kept apart." },
      { title: "Shapes and connectors", text: "Add shapes from the Shapes palette, drag from one shape to another with the Connect tool, and edit labels, fill colour, arrow style, dashed lines and cardinality (for ER diagrams)." },
      { title: "Properties panel", text: "Select a node or an edge to edit its label, shape, boundary (group box), entity fields and colour." },
      { title: "Auto layout", text: "Arrange the diagram automatically, choosing the direction (top to bottom, left to right…) from the diagram settings." },
      { title: "Undo, redo, zoom", text: "Ctrl+Z and Ctrl+Y step through your edits. Zoom in, out or fit the whole diagram on screen." },
      { title: "Export", text: "Save as SVG into the workspace, copy SVG or a PNG image to the clipboard, or copy a Mermaid version for documentation." },
    ],
    tutorial: [
      { title: "Create a diagram", text: "Click New diagram, type a name and pick a template, then Create diagram." },
      { title: "Add shapes", text: "Pick shapes from the palette and click on the canvas. Double-click a shape to edit its label." },
      { title: "Connect them", text: "Choose the Connect tool and drag from one shape to another. Select the line to add a label or change the arrow." },
      { title: "Tidy up", text: "Press Auto layout, then fix anything by dragging. Use Fit to screen to see the whole picture." },
      { title: "Let the agent help", text: "In the AI Agent panel type: 'draw an ER diagram of the tables used in src/db'. The agent writes the diagram and it opens on the canvas." },
      { title: "Export", text: "Use Export › Save SVG to workspace to keep an image next to your docs, or Copy Mermaid to paste into a README." },
    ],
    tips: [
      "Ask the agent for a first draft and then adjust by hand; it is faster than starting from an empty canvas.",
      "Use boundaries to group shapes (for example one box per service) so large diagrams stay readable.",
      "Press ? in the editor to see every keyboard shortcut.",
    ],
    cautions: [
      "Deleting a diagram removes its file; if it was committed you can get it back from git, if not it is gone.",
      "If you and an agent edit the same diagram at once, the editor flushes your unsaved edits first; save before asking the agent to change something you are in the middle of editing.",
      "Auto layout moves shapes. Undo (Ctrl+Z) brings the old positions back.",
    ],
    agents: { default: "diagram", base: "diagram-sa" },
    shots: [{ file: "diagram.jpg", caption: "Left: the list of diagrams. Centre: the canvas with shapes and connectors and the tool bar. Right: the AI Agent panel." }],
  },

  design: {
    summary: "Design screens and components with frames, auto layout and colour tokens, then preview, review and export them for developers.",
    overview: [
      "Design is a lightweight design editor. A design is a file in the repository (.pigry/designs/<owner>/<name>.design.json) made of frames, shapes, text and images. Because it is a file, designs are reviewed and versioned like code.",
      "The UX/UI Designer agent can create and edit designs with the same tools you use: it adds frames, sets colour tokens, runs a design check, renders a preview and exports HTML/CSS for hand-off.",
    ],
    features: [
      { title: "Layers", text: "The layers panel lists every node of the design. Rename, reorder (bring forward, send backward), group into a frame, or delete." },
      { title: "Frames and auto layout", text: "Frames hold content. Turn on auto layout to stack children vertically or horizontally with a gap, hug or fill sizing, justify and align settings." },
      { title: "Appearance", text: "Set fill (solid or gradient), stroke, corner radius, opacity and shadows for the selected node." },
      { title: "Text and images", text: "Edit the text content, font family, size, weight, line height and alignment; place images from the workspace." },
      { title: "Colour tokens", text: "Define named colours such as primary once and use the token name as a fill, so a palette change is one edit." },
      { title: "Check, preview and export", text: "Run a design check for common problems, render a preview image, and export PNG or HTML/CSS to hand off to developers." },
    ],
    tutorial: [
      { title: "Create a design", text: "Create a new design and name it, for example login-screen." },
      { title: "Add a frame", text: "Add a frame and choose a size preset (phone, tablet, desktop) or enter a custom size." },
      { title: "Fill it", text: "Add text, buttons and images inside the frame. Turn on auto layout on the frame so the items line up with an even gap." },
      { title: "Set your colours", text: "Open Colour tokens, add primary and surface, then use those names as fills." },
      { title: "Ask the agent to review", text: "In the AI Agent panel type: 'check this design for contrast and spacing problems'. The agent runs the design check and reports." },
      { title: "Export", text: "Export HTML/CSS or a PNG preview for the developers, and link it from a report." },
    ],
    tips: [
      "Use auto layout for anything that holds a list; resizing then keeps spacing consistent.",
      "Name your layers (Header, Primary button…); agents and teammates refer to nodes by name.",
      "Shortcuts: Ctrl+D duplicates, Ctrl+G wraps in a frame, ] and [ move a layer forward or back.",
    ],
    cautions: [
      "This is not a full vector tool; complex illustrations are better made elsewhere and placed as images.",
      "Deleting a design deletes its file; commit before large experiments so you can go back.",
      "A colour token used as a fill is looked up by name; renaming or deleting a token changes every node that uses it.",
    ],
    agents: { default: "design", base: "uxui" },
    shots: [{ file: "design.jpg", caption: "Left: layers. Centre: the canvas with a frame. Right: the properties panel for position, auto layout, fill, stroke and text." }],
  },

  board: {
    summary: "Run workshops on a digital whiteboard: sections, sticky notes, votes, connectors, and live embeds of diagrams, designs and code.",
    overview: [
      "Board is a whiteboard for thinking together: brainstorms, retros, journey maps, prioritisation matrices. Each board is a file in the repository (.pigry/boards/<owner>/<name>.board.json), so the result of a workshop lives next to the code.",
      "The Board facilitator agent can set up a template, add sections and sticky notes, cluster ideas, vote, and write a summary. Notes can also embed a diagram, a design, a range of code lines, a branch comparison or a commit, and those embeds stay in sync with the source.",
    ],
    features: [
      { title: "Templates and sections", text: "Start from a template (for example retro or journey map) or an empty board. Sections group notes; drag a section to move everything in it." },
      { title: "Sticky notes and votes", text: "Add notes, give them a colour, and vote on them. The vote count helps you see what the group cares about." },
      { title: "Connectors, shapes, text", text: "Draw arrows and lines (dashed, arrow at one or both ends), add shapes, free text and stamps." },
      { title: "Embeds", text: "Add a live diagram or design, a piece of code (file lines), a compare between branches or a commit. Open the source from the embed." },
      { title: "Search and arrange", text: "Search notes by text, arrange notes in a grid, bring forward or send backward, and duplicate with Ctrl+D." },
      { title: "Chat chips", text: "Select items on the board and the selection is sent with your message to the agent, so you can ask 'summarise these'." },
    ],
    tutorial: [
      { title: "Create a board", text: "Create a new board from a template such as a retrospective." },
      { title: "Add notes", text: "Click a section and add sticky notes. Type short sentences; one idea per note." },
      { title: "Move and group", text: "Drag notes between sections, or select several and press Ctrl+G to put them in a new section." },
      { title: "Vote", text: "Give votes to the notes that matter most." },
      { title: "Summarise with the agent", text: "In the AI Agent panel select the voted notes and type: 'summarise these and list three actions'." },
      { title: "Share", text: "Export the board or commit the file; teammates see the same board." },
    ],
    tips: [
      "Embed the diagram or the code under discussion on the board so the conversation has the facts in view.",
      "Keep one board per workshop; boards with hundreds of notes become slow to read.",
      "Ask the facilitator agent to cluster similar ideas first, then tidy the result by hand.",
    ],
    cautions: [
      "A board is a shared file: if two people (or an agent and you) edit the same board in different copies of the repo, you can get a merge conflict in the JSON.",
      "Deleting a section deletes the notes inside it; undo (Ctrl+Z) immediately if you removed it by mistake.",
      "Embeds show the current state of the source. If the diagram or file is deleted, the embed shows that it is missing.",
    ],
    agents: { default: "board", base: "board-sa" },
    shots: [{ file: "board.jpg", caption: "The whiteboard: sections with sticky notes and votes, connectors between sections, and the AI Agent panel on the right." }],
  },

  e2e: {
    summary: "Write, run and debug Cypress-style end-to-end tests from inside Pigry, with a live command log, time travel, screenshots and reports.",
    overview: [
      "E2E Testing keeps your end-to-end specs in the repository (.pigry/e2e/specs/<owner>/<name>.cy.js or .ts) and runs them in an external test browser. While a spec runs you see every command as it happens, and after it ends you can step back through the DOM snapshots (time travel).",
      "The E2E QA agent writes and runs specs with the same tools: it can create a spec, run it, read the results and statistics, add fixtures and selectors, and save a Markdown report with screenshots into the Reports menu.",
    ],
    features: [
      { title: "Specs, Runs and Settings", text: "The side list has three tabs: Specs (your test files), Runs (history of results, flaky and slow tests) and Settings (base URL, timeouts, evidence options)." },
      { title: "Spec editor", text: "Edit JavaScript or TypeScript specs with Cypress commands. Type errors in .ts specs are shown as warnings." },
      { title: "Run spec, Run all, Watch", text: "Run the open spec, every spec, or the it() under the cursor. Watch mode re-runs when the file changes, whoever saved it." },
      { title: "Live runner", text: "See suites, tests and every command as they run. Pause and run one command at a time to step through." },
      { title: "Time travel and evidence", text: "Hover a command to see the page as it was. Failed tests keep a screenshot, a code frame, the browser console and optional network JSON; you can also record a video." },
      { title: "Reports and CI", text: "Save a Markdown report with linked screenshots, and export JUnit XML for your CI system." },
      { title: "Selector playground and Studio", text: "Pick elements on the page to get reliable selectors, and record clicks into a spec with the Studio recorder." },
    ],
    tutorial: [
      { title: "Set the base URL", text: "Open Settings and enter the address of the app under test, for example http://localhost:5173." },
      { title: "Create a spec", text: "Click New spec, give it a name, choose a template and JavaScript or TypeScript, then Create spec." },
      { title: "Write a test", text: "Use cy.visit('/'), cy.get(...).click() and cy.contains(...).should('be.visible'). Add cy.screenshot('login') to document a passing case." },
      { title: "Run it", text: "Press Run spec. Watch the command log; green means passed, red means failed." },
      { title: "Investigate a failure", text: "Click the failed command to see the page snapshot, the error and the code frame. Ask the agent: 'why did this fail and how do I fix the selector?'" },
      { title: "Report", text: "Ask the agent to run all specs with report: true; the report appears in the Reports menu with screenshots." },
    ],
    tips: [
      "Use data-testid attributes for selectors so tests survive layout changes.",
      "Turn on Watch while you write a spec: it re-runs on every save.",
      "Look at the Runs tab for tests that fail most often or are flaky (passed only after a retry); fix those first.",
    ],
    cautions: [
      "Specs drive a real browser against a real app. Do not point them at a production system with real accounts or payments.",
      "Videos and screenshots are saved under .pigry/e2e/evidence/; they can be large, so do not commit them blindly.",
      "Only one run happens at a time. Stop the current run before starting another.",
      "Tests that depend on each other or on leftover data become flaky; make each test set up its own state.",
    ],
    agents: { default: "e2e", base: "e2e-qa" },
    shots: [{ file: "e2e.jpg", caption: "Left: Specs, Runs and Settings tabs with the spec list. Centre: the spec editor or the live runner with the command log. Top: Run all and New spec." }],
  },

  reports: {
    summary: "Read the reports your agents saved: security reviews, test cases, bug reports and hand-off documents, grouped by agent.",
    overview: [
      "Agents save their written results as Markdown files under .pigry/reports/<agent>/ in the repository. The Reports menu finds them all in one place, groups them by the agent that wrote them, and shows each one rendered, with an outline of its headings.",
      "Because reports are ordinary files, they can be reviewed in a pull request, kept in git history, and linked to from other menus. The list refreshes when you open the menu, when the window regains focus, and when you press Refresh.",
    ],
    features: [
      { title: "Grouped by agent", text: "Reports are listed under @qa, @white-hat, @uxui and so on, so you can find who wrote what." },
      { title: "Rendered Markdown", text: "Headings, lists, tables, code blocks and links are rendered. File names such as src/app.ts in a report are clickable." },
      { title: "On this page", text: "The outline on the right jumps to a heading in long reports." },
      { title: "Search", text: "Type in Find a report to filter by agent, file name or path." },
      { title: "Open in Explorer", text: "Jump to the file itself to edit it or to see it in git." },
    ],
    tutorial: [
      { title: "Ask for a report", text: "In any menu tell an agent: 'review this repository for security problems and save a report'. It writes to .pigry/reports/<its name>/." },
      { title: "Open Reports", text: "The new report appears under the agent's name. Press Refresh if you have just asked." },
      { title: "Read it", text: "Click the report. Use the outline on the right to jump to the findings." },
      { title: "Check the claims", text: "Mention @report-reviewer: 'verify the findings in this report against the code'." },
      { title: "Share it", text: "Open it in Explorer and commit it, or paste a link to the file in a pull request." },
    ],
    tips: [
      "Ask agents to save to .pigry/reports/<their name>/ with a descriptive file name, for example login-test-cases.md.",
      "Use the report reviewer to find which findings are confirmed and which still need action.",
      "Reports can embed screenshots saved under .pigry/reports/<agent>/evidence/.",
    ],
    cautions: [
      "Reports are written by AI and can be wrong or out of date; verify a finding before acting on it.",
      "A report may contain sensitive details such as paths, versions or vulnerabilities. Think before committing it to a public repository.",
      "Only .md, .markdown and .txt files are listed; images and other attachments are not shown in the list.",
    ],
    agents: { default: "reports", base: "report-reviewer" },
    shots: [{ file: "reports.jpg", caption: "Left: reports grouped by agent with a search box. Centre: the selected report rendered as Markdown. Right: the outline of its headings." }],
  },

  "ai-agent": {
    summary: "The Copilot chat: a team of agents you can talk to, with sessions, @mentions, skills and tools, on any task in the repository.",
    overview: [
      "Copilot is the full-screen version of the AI Agent panel that every other menu shows on the right. It talks to the Copilot agent by default, and you can @mention any other agent, built-in or your own, to get a specialist.",
      "Agents work with real tools: they read and write files, search code, read git history and diffs, run commands, query GitHub, and use the editors for diagrams, designs, boards and tests. Every tool call is shown in a live work log, and some risky actions ask for approval first.",
    ],
    features: [
      { title: "Sessions", text: "Each conversation is a session. Start a New session for a new topic; old sessions stay in the list so you can come back." },
      { title: "@mention agents", text: "Type @ to pick an agent. Tag more than one agent in one message and they work at the same time; you get one answer from each." },
      { title: "# skills", text: "Type # to attach a skill, a saved set of instructions such as the cherry-pick or code-review workflow, to the message." },
      { title: "Tools and approvals", text: "The work log shows each file read, search and command. Actions that need your permission show 'Approval required'." },
      { title: "Your own agents", text: "Add agents with their own job title, tools, skills, model and effort, and connect MCP servers or hooks." },
      { title: "Memory and context", text: "Agents can remember notes between sessions, and the context meter shows how full the model's context is." },
    ],
    tutorial: [
      { title: "Start a session", text: "Click New session." },
      { title: "Ask something concrete", text: "For example: 'find where we parse the config file and explain how errors are handled'." },
      { title: "Watch the work log", text: "You see which files the agent opened. Click an entry for its details." },
      { title: "Bring in a specialist", text: "Type @ and pick, for example, the code reviewer: '@code-reviewer review my staged changes'." },
      { title: "Run two agents in parallel", text: "'@coder add the endpoint and @qa write test cases for it'. If both need the same file, the second waits for the first to finish writing and re-reads it first." },
    ],
    tips: [
      "Be specific about the files, the goal and what 'done' means; the agent works much better with a concrete task.",
      "Use separate sessions for separate topics, so the context stays small and focused.",
      "Ask the agent to explain before it changes: 'what would you change? do not edit yet'.",
    ],
    cautions: [
      "Agents can change files and run commands in your working tree. Always read approval prompts, and review the result in Working changes.",
      "Never paste secrets (passwords, tokens) into the chat; they may be sent to the model provider.",
      "Answers can be wrong. Check important facts against the code or the documentation.",
      "A provider must be configured in Settings (an API key or a CLI such as Claude Code) before the agents can answer.",
    ],
    agents: { default: "copilot", base: "workspace-guide" },
    shots: [{ file: "ai-agent.jpg", caption: "Left: sessions. Centre: the conversation with the live work log. Bottom: the composer where you type @ to mention an agent or # to attach a skill." }],
  },
};
