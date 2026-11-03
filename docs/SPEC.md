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

### 4.2 Next (in order)

1. **Inline review comments.** Click a diff line to comment. Comments collect in a pending review and are submitted together. Existing threads show on their lines.
2. **Code navigation in the worktree.** tree-sitter symbols and "go to definition" first, then language servers (LSP) for exact definitions and callers.
3. **Better noise filter:**
   - moved code inside and between files (git `--color-moved`)
   - formatting changes beyond whitespace, by comparing syntax trees (tree-sitter)
   - per-repo rules in a `.prway.json`
4. **Context panel**, for each changed function:
   - history: `git log -L`, past PRs and their review discussions
   - usage: callers, and tests that cover it
   - feed this context into the AI guide
5. **Knowledge base.** After a PR merges, save its intent, the business rules changed and the review decisions:
   - store them as markdown per domain or path, for example `.prway/kb/pricing.md`, so they're versioned and reviewable
   - index them by file and symbol
   - show related entries when a later PR touches the same code
6. **Packaging:** `electron-builder` for macOS (`.dmg`), Linux (`.AppImage`, `.deb`) and Windows. Code signing and notarization come later.
7. **More AI providers:** OpenAI, local models through an OpenAI-compatible endpoint, Claude through Bedrock or Vertex.
8. **Team notifications:** review-request reminders, plus a time-to-first-review metric.

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
│           name-status/numstat, file contents           │ API   │ PrView   files | diff |  │
│ review/   noise filter, guide prompt + schema,         │       │          guide panel     │
│           guide generation and storage                 │       │ Monaco DiffEditor        │
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
| Name "PRway" | "Diffscope" and "Reviewport" were already used by other tools; `prway` is free on npm and GitHub |

## 8. Platform notes

- **Linux:** main development platform. Works.
- **macOS:** expected to work, not tested yet. `safeStorage` uses the Keychain, and the git from Xcode Command Line Tools is enough.
  - Known issue: an app opened from Finder or the Dock doesn't get your shell's `PATH`, so `claude` may not be found.
  - Workaround: `PRWAY_CLAUDE_BIN=/path/to/claude`.
- **Claude Code account:** reviews use whatever `CLAUDE_CONFIG_DIR` PRway was started with. Set
  `PRWAY_CLAUDE_CONFIG_DIR` to use a different account for reviews only (`~/.claude` = the default account).
  - Fix planned: also search the usual install folders (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`).
- **Windows:** not tried.

## 9. Open questions

- How should the knowledge base be shared across a team: in the repo (`.prway/kb/`) or in a separate store?
- How much history should go into the AI context before it gets too expensive or slow?
- Should the AI guide show up in GitHub too (one PR comment), or stay private to the reviewer?
- Pricing and distribution if this becomes a product: open source with a paid team tier?
