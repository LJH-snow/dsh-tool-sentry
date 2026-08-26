import { describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SentryClient } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

function tools(client = new SentryClient({ fetchImpl: globalThis.fetch })) {
  return Object.fromEntries(createTools(client).map(t => [t.name, t]))
}

describe('tool definitions', () => {
  it('registers the planned Sentry tool set', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'sentry_get_issue',
      'sentry_get_organization',
      'sentry_get_project',
      'sentry_get_release',
      'sentry_get_team',
      'sentry_list_issue_events',
      'sentry_list_issues',
      'sentry_list_members',
      'sentry_list_projects',
      'sentry_list_releases',
      'sentry_list_teams',
      'sentry_update_issue',
    ])
  })

  it('returns business values without a token', async () => {
    const map = tools()
    expect(await map.sentry_get_organization.execute({}, exec())).toMatchObject({ found: false })
    expect(String((await map.sentry_get_organization.execute({}, exec())).reason)).toContain('token')
    expect(await map.sentry_list_projects.execute({}, exec())).toEqual({
      found: false,
      items: [],
      reason: 'Listing Sentry projects requires a Sentry auth token.',
    })
    expect(await map.sentry_update_issue.execute({ issueId: '9', status: 'resolved' }, exec())).toMatchObject({
      ok: false,
      id: '9',
    })
  })

  it('uses the configured default organization and allows an explicit override', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      id: '1', slug: 'acme', name: 'Acme', dateCreated: '2026-01-01T00:00:00Z',
      isEarlyAdopter: false, require2FA: false, pendingAccessRequests: 0,
    }))
    const client = new SentryClient({ token: 't', organization: 'acme', fetchImpl })
    const map = tools(client)

    const result = await map.sentry_get_organization.execute({}, exec())
    expect(result).toMatchObject({ found: true, slug: 'acme' })
    expect(fetchImpl.mock.calls[0][0]).toContain('/organizations/acme/')

    await map.sentry_get_organization.execute({ organization: 'other' }, exec())
    expect(fetchImpl.mock.calls[1][0]).toContain('/organizations/other/')
  })

  it('maps 404s to found:false', async () => {
    const map = tools(new SentryClient({ token: 't', organization: 'acme', fetchImpl: vi.fn(async () => jsonResponse(404, {})) }))
    expect(await map.sentry_get_organization.execute({}, exec())).toEqual({ found: false })
    expect(await map.sentry_get_project.execute({ slug: 'frontend' }, exec())).toEqual({ found: false })
    expect(await map.sentry_get_issue.execute({ issueId: '9' }, exec())).toEqual({ found: false })
    expect(await map.sentry_get_release.execute({ project: 'frontend', version: '1.0.0' }, exec())).toEqual({ found: false })
    expect(await map.sentry_get_team.execute({ slug: 'eng' }, exec())).toEqual({ found: false })
  })

  it('list_issues forwards filters and clamps limits', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [
      { id: '9', shortId: 'ACME-1', title: 'Bug', level: 'error', status: 'unresolved', firstSeen: '', lastSeen: '', permalink: 'u' },
    ]))
    const client = new SentryClient({ token: 't', organization: 'acme', fetchImpl })
    const map = tools(client)

    const result = await map.sentry_list_issues.execute({ project: 'frontend', query: 'is:unresolved', status: 'unresolved', limit: 999 }, exec())
    expect(result).toMatchObject({ found: true, items: [{ shortId: 'ACME-1', title: 'Bug' }] })
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('/projects/acme/frontend/issues/?')
    expect(url).toContain('query=is%3Aunresolved')
    expect(url).toContain('status=unresolved')
    expect(url).toContain('limit=100')
  })

  it('clamps list_projects limits to the documented range', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []))
    const client = new SentryClient({ token: 't', fetchImpl })
    const map = tools(client)
    await map.sentry_list_projects.execute({ limit: 999 }, exec())
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('per_page=100')
  })

  it('renders issue and organization values as pure text blocks', async () => {
    const map = tools()
    const issueBlocks = await (map.sentry_get_issue.output as { render: (a: unknown, v: any) => unknown }).render({}, {
      found: true,
      shortId: 'ACME-1',
      level: 'error',
      title: 'Null pointer',
      status: 'unresolved',
      count: 7,
      userCount: 2,
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-02T00:00:00Z',
      permalinkUrl: 'u',
    })
    expect(JSON.stringify(issueBlocks)).toContain('ACME-1 [error] Null pointer')
    expect(JSON.stringify(issueBlocks)).toContain('events: 7')

    const orgBlocks = await (map.sentry_get_organization.output as { render: (a: unknown, v: any) => unknown }).render({}, {
      found: true,
      name: 'Acme',
      slug: 'acme',
      dateCreated: '2026-01-01T00:00:00Z',
      require2FA: true,
      pendingAccessRequests: 3,
      url: 'u',
    })
    expect(JSON.stringify(orgBlocks)).toContain('Acme (acme)')
    expect(JSON.stringify(orgBlocks)).toContain('2FA required: yes')
  })

  it('update_issue sends the update and presents an edit card', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      id: '9', shortId: 'ACME-1', title: 'Bug', status: 'resolved', firstSeen: '', lastSeen: '',
      assignedTo: { email: 'alice@acme.com' },
    }))
    const client = new SentryClient({ token: 't', organization: 'acme', fetchImpl })
    const map = tools(client)

    const result = await map.sentry_update_issue.execute({ issueId: '9', status: 'resolved', assignedTo: 'alice@acme.com' }, exec())
    expect(result).toEqual({ ok: true, id: '9', status: 'resolved', assignedTo: 'alice@acme.com' })
    expect(map.sentry_update_issue.presentCall!({ issueId: '9' })).toMatchObject({ card: 'generic', kind: 'edit' })
    expect(map.sentry_update_issue.presentResult!({ issueId: '9' }, { ok: true, id: '9', status: 'resolved' })).toMatchObject({
      card: 'generic',
      title: 'Issue 9 updated',
    })
  })
})
