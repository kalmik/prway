// Function cards: what PRway knows about a function (a short summary and its rules), written by the AI while
// explaining a PR and editable by you. A card belongs to a version of the code (its key hashes the path, name
// and code), so it is reused in any PR while the function stays the same. Your edits win over the AI's.
//
// On disk: ~/.prway/trace/<owner>/<repo>/cards/<hash of id>.json, the newest versions first.

import { join } from 'node:path'
import type { FunctionCard } from '../../shared/types'
import { hash, readJson, traceDir, writeJson } from './facts'

const KEEP_VERSIONS = 10

interface CardFile {
  id: string
  versions: FunctionCard[]
}

const fileOf = (repo: string, id: string) => join(traceDir(repo), 'cards', `${hash(id)}.json`)

export class CardStore {
  constructor(private repo: string) {}

  /**
   * The card for this version of the function. Without one, your latest edit of an older version (marked
   * outdated), so what you wrote isn't lost when the code changes.
   */
  get(id: string, key: string): FunctionCard | null {
    const versions = readJson<CardFile>(fileOf(this.repo, id))?.versions ?? []
    const exact = versions.filter((c) => c.key === key)
    const pick = exact.find((c) => c.source === 'edited') ?? exact[0]
    if (pick) return pick
    const edited = versions.find((c) => c.source === 'edited')
    return edited ? { ...edited, outdated: true } : null
  }

  put(card: Omit<FunctionCard, 'updatedAt' | 'outdated'>): FunctionCard {
    const p = fileOf(this.repo, card.id)
    const versions = readJson<CardFile>(p)?.versions ?? []
    const saved: FunctionCard = { ...card, updatedAt: new Date().toISOString() }
    // An AI card never replaces your edit of the same version.
    if (card.source === 'ai' && versions.some((c) => c.key === card.key && c.source === 'edited')) {
      return versions.find((c) => c.key === card.key && c.source === 'edited')!
    }
    const rest = versions.filter((c) => !(c.key === card.key && (c.source === card.source || card.source === 'edited')))
    writeJson(p, { id: card.id, versions: [saved, ...rest].slice(0, KEEP_VERSIONS) } satisfies CardFile)
    return saved
  }
}
