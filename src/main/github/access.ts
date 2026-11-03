// Explains why an organization's repositories are missing from the list.
// GitHub hides them without an error in three common cases:
//   - the org uses SAML SSO and the token is not authorized for it (X-GitHub-SSO header)
//   - the org restricts OAuth apps and has not approved PRway yet (403 on org endpoints)
//   - the token is fine-grained (covers one owner only) or lacks the needed scopes

import type { AccessIssue } from '../../shared/types'
import { GitHubError, type GitHub } from './api'
import { CLIENT_ID } from './auth'

const NEEDED_SCOPES = ['repo', 'read:org', 'notifications']
const NEW_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,notifications&description=PRway'
const TOKENS_URL = 'https://github.com/settings/tokens'

type TokenKind = 'classic' | 'fine-grained' | 'oauth' | 'other'

function tokenKind(token: string): TokenKind {
  if (token.startsWith('ghp_')) return 'classic'
  if (token.startsWith('github_pat_')) return 'fine-grained'
  if (token.startsWith('gho_')) return 'oauth'
  return 'other'
}

/** Org IDs from a header like "partial-results; organizations=21955855,20582480". */
export function ssoOrgIds(header: string | null): number[] {
  const list = /organizations=([\d,]+)/.exec(header ?? '')?.[1]
  return list ? list.split(',').map(Number).filter(Boolean) : []
}

async function orgLogin(gh: GitHub, id: number): Promise<string> {
  try {
    return (await gh.get<{ login: string }>(`/organizations/${id}`)).login
  } catch {
    return `organization #${id}`
  }
}

function ssoIssue(org: string, kind: TokenKind): AccessIssue {
  const isOrgName = !org.startsWith('organization #')
  if (kind === 'oauth') {
    return {
      kind: 'sso',
      org,
      message: `${org} uses SAML single sign-on. Start an SSO session for it, then sign out and sign in to PRway again.`,
      actionLabel: 'Start SSO session',
      actionUrl: isOrgName ? `https://github.com/orgs/${org}/sso` : TOKENS_URL
    }
  }
  return {
    kind: 'sso',
    org,
    message: `${org} uses SAML single sign-on and your token is not authorized for it. On GitHub's tokens page, click "Configure SSO" next to your token and authorize ${org}, then refresh.`,
    actionLabel: 'Open token settings',
    actionUrl: TOKENS_URL
  }
}

export async function diagnoseAccess(gh: GitHub, ssoHeaders: (string | null)[]): Promise<AccessIssue[]> {
  const issues: AccessIssue[] = []
  const kind = tokenKind(gh.token)

  if (kind === 'fine-grained') {
    issues.push({
      kind: 'fine-grained-token',
      message:
        'You signed in with a fine-grained token. It only covers one owner (you or a single org) and cannot read notifications. Use a classic token instead.',
      actionLabel: 'Create a classic token',
      actionUrl: NEW_TOKEN_URL
    })
  }

  // Classic and OAuth tokens report their scopes in X-OAuth-Scopes.
  if (kind === 'classic' || kind === 'oauth') {
    const res = await gh.request('/user')
    const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim())
    const missing = NEEDED_SCOPES.filter((s) => !scopes.includes(s))
    if (missing.length) {
      issues.push({
        kind: 'missing-scopes',
        message: `Your token is missing these scopes: ${missing.join(', ')}. Without "repo" private org repos are hidden; without "read:org" orgs cannot be checked.`,
        actionLabel: kind === 'classic' ? 'Create a new token' : 'Sign in again',
        actionUrl: NEW_TOKEN_URL
      })
    }
  }

  // Orgs that GitHub filtered out of the repo list because of SAML SSO.
  const ssoIds = [...new Set(ssoHeaders.flatMap(ssoOrgIds))]
  const ssoOrgs = await Promise.all(ssoIds.map((id) => orgLogin(gh, id)))
  for (const org of ssoOrgs) issues.push(ssoIssue(org, kind))

  // Probe each org the user belongs to, to catch OAuth app restrictions and SSO blocks.
  let orgs: string[] = []
  try {
    orgs = (await gh.paginate<{ login: string }>('/user/orgs?per_page=100', 100)).map((o) => o.login)
  } catch {
    /* no read:org scope: already reported above */
  }
  const probes = await Promise.all(
    orgs
      .filter((o) => !ssoOrgs.includes(o))
      .slice(0, 30)
      .map(async (org): Promise<AccessIssue | null> => {
        try {
          await gh.request(`/orgs/${org}/repos?per_page=1`)
          return null
        } catch (err) {
          if (!(err instanceof GitHubError) || err.status !== 403) return null
          if (err.sso) return ssoIssue(org, kind)
          if (/OAuth App access restrictions/i.test(err.apiMessage)) {
            return {
              kind: 'oauth-restricted',
              org,
              message: `${org} restricts third-party apps and has not approved PRway yet. Request access, then an org owner approves it once for everyone.`,
              actionLabel: 'Request access',
              actionUrl: CLIENT_ID
                ? `https://github.com/settings/connections/applications/${CLIENT_ID}`
                : 'https://github.com/settings/applications'
            }
          }
          return null
        }
      })
  )
  issues.push(...probes.filter((p): p is AccessIssue => p !== null))
  return issues
}
