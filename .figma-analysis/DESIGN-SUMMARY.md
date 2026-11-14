# Pigry — Figma Design Summary

Source: figma.com/design/`417miudvyh3Kdz8eN4eILm`/pigry (last modified 2026-11-07)
26 frames · all 1600px-wide desktop screens · dark theme · VS Code × GitHub Desktop hybrid

## App concept
Git client like GitHub Desktop, plus: built-in Monaco editor, local-first cross-repo
code search, GitHub-style Projects/Roadmap, and an approval-gated AI Agent.
Sample product version shown in designs: v0.18.0, "BETA".

## Screens (26)

**Home / no repo open**
- Home code search · Organization code search · Repository code search
  (query input with Aa / word / regex toggles, scope chips, results grouped by repo,
  read-only preview pane, "local index ready · respects .gitignore" transparency)

**Repository management**
- New project · Projects · Projects · Add item · Projects — Table · Projects — Roadmap
- All repositories · acme-inc repositories

**In-repo Git workflow**
- Working changes (staged/unstaged groups + commit composer + diff)
- Commit changes
- Repository history (commit graph table)
- Explorer · Pull requests · Releases · Issues · Actions · Wiki · Security and quality · Insights

**Editor**
- Editor only · File history · Compare code · History+Compare (2×2 state matrix)

**AI**
- AI Agent (chat, "Approval required", read-only analysis, proposed Git plan with
  step-by-step approval, "Files read only · tests not run · no repository changes")

## App shell (every in-repo screen)

```
┌────────────────────────────────────────────────────────────────┐
│ Title bar ~40px: [pigry·GIT] org/repo +Private pill · ⌘K search · ⤢ · avatar │
├──────────┬─────────────────────────────────────────────────────┤
│ Nav      │ Main workspace (varies per screen)                  │
│ 224px    │                                                     │
│ WORKSPACE│                                                     │
│ branches │                                                     │
│ remotes  │                                                     │
│ tags     │                                                     │
│ stashes  │                                                     │
│ health   │                                                     │
├──────────┴─────────────────────────────────────────────────────┤
│ Status bar 28px: ●Up to date · ~/path · N files changed · Terminal │
└────────────────────────────────────────────────────────────────┘
```

- Nav items: Explorer, Commit graph, Working changes (count badge), AI Agent,
  Pull requests (badge), Releases, Issues, Actions, Projects, Wiki,
  Security and quality, Insights
- Nav sections: LOCAL BRANCHES / REMOTES (nested remote branches) / TAGS / STASHES,
  collapsible with counts; bottom = repository health card + Preferences ⌘,

## Design tokens

**Fonts** — Inter (UI) + JetBrains Mono (code, paths, SHA, email). Dense: 9–13px,
line-height ~1.2–1.45. Weights mostly 400, 500/600 for emphasis, UPPERCASE + letterspaced labels.

**Backgrounds (layered dark)** — deepest → raised:
`#0e1014` (status bar) · `#111317` (sidebar) · `#15171c` (title bar/panels) ·
`#191c22` · `#1d2129` (workspace) · `#20242b` (cards/inputs) · code surface `#1a1d24`/`#1b1e28`

**Borders** `#2a2e37` (1px subtle), hover variants `#343a46`

**Text** `#e9ebf0` primary · `#9299a7` secondary · `#656d7c` muted · `#c9ced8` mid

**Accent** `#8b9dff` indigo — active nav, primary buttons, links, diff-highlight.
Tinted bg `#252d49` / `#38405b` / `#43517b` (selected rows, active segments)

**Semantic** green `#6dd6ad` (+added/success) · red `#e79098` (−removed) ·
orange `#edb675` (modified/warning) · cyan `#62cee7` (info) ·
purple `#b59aff`/`#a698ff` (AI features, "Generate message ✨")

**Diff tints** added `#152a24`, removed `#453a2c`-ish (dark green/red row backgrounds)

**Radius** 6px default · 4px small · 99/999px pills/badges · 8–12px cards
**Shadows** rare, large-soft (0 24px 80px 44% black) for overlays/modals only
**Density** nav rows 26–28px, file rows 44px, toolbar 40–48px, compact gutters 10–24px

## Key components seen
- Command search (⌘K) input in title bar; ⌘F filter; ⌘⏎ commit; ⌘, preferences
- Pills/badges: visibility (Private), count badges, Unstaged/Staged, preview-mode
- Diff pane: hunk headers `@@ -24,18 +24,31 @@` + function context, dual line-number
  gutter, Unified/Split segmented control, Ignore whitespace, per-hunk/per-line stage,
  footer "TypeScript JSX · UTF-8 · LF"
- Commit composer: message textarea (title+body), char counter, "Generate message" (AI),
  Amend checkbox, author identity, primary "Commit N staged files ⌘↵"
- Commit graph: GRAPH | COMMIT MESSAGE | AUTHOR | COMMIT | TIME table w/ lanes,
  branch labels, merge commits, relative time
- Repo health card: "6 local changes · 3 staged · 3 unstaged" with status dot

## Stack target
React + TypeScript + Tauri + monaco-editor (per user). Monaco fits: diff editor for
Working changes/Compare, full editor for Explorer/Editor screens.

## Notes / gaps
- Figma REST data has no hover/focus/active-interactive states — confirm with user
  when implementing (active nav shown; hover styles inferred: brighten text + bg fill)
- All screens designed at fixed 1600px; app must be resizable — sidebar 224px fixed,
  main workspace flexible (file list 360px + diff flexible)
- No light theme in the file
