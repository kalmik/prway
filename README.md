# Diffscope

A desktop app for **human** code review of GitHub pull requests: the review is the main view,
every PR gets its own git worktree, and GitHub notifications for your PRs show up on your desktop.

> Name note: an open-source CLI called "diffscope" already exists (a Rust AI review engine).
> Check for conflicts before publishing under this name.

## Run it

```bash
asdf install            # Node 26 LTS, pinned in .tool-versions
npm install             # also downloads the Electron binary
npm run dev             # start the app with hot reload
```

Other scripts: `npm run typecheck`, `npm run build` (type-check and bundle into `out/`), `npm run preview`.

## Signing in

Two options:

1. **Personal access token (quickest):** create a *classic* token with the scopes `repo`, `read:org`,
   `notifications` and paste it into the login screen. Fine-grained tokens can't read notifications.
2. **"Sign in with GitHub" button (device flow):**
   1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
      Any homepage and callback URL works, for example `http://localhost`.
   2. Tick **Enable Device Flow** and save.
   3. `cp .env.example .env` and set `MAIN_VITE_GITHUB_CLIENT_ID` to the app's Client ID. It isn't a secret.
   4. Restart `npm run dev`.

The token is encrypted with your system keyring (Electron `safeStorage`). The UI never sees it.

## What works (milestone 1)

- Sign in with GitHub, pick a repository, list its open PRs ("For me" = your review is requested).
- Open a PR: Diffscope fetches it into its own **git worktree** and shows every changed file in a side-by-side
  diff (Monaco, the VS Code editor). Unchanged regions are folded, and you can hide whitespace-only changes.
- Mark files as **viewed**. Progress is saved per PR head commit, so new commits reset it.
- Submit a review: comment, approve or request changes.
- **Notifications:** the bell shows unread GitHub PR notifications. New ones also appear as desktop notifications,
  and clicking one opens that PR.
- "Open worktree folder" opens the PR checkout, so you can also open it in your IDE.

## Where things live

```
~/.diffscope/repos/<owner>/<name>.git          bare, partial clone (file contents download on demand)
~/.diffscope/worktrees/<owner>/<name>/pr-<n>   one checkout per PR
```

## Code map

```
src/shared/types.ts          types + the API contract between UI and backend
src/main/index.ts            Electron main process: window, IPC handlers, desktop notifications
src/main/github/             GitHub REST client, device-flow login, PRs, notification poller
src/main/git/worktrees.ts    clone / fetch / worktree / file contents per PR
src/main/store.ts            settings + encrypted token
src/preload/index.ts         exposes window.diffscope to the UI (no Node access in the UI)
src/renderer/src/            React UI (App, TopBar, PrList, PrView, ReviewBox)
```

## Next steps

1. Inline review comments on diff lines (GitHub's pending review API).
2. Code navigation inside the worktree: tree-sitter symbols first, then language servers (LSP) for exact jumps.
3. Noise filter: detect formatting-only changes, moved code and generated files, and group them as "skip".
4. AI review guide: intent of the change, reading order, hot spots, and where the business rules change.
5. Context panel: history of the changed functions (past PRs and their review discussions) and who calls them.
6. Knowledge base: save decisions and business rules from each merged PR and show them on future PRs.
