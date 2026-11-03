import type { GhUser, PullDetail, PullSummary, RepoListing, ReviewEvent } from '../../shared/types'
import { diagnoseAccess } from './access'
import type { GitHub } from './api'

// Only the fields PRway uses from GitHub's REST responses.
interface RawUser {
  login: string
  avatar_url: string
}
interface RawPull {
  number: number
  title: string
  user: RawUser | null
  draft?: boolean
  updated_at: string
  html_url: string
  head: { ref: string; sha: string }
  base: { ref: string; sha: string }
  requested_reviewers?: RawUser[]
  body?: string | null
  additions?: number
  deletions?: number
  changed_files?: number
}

export async function getViewer(gh: GitHub): Promise<GhUser> {
  const u = await gh.get<{ login: string; name: string | null; avatar_url: string }>('/user')
  return { login: u.login, name: u.name, avatarUrl: u.avatar_url }
}

export async function listRepos(gh: GitHub): Promise<RepoListing> {
  const ssoHeaders: (string | null)[] = []
  const raw = await gh.paginate<{
    full_name: string
    private: boolean
    pushed_at: string
    description: string | null
    archived: boolean
  }>('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', 1000, (h) =>
    ssoHeaders.push(h.get('x-github-sso'))
  )
  const repos = raw
    .filter((r) => !r.archived)
    .map((r) => ({ fullName: r.full_name, private: r.private, pushedAt: r.pushed_at, description: r.description }))

  let issues: RepoListing['issues'] = []
  try {
    issues = await diagnoseAccess(gh, ssoHeaders)
  } catch (err) {
    console.warn('[repos] access check failed:', (err as Error).message)
  }
  return { repos, issues }
}

function toSummary(repo: string, p: RawPull, me: string): PullSummary {
  return {
    repo,
    number: p.number,
    title: p.title,
    author: p.user?.login ?? 'ghost',
    authorAvatar: p.user?.avatar_url ?? '',
    draft: !!p.draft,
    updatedAt: p.updated_at,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    url: p.html_url,
    reviewRequested: (p.requested_reviewers ?? []).some((r) => r.login === me)
  }
}

export async function listPulls(gh: GitHub, repo: string, me: string): Promise<PullSummary[]> {
  const raw = await gh.paginate<RawPull>(`/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`, 300)
  return raw.map((p) => toSummary(repo, p, me))
}

export async function getPull(gh: GitHub, repo: string, number: number, me: string): Promise<PullDetail & { baseSha: string }> {
  const p = await gh.get<RawPull>(`/repos/${repo}/pulls/${number}`)
  return {
    ...toSummary(repo, p, me),
    body: p.body ?? null,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
    baseSha: p.base.sha
  }
}

export async function submitReview(
  gh: GitHub,
  repo: string,
  number: number,
  event: ReviewEvent,
  body: string
): Promise<void> {
  if (event !== 'APPROVE' && !body.trim()) throw new Error('A comment is required for this review type')
  await gh.request(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: { event, body } })
}
