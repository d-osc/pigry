import type { MenuGuide } from '../menuGuides.types.ts';

export type GithubGuideId =
  | 'pull-requests' | 'commit-graph' | 'branches' | 'releases' | 'actions' | 'security' | 'issues' | 'projects' | 'wiki' | 'insights';

/** Guides for the history, branch and GitHub menus. The GitHub ones need the GitHub CLI (gh) signed in to your account. */
export const GITHUB_GUIDES: Record<GithubGuideId, MenuGuide> = {
  "commit-graph": {
    summary: "See the whole history of the repository as a graph, inspect any commit, and act on it: cherry-pick, revert, create a branch or start a rebase.",
    overview: [
      "The commit graph draws every branch as a coloured lane and every commit as a dot, so you can see where branches split and join. Click a commit to open its details on the right: message, author, signature, changed files and a diff.",
      "It is the quickest way to answer 'what happened here and when?'. Search by message or SHA, filter by file path, and show or hide remote branches.",
    ],
    features: [
      { title: "Search and filter", text: "Search commits by message or SHA, filter by a path such as src/components or a file, and choose All branches or one branch." },
      { title: "Show remotes and columns", text: "Show remote branches in the graph and choose which columns (time, author, SHA…) to display." },
      { title: "Commit details", text: "Overview, changed files with a diff (Unified or Split, compared to the first parent), Previous file / Next file, and the GPG signature status." },
      { title: "Cherry-pick and Revert", text: "Buttons on a commit copy it onto the current branch or undo it with a new commit." },
      { title: "New branch", text: "Create a branch from the selected commit and optionally check it out." },
      { title: "Interactive rebase", text: "Start the rebase planner from a commit to reorder, squash or drop commits after it." },
    ],
    tutorial: [
      { title: "Find a commit", text: "Type part of the message or paste a SHA in the search box." },
      { title: "Open it", text: "Click the commit. The panel on the right shows who made it and which files changed." },
      { title: "Read the change", text: "Click a file to see its diff; use Previous file and Next file to move through them." },
      { title: "Act on it", text: "Press Cherry-pick to bring it to your branch, or Revert to undo it." },
      { title: "Branch from it", text: "Use New branch to start work from this point in history." },
    ],
    tips: [
      "Filter by path to see the history of a single folder or file.",
      "Ask '@bug-hunter which commit most likely introduced this bug?' with the symptom.",
      "Pushed and unpushed commits are marked, so you can see what the remote already has.",
    ],
    cautions: [
      "Cherry-pick, revert and rebase change your branch; make sure the right branch is checked out first.",
      "Rebasing rewrites history. Do not rebase commits that other people already use.",
      "On very large repositories the graph loads in pages; use search or a path filter to find old commits.",
    ],
    agents: { default: "commit-graph", base: "bug-hunter" },
    shots: [{ file: "commit-graph.jpg", caption: "Left: the commit graph with branch lanes and the search and filter bar. Right: the details of the selected commit with its files and diff." }],
  },

  branches: {
    summary: "List local and remote branches, check one out, create new ones, rename or delete them and look at their commits.",
    overview: [
      "Branches shows every local and remote branch with the one you are on marked HEAD. Select a branch to see its commits and the diff of any commit on the right.",
      "A branch is just a movable label on a commit, so creating one is instant and cheap. Use one branch per task.",
    ],
    features: [
      { title: "Search branches", text: "Filter the list by name." },
      { title: "Checkout", text: "Switch your working tree to the selected branch (commit or stash your changes first)." },
      { title: "New branch", text: "Create a branch From the selected one, and tick 'Checkout the new branch' to switch to it." },
      { title: "Rename and delete", text: "Rename a branch, or delete it when it is merged and no longer needed." },
      { title: "Branch commits", text: "Browse and search the commits of the selected branch and open their diffs." },
    ],
    tutorial: [
      { title: "Select the starting point", text: "Click main (or the branch you want to build on)." },
      { title: "Create the branch", text: "Press New branch, type feat/login-form, keep 'Checkout the new branch' ticked and press Create branch." },
      { title: "Work", text: "Make your commits in Working changes." },
      { title: "Clean up later", text: "When it is merged, come back and Delete the branch." },
    ],
    tips: [
      "Use a clear prefix such as feat/, fix/ or chore/ so the list stays readable.",
      "Ask '@upstream-checker' whether a branch is ahead of or behind its remote.",
    ],
    cautions: [
      "Checkout fails or carries changes over if you have uncommitted work; commit or stash first.",
      "Deleting a branch that is not merged can lose commits; Git warns you, read the warning.",
      "Renaming a branch that is already on the remote does not rename the remote branch.",
    ],
    agents: { default: "branches", base: "upstream-checker" },
    shots: [{ file: "branches.jpg", caption: "Left: local and remote branches with HEAD marked and New branch. Right: the commits of the selected branch." }],
  },

  "pull-requests": {
    summary: "Browse, review and create pull requests without leaving Pigry: overview, changed files, commits, checks and discussion.",
    overview: [
      "Pull requests talks to GitHub through the GitHub CLI (gh), so you must be signed in to gh with access to the repository. The list shows open and closed pull requests with their status, review state and number of comments.",
      "Open one to read its Overview (description, checks, discussion, reviewers, labels), the Files changed with diffs, its Commits and the Checks. You can review, approve, request changes, comment and check out the branch locally.",
    ],
    features: [
      { title: "List, search and filters", text: "Search by title, #number or branch; filter by author, review status and label; sort by recently or least recently updated; see Your review queue." },
      { title: "Overview and discussion", text: "Read the summary, check status, reviewers and labels, and write comments with Markdown preview." },
      { title: "Files changed", text: "Read per-file diffs in Split or Unified view. History shows the PR's commits one by one, Compare compares against a chosen commit and Blame annotates lines." },
      { title: "Review", text: "Review changes lets you Approve, Request changes or Comment and Submit review." },
      { title: "Check out branch", text: "Fetches the PR branch and switches to it so you can run the code." },
      { title: "New pull request", text: "Create one from your branch: title, base branch and description." },
      { title: "Copy link / Open on GitHub", text: "Share the PR or continue on github.com." },
    ],
    tutorial: [
      { title: "Check you are signed in", text: "If the list says unavailable, sign in with gh in a terminal first (gh auth login)." },
      { title: "Pick a PR", text: "Select one from Your review queue or search by number." },
      { title: "Read it", text: "Start with Overview, then Files changed. Ask '@pr-reviewer review this pull request'." },
      { title: "Run it", text: "Press Check out branch and run the tests in the terminal." },
      { title: "Review", text: "Choose Review changes › Approve or Request changes, add your comments and Submit review." },
    ],
    tips: [
      "Read the commits one by one with History when the combined diff is too big.",
      "Draft the description of your own PR with the agent, from the diff.",
      "Use filters such as 'Review requested' to keep your queue short.",
    ],
    cautions: [
      "Approve, Request changes and comments are posted to GitHub in your name and cannot be taken back quietly.",
      "Checking out a PR branch changes your working tree; commit or stash first.",
      "Do not run code from a pull request by someone you do not trust.",
      "The list can be out of date; press Refresh before acting.",
    ],
    agents: { default: "pull-requests", base: "pr-reviewer" },
    shots: [{ file: "pull-requests.jpg", caption: "Left: the pull request list with search and filters. Right: the selected pull request with Overview, Files changed, Commits and Checks tabs." }],
  },

  releases: {
    summary: "Create, edit and review GitHub releases, their tags and release notes.",
    overview: [
      "Releases lists the releases of the repository with badges for Latest, Draft and Prerelease, plus the tags. Open one to read its notes and see its downloadable assets.",
      "To publish a new version, create a release with a tag name (for example v1.4.0), the target branch, a title and notes. You can save it as a draft first and publish later from GitHub. The release notes agent can write the notes from your commit history.",
    ],
    features: [
      { title: "Release list", text: "Search by version or title; see Latest, Draft and Prerelease at a glance." },
      { title: "New release", text: "Enter the tag name, target branch, title and notes, then Create release or Save as draft." },
      { title: "Edit release", text: "Change the title and notes of an existing release and Save changes." },
      { title: "Assets", text: "See the files attached to a release (installers, archives)." },
      { title: "Tags", text: "Browse tags, copy a tag name or open it on GitHub." },
    ],
    tutorial: [
      { title: "Decide the version", text: "Follow your versioning scheme, for example the next patch number." },
      { title: "Draft the notes", text: "Ask '@release-notes-writer write notes for the commits since the last release'." },
      { title: "Create the release", text: "Press New release, fill tag, target branch, title and paste the notes." },
      { title: "Save as draft", text: "Choose Save as draft first and review it." },
      { title: "Publish", text: "Publish from GitHub when the build and the assets are ready." },
    ],
    tips: [
      "Group the notes by Added, Changed and Fixed so readers find what matters.",
      "A draft release is not public and is not marked Latest until it is published.",
    ],
    cautions: [
      "Creating a release with a new tag creates that tag on the remote; double-check the name and target branch.",
      "Published releases are public. Check that the notes contain no secrets or internal links.",
      "A tag is hard to move once people use it; avoid deleting and re-creating public tags.",
    ],
    agents: { default: "releases", base: "release-notes-writer" },
    shots: [{ file: "releases.jpg", caption: "Left: the release list with Latest, Draft and Prerelease badges. Right: the notes and assets of the selected release." }],
  },

  actions: {
    summary: "Watch GitHub Actions runs, read their logs, and re-run or cancel them.",
    overview: [
      "Actions lists the workflow runs of the repository with status, branch, commit, who started them and how long they took. Open a run to see its jobs, the combined log and any artifacts.",
      "When a run fails, the log is the fastest way to see why. Ask the CI log reviewer to read it and explain the failure.",
    ],
    features: [
      { title: "Run list and filters", text: "Search runs, commits or actors and filter by workflow, branch and status." },
      { title: "Run details", text: "See each job and the combined log of the run." },
      { title: "Cancel / Re-run", text: "Cancel a run, Re-run failed jobs or Re-run all jobs." },
      { title: "Run workflow", text: "Start a workflow manually when it supports manual dispatch." },
      { title: "Artifacts and workflow file", text: "List the artifacts a run uploaded and view the workflow definition." },
    ],
    tutorial: [
      { title: "Open Actions", text: "The newest runs are at the top." },
      { title: "Pick a failed run", text: "Filter by branch or search the commit message." },
      { title: "Read the log", text: "Open the failed job. Ask '@ci-log-reviewer why did this fail?'." },
      { title: "Fix and push", text: "Fix the cause in your code and push; a new run starts." },
      { title: "Re-run", text: "For a flaky failure use Re-run failed jobs." },
    ],
    tips: [
      "Look at the first error in the log, not the last; later lines are usually consequences.",
      "Compare a failing run with the last green one to see what changed.",
    ],
    cautions: [
      "Re-running and manual workflows can deploy or send things for real; check what the workflow does.",
      "Logs can contain secrets that were printed by mistake; do not paste logs into public places.",
      "Cancelling a deployment job midway can leave it in a half-finished state.",
    ],
    agents: { default: "actions", base: "ci-log-reviewer" },
    shots: [{ file: "actions.jpg", caption: "Left: workflow runs with search and filters. Right: the jobs, log and artifacts of the selected run." }],
  },

  security: {
    summary: "Review security and quality findings from GitHub: code scanning alerts, vulnerable dependencies and exposed secrets.",
    overview: [
      "Security and quality shows alerts for the repository grouped by severity (Critical, High, Medium, Low). Open a finding to read why it matters, where it is, and, for dependencies, the vulnerable version range and the patched version.",
      "This menu needs the desktop app and GitHub access. If a kind of scanning is not enabled for the repository, the menu says so and offers Configure checks.",
    ],
    features: [
      { title: "Findings by severity", text: "Filter and search findings, rules or paths." },
      { title: "Details", text: "Why this matters, the affected file or manifest, the ecosystem and the fix." },
      { title: "Dependencies", text: "Vulnerable range and Patched version help you choose the upgrade." },
      { title: "Secrets", text: "Exposed secrets that GitHub found are listed so you can rotate them." },
      { title: "Dismiss", text: "Dismiss an alert as a false positive on GitHub when you have verified it." },
    ],
    tutorial: [
      { title: "Start with Critical", text: "Sort or filter so Critical and High come first." },
      { title: "Read the finding", text: "Open it and read 'Why this matters' and the location." },
      { title: "Ask the auditor", text: "'@security-auditor is this reachable in our code?'" },
      { title: "Fix", text: "Upgrade the dependency to the patched version or change the code." },
      { title: "Verify", text: "Push and check that the alert closes on the next scan." },
    ],
    tips: [
      "For an exposed secret, rotate it first; removing it from the code does not remove it from history.",
      "Ask the security auditor to save a Markdown report; it appears in the Reports menu.",
    ],
    cautions: [
      "Dismissing an alert hides it for everyone; only dismiss when you are sure it is a false positive.",
      "The results are only as good as the scanners enabled for the repository: 'All clear' does not mean 'secure'.",
      "Do not paste vulnerability details into public issues before they are fixed.",
    ],
    agents: { default: "security-and-quality", base: "security-auditor" },
    shots: [{ file: "security.jpg", caption: "Findings grouped by severity with search, and the details of the selected finding." }],
  },

  issues: {
    summary: "Browse, search, create and manage GitHub issues, with labels, assignees and milestones.",
    overview: [
      "Issues lists the issues of the repository, open or closed, with search by title, #number or label and filters for label, assignee and milestone. Open an issue to read its description and the discussion, and to comment.",
      "You can create new issues with a title and a Markdown description (with preview), and close or reopen existing ones.",
    ],
    features: [
      { title: "Search and filter", text: "Any label, any assignee, any milestone, and the Open or Closed state; sort order toggles." },
      { title: "Issue details", text: "Description, activity and comments, assignees, labels and milestone." },
      { title: "Comment", text: "Write in Markdown and check it in Preview before you post." },
      { title: "New issue", text: "Title and optional description; Create issue." },
      { title: "Close / Reopen", text: "Change the state of an issue." },
      { title: "Copy link / Open on GitHub", text: "Share it or continue on github.com." },
    ],
    tutorial: [
      { title: "Search first", text: "Type keywords to see whether the issue already exists." },
      { title: "Create", text: "Press New issue, write a clear title and the steps to reproduce." },
      { title: "Get help", text: "Ask '@issue-triage-helper suggest labels and a priority'." },
      { title: "Follow up", text: "Comment as work progresses and close the issue when fixed." },
    ],
    tips: [
      "Put the expected and actual behaviour and how to reproduce it in every bug report.",
      "Link issues from commits and pull requests with 'Fixes #123' so they close automatically.",
    ],
    cautions: [
      "Issues in a public repository are public; never include passwords, tokens or personal data.",
      "Comments and state changes are posted to GitHub under your name.",
      "Closing an issue that others are working on can confuse them; say why in a comment.",
    ],
    agents: { default: "issues", base: "issue-triage-helper" },
    shots: [{ file: "issues.jpg", caption: "Left: the issue list with search, filters and Open / Closed. Right: the issue description, activity and the labels, assignees and milestone." }],
  },

  projects: {
    summary: "Follow GitHub Projects as a board, a table or a roadmap, and see what is planned and who is on it.",
    overview: [
      "Projects shows the GitHub Projects (the project boards) of your account or organisation. Choose a project and a view: Board (columns by status), Table (rows with fields) or Roadmap (a timeline of iterations).",
      "Pigry is for reading and planning here: you add items on GitHub itself, then reload to see them. The board planner agent groups related issues and pull requests, spots blockers and suggests next actions.",
    ],
    features: [
      { title: "Board, Table, Roadmap", text: "Switch between status columns, a detailed table and a timeline." },
      { title: "Search and filter", text: "Search items and filter by status, assignee or iteration." },
      { title: "Iterations", text: "The roadmap shows scheduled iterations; zoom, move by week and fit the timeline." },
      { title: "Reload / Open on GitHub", text: "Refresh the data, or open the project on GitHub to add items." },
    ],
    tutorial: [
      { title: "Choose the project", text: "Pick it from the project views list." },
      { title: "Read the board", text: "Look at which items are In progress and which are Done." },
      { title: "Check the plan", text: "Open Roadmap to see iterations and what is scheduled." },
      { title: "Ask the planner", text: "'@board-planner what is blocked, and what should we do next?'." },
    ],
    tips: [
      "Use the Table view for sorting and for finding items with no assignee.",
      "Keep the status field up to date on GitHub so the board stays trustworthy.",
    ],
    cautions: [
      "You need access to the projects; a repository without any project shows an empty state.",
      "Changes made on GitHub appear only after you reload.",
      "Do not rely on the roadmap dates when iterations are not maintained.",
    ],
    agents: { default: "projects", base: "board-planner" },
    shots: [{ file: "projects.jpg", caption: "The project views (Board, Table, Roadmap) with items grouped by status and the search bar." }],
  },

  wiki: {
    summary: "Read and write the repository's wiki pages in Markdown, with page history and an outline.",
    overview: [
      "The GitHub wiki of a repository is a separate Git repository of Markdown pages. Pigry clones it for you, lists the pages, renders them and lets you create and edit pages. Each page shows who maintains it and its history.",
      "If the repository has no wiki yet, the menu offers to create the first page.",
    ],
    features: [
      { title: "Page list and search", text: "Find a page by name; the list is on the left." },
      { title: "Rendered Markdown", text: "Headings, lists, tables, code and links are rendered, with an outline in 'On this page'." },
      { title: "New page / Edit page", text: "Write Markdown with a title; pages are named like My-Page.md." },
      { title: "Page history", text: "See which commits changed the page and who made them." },
      { title: "Open on GitHub", text: "Jump to the wiki on github.com." },
    ],
    tutorial: [
      { title: "Open Wiki", text: "The first page opens, or you are asked to create one." },
      { title: "Create a page", text: "Press New page, type a title such as Architecture and write the content." },
      { title: "Save", text: "Save the page; it is committed to the wiki repository." },
      { title: "Improve it", text: "Ask '@docs-writer improve this page and add an overview section'." },
    ],
    tips: [
      "Start each page with a short summary and a table of contents-friendly set of headings.",
      "Link pages to each other with [text](Other-Page).",
    ],
    cautions: [
      "The wiki is public if the repository is public; do not put secrets in it.",
      "Edits are committed to the wiki repository; a conflicting change made on GitHub at the same time may need a manual merge.",
      "Wikis must be enabled in the repository settings on GitHub.",
    ],
    agents: { default: "wiki", base: "docs-writer" },
    shots: [{ file: "wiki.jpg", caption: "Left: the page list with search. Centre: the rendered page with Page history and Edit page. Right: 'On this page' outline." }],
  },

  insights: {
    summary: "See how the repository is doing: commit activity, code changes, contributors, pull requests and issues over a period.",
    overview: [
      "Insights turns the repository's history and GitHub data into charts and tables for the selected period. It shows commit activity per day, how many lines were added and deleted, who contributed, and how many pull requests and issues were opened and resolved.",
      "A 'What to focus on' section points out gaps in the data and things worth a look. Where GitHub data is not available, the menu says so instead of guessing.",
    ],
    features: [
      { title: "Commit activity", text: "Commits per day for the period, and the list of recent commits." },
      { title: "Code changes", text: "Lines added and deleted, period totals and code frequency." },
      { title: "Contributors", text: "Commits per person and their share of the total." },
      { title: "Pull requests and issues", text: "Opened and resolved counts (needs GitHub access)." },
      { title: "Traffic", text: "Views and clones when GitHub provides them for the repository." },
    ],
    tutorial: [
      { title: "Choose the period", text: "Pick the time range, for example the last 90 days." },
      { title: "Read the activity", text: "Look for quiet weeks and bursts of commits." },
      { title: "Check contributors", text: "See who works on the project and how the work is shared." },
      { title: "Ask the analyst", text: "'@activity-analyst summarise this period in five bullet points'." },
    ],
    tips: [
      "Compare two periods to see whether the pace is changing.",
      "Use the numbers as conversation starters, not as a performance score for people.",
    ],
    cautions: [
      "Commit counts say little about the value of the work; large generated commits distort the totals.",
      "Delivery and traffic data depend on GitHub access and permissions and may show as unavailable.",
      "Merge commits and bots count as activity unless filtered by the data source.",
    ],
    agents: { default: "insights", base: "activity-analyst" },
    shots: [{ file: "insights.jpg", caption: "Commit activity, code changes, contributors and the pull request and issue tiles for the selected period." }],
  },
};
