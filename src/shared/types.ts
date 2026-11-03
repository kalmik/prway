// Types shared by the main process (Node side) and the renderer (UI side).

export interface GhUser {
  login: string
  name: string | null
  avatarUrl: string
}

export interface AuthState {
  user: GhUser | null
  /** True when a GitHub OAuth client ID is configured, so "Sign in with GitHub" works. */
  deviceFlowAvailable: boolean
  /** False when the OS keyring is unavailable and the token only lives in memory. */
  tokenPersisted: boolean
}

export interface DeviceCode {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export interface Repo {
  fullName: string
  private: boolean
  pushedAt: string
  description: string | null
}

/** A reason why some repositories (usually an org's) are hidden, with how to fix it. */
export interface AccessIssue {
  kind: 'sso' | 'oauth-restricted' | 'fine-grained-token' | 'missing-scopes'
  org?: string
  message: string
  actionLabel: string
  actionUrl: string
}

export interface RepoListing {
  repos: Repo[]
  issues: AccessIssue[]
}

export interface PullSummary {
  repo: string
  number: number
  title: string
  author: string
  authorAvatar: string
  draft: boolean
  updatedAt: string
  headRef: string
  baseRef: string
  url: string
  /** The signed-in user is a requested reviewer (team requests are not counted yet). */
  reviewRequested: boolean
}

export interface PullDetail extends PullSummary {
  body: string | null
  additions: number
  deletions: number
  changedFiles: number
}

/** Git name-status letters: Added, Modified, Deleted, Renamed, Copied, Type change. */
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

export interface ChangedFile {
  path: string
  oldPath?: string
  status: FileStatus
}

export interface WorktreeInfo {
  path: string
  headSha: string
  mergeBase: string
  files: ChangedFile[]
}

export interface FileDiff {
  original: string
  modified: string
  /** Set when the file is binary or too large to show; contents are then empty. */
  skipped?: 'binary' | 'too-large'
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export interface PrNotification {
  id: string
  repo: string
  prNumber: number | null
  title: string
  /** GitHub reason, e.g. review_requested, mention, comment, state_change. */
  reason: string
  updatedAt: string
  url: string
}

export interface OpenPrRequest {
  repo: string
  number: number
}

/** The API the preload script exposes to the UI as `window.diffscope`. */
export interface DiffscopeApi {
  auth: {
    state(): Promise<AuthState>
    startDeviceFlow(): Promise<DeviceCode>
    waitForDeviceFlow(): Promise<AuthState>
    cancelDeviceFlow(): Promise<void>
    loginWithToken(token: string): Promise<AuthState>
    logout(): Promise<void>
  }
  repos: {
    list(): Promise<RepoListing>
    getSelected(): Promise<string | null>
    setSelected(fullName: string): Promise<void>
  }
  pulls: {
    list(repo: string): Promise<PullSummary[]>
    get(repo: string, number: number): Promise<PullDetail>
    submitReview(repo: string, number: number, event: ReviewEvent, body: string): Promise<void>
  }
  worktree: {
    prepare(repo: string, number: number): Promise<WorktreeInfo>
    fileDiff(repo: string, number: number, file: ChangedFile): Promise<FileDiff>
    reveal(repo: string, number: number): Promise<void>
    remove(repo: string, number: number): Promise<void>
  }
  notifications: {
    list(): Promise<PrNotification[]>
    markRead(id: string): Promise<void>
  }
  openExternal(url: string): Promise<void>
  onNotifications(cb: (items: PrNotification[]) => void): () => void
  onOpenPr(cb: (req: OpenPrRequest) => void): () => void
}
