// One interface for every AI backend. To add a provider (OpenAI, a local model...),
// implement AiProvider and register it in getProvider().

import type { AiEffort, AiProviderId, AiSettings } from '../../shared/types'
import { loadSecret, loadSettings, saveSettings } from '../store'
import { AnthropicApiProvider } from './anthropicApi'
import { ClaudeCodeProvider } from './claudeCode'

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

export const API_KEY_SECRET = 'anthropic-api-key'

const DEFAULTS = { provider: 'claude-code' as AiProviderId, model: 'claude-opus-5-5', effort: 'high' as AiEffort }

export function getAiSettings(): AiSettings {
  const saved = loadSettings().ai
  return { ...DEFAULTS, ...saved, hasApiKey: !!loadSecret(API_KEY_SECRET) }
}

export function saveAiSettings(s: Omit<AiSettings, 'hasApiKey'>): void {
  saveSettings({ ai: { provider: s.provider, model: s.model.trim() || DEFAULTS.model, effort: s.effort } })
}

export function getProvider(id: AiProviderId): AiProvider {
  switch (id) {
    case 'claude-code':
      return new ClaudeCodeProvider()
    case 'anthropic-api': {
      const key = loadSecret(API_KEY_SECRET)
      if (!key) throw new Error('No Anthropic API key saved. Add one in AI settings (⚙).')
      return new AnthropicApiProvider(key)
    }
  }
}
