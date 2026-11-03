// Calls the Claude API directly with an API key (billed per token on your Anthropic Console account).

import Anthropic from '@anthropic-ai/sdk'
import type { AiProvider, StructuredRequest } from './provider'

export class AnthropicApiProvider implements AiProvider {
  readonly id = 'anthropic-api' as const
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async generate<T>(req: StructuredRequest): Promise<T> {
    try {
      // Streaming avoids HTTP timeouts on long diffs; finalMessage() waits for the full answer.
      const message = await this.client.beta.messages
        .stream({
          model: req.model,
          max_tokens: 64000,
          // If a safety classifier declines, the API retries on a fallback model it picks.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }]
        })
        .finalMessage()

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
