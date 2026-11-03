# PRway

Desktop app (Electron + React + TypeScript) for human code review of GitHub PRs. Product spec, roadmap and
key decisions: `docs/SPEC.md`. Read it before planning new features.

## Commands

- `npm install`: install deps; `postinstall` downloads the Electron binary
- `npm run dev`: run with hot reload
- `npm run typecheck`: type-check the main and renderer projects
- `npm run build`: type-check, then bundle into `out/`

Node version is pinned in `.tool-versions` (asdf).

## Layout

- `src/shared/types.ts`: types and the `PrwayApi` IPC contract. Change it first when adding a feature.
- `src/main/`: Electron main process (GitHub client, git worktrees, noise filter, AI guide, AI providers)
- `src/preload/index.ts`: exposes `window.prway`; must match `PrwayApi`
- `src/renderer/src/`: React UI
- Pure modules with no Electron import (`src/main/review/noise.ts`, `src/main/review/guidePrompt.ts`) can be
  run directly with Node 26 (`node file.ts`) for quick checks.

## Rules

- Never commit secrets. The GitHub token and API keys go only through `safeStorage` (`src/main/store.ts`).
- The renderer has no Node access. Everything goes through IPC handlers in `src/main/index.ts`.
- Pass tokens to git through environment variables (`gitEnv` in `worktrees.ts`), never as arguments.
- AI requests use a JSON schema (structured output); keep `GUIDE_SCHEMA` and the `ReviewGuide` type in sync.
- Default model: `claude-opus-5-5`.
