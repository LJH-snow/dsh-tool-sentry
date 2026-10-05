import { describe, expect, it, vi } from 'vitest'
import { SentryClient, SentryError } from '../src/client.ts'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('SentryClient', () => {
  it('fetches organization metadata with auth header and default base URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      id: '1',
      slug: 'acme',
      name: 'Acme',
      dateCreated: '2026-01-01T00:00:00Z',
      isEarlyAdopter: false,
      require2FA: true,
      pendingAccessRequests: 3,
      avatar: { avatarUuid: 'abc' },
      links: { organizationUrl: 'https://sentry.io/organizations/acme/' },
    }))
    const client = new SentryClient({ token: 'sntrys_test', fetchImpl })
    const org = await client.getOrganization('acme')

    expect(org).toEqual({
      id: '1',
      slug: 'acme',
      name: 'Acme',
      dateCreated: '2026-01-01T00:00:00Z',
      isEarlyAdopter: false,
      require2FA: true,
      pendingAccessRequests: 3,
      avatarUrl: 'https://sentry.io/avatar/abc',
      url: 'https://sentry.io/organizations/acme/',
    })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sentry.io/api/0/organizations/acme/')
    expect(init.headers).toMatchObject({ authorization: 'Bearer sntrys_test' })
  })

  it('strips a trailing slash from a baseUrl override', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      id: '1', slug: 'acme', name: 'Acme', dateCreated: '2026-01-01T00:00:00Z',
      isEarlyAdopter: false, require2FA: false, pendingAccessRequests: 0,
    }))
    const client = new SentryClient({ baseUrl: 'https://sentry.example.com/api/0/', fetchImpl })
    await client.getOrganization('acme')
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://sentry.example.com/api/0/organizations/acme/')
  })

  it('listProjects sends query/per_page and maps project fields', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [
      {
        id: '11',
        slug: 'frontend',
        name: 'Frontend',
        organization: { slug: 'acme' },
        platform: 'javascript',
        firstEvent: '2026-02-01T00:00:00Z',
        dateCreated: '2026-01-01T00:00:00Z',
        team: { slug: 'eng', name: 'Engineering' },
        latestRelease: { version: '1.2.0' },
        features: ['integrations'],
      },
    ]))
    const client = new SentryClient({ token: 'sntrys_test', fetchImpl })
    const items = await client.listProjects({ query: 'frontend', perPage: 5 })

    expect(items[0]).toEqual({
      id: '11',
      slug: 'frontend',
      name: 'Frontend',
      platform: 'javascript',
      color: null,
      isBookmarked: false,
      isMember: false,
      hasAccess: false,
      firstEvent: '2026-02-01T00:00:00Z',
      dateCreated: '2026-01-01T00:00:00Z',
      teamSlug: 'eng',
      teamName: 'Engineering',
      latestRelease: '1.2.0',
      webUrl: 'https://sentry.io/organizations/acme/projects/frontend/',
      features: ['integrations'],
    })
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('/projects/?per_page=5')
    expect(url).toContain('query=frontend')
  })

  it('listIssues builds filters and maps numeric count strings', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [
      {
        id: '9',
        shortId: 'ACME-1',
        title: 'Null pointer',
        culprit: 'app.ts:10',
        level: 'error',
        status: 'unresolved',
        count: '42',
        userCount: 3,
        firstSeen: '2026-03-01T00:00:00Z',
        lastSeen: '2026-03-02T00:00:00Z',
        permalink: 'https://sentry.io/organizations/acme/issues/9/',
        assignedTo: { email: 'alice@acme.com' },
        project: { slug: 'frontend' },
      },
    ]))
    const client = new SentryClient({ token: 'sntrys_test', fetchImpl })
    const items = await client.listIssues('acme', 'frontend', {
      query: 'is:unresolved',
      status: 'unresolved',
      limit: 50,
    })

    expect(items[0]).toMatchObject({
      id: '9',
      shortId: 'ACME-1',
      count: 42,
      userCount: 3,
      permalinkUrl: 'https://sentry.io/organizations/acme/issues/9/',
      assignedTo: 'alice@acme.com',
      projectSlug: 'frontend',
    })
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('/projects/acme/frontend/issues/?')
    expect(url).toContain('query=is%3Aunresolved')
    expect(url).toContain('status=unresolved')
    expect(url).toContain('limit=50')
  })

  it('maps issue, event, release, team, and member responses', async () => {
    const issue = new SentryClient({ token: 't', fetchImpl: vi.fn(async () => jsonResponse(200, {
      id: '9', shortId: 'ACME-1', title: 'Boom', level: 'error', status: 'resolved',
      firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
      permalink: 'https://sentry.io/organizations/acme/issues/9/',
      project: { slug: 'frontend' },
    })) })
    expect(await issue.getIssue('acme', '9')).toMatchObject({ id: '9', title: 'Boom' })

    const events = new SentryClient({ token: 't', fetchImpl: vi.fn(async () => jsonResponse(200, [
      { id: 'e1', eventID: 'short-1', message: 'boom', dateCreated: '2026-01-01T00:00:00Z', platform: 'node', type: 'error', groupID: '9', title: 'Boom' },
    ])) })
    expect(await events.listIssueEvents('acme', '9', { limit: 5 })).toMatchObject([
      { eventId: 'short-1', groupId: '9', type: 'error' },
    ])

    const releases = new SentryClient({ token: 't', fetchImpl: vi.fn(async () => jsonResponse(200, [
      { version: '1.0.0', shortVersion: '1.0.0', url: 'https://sentry.io/releases/1', dateCreated: '2026-01-01T00:00:00Z', projects: [{ slug: 'frontend', name: 'Frontend' }], commits: [{}, {}], newGroups: 5 },
    ])) })
    expect(await releases.listReleases('acme', 'frontend', { perPage: 3 })).toMatchObject([
      { version: '1.0.0', commits: 2, commitCount: 2, newGroups: 5 },
    ])

    const teams = new SentryClient({ token: 't', fetchImpl: vi.fn(async () => jsonResponse(200, [
      { id: 't1', slug: 'eng', name: 'Engineering', organization: { slug: 'acme' }, hasAccess: true, isPending: false, avatar: { avatarUuid: 'z' }, memberCount: 12, projectCount: 3 },
    ])) })
    expect(await teams.listTeams('acme', { perPage: 3 })).toMatchObject([
      { slug: 'eng', organizationSlug: 'acme', avatarUrl: 'https://sentry.io/avatar/z', memberCount: 12, projectCount: 3 },
    ])

    const members = new SentryClient({ token: 't', fetchImpl: vi.fn(async () => jsonResponse(200, [
      { id: 'm1', email: 'alice@example.com', name: 'Alice', role: 'member', user: { id: 'u1', name: 'Alice', email: 'alice@example.com' }, pending: false, expired: false, dateCreated: '2026-01-01T00:00:00Z' },
    ])) })
    expect(await members.listMembers('acme', { perPage: 3 })).toMatchObject([
      { id: 'm1', name: 'Alice', role: 'member', user: { id: 'u1' } },
    ])
  })

  it('builds project and team getter paths', async () => {
    const projectFetch = vi.fn(async () => jsonResponse(200, {
      id: '1', slug: 'frontend', name: 'Frontend', organization: { slug: 'acme' }, dateCreated: '2026-01-01T00:00:00Z',
    }))
    const projects = new SentryClient({ token: 't', fetchImpl: projectFetch })
    await projects.getProject('acme', 'frontend')
    expect(projectFetch.mock.calls[0][0]).toBe('https://sentry.io/api/0/projects/acme/frontend/')

    const teamFetch = vi.fn(async () => jsonResponse(200, {
      id: 't1', slug: 'eng', name: 'Engineering', dateCreated: '2026-01-01T00:00:00Z',
    }))
    const teams = new SentryClient({ token: 't', fetchImpl: teamFetch })
    await teams.getTeam('acme', 'eng')
    expect(teamFetch.mock.calls[0][0]).toBe('https://sentry.io/api/0/teams/acme/eng/')
  })

  it('getRelease URL-encodes the release version', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      version: 'frontend@1.4.0', shortVersion: '1.4.0', url: 'u', dateCreated: '2026-01-01T00:00:00Z',
    }))
    const client = new SentryClient({ token: 't', fetchImpl })
    await client.getRelease('acme', 'frontend', 'frontend@1.4.0')
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://sentry.io/api/0/projects/acme/frontend/releases/frontend%401.4.0/')
  })

  it('updateIssue sends a PATCH body and maps the response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      id: '9', shortId: 'ACME-1', title: 'Boom', status: 'resolved', firstSeen: '', lastSeen: '',
      assignedTo: { email: 'alice@acme.com' },
    }))
    const client = new SentryClient({ token: 't', fetchImpl })
    const result = await client.updateIssue('acme', '9', { status: 'resolved', assignedTo: 'alice@acme.com' })

    expect(result).toEqual({
      ok: true,
      id: '9',
      status: 'resolved',
      assignedTo: 'alice@acme.com',
    })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sentry.io/api/0/organizations/acme/issues/9/')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ status: 'resolved', assignedTo: 'alice@acme.com' })
  })

  it('maps updateIssue 400 and 404 to business failures', async () => {
    const bad = new SentryClient({ token: 't', fetchImpl: vi.fn(async () => jsonResponse(400, { detail: 'invalid update' })) })
    expect(await bad.updateIssue('acme', '9', { status: 'resolved' })).toMatchObject({ ok: false, id: '9' })

    const missing = new SentryClient({ token: 't', fetchImpl: vi.fn(async () => jsonResponse(404, {})) })
    expect(await missing.updateIssue('acme', '9', { status: 'resolved' })).toMatchObject({ ok: false, id: '9' })
  })

  it('throws SentryError with status for infrastructure failures', async () => {
    const client = new SentryClient({ token: 'bad', fetchImpl: vi.fn(async () => jsonResponse(401, { detail: 'Invalid token' })) })
    await expect(client.getOrganization('acme')).rejects.toMatchObject({ name: 'SentryError', status: 401 })
  })
})

describe('Sentry endpoint policy', () => {
  const valid = { token: 'sntrys_test' }
  const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const call = (client: SentryClient) => client.getOrganization('org')

  it('rejects literal link-local endpoints by default, including IPv4 embedded in IPv6', async () => {
    for (const baseUrl of [
      'http://169.254.169.254',
      'http://169.254.1.1',
      'http://[fe80::1]',
      'http://[::ffff:169.254.169.254]',
      'http://[64:ff9b::a9fe:a9fe]',
      'http://[::169.254.169.254]',
    ]) {
      const fetchImpl = vi.fn()
      await expect(call(new SentryClient({ ...valid, baseUrl, fetchImpl }))).rejects.toBeInstanceOf(SentryError)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('keeps self-hosted private and loopback endpoints working by default', async () => {
    for (const baseUrl of [
      'http://10.0.0.5',
      'http://172.16.4.4',
      'http://192.168.1.10',
      'http://127.0.0.1:8080',
      'http://[fc00::1]',
    ]) {
      const fetchImpl = vi.fn(async () => ok())
      await call(new SentryClient({ ...valid, baseUrl, fetchImpl })).catch(() => undefined)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('performs no DNS work in the default mode', async () => {
    const lookupImpl = vi.fn(async () => { throw new Error('default mode must not resolve hostnames') })
    const fetchImpl = vi.fn(async () => ok())
    await call(new SentryClient({ ...valid, baseUrl: 'https://sentry.internal.corp', fetchImpl, lookupImpl })).catch(() => undefined)
    expect(lookupImpl).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects private and link-local endpoints when enforcePublicEndpoint is on', async () => {
    for (const baseUrl of ['http://10.0.0.5', 'http://127.0.0.1', 'http://169.254.169.254', 'http://[fc00::1]']) {
      const fetchImpl = vi.fn()
      await expect(call(new SentryClient({ ...valid, baseUrl, fetchImpl, enforcePublicEndpoint: true }))).rejects.toBeInstanceOf(SentryError)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('resolves and rejects blocked hostnames only when enforcePublicEndpoint is on', async () => {
    const lookupImpl = async () => [{ address: '169.254.169.254', family: 4 as const }]
    const fetchImpl = vi.fn()
    await expect(call(new SentryClient({ ...valid, baseUrl: 'https://metadata.sentry.test', fetchImpl, lookupImpl, enforcePublicEndpoint: true }))).rejects.toBeInstanceOf(SentryError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows a public endpoint when enforcePublicEndpoint is on', async () => {
    const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 as const }]
    const fetchImpl = vi.fn(async () => ok())
    await call(new SentryClient({ ...valid, baseUrl: 'https://sentry.example.test', fetchImpl, lookupImpl, enforcePublicEndpoint: true })).catch(() => undefined)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
