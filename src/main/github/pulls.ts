import type {
  DiffSide,
  DraftComment,
  GhUser,
  PullDetail,
  PullSummary,
  RepoListing,
  ReviewComment,
  ReviewEvent,
  ReviewThread
} from '../../shared/types'
import { diagnoseAccess } from './access'
import { GitHubError, type GitHub } from './api'

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

/** Sends a review. Drafts become inline comments, anchored to `commitId` (the head PRway showed). */
export async function submitReview(
  gh: GitHub,
  repo: string,
  number: number,
  event: ReviewEvent,
  body: string,
  comments: DraftComment[],
  commitId: string | null
): Promise<void> {
  if (event !== 'APPROVE' && !body.trim() && !comments.length) {
    throw new Error('Write a comment, or add inline comments, for this review type')
  }
  const payload: Record<string, unknown> = { event, body }
  if (comments.length) {
    if (!commitId) throw new Error('Open the PR files first so PRway knows which commit the comments refer to')
    payload.commit_id = commitId
    payload.comments = comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.startLine && c.startLine < c.line ? { start_line: c.startLine, start_side: c.side } : {}),
      body: c.body
    }))
  }
  try {
    await gh.request(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: payload })
  } catch (err) {
    if (err instanceof GitHubError && err.status === 422 && comments.length) {
      throw new Error(
        `GitHub rejected the review: ${err.apiMessage}. An inline comment may point at a line outside the diff, or the PR got new commits: reload the PR and check your drafts.`
      )
    }
    throw err
  }
}

// ---- Review threads (GraphQL: the REST API has no "resolved" state) ----

interface RawThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  startLine: number | null
  originalLine: number | null
  diffSide: DiffSide
  comments: {
    nodes: {
      databaseId: number
      body: string
      createdAt: string
      url: string
      author: { login: string; avatarUrl: string } | null
    }[]
  }
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine diffSide
          comments(first: 100) { nodes { databaseId body createdAt url author { login avatarUrl } } }
        }
      }
    }
  }
}`

export async function listThreads(gh: GitHub, repo: string, number: number): Promise<ReviewThread[]> {
  const [owner, name] = repo.split('/')
  const threads: ReviewThread[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page++) {
    type Res = {
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawThread[] } } | null }
    }
    const data: Res = await gh.graphql<Res>(THREADS_QUERY, { owner, name, number, cursor })
    const conn = data.repository.pullRequest?.reviewThreads
    if (!conn) break
    for (const t of conn.nodes) {
      threads.push({
        id: t.id,
        path: t.path,
        line: t.isOutdated ? null : t.line,
        startLine: t.isOutdated ? null : t.startLine,
        side: t.diffSide,
        resolved: t.isResolved,
        outdated: t.isOutdated,
        comments: t.comments.nodes.map((c) => ({
          id: c.databaseId,
          author: c.author?.login ?? 'ghost',
          authorAvatar: c.author?.avatarUrl ?? '',
          body: c.body,
          createdAt: c.createdAt,
          url: c.url
        }))
      })
    }
    if (!conn.pageInfo.hasNextPage) break
    cursor = conn.pageInfo.endCursor
  }
  return threads
}

export async function replyToComment(gh: GitHub, repo: string, number: number, commentId: number, body: string): Promise<ReviewComment> {
  if (!body.trim()) throw new Error('The reply is empty')
  const res = await gh.request<{ id: number; body: string; created_at: string; html_url: string; user: RawUser | null }>(
    `/repos/${repo}/pulls/${number}/comments/${commentId}/replies`,
    { method: 'POST', body: { body } }
  )
  const c = res.data
  return { id: c.id, author: c.user?.login ?? 'ghost', authorAvatar: c.user?.avatar_url ?? '', body: c.body, createdAt: c.created_at, url: c.html_url }
}

export async function setThreadResolved(gh: GitHub, threadId: string, resolved: boolean): Promise<void> {
  const mutation = resolved
    ? 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }'
    : 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }'
  await gh.graphql(mutation, { id: threadId })
}

// ---- Data for the knowledge base ----

export interface MergeInfo {
  merged: boolean
  mergedAt: string | null
  headSha: string
  title: string
  url: string
  author: string
  body: string | null
}

export async function getMergeInfo(gh: GitHub, repo: string, number: number): Promise<MergeInfo> {
  const p = await gh.get<RawPull & { merged?: boolean; merged_at?: string | null }>(`/repos/${repo}/pulls/${number}`)
  return {
    merged: !!p.merged_at,
    mergedAt: p.merged_at ?? null,
    headSha: p.head.sha,
    title: p.title,
    url: p.html_url,
    author: p.user?.login ?? 'ghost',
    body: p.body ?? null
  }
}

export async function listReviews(gh: GitHub, repo: string, number: number): Promise<{ reviewer: string; state: string; body: string }[]> {
  const raw = await gh.paginate<{ user: RawUser | null; state: string; body: string | null }>(
    `/repos/${repo}/pulls/${number}/reviews?per_page=100`,
    300
  )
  return raw.map((r) => ({ reviewer: r.user?.login ?? 'ghost', state: r.state, body: r.body ?? '' }))
}

export async function listPrFiles(gh: GitHub, repo: string, number: number): Promise<{ path: string; patch: string }[]> {
  const raw = await gh.paginate<{ filename: string; patch?: string }>(`/repos/${repo}/pulls/${number}/files?per_page=100`, 300)
  return raw.map((f) => ({ path: f.filename, patch: f.patch ?? '' }))
}

/** Review comments of a PR (REST, includes outdated ones), for the context panel's past PRs. */
export async function listReviewComments(
  gh: GitHub,
  repo: string,
  number: number
): Promise<{ path: string; author: string; body: string; url: string }[]> {
  const raw = await gh.paginate<{ path: string; body: string; html_url: string; user: RawUser | null }>(
    `/repos/${repo}/pulls/${number}/comments?per_page=100`,
    300
  )
  return raw.map((c) => ({ path: c.path, author: c.user?.login ?? 'ghost', body: c.body, url: c.html_url }))
}

/** PRs that contain a commit (for history entries whose message doesn't name the PR). */
export async function pullsForCommit(gh: GitHub, repo: string, sha: string): Promise<{ number: number; title: string; url: string }[]> {
  const raw = await gh.get<RawPull[]>(`/repos/${repo}/commits/${sha}/pulls`)
  return raw.map((p) => ({ number: p.number, title: p.title, url: p.html_url }))
}
