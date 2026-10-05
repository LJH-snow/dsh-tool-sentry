/** Sentry REST client with injected fetch for testability. */

import { EndpointSecurityError, guardEndpoint, normalizeBaseUrl, type EndpointPolicy, type LookupImpl } from './url-security.js'

export interface SentryClientOptions {
  token?: string
  /** Optional default organization slug used when tools are called without an explicit organization. */
  organization?: string
  /** API base URL override (default https://sentry.io/api/0). */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Require a publicly reachable endpoint and resolve hostnames. Off by default so self-hosted deployments keep working. */
  enforcePublicEndpoint?: boolean
  /** Test-only DNS lookup override; production uses node:dns/promises. */
  lookupImpl?: LookupImpl
  /** Request timeout in milliseconds. 0 disables the timeout. */
  timeoutMs?: number
}

export interface OrganizationInfo {
  id: string
  slug: string
  name: string
  dateCreated: string
  isEarlyAdopter: boolean
  require2FA: boolean
  pendingAccessRequests: number
  avatarUrl: string | null
  url: string
}

export interface ProjectInfo {
  id: string
  slug: string
  name: string
  platform: string | null
  color: string | null
  isBookmarked: boolean
  isMember: boolean
  hasAccess: boolean
  firstEvent: string | null
  dateCreated: string
  teamSlug: string | null
  teamName: string | null
  latestRelease: string | null
  webUrl: string
  features: string[]
}

export interface IssueInfo {
  id: string
  shortId: string
  title: string
  culprit: string | null
  level: string
  status: string
  count: number
  userCount: number
  firstSeen: string
  lastSeen: string
  permalinkUrl: string
  assignedTo: string | null
  projectSlug: string
}

export interface EventInfo {
  id: string
  eventId: string
  message: string | null
  dateCreated: string
  platform: string | null
  type: string | null
  groupId: string | null
  title: string | null
}

export interface ReleaseInfo {
  version: string
  shortVersion: string
  url: string
  dateCreated: string | null
  dateReleased: string | null
  projects: Array<{ slug: string; name: string }>
  commits: number
  newGroups: number
  commitCount: number
}

export interface TeamInfo {
  id: string
  slug: string
  name: string
  organizationSlug: string
  hasAccess: boolean
  isPending: boolean
  memberCount: number
  projectCount: number
  avatarUrl: string | null
}

export interface MemberInfo {
  id: string
  email: string
  name: string | null
  role: string
  user: { id: string | null; name: string | null; email: string | null } | null
  pending: boolean
  expired: boolean
  dateCreated: string
}

export interface IssueUpdateResult {
  ok: boolean
  id?: string
  status?: string
  assignedTo?: string | null
  reason?: string
}

export class SentryError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'SentryError'
  }
}

interface RawOrganization {
  id: string
  slug: string
  name: string
  dateCreated: string
  isEarlyAdopter: boolean
  require2FA: boolean
  pendingAccessRequests: number
  avatar?: { avatarUuid?: string | null }
  links?: { organizationUrl?: string }
}

interface RawProject {
  id: string
  slug: string
  name: string
  organization?: { slug?: string }
  platform?: string | null
  color?: string | null
  isBookmarked?: boolean
  isMember?: boolean
  hasAccess?: boolean
  firstEvent?: string | null
  dateCreated: string
  team?: { slug?: string; name?: string } | null
  latestRelease?: { version?: string | null } | null
  features?: string[]
}

interface RawIssue {
  id: string
  shortId: string
  title: string
  culprit?: string | null
  level?: string
  status?: string
  count?: string | number
  userCount?: number
  firstSeen: string
  lastSeen: string
  permalink?: string
  assignedTo?: { email?: string; name?: string } | null
  project?: { slug?: string }
}

interface RawEvent {
  id: string
  eventID?: string
  message?: string | null
  dateCreated: string
  platform?: string | null
  type?: string | null
  groupID?: string | null
  title?: string | null
}

interface RawRelease {
  version: string
  shortVersion?: string
  url?: string
  dateCreated?: string | null
  dateReleased?: string | null
  projects?: Array<{ slug?: string; name?: string }>
  commits?: Array<unknown>
  newGroups?: number
  commitCount?: number
}

interface RawTeam {
  id: string
  slug: string
  name: string
  organization?: { slug?: string }
  hasAccess?: boolean
  isPending?: boolean
  avatar?: { avatarUuid?: string | null }
  memberCount?: number
  projectCount?: number
}

interface RawMember {
  id: string
  email: string
  name?: string | null
  role: string
  user?: { id?: string | null; name?: string | null; email?: string | null } | null
  pending?: boolean
  expired?: boolean
  dateCreated: string
}

function stringNumber(value: string | number | undefined): number {
  if (value === undefined) return 0
  return typeof value === 'number' ? value : Number(value) || 0
}

function mapOrganization(raw: RawOrganization): OrganizationInfo {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    dateCreated: raw.dateCreated,
    isEarlyAdopter: raw.isEarlyAdopter,
    require2FA: raw.require2FA,
    pendingAccessRequests: raw.pendingAccessRequests,
    avatarUrl: raw.avatar?.avatarUuid ? `https://sentry.io/avatar/${raw.avatar.avatarUuid}` : null,
    url: raw.links?.organizationUrl ?? `https://sentry.io/organizations/${raw.slug}/`,
  }
}

function mapProject(raw: RawProject): ProjectInfo {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    platform: raw.platform ?? null,
    color: raw.color ?? null,
    isBookmarked: raw.isBookmarked ?? false,
    isMember: raw.isMember ?? false,
    hasAccess: raw.hasAccess ?? false,
    firstEvent: raw.firstEvent ?? null,
    dateCreated: raw.dateCreated,
    teamSlug: raw.team?.slug ?? null,
    teamName: raw.team?.name ?? null,
    latestRelease: raw.latestRelease?.version ?? null,
    webUrl: `https://sentry.io/organizations/${raw.organization?.slug ?? ''}/projects/${raw.slug}/`,
    features: raw.features ?? [],
  }
}

function mapIssue(raw: RawIssue): IssueInfo {
  return {
    id: raw.id,
    shortId: raw.shortId,
    title: raw.title,
    culprit: raw.culprit ?? null,
    level: raw.level ?? 'error',
    status: raw.status ?? 'unresolved',
    count: stringNumber(raw.count),
    userCount: raw.userCount ?? 0,
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
    permalinkUrl: raw.permalink ?? `https://sentry.io/organizations/${raw.project?.slug ?? ''}/issues/${raw.id}/`,
    assignedTo: raw.assignedTo?.email ?? raw.assignedTo?.name ?? null,
    projectSlug: raw.project?.slug ?? '',
  }
}

function mapEvent(raw: RawEvent): EventInfo {
  return {
    id: raw.id,
    eventId: raw.eventID ?? raw.id,
    message: raw.message ?? null,
    dateCreated: raw.dateCreated,
    platform: raw.platform ?? null,
    type: raw.type ?? null,
    groupId: raw.groupID ?? null,
    title: raw.title ?? null,
  }
}

function mapRelease(raw: RawRelease): ReleaseInfo {
  return {
    version: raw.version,
    shortVersion: raw.shortVersion ?? raw.version,
    url: raw.url ?? '',
    dateCreated: raw.dateCreated ?? null,
    dateReleased: raw.dateReleased ?? null,
    projects: (raw.projects ?? []).map(p => ({ slug: p.slug ?? '', name: p.name ?? p.slug ?? '' })),
    commits: (raw.commits ?? []).length,
    newGroups: raw.newGroups ?? 0,
    commitCount: raw.commitCount ?? (raw.commits ?? []).length,
  }
}

function mapTeam(raw: RawTeam): TeamInfo {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    organizationSlug: raw.organization?.slug ?? '',
    hasAccess: raw.hasAccess ?? false,
    isPending: raw.isPending ?? false,
    memberCount: raw.memberCount ?? 0,
    projectCount: raw.projectCount ?? 0,
    avatarUrl: raw.avatar?.avatarUuid ? `https://sentry.io/avatar/${raw.avatar.avatarUuid}` : null,
  }
}

function mapMember(raw: RawMember): MemberInfo {
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name ?? raw.user?.name ?? null,
    role: raw.role,
    user: raw.user ? {
      id: raw.user.id ?? null,
      name: raw.user.name ?? null,
      email: raw.user.email ?? null,
    } : null,
    pending: raw.pending ?? false,
    expired: raw.expired ?? false,
    dateCreated: raw.dateCreated,
  }
}

export class SentryClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly endpointPolicy: EndpointPolicy

  constructor(private readonly options: SentryClientOptions = {}) {
    this.token = options.token ?? ''
    try {
      this.baseUrl = options.enforcePublicEndpoint === true
        ? normalizeBaseUrl(options.baseUrl, 'https://sentry.io/api/0')
        : (options.baseUrl ?? 'https://sentry.io/api/0').replace(/\/+$/, '')
    } catch (error) {
      if (error instanceof EndpointSecurityError) throw new SentryError(error.message, 400)
      throw error
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 15000
    this.endpointPolicy = { enforcePublicEndpoint: options.enforcePublicEndpoint === true, lookupImpl: options.lookupImpl }
  }

  hasToken(): boolean {
    return this.token.length > 0
  }

  getDefaultOrganization(): string | undefined {
    return this.options.organization
  }

  async getOrganization(slug: string, signal?: AbortSignal): Promise<OrganizationInfo> {
    const raw = await this.request<RawOrganization>(`/organizations/${encodeURIComponent(slug)}/`, { signal })
    return mapOrganization(raw)
  }

  async listProjects(options: { query?: string; perPage?: number; signal?: AbortSignal } = {}): Promise<ProjectInfo[]> {
    const params = new URLSearchParams({
      per_page: String(Math.max(1, Math.min(options.perPage ?? 20, 100))),
    })
    if (options.query) params.set('query', options.query)
    const raw = await this.request<RawProject[]>(`/projects/?${params}`, { signal: options.signal })
    return raw.map(mapProject)
  }

  async getProject(organization: string, slug: string, signal?: AbortSignal): Promise<ProjectInfo> {
    const raw = await this.request<RawProject>(
      `/projects/${encodeURIComponent(organization)}/${encodeURIComponent(slug)}/`,
      { signal },
    )
    return mapProject(raw)
  }

  async listIssues(
    organization: string,
    project: string,
    options: { query?: string; status?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<IssueInfo[]> {
    const params = new URLSearchParams()
    if (options.query) params.set('query', options.query)
    if (options.status) params.set('status', options.status)
    params.set('limit', String(Math.max(1, Math.min(options.limit ?? 20, 100))))
    const raw = await this.request<RawIssue[]>(
      `/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/issues/?${params}`,
      { signal: options.signal },
    )
    return raw.map(mapIssue)
  }

  async getIssue(organization: string, issueId: string, signal?: AbortSignal): Promise<IssueInfo> {
    const raw = await this.request<RawIssue>(
      `/organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(issueId)}/`,
      { signal },
    )
    return mapIssue(raw)
  }

  async listIssueEvents(
    organization: string,
    issueId: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<EventInfo[]> {
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(options.limit ?? 10, 100))),
    })
    const raw = await this.request<RawEvent[]>(
      `/organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(issueId)}/events/?${params}`,
      { signal: options.signal },
    )
    return raw.map(mapEvent)
  }

  async listReleases(
    organization: string,
    project: string,
    options: { perPage?: number; signal?: AbortSignal } = {},
  ): Promise<ReleaseInfo[]> {
    const params = new URLSearchParams({
      per_page: String(Math.max(1, Math.min(options.perPage ?? 10, 100))),
    })
    const raw = await this.request<RawRelease[]>(
      `/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/releases/?${params}`,
      { signal: options.signal },
    )
    return raw.map(mapRelease)
  }

  async getRelease(organization: string, project: string, version: string, signal?: AbortSignal): Promise<ReleaseInfo> {
    const raw = await this.request<RawRelease>(
      `/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/releases/${encodeURIComponent(version)}/`,
      { signal },
    )
    return mapRelease(raw)
  }

  async listTeams(organization: string, options: { perPage?: number; signal?: AbortSignal } = {}): Promise<TeamInfo[]> {
    const params = new URLSearchParams({
      per_page: String(Math.max(1, Math.min(options.perPage ?? 20, 100))),
    })
    const raw = await this.request<RawTeam[]>(
      `/organizations/${encodeURIComponent(organization)}/teams/?${params}`,
      { signal: options.signal },
    )
    return raw.map(mapTeam)
  }

  async getTeam(organization: string, slug: string, signal?: AbortSignal): Promise<TeamInfo> {
    const raw = await this.request<RawTeam>(
      `/teams/${encodeURIComponent(organization)}/${encodeURIComponent(slug)}/`,
      { signal },
    )
    return mapTeam(raw)
  }

  async listMembers(organization: string, options: { perPage?: number; signal?: AbortSignal } = {}): Promise<MemberInfo[]> {
    const params = new URLSearchParams({
      per_page: String(Math.max(1, Math.min(options.perPage ?? 20, 100))),
    })
    const raw = await this.request<RawMember[]>(
      `/organizations/${encodeURIComponent(organization)}/members/?${params}`,
      { signal: options.signal },
    )
    return raw.map(mapMember)
  }

  async updateIssue(
    organization: string,
    issueId: string,
    input: { status?: 'unresolved' | 'resolved' | 'ignored'; assignedTo?: string; signal?: AbortSignal },
  ): Promise<IssueUpdateResult> {
    try {
      const body: Record<string, string> = {}
      if (input.status) body.status = input.status
      if (input.assignedTo) body.assignedTo = input.assignedTo
      const raw = await this.request<RawIssue>(
        `/organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(issueId)}/`,
        { method: 'PATCH', body: JSON.stringify(body) },
        input.signal,
      )
      return {
        ok: true,
        id: raw.id,
        status: raw.status ?? input.status,
        assignedTo: raw.assignedTo?.email ?? raw.assignedTo?.name ?? input.assignedTo ?? null,
      }
    } catch (error) {
      if (error instanceof SentryError && (error.status === 404 || error.status === 400)) {
        return { ok: false, id: issueId, reason: 'Could not update the Sentry issue (issue not found or invalid update).' }
      }
      throw error
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (this.timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new Error(`Sentry request timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    }
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${this.token}`,
      }
      if (init.body !== undefined && init.body !== null) headers['content-type'] = 'application/json'
          const blocked = await guardEndpoint(this.baseUrl + path, this.endpointPolicy)
    if (blocked) throw new SentryError(blocked, 400)
const response = await this.fetchImpl(this.baseUrl + path, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: controller.signal,
      })
      if (!response.ok) {
        let message = `Sentry API request failed with status ${response.status}`
        try {
          const data = await response.json() as { detail?: string }
          if (data.detail) message = data.detail
        } catch {
          // keep the status-based message when the response is not JSON
        }
        throw new SentryError(message, response.status)
      }
      if (response.status === 204) return undefined as T
      return await response.json() as T
    } finally {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
}
