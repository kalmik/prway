// Prompt customisation storage and resolution (see promptLayers.ts for how layers combine).
// Your layers live in settings.json under "prompts" ("*" = all repositories); the team layer is the
// repo's .prway.json "prompts", read from the PR base (or, for the settings page, the last fetched base branch).

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PromptKind, PromptLayer, PromptSettingsView } from '../../shared/types'
import { catFiles, git, type WorktreeManager } from '../git/worktrees'
import { dataDir, loadSettings, saveSettings } from '../store'
import { CHAT_SYSTEM, SYSTEM_PROMPT } from './guidePrompt'
import { parseRepoRules, type RepoRules } from './noise'
import { composePrompt, EMPTY_LAYER, parsePromptLayer, type NamedLayer } from './promptLayers'
import { WALKTHROUGH_SYSTEM } from './walkthroughPrompt'

export const BUILT_IN: Record<PromptKind, string> = { guide: SYSTEM_PROMPT, walkthrough: WALKTHROUGH_SYSTEM, chat: CHAT_SYSTEM }

const GLOBAL = '*'

function saved(scope: string): PromptLayer {
  const layer = loadSettings().prompts?.[scope]
  return layer ? { ...EMPTY_LAYER, ...layer, replace: { ...layer.replace } } : { ...EMPTY_LAYER, replace: {} }
}

function layers(repo: string | null, team: PromptLayer | null): NamedLayer[] {
  const out: NamedLayer[] = [{ name: 'your settings for all repositories', layer: saved(GLOBAL) }]
  if (repo) {
    if (team) out.push({ name: "the team's .prway.json", layer: team })
    out.push({ name: `your settings for ${repo}`, layer: saved(repo) })
  }
  return out
}

/** The system prompt for an AI request on `repo`. `rules`: the PR's .prway.json (from its base), if prepared. */
export function systemPrompt(kind: PromptKind, repo: string | null, rules: RepoRules | null): { system: string; hash: string } {
  return composePrompt(kind, BUILT_IN[kind], layers(repo, parsePromptLayer(rules?.prompts)))
}

/** .prway.json "prompts" from the most recently fetched base branch of the repo, for the settings page. */
async function teamLayer(worktrees: WorktreeManager, repo: string): Promise<{ layer: PromptLayer | null; source: string | null }> {
  const dir = worktrees.repoDir(repo)
  if (!existsSync(dir)) return { layer: null, source: null }
  const ref = (await git(['for-each-ref', '--sort=-committerdate', '--count=1', '--format=%(refname)', 'refs/prway/base/'], dir).catch(() => '')).trim()
  if (!ref) return { layer: null, source: null }
  const blob = (await catFiles(dir, [`${ref}:.prway.json`]).catch(() => null))?.get(`${ref}:.prway.json`)
  if (!blob) return { layer: null, source: null }
  try {
    const layer = parsePromptLayer(parseRepoRules(blob.toString('utf8')).prompts)
    return { layer, source: `${ref.replace('refs/prway/base/', '')}:.prway.json` }
  } catch {
    return { layer: null, source: `${ref.replace('refs/prway/base/', '')}:.prway.json (invalid JSON)` }
  }
}

/** Repositories PRway has data for, plus the selected one. */
function knownRepos(): string[] {
  const found = new Set<string>()
  const selected = loadSettings().selectedRepo
  if (selected) found.add(selected)
  for (const root of ['worktrees', 'guides', 'repos']) {
    const base = join(dataDir, root)
    if (!existsSync(base)) continue
    for (const owner of readdirSync(base)) {
      const ownerDir = join(base, owner)
      try {
        for (const name of readdirSync(ownerDir)) found.add(`${owner}/${name.replace(/\.git$/, '')}`)
      } catch {
        /* not a folder */
      }
    }
  }
  for (const key of Object.keys(loadSettings().prompts ?? {})) if (key !== GLOBAL) found.add(key)
  return [...found].sort()
}

export async function promptsView(worktrees: WorktreeManager, repo: string | null): Promise<PromptSettingsView> {
  const team = repo ? await teamLayer(worktrees, repo) : { layer: null, source: null }
  return {
    repo,
    personal: saved(repo ?? GLOBAL),
    global: repo ? saved(GLOBAL) : null,
    team: team.layer,
    teamSource: team.source,
    builtIn: BUILT_IN,
    repos: knownRepos()
  }
}

export function savePrompts(repo: string | null, layer: PromptLayer): void {
  const all = { ...(loadSettings().prompts ?? {}) }
  const clean: PromptLayer = {
    context: layer.context.trim(),
    guide: layer.guide.trim(),
    walkthrough: layer.walkthrough.trim(),
    chat: layer.chat.trim(),
    replace: { guide: !!layer.replace.guide, walkthrough: !!layer.replace.walkthrough, chat: !!layer.replace.chat }
  }
  const empty = !clean.context && !clean.guide && !clean.walkthrough && !clean.chat
  if (empty) delete all[repo ?? GLOBAL]
  else all[repo ?? GLOBAL] = clean
  saveSettings({ prompts: all })
}

/** For the preview on the settings page: the team layer as the settings page sees it. */
export async function previewPrompt(worktrees: WorktreeManager, repo: string | null, kind: PromptKind): Promise<string> {
  const team = repo ? (await teamLayer(worktrees, repo)).layer : null
  return composePrompt(kind, BUILT_IN[kind], layers(repo, team)).system
}
