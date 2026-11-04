// Chat about a PR: the reviewer asks questions, the model answers with the diff, the guide and the
// repository context in front of it.
//
// How follow-ups stay cheap:
//   Claude Code   a real session per conversation: the first message sends the PR material, follow-ups resume
//                 the session and send only the new question
//   Anthropic API stateless, but the PR material is a cached prompt prefix, so follow-ups read it from the cache
// The conversation PRway shows is the source of truth: if it no longer matches the session (cleared, edited,
// new commits, other instructions), a fresh session starts with the whole conversation.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangedFile, ChatCodeRef, ChatMessage, PullDetail, ReviewGuide } from '../../shared/types'
import { getAiSettings, getProvider } from '../ai/provider'
import { dataDir } from '../store'
import { prMaterial, type GuideDeps } from './guide'
import { briefingPromptText, loadBriefing } from '../trace/briefing'
import { systemPrompt } from './prompts'

const MAX_TURNS = 20

const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string', description: 'The reply to the last question, in markdown.' } }
}

/** A Claude Code session for one PR's conversation. */
interface ChatSession {
  id: string
  /** Hash of the system prompt + PR material the session started with. */
  material: string
  /** Hash of the conversation the session has seen (questions and answers). */
  conversation: string
}

const sessionsFile = () => join(dataDir, 'chat-sessions.json')

function loadSessions(): Record<string, ChatSession> {
  try {
    return existsSync(sessionsFile()) ? (JSON.parse(readFileSync(sessionsFile(), 'utf8')) as Record<string, ChatSession>) : {}
  } catch {
    return {}
  }
}

function saveSession(key: string, session: ChatSession | null): void {
  const all = loadSessions()
  if (session) all[key] = session
  else delete all[key]
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(sessionsFile(), JSON.stringify(all, null, 2))
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16)

/** Code the reviewer attached, with line numbers, so the model knows exactly which lines are meant. */
function refBlock(r: ChatCodeRef): string {
  const version = r.side === 'base' ? 'before this PR (base)' : "in this PR's version (head)"
  const numbered = r.code
    .split('\n')
    .map((line, i) => `${r.startLine + i}| ${line}`)
    .join('\n')
  const where = r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}-${r.endLine}`
  return `[The reviewer points at ${r.path} ${where}, ${version}:]\n\`\`\`\n${numbered}\n\`\`\``
}

/** A message as the model sees it: attached code first, then the text. */
const messageText = (m: ChatMessage) => [...(m.refs ?? []).map(refBlock), m.text].join('\n')

const conversationHash = (messages: ChatMessage[]) => hash(messages.map((m) => `${m.role}:${messageText(m)}`).join('\u0000'))
const transcript = (messages: ChatMessage[]) =>
  messages
    .slice(-MAX_TURNS)
    .map((m) => `${m.role === 'user' ? 'REVIEWER' : 'YOU'}: ${messageText(m)}`)
    .join('\n\n')

export async function chat(
  deps: GuideDeps,
  pull: PullDetail,
  files: ChangedFile[],
  guide: ReviewGuide | null,
  messages: ChatMessage[]
): Promise<ChatMessage> {
  const last = messages.at(-1)
  if (!last || last.role !== 'user' || !last.text.trim()) throw new Error('Ask a question first')
  const settings = getAiSettings()
  const provider = getProvider(settings.provider)
  const { prompt } = await prMaterial(deps, pull, files)
  const guideText = guide
    ? `\nREVIEW GUIDE (made earlier by AI):\n${JSON.stringify({ intent: guide.intent, businessRules: guide.businessRules, mismatches: guide.mismatches, files: guide.files, questions: guide.questions })}`
    : ''
  const head = deps.worktrees.headSha(pull.repo, pull.number)
  const background = briefingPromptText(head ? loadBriefing(pull.repo, pull.number, head) : null)
  const briefingText = background ? `\nBACKGROUND (how the changed code worked before this PR, traced by PRway):\n${background}` : ''
  const system = systemPrompt('chat', pull.repo, deps.worktrees.rulesOrNull(pull.repo, pull.number)).system
  // The stable part: the same for every question about this PR (until new commits or a new guide).
  const prefix = `${prompt}${guideText}${briefingText}\n\n`
  const base = {
    system,
    schema: CHAT_SCHEMA,
    model: settings.model,
    // Chat should feel quick; the guide is where deep thinking goes.
    effort: settings.effort === 'max' || settings.effort === 'xhigh' ? ('high' as const) : settings.effort
  }

  if (provider.id !== 'claude-code') {
    const answer = await provider.generate<{ answer: string }>({
      ...base,
      prefix,
      prompt: `CONVERSATION SO FAR (answer the last REVIEWER message):\n${transcript(messages)}`
    })
    return { role: 'assistant', text: answer.answer }
  }

  // Claude Code: resume the PR's session when it has seen exactly the conversation before this question.
  const key = `${pull.repo}#${pull.number}`
  const material = hash(`${settings.model}\n${system}\n${prefix}`)
  const saved = loadSessions()[key]
  const before = messages.slice(0, -1)
  const canResume = !!saved && saved.material === material && saved.conversation === conversationHash(before)

  const ask = async (resume: boolean, id: string) =>
    provider.generate<{ answer: string }>({
      ...base,
      prefix,
      session: { id, resume },
      prompt: resume
        ? `REVIEWER: ${messageText(last)}\n\n(Answer this new question about the same pull request.)`
        : `CONVERSATION SO FAR (answer the last REVIEWER message):\n${transcript(messages)}`
    })

  let id = canResume ? saved.id : randomUUID()
  let answer: { answer: string }
  try {
    answer = await ask(canResume, id)
  } catch (err) {
    if (!canResume) throw err
    // The session is gone (e.g. Claude Code's data was cleared): start again with the whole conversation.
    console.warn('[chat] resume failed, starting a new session:', (err as Error).message)
    id = randomUUID()
    answer = await ask(false, id)
  }
  const reply: ChatMessage = { role: 'assistant', text: answer.answer }
  saveSession(key, { id, material, conversation: conversationHash([...messages, reply]) })
  return reply
}
