// Calls the Claude API directly with an API key (billed per token on your Anthropic Console account).

import Anthropic from '@anthropic-ai/sdk'
import { CODE_TOOLS, runCodeTool } from './codeTools'
import type { AiProvider, StructuredRequest } from './provider'

/** Most tool rounds per answer; after that, tool use is switched off so the model has to answer. */
const MAX_TOOL_ROUNDS = 12

export class AnthropicApiProvider implements AiProvider {
  readonly id = 'anthropic-api' as const
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async generate<T>(req: StructuredRequest): Promise<T> {
    try {
      // The prefix (e.g. the PR material) is marked for prompt caching: follow-ups that start the same way
      // read it from the cache instead of paying for it again. The API keeps no session; the prompt carries it all.
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        {
          role: 'user',
          content: req.prefix
            ? [
                { type: 'text', text: req.prefix, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: req.prompt }
              ]
            : req.prompt
        }
      ]
      let message: Anthropic.Beta.BetaMessage
      for (let round = 0; ; round++) {
        // Streaming avoids HTTP timeouts on long diffs; finalMessage() waits for the full answer.
        message = await this.client.beta.messages
          .stream({
            model: req.model,
            max_tokens: 64000,
            // If a safety classifier declines, the API retries on a fallback model it picks.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            thinking: { type: 'adaptive' },
            output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
            system: req.system,
            ...(req.code ? { tools: CODE_TOOLS, tool_choice: { type: round < MAX_TOOL_ROUNDS ? 'auto' : 'none' } as const } : {}),
            messages
          })
          .finalMessage()
        if (message.stop_reason !== 'tool_use' || !req.code) break
        // Run the tools the model asked for and send the results back (thinking blocks included, unchanged).
        messages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] })
        const dir = req.code.dir
        const results = await Promise.all(
          message.content
            .filter((b) => b.type === 'tool_use')
            .map(async (b) => ({
              type: 'tool_result' as const,
              tool_use_id: b.id,
              content: await runCodeTool(dir, b.name, (b.input ?? {}) as Record<string, unknown>)
            }))
        )
        messages.push({ role: 'user', content: results })
      }

      if (message.stop_reason === 'refusal') {
        throw new Error(`Claude declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ''}.`)
      }
      if (message.stop_reason === 'max_tokens') throw new Error('The answer was cut off (max tokens reached).')

      const text = message.content.find((b) => b.type === 'text')
      if (!text || text.type !== 'text') throw new Error('Claude returned no answer.')
      return JSON.parse(text.text) as T
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic API key is invalid.')
      if (err instanceof Anthropic.PermissionDeniedError) throw new Error('This API key cannot use that model.')
      if (err instanceof Anthropic.NotFoundError) throw new Error(`Unknown model "${req.model}".`)
      if (err instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the Anthropic API, try again shortly.')
      if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status}: ${err.message}`)
      throw err
    }
  }
}
