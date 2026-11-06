import type {
  ConversationItem,
  DiffSide,
  DraftComment,
  GhUser,
  PullDetail,
  PullSummary,
  RepoListing,
  ReviewComment,
  ReviewEvent,
  ReviewThread,
  SubmitResult
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
  const mine = await myReviews(gh, repo, me).catch((err) => {
    console.warn('[pulls] could not read your reviews:', (err as Error).message)
    return new Map<number, PullSummary['myReview']>()
  })
  return raw.map((p) => ({ ...toSummary(repo, p, me), myReview: mine.get(p.number) }))
}

/** Your latest review on each open PR, in one GraphQL query (up to 100 most recently updated PRs). */
async function myReviews(gh: GitHub, repo: string, me: string): Promise<Map<number, PullSummary['myReview']>> {
  const [owner, name] = repo.split('/')
  type Res = {
    repository: {
      pullRequests: {
        nodes: {
          number: number
          headRefOid: string
          reviews: { nodes: { state: string; commit: { oid: string } | null }[] }
        }[]
      }
    }
  }
  const data = await gh.graphql<Res>(
    `query($owner: String!, $name: String!, $me: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number headRefOid
            reviews(author: $me, last: 10) { nodes { state commit { oid } } }
          }
        }
      }
    }`,
    { owner, name, me }
  )
  const out = new Map<number, PullSummary['myReview']>()
  for (const pr of data.repository.pullRequests.nodes) {
    // The last review that took a position; plain comments after an approval don't undo it.
    const reviews = pr.reviews.nodes.filter((r) => r.state !== 'PENDING')
    const decisive = [...reviews].reverse().find((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED')
    const latest = decisive ?? reviews.at(-1)
    if (!latest) continue
    out.set(pr.number, {
      state: latest.state as NonNullable<PullSummary['myReview']>['state'],
      stale: !!latest.commit && latest.commit.oid !== pr.headRefOid
    })
  }
  return out
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

/** A link to lines at a commit; GitHub shows it as a code snippet when it sits on its own line. */
export function codeLink(repo: string, sha: string, path: string, line: number, startLine?: number): string {
  const lines = startLine && startLine < line ? `L${startLine}-L${line}` : `L${line}`
  return `https://github.com/${repo}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}#${lines}`
}

/**
 * Sends the review: drafts on diff lines go in it as inline comments; drafts outside the diff (GitHub takes line
 * comments only there) follow it one by one as file comments that start with a link to their lines.
 */
export async function submitReview(
  gh: GitHub,
  repo: string,
  number: number,
  event: ReviewEvent,
  body: string,
  comments: DraftComment[],
  commitId: string | null
): Promise<SubmitResult> {
  if (event !== 'APPROVE' && !body.trim() && !comments.length) {
    throw new Error('Write a comment, or add inline comments, for this review type')
  }
  if (comments.length && !commitId) throw new Error('Open the PR files first so PRway knows which commit the comments refer to')
  const inline = comments.filter((c) => !c.outside)
  const outside = comments.filter((c) => c.outside)
  // A plain comment review with nothing in it but file comments: those are enough on their own.
  if (inline.length || body.trim() || event !== 'COMMENT') {
    const payload: Record<string, unknown> = { event, body }
    if (inline.length) {
      payload.commit_id = commitId
      payload.comments = inline.map((c) => ({
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
      if (err instanceof GitHubError && err.status === 422 && inline.length) {
        throw new Error(
          `GitHub rejected the review: ${err.apiMessage}. An inline comment may point at a line outside the diff, or the PR got new commits: reload the PR and check your drafts.`
        )
      }
      throw err
    }
  }
  const notSent: string[] = []
  let error: string | null = null
  for (const c of outside) {
    try {
      await gh.request(`/repos/${repo}/pulls/${number}/comments`, {
        method: 'POST',
        body: {
          commit_id: commitId,
          path: c.path,
          subject_type: 'file',
          // The link points at the commit the line numbers were written on.
          body: `${codeLink(repo, c.headSha || commitId!, c.path, c.line, c.startLine)}\n\n${c.body}`
        }
      })
    } catch (err) {
      notSent.push(c.id)
      error ??= err instanceof GitHubError ? err.apiMessage : (err as Error).message
    }
  }
  return {
    notSent,
    error: notSent.length
      ? `${notSent.length} comment${notSent.length > 1 ? 's' : ''} outside the diff could not be sent (kept as draft${notSent.length > 1 ? 's' : ''}): ${error}`
      : null
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
      diffHunk: string
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
          comments(first: 100) { nodes { databaseId body createdAt url diffHunk author { login avatarUrl } } }
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
        originalLine: t.originalLine,
        diffHunk: t.comments.nodes[0]?.diffHunk ?? '',
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

// ---- Conversation: description, general comments, review summaries ----

interface RawIssueComment {
  id: number
  body: string | null
  created_at: string
  html_url: string
  user: RawUser | null
}

const fromIssueComment = (c: RawIssueComment): ConversationItem => ({
  kind: 'comment',
  id: `c${c.id}`,
  author: c.user?.login ?? 'ghost',
  authorAvatar: c.user?.avatar_url ?? '',
  body: c.body ?? '',
  createdAt: c.created_at,
  url: c.html_url
})

export async function listConversation(gh: GitHub, repo: string, number: number): Promise<ConversationItem[]> {
  type RawReview = { id: number; body: string | null; state: string; submitted_at?: string; html_url: string; user: RawUser | null }
  const [pull, comments, reviews, inline] = await Promise.all([
    gh.get<RawPull & { created_at: string }>(`/repos/${repo}/pulls/${number}`),
    gh.paginate<RawIssueComment>(`/repos/${repo}/issues/${number}/comments?per_page=100`, 500),
    gh.paginate<RawReview>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`, 300),
    gh.paginate<{ pull_request_review_id: number | null }>(`/repos/${repo}/pulls/${number}/comments?per_page=100`, 1000)
  ])
  const inlinePerReview = new Map<number, number>()
  for (const c of inline) if (c.pull_request_review_id) inlinePerReview.set(c.pull_request_review_id, (inlinePerReview.get(c.pull_request_review_id) ?? 0) + 1)

  const items: ConversationItem[] = [
    {
      kind: 'description',
      id: 'description',
      author: pull.user?.login ?? 'ghost',
      authorAvatar: pull.user?.avatar_url ?? '',
      body: pull.body ?? '',
      createdAt: pull.created_at,
      url: pull.html_url
    },
    ...comments.map(fromIssueComment),
    // A review with no text and only inline comments still says who approved or asked for changes.
    ...reviews
      .filter((r) => r.state !== 'PENDING' && (r.body?.trim() || r.state !== 'COMMENTED'))
      .map((r) => ({
        kind: 'review' as const,
        id: `r${r.id}`,
        author: r.user?.login ?? 'ghost',
        authorAvatar: r.user?.avatar_url ?? '',
        body: r.body ?? '',
        createdAt: r.submitted_at ?? pull.created_at,
        url: r.html_url,
        state: r.state,
        inlineCount: inlinePerReview.get(r.id) ?? 0
      }))
  ]
  return items.sort((a, b) => (a.kind === 'description' ? -1 : b.kind === 'description' ? 1 : a.createdAt.localeCompare(b.createdAt)))
}

export async function postComment(gh: GitHub, repo: string, number: number, body: string): Promise<ConversationItem> {
  if (!body.trim()) throw new Error('The comment is empty')
  const res = await gh.request<RawIssueComment>(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } })
  return fromIssueComment(res.data)
}

// ---- Data for the knowledge base ----

export interface MergeInfo {
  /** Still open on GitHub. */
  open: boolean
  merged: boolean
  mergedAt: string | null
  headSha: string
  title: string
  url: string
  author: string
  body: string | null
}

export async function getMergeInfo(gh: GitHub, repo: string, number: number): Promise<MergeInfo> {
  const p = await gh.get<RawPull & { merged?: boolean; merged_at?: string | null; state?: string }>(`/repos/${repo}/pulls/${number}`)
  return {
    open: p.state === 'open',
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
