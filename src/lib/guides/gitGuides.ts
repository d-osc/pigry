import type { MenuGuide } from '../menuGuides.types.ts';

export type GitGuideId =
  | 'working-changes' | 'push-commits' | 'pull-commits' | 'merge-branch' | 'merge-conflicts' | 'compare-branch' | 'stashes'
  | 'cherry-pick' | 'revert-commit' | 'duplicate-commit' | 'edit-commit' | 'rebase-branch';

/** Guides for the menus that work with local git: changes, syncing, merging and rewriting history. */
export const GIT_GUIDES: Record<GitGuideId, MenuGuide> = {
  "working-changes": {
    summary: "Review everything you have changed, stage the parts you want and create the commit.",
    overview: [
      "Working changes compares your working tree with HEAD. Files you have edited appear under Unstaged changes; once you stage them they move to Staged changes. A commit contains exactly the staged changes, so staging is how you decide what goes into the next commit.",
      "You can stage a whole file, or only some hunks of it, which is the way to split one messy edit into several clean commits. The diff on the right is read-only and can be shown Split (side by side) or Unified.",
    ],
    features: [
      { title: "Stage and unstage", text: "Stage all / Unstage all, or move single files. Inside a diff use Stage hunk and Unstage hunk for part of a file." },
      { title: "Discard", text: "Discard file or Discard hunk throws the change away and restores the committed version." },
      { title: "Filter and diff options", text: "Filter files by name, toggle Ignore whitespace, and switch between Split and Unified." },
      { title: "Commit message", text: "Write a summary line and a description. 'Compose a message from the staged diff' asks the AI to propose one for you to edit." },
      { title: "Create commit / Amend", text: "Create commit (Ctrl/Cmd+Enter) records the staged changes. Amend last commit rewrites the previous commit with the staged changes and a new message." },
      { title: "Stash changes", text: "Put all current changes aside without committing, from the More actions menu or the Stash button." },
      { title: "Copy status summary", text: "Copies a short list of changed files, handy for a chat message or a ticket." },
    ],
    tutorial: [
      { title: "Look at the list", text: "Open Working changes. Click a file to see its diff." },
      { title: "Review each change", text: "Read the diff. If a hunk does not belong in this commit, leave it unstaged." },
      { title: "Stage", text: "Press Stage all, or Stage hunk on the parts you want." },
      { title: "Write the message", text: "Type a summary line, or press the compose button to get a suggestion from the staged diff, then edit it." },
      { title: "Commit", text: "Press Create commit (Ctrl/Cmd+Enter). The files disappear from the list." },
      { title: "Next step", text: "Open Push Commits to send the commit to the remote." },
    ],
    tips: [
      "Make small commits: one purpose per commit makes review and revert much easier.",
      "Ask @code-reviewer to review the staged diff before you commit.",
      "Use Ignore whitespace to see the real change when a file was only re-formatted.",
    ],
    cautions: [
      "Discard file and Discard hunk cannot be undone: uncommitted work is gone. Stash first if you are not sure.",
      "Amend last commit rewrites history. Do not amend a commit that has already been pushed and shared.",
      "Do not stage secrets or large generated files. Check the staged list before committing.",
      "A pre-commit hook can reject the commit; read the message, fix the cause and commit again.",
    ],
    agents: { default: "working-changes", base: "code-reviewer" },
    shots: [{ file: "working-changes.jpg", caption: "Left: Unstaged and Staged changes with Stage all / Unstage all and the commit box. Right: the diff of the selected file with Split / Unified and hunk actions." }],
  },

  "push-commits": {
    summary: "See exactly which commits will be pushed to the remote, check them, and publish them.",
    overview: [
      "Push Commits lists the commits that exist on your branch but not on the remote yet (the upstream). You can read each commit and its files before anything leaves your machine.",
      "If the branch has never been pushed, Pigry offers to publish it and set the upstream for you.",
    ],
    features: [
      { title: "Push preview", text: "The list shows every unpushed commit with its author and time. Open one to see its files and diffs." },
      { title: "Search and sort", text: "Search by SHA, message or author, and sort newest first or oldest first." },
      { title: "Publish a new branch", text: "For a branch without an upstream the push publishes it to the remote and links the two." },
      { title: "Agent checklist", text: "The push checklist agent reviews the commits for missing tests, stray debug code or secrets before you push." },
    ],
    tutorial: [
      { title: "Open Push Commits", text: "The list shows what is ahead of the remote. If it is empty there is nothing to push." },
      { title: "Read the commits", text: "Click a commit to read its changes." },
      { title: "Ask for a check", text: "Type '@push-checklist is this safe to push?' in the AI Agent panel." },
      { title: "Push", text: "Press the push button. The list empties when the push succeeds." },
    ],
    tips: [
      "Pull first (Pull commit) when the remote has new work, to avoid a rejected push.",
      "Check the branch name in the header: pushing the wrong branch is a common mistake.",
    ],
    cautions: [
      "Once pushed, other people may build on your commits. Avoid rewriting them afterwards (amend, rebase) without agreeing with the team.",
      "A push can be rejected if the remote moved on; pull or rebase, then push again.",
      "Pushing needs permission on the remote; a failure message tells you if authentication or protection rules blocked it.",
    ],
    agents: { default: "push-commits", base: "push-checklist" },
    shots: [{ file: "push-commits.jpg", caption: "The list of unpushed commits with search and sort, the commit details and the push action." }],
  },

  "pull-commits": {
    summary: "Fetch what others pushed, review the incoming commits and bring them into your branch.",
    overview: [
      "Pull commit first fetches the remote so Pigry knows about new commits, then lists the incoming commits (the ones on the upstream that you do not have). You can read every commit and its per-file diff before you accept them.",
      "If your branch has not moved, the pull is a fast-forward. If both sides have new commits the branches have diverged and the AI agent explains what to expect.",
    ],
    features: [
      { title: "Fetch", text: "Updates the remote-tracking branches without changing your files." },
      { title: "Incoming commits", text: "Browse and search the commits you will receive, with author and time." },
      { title: "Per-file diffs", text: "Open a commit and a file to see what changes, in Split or Unified view." },
      { title: "Pull", text: "Applies the incoming commits to your current branch." },
      { title: "Impact review", text: "The incoming-impact agent explains which of your files the new commits touch and whether it can fast-forward." },
    ],
    tutorial: [
      { title: "Fetch", text: "Press Fetch. The count of incoming commits updates." },
      { title: "Read them", text: "Click a commit, then a file, to see the diff." },
      { title: "Check for trouble", text: "Ask '@incoming-impact will this conflict with my changes?'." },
      { title: "Pull", text: "Press Pull. Your branch now includes the new commits." },
    ],
    tips: [
      "Commit or stash your own changes before pulling so the pull has a clean base.",
      "Pull often; small updates are much easier to merge than a month of changes.",
    ],
    cautions: [
      "A pull into a dirty working tree can fail or create conflicts; commit or stash first.",
      "If the branches diverged, the pull makes a merge or needs a rebase; read the explanation before confirming.",
      "Pulling changes your files, so reload anything you have open in other tools.",
    ],
    agents: { default: "pull-commits", base: "incoming-impact" },
    shots: [{ file: "pull-commits.jpg", caption: "The incoming commits after a fetch with their files and diff, and the Fetch and Pull actions." }],
  },

  "merge-branch": {
    summary: "Merge another branch into the one you have checked out, choosing how the history is recorded, and resolve conflicts.",
    overview: [
      "Pick a Source branch and a Strategy. The merge is applied to the branch you have checked out (shown at the top). Pigry previews the commits and files that will come in before you merge.",
      "When two branches changed the same lines the merge stops with conflicts and a conflict editor opens right below: pick each file, choose what to keep in every conflict, then press Commit merge.",
    ],
    features: [
      { title: "Fast-forward (ff)", text: "Moves your branch forward without a merge commit. Only works when your branch has no commits of its own." },
      { title: "No fast-forward (no-ff)", text: "Always creates a merge commit, which records that a branch existed." },
      { title: "Squash", text: "Combines all the changes into staged changes that you commit yourself, as one commit." },
      { title: "Conflict editor", text: "Lists the conflicted files; each conflict shows Current (your branch) and Incoming (the branch being merged) with Accept current, Accept incoming, Accept both or Edit. Edit whole file writes the result by hand, and Whole file takes one version (or keeps a deletion)." },
      { title: "Abort", text: "Stops the merge and restores the branch to how it was before; your choices are discarded." },
    ],
    tutorial: [
      { title: "Check out the target", text: "Make sure the branch that should receive the changes is checked out." },
      { title: "Choose the source", text: "Select the Source branch and look at the commit list." },
      { title: "Choose a strategy", text: "no-ff for a merge commit, ff for a straight line, squash for one tidy commit." },
      { title: "Merge", text: "Press merge. If conflicts appear, resolve every file in the conflict editor — the progress bar shows how many are left." },
      { title: "Finish", text: "Press Commit merge: Pigry writes and stages every resolved file and creates the merge commit." },
    ],
    tips: [
      "Ask @merge-conflict-helper to explain a conflict and propose a resolution.",
      "Merge the main branch into your feature branch regularly to keep conflicts small.",
    ],
    cautions: [
      "Squash drops the individual commits and their authors from the target history; use it only when that is what you want.",
      "Never leave conflict markers (<<<<<<<) in a file you stage.",
      "Abort merge discards the half-done resolution work; save what you need first.",
    ],
    agents: { default: "merge-branch", base: "merge-conflict-helper" },
    shots: [{ file: "merge-branch.jpg", caption: "The source branch and strategy selectors, the incoming commits and the diff of the selected file." }],
  },

  "merge-conflicts": {
    summary: "Resolve conflict markers one conflict at a time — pick a side, keep both or write the result — then finish or abort the merge, rebase, cherry-pick or revert.",
    overview: [
      "When git cannot combine two changes to the same lines it writes both into the file between <<<<<<<, ======= and >>>>>>> markers and stops. Merge conflicts lists every conflicted file and shows each conflict as a card: the Current change on one side, the Incoming change on the other, with the lines that differ highlighted and the code around it.",
      "A banner says what stopped (a merge, a rebase, a cherry-pick, a revert, or conflicts from a stash) and what Current and Incoming mean for it — during a rebase they are reversed: Current is the new base and Incoming is your own commit. When every file is resolved, Continue (or Commit merge) finishes the operation and Abort puts the branch back as it was.",
    ],
    features: [
      { title: "Conflict cards", text: "Each conflict shows both sides side by side with line numbers, the nearby lines and, when the file has it, the common ancestor (the version before either change)." },
      { title: "One-click choices", text: "Accept current, Accept incoming, Accept both (current first or incoming first), keep the ancestor, or Edit to write the combined result yourself. Change undoes a choice." },
      { title: "Safe suggestions", text: "When both sides made the same change, differ only in whitespace, or only one side changed the lines, the card suggests the answer; Apply safe suggestions takes them all at once." },
      { title: "Preview and save", text: "Preview result shows the whole file with any markers left in red. Save writes the choices so far; Save & mark resolved writes and stages the file." },
      { title: "Whole-file choices", text: "Keep the current or the incoming version of the whole file, for generated files such as lock files." },
      { title: "Finish or abort", text: "Continue rebase, Continue cherry-pick, Continue revert or Commit merge once no file is left; Abort asks first, then restores the branch." },
      { title: "Side bar badge", text: "The menu shows how many files are conflicted, so you notice conflicts from any menu." },
      { title: "Agents", text: "@merge-conflicts explains a conflict in plain words; @conflict-resolver reads both sides and their history, resolves the blocks with conflict_resolve and tells you which ones need your decision." },
    ],
    tutorial: [
      { title: "Get a conflict", text: "Merge, rebase, cherry-pick or pull a branch that changed the same lines as yours. The Merge conflicts menu shows a count in the side bar." },
      { title: "Open the menu", text: "The banner says what stopped and how many files are left. Read How it works on the right the first time." },
      { title: "Pick a file", text: "Choose a file on the left. Each conflict is a card; N and P move between them." },
      { title: "Decide each conflict", text: "Compare the two sides and press Accept current, Accept incoming or Accept both — or Edit to combine them. Use a suggestion when the card offers one." },
      { title: "Check the result", text: "Press Preview result to read the whole file, then Save & mark resolved." },
      { title: "Finish", text: "When no file is left press Continue (or Commit merge). For conflicts from a stash or a Pigry cherry-pick, commit the files in Working changes." },
    ],
    tips: [
      "Read what each side meant before choosing: a conflict is two valid changes, not a right and a wrong one.",
      "Accept both is right for independent additions (two imports, two list items); Edit is right when the same code was changed in two ways.",
      "For lock files take one side, then run the package manager again instead of merging by hand.",
      "Run the tests after resolving — a file without markers can still be wrong.",
    ],
    cautions: [
      "During a rebase Current and Incoming are reversed: Current is the branch you rebase onto, Incoming is your own commit.",
      "Abort throws away every resolution made since the operation started.",
      "Binary files cannot be merged line by line: keep one whole version, or resolve them outside Pigry and mark them resolved.",
      "Save & mark resolved stages the file as it is — check the preview first.",
    ],
    agents: { default: "merge-conflicts", base: "conflict-resolver" },
    shots: [{ file: "merge-conflicts.jpg", caption: "A merge stopped with conflicts: the conflicted files, a conflict card with the current and incoming sides and the actions, and the How it works panel." }],
  },

  "compare-branch": {
    summary: "Compare any two branches: which commits are unique to each side and how their files differ.",
    overview: [
      "Choose a Base branch and a Compare branch. Pigry shows the commits that exist only on each side and the files that differ between the two tips, with a full diff you can read in Split or Unified view.",
      "Nothing is changed in your repository; this menu is for looking and deciding, for example before a merge or a pull request.",
    ],
    features: [
      { title: "Base and Compare", text: "Select the two branches. Press Refresh comparison after the branches changed." },
      { title: "Unique commits", text: "See what is on Compare but not on Base, and the other way round." },
      { title: "Changed files", text: "Click a file for its diff. Large and binary files are reported but not shown." },
      { title: "Layout", text: "Switch between Split and Unified diffs." },
    ],
    tutorial: [
      { title: "Pick the branches", text: "Set Base to main and Compare to your feature branch." },
      { title: "Read the commits", text: "Check the commits that are unique to the feature branch." },
      { title: "Open the files", text: "Click through the changed files." },
      { title: "Ask for a summary", text: "'@branch-diff-reviewer summarise the risks in this comparison'." },
    ],
    tips: [
      "Compare before you merge or open a pull request to be sure only the intended changes are included.",
      "Use Unified view for small changes and Split view for large rewrites.",
    ],
    cautions: [
      "The comparison uses the branches as they are locally. Fetch first if you want the latest remote state.",
      "Choosing the same branch on both sides shows nothing; pick two different branches.",
    ],
    agents: { default: "compare-branch", base: "branch-diff-reviewer" },
    shots: [{ file: "compare-branch.jpg", caption: "Base and Compare selectors, commits unique to each branch, and the diff of a changed file." }],
  },

  stashes: {
    summary: "Put work-in-progress aside and bring it back later, without committing.",
    overview: [
      "A stash is a saved copy of your uncommitted changes. Stashing cleans your working tree so you can switch branches or pull, and later you apply the stash to get the changes back.",
      "Stashes Code lists every stash with its message and branch, and lets you look inside a stash before you apply it.",
    ],
    features: [
      { title: "Stash", text: "Saves your current changes with an optional message and cleans the working tree." },
      { title: "View", text: "See which files a stash changes and read its diff." },
      { title: "Apply", text: "Re-applies a stash and keeps the entry so you can use it again." },
      { title: "Pop", text: "Applies a stash and removes it from the list." },
      { title: "Drop", text: "Deletes a stash permanently." },
      { title: "Apply latest / Pop latest", text: "Shortcuts for the newest stash." },
    ],
    tutorial: [
      { title: "Stash your work", text: "Press Stash and type a message such as 'half-done login form'." },
      { title: "Do the other task", text: "Switch branch or pull; the working tree is clean." },
      { title: "Come back", text: "Return to the original branch and open Stashes Code." },
      { title: "Look first", text: "Press View on the stash to check what it contains." },
      { title: "Restore", text: "Press Pop to apply it and remove it, or Apply to keep a copy." },
    ],
    tips: [
      "Always give a stash a message; 'WIP on main' is impossible to understand a week later.",
      "Use Apply instead of Pop when you are unsure it will apply cleanly.",
    ],
    cautions: [
      "Drop deletes a stash permanently; it is very hard to recover.",
      "Applying a stash onto changed files can produce conflicts. Resolve them in Working changes.",
      "Untracked files may not be part of a stash; check the list of files before relying on it.",
    ],
    agents: { default: "stashes-code", base: "stash-inspector" },
    shots: [{ file: "stashes.jpg", caption: "The list of stashes with View, Apply, Pop and Drop, and the files of the selected stash." }],
  },

  "cherry-pick": {
    summary: "Copy the changes of one commit from anywhere in history onto the branch you are on.",
    overview: [
      "Cherry-picking takes a single commit, possibly from another branch, and applies its changes to your current branch. Pigry stages the result so you can review it and commit it yourself.",
      "Browse the commits of all branches or of one branch, open a commit to read its files and diffs, then press Cherry-pick.",
    ],
    features: [
      { title: "Browse and filter", text: "Choose a branch or All branches, search by SHA or message, filter by author and time range, and sort." },
      { title: "Inspect a commit", text: "Open a commit to see its message, files and a before/after diff of every file." },
      { title: "Cherry-pick", text: "Applies the commit's changes to the working tree and stages them. Merge commits cannot be cherry-picked." },
      { title: "Conflicts", text: "If the commit does not apply cleanly the conflicted files are listed with an Abort cherry-pick button." },
    ],
    tutorial: [
      { title: "Find the commit", text: "Pick the branch that has the fix and search for its message." },
      { title: "Read it", text: "Open the commit and check the files." },
      { title: "Cherry-pick", text: "Press Cherry-pick. The changes are now staged on your branch." },
      { title: "Finish", text: "Open Working changes, review the staged diff and create the commit." },
    ],
    tips: [
      "Ask '@pick-reviewer does this commit depend on earlier commits?' before picking.",
      "Pick in the order the commits were made when you take more than one.",
    ],
    cautions: [
      "The commit is not created automatically: you must commit the staged changes yourself.",
      "A cherry-picked commit has a new SHA; Git may later see it as a duplicate when you merge the branches.",
      "Abort cherry-pick resets the working tree; do not use it if you have other uncommitted work you want to keep.",
    ],
    agents: { default: "cherry-pick", base: "pick-reviewer" },
    shots: [{ file: "cherry-pick.jpg", caption: "The branch selector and commit list, and an opened commit with its files and the Cherry-pick button." }],
  },

  "revert-commit": {
    summary: "Undo a commit safely by creating a new commit that reverses it, keeping the history intact.",
    overview: [
      "Revert commit lists the commits of the branch you have checked out. Choose one and Pigry creates a new commit with the opposite changes. Nobody's history is rewritten, so it is the safe way to undo something that has already been pushed.",
      "If later commits changed the same lines the revert conflicts. The conflicted files are listed and you can resolve them or press Abort revert to go back.",
    ],
    features: [
      { title: "Current branch history", text: "Only commits reachable from your branch are listed, since only those can be reverted." },
      { title: "Inspect first", text: "Open a commit to read its files and before/after diffs." },
      { title: "Revert", text: "Creates the 'Revert …' commit with the original message referenced. Merge commits cannot be reverted here." },
      { title: "Conflict handling", text: "Shows the conflicted files with Abort revert, which restores the branch." },
    ],
    tutorial: [
      { title: "Find the bad commit", text: "Search for it by message or SHA." },
      { title: "Check the impact", text: "Ask '@revert-checker what would reverting this undo, and could it conflict?'." },
      { title: "Revert", text: "Press Revert <sha>. A new commit appears at the top of the branch." },
      { title: "Resolve if needed", text: "On conflicts, edit the files in Working changes, stage them and commit, or press Abort revert." },
      { title: "Push", text: "Open Push Commits to share the revert." },
    ],
    tips: [
      "Revert is the right tool for pushed commits; use Edit commit or Rebase only for commits nobody else has.",
      "Revert in the reverse order of the commits when you undo several that depend on each other.",
    ],
    cautions: [
      "Your working tree should be clean first; Git refuses a revert that would overwrite uncommitted changes.",
      "Reverting a commit does not remove it from history, and secrets that were committed stay in history.",
      "If you later want the changes back, you have to revert the revert.",
    ],
    agents: { default: "revert-commit", base: "revert-checker" },
    shots: [{ file: "revert-commit.jpg", caption: "Commits of the current branch, an opened commit with its files, and the Revert button." }],
  },

  "duplicate-commit": {
    summary: "Copy a commit from one local branch to another, with a check that it is not already there.",
    overview: [
      "Choose a Source branch and a Destination branch. Pigry lists the commits of the source that can be duplicated to the destination, and marks the ones that are already present, either by the same SHA or because an equivalent patch exists, as ineligible.",
      "This is a guided cherry-pick between two local branches, without having to check the destination branch out first.",
    ],
    features: [
      { title: "Source and destination", text: "Pick two local branches. The list of source commits updates." },
      { title: "Eligibility", text: "'Can duplicate to the selected branch' commits are available; 'Already in destination' commits are not." },
      { title: "Review before copying", text: "Open a commit to read its files and diffs." },
      { title: "Duplicate commit", text: "Creates the copy on the destination branch." },
    ],
    tutorial: [
      { title: "Choose the branches", text: "Source: the branch with the fix. Destination: the release branch." },
      { title: "Find the commit", text: "Search by message or SHA; ineligible commits are marked." },
      { title: "Check it", text: "Ask '@transfer-check will this apply cleanly to the destination?'." },
      { title: "Duplicate", text: "Press Duplicate commit. The destination branch moves forward." },
    ],
    tips: [
      "Use it to back-port a fix to a release branch.",
      "Duplicate the commits in the order they were made.",
    ],
    cautions: [
      "Only local branches are offered; fetch or check out the remote branch first.",
      "The copy gets a new SHA and diverges from the original; later merges may show the change twice.",
      "It needs the desktop app, because it runs Git on your machine.",
    ],
    agents: { default: "duplicate-commit", base: "transfer-check" },
    shots: [{ file: "duplicate-commit.jpg", caption: "Source and destination branch selectors, the source commits with their eligibility, and the selected commit's files." }],
  },

  "edit-commit": {
    summary: "Change an older commit on your current branch (its files or message) and replay the commits after it.",
    overview: [
      "Edit commit stops the history at the commit you pick. You then change files in Explorer, stage them and press Save and continue; Pigry rewrites that commit and replays all later commits on top of it.",
      "It only works on a local branch that is checked out, and only when your working tree is clean.",
    ],
    features: [
      { title: "Editable commits", text: "The list shows commits you can edit on the current branch; search by message or SHA." },
      { title: "Start editing", text: "Moves you to that commit so you can change its files." },
      { title: "Edit in Explorer", text: "Open and save files like normal, then stage the changes in Working changes." },
      { title: "Save and continue", text: "Rewrites the commit and replays the rest. If a later commit conflicts, resolve and continue." },
    ],
    tutorial: [
      { title: "Clean the tree", text: "Commit or stash your working changes; the menu tells you if you must." },
      { title: "Pick the commit", text: "Select it and press Start editing." },
      { title: "Change files", text: "Open Explorer, edit and save the files, then stage them in Working changes." },
      { title: "Continue", text: "Press Save and continue. The later commits are replayed." },
    ],
    tips: [
      "Ask '@amend-reviewer' to check the plan, especially how many later commits will be replayed.",
      "Use this for small clean-ups; for a bigger reshuffle use Rebase Branch.",
    ],
    cautions: [
      "This rewrites history: every commit after the edited one gets a new SHA.",
      "Do not edit commits that were already pushed and shared, unless the team agrees and you will force-push.",
      "While editing, the branch shows as HEAD (detached). Finish or abort before doing other git work.",
    ],
    agents: { default: "edit-commit", base: "amend-reviewer" },
    shots: [{ file: "edit-commit.jpg", caption: "The editable commits of the current branch with search, and the Start editing action." }],
  },

  "rebase-branch": {
    summary: "Replay your branch on top of another one and reorder, squash or drop commits with a visual plan.",
    overview: [
      "Rebase takes the commits of your branch and replays them on top of a Base branch, giving a straight, linear history. Rebase Branch shows the plan before anything happens: each commit can be picked, squashed into the previous one, or dropped, and you can reorder them.",
      "The same planner opens from the Commit graph when you start an interactive rebase on a commit.",
    ],
    features: [
      { title: "Base branch", text: "Choose what to rebase onto, for example main." },
      { title: "Plan", text: "Click a commit's action to cycle pick, squash and drop. Use the arrows to move a commit up or down." },
      { title: "Replay order", text: "Show replay order lists the order commits will be applied." },
      { title: "Start rebase with plan", text: "Applies the plan. If a commit conflicts, resolve it and continue." },
      { title: "Abort rebase", text: "Stops and restores the branch to how it was." },
    ],
    tutorial: [
      { title: "Choose the base", text: "Select main (or the branch you want to build on)." },
      { title: "Edit the plan", text: "Squash small fix-up commits into their parents and drop what you do not need." },
      { title: "Check the order", text: "Press Show replay order." },
      { title: "Start", text: "Press Start rebase with plan." },
      { title: "Resolve conflicts", text: "Edit, stage and continue until finished; or press Abort rebase." },
    ],
    tips: [
      "Ask '@rebase-plan-reviewer' to check the plan and warn about commits that depend on each other.",
      "Rebase your own local branch before opening a pull request for a clean history.",
    ],
    cautions: [
      "Rebasing rewrites history; commits get new SHAs. Never rebase a branch other people have based work on.",
      "After rebasing a pushed branch you must force-push; use the safe option and tell your team.",
      "Dropping a commit deletes its changes from the branch. Check the plan twice.",
    ],
    agents: { default: "rebase-branch", base: "rebase-plan-reviewer" },
    shots: [{ file: "rebase-branch.jpg", caption: "The base branch selector, the commit plan with pick / squash / drop and the replay order." }],
  },
};
