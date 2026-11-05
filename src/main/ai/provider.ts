// One interface for every AI backend. To add a provider (OpenAI, a local model...),
// implement AiProvider and register it in getProvider().

import type { AiAccount, AiConfig, AiEffort, AiInUse, AiProviderId, ClaudeSignIn } from '../../shared/types'
import { clearSecret, loadSecret, loadSettings, saveSecret, saveSettings } from '../store'
import { AnthropicApiProvider } from './anthropicApi'
import { ClaudeCodeProvider, claudeSignIn } from './claudeCode'

export interface StructuredRequest {
  system: string
  /**
   * The stable start of the prompt (e.g. the PR material), sent before `prompt`. Providers that support it
   * cache it, so follow-up requests with the same prefix are cheaper and faster.
   */
  prefix?: string
  prompt: string
  /**
   * Keep the conversation in a provider-side session (Claude Code). On `resume`, the session already holds the
   * earlier turns, so only `prompt` (the new turn) is sent and `prefix` is skipped.
   */
  session?: { id: string; resume: boolean }
  /**
   * Lets the model read the code itself (read-only): `dir` is the PR's checkout at its head. Claude Code uses its
   * own Read/Grep/Glob tools there; the API gets PRway's read_file/grep/list_files tools.
   */
  code?: { dir: string }
  /** JSON Schema the answer must follow. */
  schema: Record<string, unknown>
  model: string
  effort: AiEffort
}

export interface AiProvider {
  readonly id: AiProviderId
  /** Returns the parsed JSON answer. Throws with a readable message on failure. */
  generate<T>(req: StructuredRequest): Promise<T>
}

/** The API key from before AI accounts (moved to the "default" account). */
const LEGACY_API_KEY_SECRET = 'anthropic-api-key'
export const apiKeySecret = (accountId: string) => `anthropic-api-key-${accountId}`

const DEFAULTS = { provider: 'claude-code' as AiProviderId, model: 'claude-opus-5-5', effort: 'high' as AiEffort }

type StoredAccount = Omit<AiAccount, 'hasApiKey'>
type Stored = { accounts: StoredAccount[]; defaultAccount: string; orgs: Record<string, string> }

/** The saved accounts; the first time, one "Default" account made from the old single AI setting. */
function stored(): Stored {
  const saved = loadSettings()
  if (saved.aiAccounts?.accounts.length) return saved.aiAccounts
  const old = { ...DEFAULTS, ...saved.ai }
  const first: StoredAccount = {
    id: 'default',
    name: 'Default',
    provider: old.provider,
    // PRWAY_CLAUDE_CONFIG_DIR used to pick the Claude Code account for reviews.
    claudeConfigDir: process.env.PRWAY_CLAUDE_CONFIG_DIR?.trim() || null,
    model: old.model,
    effort: old.effort
  }
  const legacyKey = loadSecret(LEGACY_API_KEY_SECRET)
  if (legacyKey) saveSecret(apiKeySecret(first.id), legacyKey)
  const made: Stored = { accounts: [first], defaultAccount: first.id, orgs: {} }
  saveSettings({ aiAccounts: made })
  return made
}

const withKey = (a: StoredAccount): AiAccount => ({ ...a, hasApiKey: a.provider === 'anthropic-api' && !!loadSecret(apiKeySecret(a.id)) })

export function aiConfig(): AiConfig {
  const s = stored()
  const accounts = s.accounts.map(withKey)
  const signIns: Record<string, ClaudeSignIn> = {}
  for (const a of accounts) if (a.provider === 'claude-code') signIns[a.id] = claudeSignIn(a.claudeConfigDir)
  return { accounts, defaultAccount: s.defaultAccount, orgs: s.orgs, signIns }
}

function update(fn: (s: Stored) => Stored): AiConfig {
  saveSettings({ aiAccounts: fn(stored()) })
  return aiConfig()
}

export function saveAccount(account: StoredAccount, apiKey?: string | null): AiConfig {
  const clean: StoredAccount = {
    id: account.id.trim() || `acc-${Date.now().toString(36)}`,
    name: account.name.trim() || 'Untitled',
    provider: account.provider,
    claudeConfigDir: account.provider === 'claude-code' ? account.claudeConfigDir?.trim() || null : null,
    model: account.model.trim() || DEFAULTS.model,
    effort: account.effort
  }
  if (apiKey === null) clearSecret(apiKeySecret(clean.id))
  else if (typeof apiKey === 'string' && apiKey.trim()) {
    if (!saveSecret(apiKeySecret(clean.id), apiKey.trim())) throw new Error('No system keyring available to store the API key safely.')
  }
  return update((s) => {
    const i = s.accounts.findIndex((a) => a.id === clean.id)
    const accounts = i >= 0 ? s.accounts.map((a, j) => (j === i ? clean : a)) : [...s.accounts, clean]
    return { ...s, accounts }
  })
}

export function deleteAccount(id: string): AiConfig {
  const s = stored()
  if (s.defaultAccount === id) throw new Error('This is the default account: make another one the default first.')
  clearSecret(apiKeySecret(id))
  return update((st) => ({
    ...st,
    accounts: st.accounts.filter((a) => a.id !== id),
    orgs: Object.fromEntries(Object.entries(st.orgs).filter(([, acc]) => acc !== id))
  }))
}

export function setDefaultAccount(id: string): AiConfig {
  return update((s) => {
    if (!s.accounts.some((a) => a.id === id)) throw new Error('Unknown account')
    return { ...s, defaultAccount: id }
  })
}

export function linkOrg(org: string, accountId: string | null): AiConfig {
  const key = org.trim()
  if (!key) throw new Error('Name the organization')
  return update((s) => {
    const orgs = { ...s.orgs }
    if (accountId) orgs[key] = accountId
    else delete orgs[key]
    return { ...s, orgs }
  })
}

/** The account for AI requests on `repo` ("owner/name"): the owner's link, else the default. */
export function aiFor(repo: string | null): AiInUse {
  const s = stored()
  const org = repo?.split('/')[0] ?? ''
  const linked = org ? s.accounts.find((a) => a.id === s.orgs[org]) : undefined
  const account = withKey(linked ?? s.accounts.find((a) => a.id === s.defaultAccount) ?? s.accounts[0])
  return {
    account,
    signIn: account.provider === 'claude-code' ? claudeSignIn(account.claudeConfigDir) : null,
    org,
    source: linked ? 'org' : 'default'
  }
}

/** What an AI request needs: the account and its model and effort. */
export interface AiRun {
  account: AiAccount
  provider: AiProviderId
  model: string
  effort: AiEffort
}

export function getAiSettings(repo: string | null): AiRun {
  const { account } = aiFor(repo)
  return { account, provider: account.provider, model: account.model, effort: account.effort }
}

export function accountById(id: string): AiRun {
  const a = aiConfig().accounts.find((x) => x.id === id)
  if (!a) throw new Error('Unknown account')
  return { account: a, provider: a.provider, model: a.model, effort: a.effort }
}

export function getProvider(run: AiRun): AiProvider {
  switch (run.provider) {
    case 'claude-code':
      return new ClaudeCodeProvider(run.account.claudeConfigDir)
    case 'anthropic-api': {
      const key = loadSecret(apiKeySecret(run.account.id))
      if (!key) throw new Error(`No Anthropic API key saved for the AI account "${run.account.name}". Add one in Settings → AI accounts.`)
      return new AnthropicApiProvider(key)
    }
  }
}
