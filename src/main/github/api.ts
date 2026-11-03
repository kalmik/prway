// A small GitHub REST client built on fetch. Enough for Diffscope's needs, no extra dependency.

const API = 'https://api.github.com'

export interface GhResponse<T> {
  status: number
  data: T
  headers: Headers
}

export class GitHubError extends Error {
  constructor(
    public status: number,
    public apiMessage: string,
    /** Value of the X-GitHub-SSO header, set when an org's SAML SSO blocked the request. */
    public sso: string | null = null
  ) {
    super(
      `GitHub ${status}: ${apiMessage}` +
        (sso ? ' — this organization uses SAML SSO: authorize your token for it (see the repository menu).' : '')
    )
  }
}

export class GitHub {
  constructor(public readonly token: string) {}

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<GhResponse<T>> {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    })

    // 304 = "nothing changed since If-Modified-Since"; callers handle it.
    if (res.status === 304 || res.status === 204 || res.status === 205) {
      return { status: res.status, data: null as T, headers: res.headers }
    }
    if (!res.ok) {
      let message = res.statusText
      try {
        message = ((await res.json()) as { message?: string }).message ?? message
      } catch {
        /* body was not JSON */
      }
      throw new GitHubError(res.status, message, res.headers.get('x-github-sso'))
    }
    return { status: res.status, data: (await res.json()) as T, headers: res.headers }
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).data
  }

  /** Follows the Link: rel="next" header until `max` items are collected. */
  async paginate<T>(path: string, max = 500, onPage?: (headers: Headers) => void): Promise<T[]> {
    const items: T[] = []
    let next: string | null = path
    while (next && items.length < max) {
      const res: GhResponse<T[]> = await this.request<T[]>(next)
      onPage?.(res.headers)
      items.push(...res.data)
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null
    }
    return items.slice(0, max)
  }
}
