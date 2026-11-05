# PRway — Product spec

> Status: early prototype (milestones 1 and 2 done). Last updated 2026-11-03.

## 1. The problem

Code review tools in 2026 mostly try to **replace** the reviewer: AI bots (CodeRabbit, Qodo, Greptile,
Copilot review) post comments on the PR. The human reviewer still has to:

- read diffs full of noise (lockfiles, generated code, renames, reformatting)
- work out **why** the change exists and whether the code matches that reason
- find where **business rules** change, which is what really matters, hidden among mechanical edits
- remember past decisions about the same code, and what the code is used for
- switch branches locally to look at the code around a change

PRway doesn't replace the human review. It **guides** it: it strips the noise, explains the intent, points at the
hot spots, and keeps knowledge for future reviews.

## 2. Vision

A desktop app, IDE-like, where **the code review is the main view**:

1. Connect your GitHub account, pick a repository, see its open PRs.
2. Open a PR and it gets its own **git worktree**, so several PRs can be reviewed side by side without
   switching branches, and you can open the checkout in any IDE.
3. Noise is filtered out automatically. What's left is ordered into a **reading path** with risk levels.
4. An AI **review guide** says what the PR is for, which business rules change, what isn't explained by the
   intent, and which lines deserve a careful look.
5. You can follow the code: jump to definitions and callers (AST / language servers).
6. You review inside the app (comments, approve, request changes), and GitHub notifications for your PRs
   come to your desktop.
7. Over time PRway builds a **knowledge base**: decisions and business rules from past PRs come back when the
   same code changes again.

### Principles

- **Human first.** AI suggests where to look; the reviewer decides. No auto-approve, no bot comments.
- **Deterministic before AI.** Use git, parsers and rules wherever possible (noise filter, history, callers);
  use the model for judgment (intent, business rules, mismatches).
- **Local first.** Code, clones, guides and the knowledge base live on the reviewer's machine. Only the PR
  content is sent to the AI provider the user picked.
- **Bring your own AI.** Claude through the user's own subscription (Claude Code CLI) by default, API key as an
  alternative, other providers pluggable.

## 3. Market research (Nov 2026)

| Tool | Focus | Price (per user/month unless noted) | Gap vs PRway |
|---|---|---|---|
| Graphite (Cursor) | Stacked PRs, review inbox, merge queue, AI review | Free (personal) · Starter $20 · Team $40 · Enterprise custom | Needs the team to adopt stacked PRs; no noise filtering or guided reading |
| Reviewable | Better GitHub review UI, tracks reviewed revisions | Free for public/personal; paid per contributor (~$8, not public) | Fixes the UI, not understanding; GitHub only |
| CodeApprove | Faster GitHub review UI | Free tier; paid on request | Same as Reviewable |
| PullApprove | Review rules / required reviewers | Team $4 · Org $6 · Business $7,500+/yr | Workflow only |
| Axolo | Slack channel per PR, reminders | Free · $8.3 · $13.3 · Enterprise | Notifications only |
| CodeRabbit, Qodo, Greptile, Baz, Copilot review | AI reviewers that comment on PRs | ~$15–30 | Replace the reviewer instead of guiding; context shown as comments |
| Unblocked | Context from past discussions | Freemium | Not tied to the code being reviewed |
| Gerrit, Phorge | Self-hosted classic review | Free | Old UX, self-hosted |

**Gaps nobody covers well (PRway's focus):** a guided reading path, separating business-rule changes from
mechanical edits, checking the change against the stated intent, and a knowledge base that grows across PRs.

## 4. Features

### 4.1 Done

**Milestone 1 — review workspace**
- GitHub sign-in: classic personal access token, or OAuth device flow (needs an OAuth App client ID).
- Repository picker; typing `owner/repo` opens repos missing from the list.
- Diagnostics for hidden org repos: SAML SSO not authorized, OAuth app not approved by the org,
  fine-grained token, missing scopes. Each comes with a link to fix it.
- Open PRs list with a "For me" filter (your review is requested).
- One **git worktree per PR** under `~/.prway/worktrees/<owner>/<repo>/pr-<n>`, from a bare partial clone.
- Monaco side-by-side diff, unchanged regions folded, "hide whitespace changes" option.
- "Viewed" checkbox per file and a progress bar, reset when new commits arrive.
- Submit a review: comment, approve, request changes.
- Notifications: GitHub PR notifications in a bell menu plus desktop notifications; clicking one opens the PR.

**Milestone 2 — noise filter and AI review guide**
- Noise filter (no AI) puts these under a collapsed "Skip" group:
  - generated: lockfiles, `dist/`, `build/`, `vendor/`, snapshots, minified/protobuf output, `linguist-generated`
  - rename-only: pure renames, or renames with whitespace-only changes
  - formatting-only: the diff is empty when whitespace and blank lines are ignored
- AI review guide (structured JSON output):
  - intent, plus its source (linked issue, description, commits or inferred)
  - business rules changed, before → after, with path and line
  - changes not explained by the intent
  - files in reading order, each with a risk level, role, why it matters, and up to 4 focus lines
  - questions for the author
- Focus lines are highlighted in the diff, with the notes on hover. Rules, files and lines in the guide are clickable.
- Guides are saved per head commit in `~/.prway/guides/`, marked stale when new commits arrive, and can be regenerated.
- AI settings: provider (Claude Code CLI = subscription, or Anthropic API key), model, effort.

**Milestone 3 — review in depth**
- Layout: collapsible PR list; open PRs as tabs (kept loaded, so each keeps its scroll, drafts and panel; up to 10);
  the diff takes the middle, with a resizable panel (Summary · Guide · Background · Threads · Conversation · Chat) below it or on the right,
  and an "Ask about this PR" prompt under it.
- Inline review comments:
  - GitHub threads show under their lines (GraphQL, with resolved/outdated state); reply, resolve, unresolve.
  - Click a line number to write a comment (select lines first for a range). Comments stay as pending drafts
    (saved locally per PR) and go out together with the review, anchored to the head commit PRway shows.
  - Only lines inside diff hunks take comments, as on GitHub. Outdated threads are listed above the diff.
  - Conversation tab: the description, general PR comments and review summaries (with their state) in date order;
    post a general comment; Refresh reloads it and the inline threads.
- Code navigation at the PR head: ⌘/Ctrl+click or F12 for definitions, Shift+F12 for references, also in files the
  PR did not change (opened read-only), with a Back button. Built on `git grep` plus per-language definition
  patterns (Elixir, TS/JS, Python, Go, Ruby, Rust, JVM languages, SQL).
- Noise filter additions:
  - `moved`: every changed line is code git sees as moved (`--color-moved`), within or between files; moved lines are
    also marked in the diff
  - `formatting-only` beyond whitespace: both versions have the same code tokens (line wrapping; for JS-like files also
    quote style, semicolons, trailing commas). Skipped for whitespace-sensitive languages.
  - per-repo rules in `.prway.json` (`skip`, `review`, `domains`), read from the PR base so a PR can't change its own rules
- Repository context per changed function (call sites, tests, recent commits) goes into the AI guide prompt. The
  Context tab that showed it per function was removed: the Background tab covers it (history, callers, tests per
  concept). Go to definition (several matches) and find references open a panel floating over the code.
- Summary tab (first): what changed, the business rules changed (before → after) and changes the intent doesn't
  explain, from the guide
- Guided view shows only what needs you: pre-approved chunks, and files with nothing left, are left out of the outline,
  the counts and the Finish page (a link opens the Files view, where they are listed with their reason)
- Guide tab: only the intent (and where it came from) and the reading order. Business rule changes and changes the
  intent doesn't explain are in the Summary tab; questions for the author show on the Finish step
- Background tab ("before this PR"), built on demand (`src/main/trace/`):
  1. classify: the guide names 1-4 core concepts (features or business rules) with the functions where each lives
     (`concepts` in `GUIDE_SCHEMA`); no extra AI call
  2. trace (git only, seconds): from those functions, at the merge base and at the head, up through callers until an
     entry point (controllers, workers, consumers… plus `entryPoints` globs in `.prway.json`; hops inside one file
     don't count towards the depth), down to what they call and the structs they build (Elixir aliases resolved),
     plus the tests that call them and the earlier PRs that changed them (`git log -L`). At most 20 functions per side
  3. explain: one AI call (medium effort) writes, per concept, how it worked before, why (only from earlier PRs,
     comments, tests), the change and what to watch out for. Every claim cites `base:path:line`, `head:path:line` or
     an earlier PR; claims without a valid citation are dropped
  4. remember: the same call writes function cards (summary + rules). A card is keyed by a hash of the function's
     path, name and code, so it is reused in any PR while that code is unchanged and is sent instead of the code.
     Cards are editable; your edit wins, and stays visible (marked outdated) after the code changes
  - caches: file outlines per commit, word searches per word + commit (a new commit only re-searches the files that
    changed since a cached one), function history per code version, merged PRs forever
    (`~/.prway/trace/<owner>/<repo>/{facts,cards,briefings}`)
  - progress shows in the panel (tracing, then the model call, with a timer); a warm rebuild of #7612 took 4s of
    tracing + ~75s for the model
  - the briefing also goes into the chat prompt
  - pre-approval uses it (`src/renderer/src/core.ts`): chunks touching the core (business rule lines, traced
    functions of the current head, test files that call them, watch-out lines) are never pre-approved from an AI
    "trivial" verdict; with "Pre-approve low-risk chunks outside the core change" on, chunks the file walkthrough rates
    low risk and that touch none of it are pre-approved ("outside the core change"). On #7612: 134 → 103 chunks to review
- Knowledge base: when a PR you opened in PRway is merged, its intent, business rules, review decisions and changed
  functions are saved; entries about the same files or functions go into the guide prompt (no longer shown in the UI).
- Chat about the PR (same provider and prompt material as the guide). Follow-ups are cheap:
  - Claude Code: one session per conversation (`--session-id`, then `--resume`), so a follow-up sends only the new
    question; the session is restarted when the conversation, the PR material or the instructions change
    (`~/.prway/chat-sessions.json`)
  - Anthropic API: the PR material is a cached prompt prefix (`cache_control`)
  - the PR material itself is cached per head commit for 30 minutes (shared with the guide)
  - ask about specific lines: click a line number (drag for several) in the diff or the Code view and pick Ask in
    Chat in the line menu, or select code and press ⌘L. They are attached to the next question as chips (click to
    jump, × to remove) and sent with line numbers and the version (base or head)
  - reads the code itself: read-only tools over the PR's checkout (head), so it can look up callers, schemas, tests
    and config that aren't in the prompt
    - Claude Code: its own Read/Grep/Glob, `--add-dir <worktree>`, `--permission-mode dontAsk` (anything outside
      the checkout is denied), run from an empty `~/.prway/claude-cwd`
    - Anthropic API: PRway's `read_file`/`grep`/`list_files` tools (`src/main/ai/codeTools.ts`, paths kept inside
      the checkout, no `.git`), at most 12 tool rounds per answer
    - the base version is not readable; the diffs and the Background cover it
- Line menu: clicking a line number opens a small menu: Comment (diff, on lines GitHub accepts), Ask in Chat, View
  diff (Code view, changed lines) and Copy reference (`path:12-15`)

**Milestone 4 — guided review (the main view)**
- A PR opens in the guided review; the classic file list + diff is one click away ("Files").
- Left: an outline — Overview, the files in the guide's reading order with their chunks (diff hunks), skipped noise
  files, Finish & submit — with chunk and file progress.
- Overview step: the review plan (files, chunks, noise, open threads) and the AI guide, then "Start review".
- File walkthroughs see the whole functions around each chunk at the PR head (up to 200 lines each, 60k characters
  per file), not just the diff's 3 lines of context, plus the Background briefing when built. Saved under `files-v3`
  (older walkthroughs that only saw the diff context are not reused)
- File step: no side panel, everything sits on the diff:
  - the file bar shows the guide's risk badge next to "Side by side"
  - under it, one line from the guide (the file's role and why it matters); "▸ summary · N to check" opens the
    walkthrough's summary, things to check and related code (opens any file at the line, in the diff or read-only)
  - the bar above the current chunk, in the code (as wide as the code, right above the chunk's first visible line,
    below any fold): a chevron on the left opens/closes the chunk's note (remembered), then chunk N of the ones that
    need you, range, function, risk, the first sentence of the note (on its own line when the bar is narrow), chunks left, ↑/↓, Approve & next (or ✓ approved / pre-approved, click to undo) and Comment (becomes
    a pending inline comment)
  - keys: j/k chunks, a approve & next, c comment, n/p files
- Feedback on AI hints: 👍 / 👎 on every Check item and chunk note (on hover), and on the guide's focus lines in the
  diff (click the line number: the focus note is at the top of the line menu; 👎 removes that line's highlight and
  its focus link). Saved per repository in
  `~/.prway/feedback/<owner>/<repo>.json` (last 500). The last 30 "not useful" and 10 "useful" go into every new
  walkthrough and guide prompt as examples: points like the noise ones are left out, and a low-risk chunk with
  nothing else to say is marked trivial, so it gets pre-approved. A 👎 dims the hint right away; saved walkthroughs
  aren't redone (regenerate a file to apply new ratings to it)
- Walkthroughs are made per file on demand (and the next file in the background), with a capped effort for speed, and
  saved per head commit in `~/.prway/guides/.../files/<sha>/`. References to files that don't exist are dropped.
- Approvals are keyed by the hunk's changed lines, so they survive new commits that don't touch that hunk; a file
  with every chunk approved counts as viewed.
- Finish step: what's not approved yet, your pending comments, open threads, the guide's questions, and the submit form.
- Pre-approval, so the reviewer only spends time where behaviour changes:
  - rules (no AI, instant): chunks whose changed lines are only imports/aliases, comments, blank lines, formatting
    (same tokens) or moved code (`src/main/review/triage.ts`, conservative: every changed line must qualify)
  - AI: a walkthrough marks a chunk trivial only when it is also low risk (log wording, local renames, docs)
  - "Start review" explains every file in the background (2 at a time, up to 15 files) so verdicts exist up front
  - pre-approved chunks count as approved, are skipped by j/k and "Approve & next", show one line with the reason,
    and are listed on the Finish step for spot checks; unticking one sends it back to you. Both layers can be turned off.
- Walkthroughs talk only about behaviour changes and real risks; a chunk that changes nothing gets no text.
- Cleanup of worktrees whose PR is closed or merged: checked with GitHub, merged PRs saved to the knowledge base
  first, worktrees with local changes and PRs open in a tab are kept. Runs at most every 30 minutes when the PR list
  loads, and from the 🧹 button. PRs you approved (no new commits since) collapse into "Approved by you".
- Settings page (⚙): AI provider/model/effort, and **review prompts per repository**:
  - repository context (sent with every request) and extra instructions for the guide, file walkthroughs and chat;
    any of the three can replace PRway's built-in instructions (the output format and the prompt-injection guard stay)
  - layers, in order: built-in → your "All repositories" → the team's `.prway.json` `"prompts"` (from the PR base) →
    your settings for that repo; a preview shows the exact system prompt sent
  - guides record which instructions they were made with and say when they changed; walkthroughs are saved per set of
    instructions (default instructions keep the old cache)
- Restores what was open: tabs, the file per PR, drafts, chat and layout live in `ui-state.json` (written on every
  change, so a crash keeps them). A guide made for an older commit is still shown, marked outdated.
- ↻ Refresh on the open PR: fetches new commits into the worktree and reloads details, threads and conversation,
  keeping approvals, drafts and the file you were on.
- Files view: the changed files as a folder tree (default; single-child folders merged, each folder shows how many of its
  files you viewed, the selected file's folders stay open) or as a flat list in the guide's reading order
- Code view (Guided / Files / **Code**): the whole repository at the PR head like an IDE. A file tree with changed
  files and folders marked, an "only changed" filter, ⌘P quick open, editor tabs (kept per PR), read-only files with
  the PR's changed lines marked in the gutter, go to definition / references opening in new tabs, and "View diff" back
  to the review. Lists files with `git ls-tree` (trees only, nothing downloaded in the partial clone).
  Links and go to definition to a file the PR did not change open here from any view, with "← Back to review".
- Scroll positions are kept: per file in the diff (switching files or views returns to the same place), per file
  in the code view (scroll and cursor), and per panel tab (Guide, Threads, Conversation…). In memory, not across
  restarts.

### 4.2 Next (in order)

1. **Packaging:** `electron-builder` for macOS (`.dmg`), Linux (`.AppImage`, `.deb`) and Windows. Code signing and notarization come later.
2. **More AI providers:** OpenAI, local models through an OpenAI-compatible endpoint, Claude through Bedrock or Vertex.
3. **Team notifications:** review-request reminders, plus a time-to-first-review metric.
4. **Precise code understanding:** tree-sitter outlines and language servers (LSP) behind the same `symbols.ts` /
   `navigator.ts` functions, for exact definitions and callers (the regex version is fast but approximate).
5. **Syntax-aware formatting check:** compare tree-sitter syntax trees instead of tokens, so whitespace-sensitive
   languages (Python, YAML) and formatter rewrites (`mix format` parentheses) count as formatting too.

### 4.3 Ideas, not planned yet

- "Explain it back" mode: the reviewer summarizes the change before seeing the AI's guide, and PRway compares the two.
- A per-reviewer attention record: which hot spots were actually opened and which were only skimmed.
- GitLab and Bitbucket support.

## 5. Architecture

```
┌──────────── Electron main process (Node) ────────────┐       ┌──── Renderer (React) ────┐
│ github/   REST client (fetch), device-flow login,      │  IPC  │ TopBar   repo picker,    │
│           PRs, notifications poller, access checks     │◄─────►│          bell, ⚙ AI       │
│ git/      bare partial clone, worktree per PR,         │ typed │ PrList   open PRs        │
│           name-status/numstat, file contents           │ API   │ PrView   files | diff    │
│ code/     outlines, definitions, callers, history      │       │          + bottom panel  │
│ review/   noise filter, guide prompt + schema,         │       │ DiffPane Monaco diff,    │
│           guide generation and storage, chat           │       │          comment zones   │
│ kb/       knowledge base of merged PRs                 │       │ Summary, Background, Chat│
│ ai/       AiProvider: Claude Code CLI, Anthropic API   │       └──────────────────────────┘
│ store     settings.json + secrets via safeStorage      │        preload exposes window.prway
└────────────────────────────────────────────────────────┘        (no Node in the renderer)
```

- **Typed IPC contract:** `PrwayApi` in `src/shared/types.ts`. The preload exposes it as `window.prway`.
- **Security:** sandboxed renderer, `contextIsolation`, strict CSP, and no secrets in the UI.
  - The GitHub token and the API key are encrypted with Electron `safeStorage` (Keychain on macOS, the system keyring on Linux).
  - git gets the token through `GIT_CONFIG_*` environment variables, never on the command line.
- **Diffs** are computed locally with git, from the merge base to the PR head (the same comparison GitHub shows). This keeps API calls low.
- **AI calls** use structured output (a JSON schema):
  - Claude Code CLI: `claude -p --output-format json --json-schema … --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence`, run from `~/.prway` so no project `CLAUDE.md` is picked up.
  - Anthropic API: `@anthropic-ai/sdk` streaming, with `output_config.format`, adaptive thinking, and the `fallbacks: "default"` refusal fallback.
- **Prompt:** diffs are annotated with new-file line numbers so the model can cite exact lines. PR content is treated as untrusted data (prompt-injection guard). Long diffs are cut, and the guide lists which files were cut.

### Local data

| Path | Content |
|---|---|
| `~/.prway/repos/<owner>/<repo>.git` | bare partial clone |
| `~/.prway/worktrees/<owner>/<repo>/pr-<n>` | PR checkout |
| `~/.prway/guides/<owner>/<repo>/pr-<n>/<sha>.json` | saved review guides |
| `~/.prway/kb/<owner>/<repo>/` | knowledge base: `entries/pr-<n>.json` (source) and `<domain>.md` (readable), a local git repo |
| `~/.config/prway/` (Linux) · `~/Library/Application Support/prway/` (macOS) | settings.json, encrypted token / API key |

## 6. Tech stack

- Electron 45, electron-vite 6, Vite 8, React 19, TypeScript 7, Monaco Editor 0.57 (`@monaco-editor/react`)
- Node 26 LTS (pinned in `.tool-versions` for asdf)
- `@anthropic-ai/sdk` 1.x. No other runtime dependencies in the main process: GitHub is called with plain `fetch`, git through `child_process`.
- Plain CSS with light/dark theme variables (no Tailwind)

## 7. Key decisions

| Decision | Why |
|---|---|
| Desktop app, not a web app or VS Code extension | The review must be the main view; it needs local git worktrees and an OS keyring |
| Electron over Tauri | One language (TypeScript) for a first UI app; the React UI can move to Tauri later |
| OAuth App (device flow) or classic PAT, not a GitHub App | GitHub's notifications API does not work with GitHub App or fine-grained tokens |
| Own small GitHub client instead of Octokit | Current Octokit is ESM-only and clashes with the CommonJS main bundle |
| Worktree per PR, from a bare partial clone | Several PRs at once, no branch switching, file contents download on demand |
| Claude Code CLI as default AI provider | Uses the reviewer's own Claude subscription, no API key needed |
| Deterministic noise filter before AI | Cheaper, predictable, and the model sees less noise |
| Code navigation from `git grep` + language patterns first | Works on any repo with no per-language install; tree-sitter / LSP can replace it later behind the same functions |
| Review comments as local drafts, sent with the review | One notification for the author, like GitHub's pending review, and drafts survive restarts |
| Knowledge base stored locally as JSON + markdown in a git repo | Versioned and readable; how to share it with a team is still open (see below) |
| Name "PRway" | "Diffscope" and "Reviewport" were already used by other tools; `prway` is free on npm and GitHub |

## 8. Platform notes

- **Linux:** main development platform. Works.
- **macOS:** expected to work, not tested yet. `safeStorage` uses the Keychain, and the git from Xcode Command Line Tools is enough.
  - Known issue: an app opened from Finder or the Dock doesn't get your shell's `PATH`, so `claude` may not be found.
  - Workaround: `PRWAY_CLAUDE_BIN=/path/to/claude`.
  - Fix planned: also search the usual install folders (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`).
- **Claude Code account:** reviews use whatever `CLAUDE_CONFIG_DIR` PRway was started with. Set
  `PRWAY_CLAUDE_CONFIG_DIR` to use a different account for reviews only (`~/.claude` = the default account).
- **Windows:** not tried.

## 9. Open questions

- How should the knowledge base be shared across a team: commit it into the repo (`.prway/kb/`), push the local kb git
  repo somewhere, or a separate store? Today it lives in `~/.prway/kb/` only.
- How much history should go into the AI context before it gets too expensive or slow?
- Should the AI guide show up in GitHub too (one PR comment), or stay private to the reviewer?
- Pricing and distribution if this becomes a product: open source with a paid team tier?
