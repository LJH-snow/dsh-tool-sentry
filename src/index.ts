import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SentryClient, SentryError } from './client.js'

export const name = 'dsh-tool-sentry'
export const inject = ['tools']

export interface SentryPluginConfig {
  /** Sentry auth token. All Sentry REST API calls require it. */
  token?: string
  /** Optional default organization slug, e.g. acme. Tools can still override it per call. */
  organization?: string
  /** API base URL override (default https://sentry.io/api/0). */
  baseUrl?: string
  /** Request timeout in milliseconds. */
  timeoutMs?: number
}

export function apply(ctx: Context, config: SentryPluginConfig = {}) {
  const client = new SentryClient({
    token: config.token,
    organization: config.organization,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  })
  for (const tool of createTools(client)) {
    ctx.tools.register(tool)
  }
}

/** Build the tool definitions for a client. Exported so tests can drive execute/render directly. */
export function createTools(client: SentryClient) {
  return [
    defineTool({
      name: 'sentry_get_organization',
      description: 'Get Sentry organization metadata: slug, name, 2FA requirement, pending access requests, and URL.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether the organization was found' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            id: { type: 'string', description: 'Organization id' },
            slug: { type: 'string', description: 'Organization slug' },
            name: { type: 'string', description: 'Organization display name' },
            dateCreated: { type: 'string', description: 'ISO creation timestamp' },
            isEarlyAdopter: { type: 'boolean', description: 'Whether the org is an early adopter' },
            require2FA: { type: 'boolean', description: 'Whether two-factor auth is required' },
            pendingAccessRequests: { type: 'integer', description: 'Pending access request count' },
            avatarUrl: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Organization avatar URL' },
            url: { type: 'string', description: 'Organization URL in Sentry' },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Organization not found or not accessible.' }]
          const lines = [
            `${value.name} (${value.slug})`,
            `created: ${value.dateCreated}`,
            `2FA required: ${value.require2FA ? 'yes' : 'no'}`,
            `pending access requests: ${value.pendingAccessRequests ?? 0}`,
            value.url ?? '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Organization ${resolveOrganizationLabel(client, args)}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; name?: string; slug?: string }
        if (!v.found) return { card: 'generic', title: 'Organization not found' }
        return { card: 'generic', title: `${v.name} (${v.slug})` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, reason: 'Getting Sentry organization data requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        try {
          const info = await client.getOrganization(organization, exec.signal)
          return { found: true, ...info }
        } catch (error) {
          if (error instanceof SentryError && error.status === 404) return { found: false }
          throw error
        }
      },
    }),

    defineTool({
      name: 'sentry_list_projects',
      description: 'List Sentry projects visible to the token, optionally filtered by query.',
      parameters: {
        query: { type: 'string', description: 'Optional project filter' },
        limit: { type: 'integer', description: 'Maximum results, 1-100 (default 20)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether projects are accessible' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', description: 'Project id' },
                  slug: { type: 'string', description: 'Project slug' },
                  name: { type: 'string', description: 'Project name' },
                  platform: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Primary platform' },
                  firstEvent: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'First event timestamp' },
                  dateCreated: { type: 'string', description: 'Creation timestamp' },
                  teamSlug: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Owning team slug' },
                  latestRelease: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Latest release version' },
                  webUrl: { type: 'string', description: 'Project URL in Sentry' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Projects are not accessible.' }]
          const items = value.items ?? []
          if (items.length === 0) return [{ type: 'text', text: 'No projects found.' }]
          return [{ type: 'text', text: items.map(item => `${item.slug} (${item.teamSlug ?? 'no team'}) ${item.webUrl}`).join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        const query = args.query ? ` matching ${args.query}` : ''
        return { card: 'generic', title: `Projects${query}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; items?: Array<{ slug: string }> }
        if (!v.found) return { card: 'generic', title: 'Projects not accessible' }
        return { card: 'generic', title: `${(v.items ?? []).length} project(s)` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, items: [], reason: 'Listing Sentry projects requires a Sentry auth token.' }
        const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(Number(args.limit), 100))
        const items = await client.listProjects({ query: args.query, perPage: limit, signal: exec.signal })
        return { found: true, items }
      },
    }),

    defineTool({
      name: 'sentry_get_project',
      description: 'Get one Sentry project: team, platform, first event time, latest release, and feature flags.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        slug: { type: 'string', required: true, description: 'Project slug, e.g. frontend' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether the project was found' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            id: { type: 'string', description: 'Project id' },
            slug: { type: 'string', description: 'Project slug' },
            name: { type: 'string', description: 'Project name' },
            platform: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Primary platform' },
            firstEvent: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'First event timestamp' },
            dateCreated: { type: 'string', description: 'Creation timestamp' },
            teamSlug: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Owning team slug' },
            latestRelease: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Latest release version' },
            webUrl: { type: 'string', description: 'Project URL in Sentry' },
            features: { type: 'array', items: { type: 'string' }, description: 'Enabled project features' },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Project not found.' }]
          const lines = [
            `${value.name} (${value.slug})`,
            value.platform ? `platform: ${value.platform}` : '',
            value.teamSlug ? `team: ${value.teamSlug}` : '',
            value.latestRelease ? `latest release: ${value.latestRelease}` : '',
            value.firstEvent ? `first event: ${value.firstEvent}` : '',
            value.webUrl ?? '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Project ${args.slug}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; name?: string; platform?: string | null }
        if (!v.found) return { card: 'generic', title: 'Project not found' }
        return { card: 'generic', title: v.name ?? '', content: [{ type: 'text', text: v.platform ?? 'n/a' }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, reason: 'Getting Sentry project data requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        try {
          const info = await client.getProject(organization, args.slug as string, exec.signal)
          return { found: true, ...info }
        } catch (error) {
          if (error instanceof SentryError && error.status === 404) return { found: false }
          throw error
        }
      },
    }),

    defineTool({
      name: 'sentry_list_issues',
      description: 'List Sentry issues in a project with optional query and status filters, ordered by recency.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        project: { type: 'string', required: true, description: 'Project slug' },
        query: { type: 'string', description: 'Sentry search query, e.g. is:unresolved user:alice' },
        status: { type: 'string', enum: ['unresolved', 'resolved', 'ignored'], description: 'Issue status filter' },
        limit: { type: 'integer', description: 'Maximum results, 1-100 (default 20)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether issues are accessible' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', description: 'Issue id' },
                  shortId: { type: 'string', description: 'Short issue id' },
                  title: { type: 'string', description: 'Issue title' },
                  culprit: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Issue culprit' },
                  level: { type: 'string', description: 'Error level' },
                  status: { type: 'string', description: 'Issue status' },
                  count: { type: 'integer', description: 'Event count' },
                  userCount: { type: 'integer', description: 'Affected user count' },
                  firstSeen: { type: 'string', description: 'First seen timestamp' },
                  lastSeen: { type: 'string', description: 'Last seen timestamp' },
                  permalinkUrl: { type: 'string', description: 'Issue URL' },
                  assignedTo: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Assignee' },
                  projectSlug: { type: 'string', description: 'Project slug' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Issues are not accessible.' }]
          const items = value.items ?? []
          if (items.length === 0) return [{ type: 'text', text: 'No issues found.' }]
          const lines = items.map(item =>
            `${item.shortId} [${item.level}] ${item.title} (${item.count} events, ${item.userCount} users, last ${item.lastSeen})`,
          )
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        const query = args.query ? `: ${args.query}` : ''
        return { card: 'generic', title: `Issues in ${args.project}${query}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; items?: Array<{ title: string }> }
        if (!v.found) return { card: 'generic', title: 'Issues not accessible' }
        const items = v.items ?? []
        return { card: 'generic', title: `${items.length} issue(s)`, content: [{ type: 'text', text: items.slice(0, 5).map(i => i.title).join('\n') }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, items: [], reason: 'Listing Sentry issues requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, items: [], reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(Number(args.limit), 100))
        const items = await client.listIssues(organization, args.project as string, {
          query: args.query,
          status: args.status,
          limit,
          signal: exec.signal,
        })
        return { found: true, items }
      },
    }),

    defineTool({
      name: 'sentry_get_issue',
      description: 'Get one Sentry issue with recent event counts, status, assignee, and timeline.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        issueId: { type: 'string', required: true, description: 'Sentry issue id, e.g. 123456' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether the issue was found' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            id: { type: 'string', description: 'Issue id' },
            shortId: { type: 'string', description: 'Short issue id' },
            title: { type: 'string', description: 'Issue title' },
            culprit: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Issue culprit' },
            level: { type: 'string', description: 'Error level' },
            status: { type: 'string', description: 'Issue status' },
            count: { type: 'integer', description: 'Event count' },
            userCount: { type: 'integer', description: 'Affected user count' },
            firstSeen: { type: 'string', description: 'First seen timestamp' },
            lastSeen: { type: 'string', description: 'Last seen timestamp' },
            permalinkUrl: { type: 'string', description: 'Issue URL' },
            assignedTo: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Assignee' },
            projectSlug: { type: 'string', description: 'Project slug' },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Issue not found.' }]
          const lines = [
            `${value.shortId} [${value.level}] ${value.title}`,
            value.culprit ?? '',
            `status: ${value.status}`,
            `events: ${value.count ?? 0}`,
            `users: ${value.userCount ?? 0}`,
            value.assignedTo ? `assignee: ${value.assignedTo}` : '',
            `first seen: ${value.firstSeen}`,
            `last seen: ${value.lastSeen}`,
            value.permalinkUrl ?? '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Issue ${args.issueId}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; shortId?: string; title?: string; status?: string }
        if (!v.found) return { card: 'generic', title: 'Issue not found' }
        return { card: 'generic', title: v.shortId ?? '', content: [{ type: 'text', text: `${v.title} · ${v.status}` }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, reason: 'Getting Sentry issue data requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        try {
          const info = await client.getIssue(organization, args.issueId as string, exec.signal)
          return { found: true, ...info }
        } catch (error) {
          if (error instanceof SentryError && error.status === 404) return { found: false }
          throw error
        }
      },
    }),

    defineTool({
      name: 'sentry_list_issue_events',
      description: 'List recent events for a Sentry issue, useful for inspecting the latest stack trace context.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        issueId: { type: 'string', required: true, description: 'Sentry issue id' },
        limit: { type: 'integer', description: 'Maximum results, 1-100 (default 10)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether events are accessible' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', description: 'Event id' },
                  eventId: { type: 'string', description: 'Short event id' },
                  message: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Event message' },
                  dateCreated: { type: 'string', description: 'Event timestamp' },
                  platform: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Event platform' },
                  type: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Event type' },
                  title: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Event title' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Issue events are not accessible.' }]
          const items = value.items ?? []
          if (items.length === 0) return [{ type: 'text', text: 'No events found.' }]
          const lines = items.map(item => `${item.eventId} ${item.dateCreated} [${item.type ?? 'event'}] ${item.title ?? item.message ?? ''}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Events for issue ${args.issueId}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; items?: Array<{ eventId: string }> }
        if (!v.found) return { card: 'generic', title: 'Issue events not accessible' }
        return { card: 'generic', title: `${(v.items ?? []).length} event(s)` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, items: [], reason: 'Listing Sentry events requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, items: [], reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        const limit = args.limit === undefined ? 10 : Math.max(1, Math.min(Number(args.limit), 100))
        const items = await client.listIssueEvents(organization, args.issueId as string, { limit, signal: exec.signal })
        return { found: true, items }
      },
    }),

    defineTool({
      name: 'sentry_list_releases',
      description: 'List Sentry releases for a project with commit and new-group counts.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        project: { type: 'string', required: true, description: 'Project slug' },
        limit: { type: 'integer', description: 'Maximum results, 1-100 (default 10)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether releases are accessible' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  version: { type: 'string', description: 'Release version' },
                  shortVersion: { type: 'string', description: 'Short version' },
                  url: { type: 'string', description: 'Release URL' },
                  dateCreated: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Creation timestamp' },
                  dateReleased: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Release timestamp' },
                  commits: { type: 'integer', description: 'Commit count' },
                  newGroups: { type: 'integer', description: 'New issue group count' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Releases are not accessible.' }]
          const items = value.items ?? []
          if (items.length === 0) return [{ type: 'text', text: 'No releases found.' }]
          return [{ type: 'text', text: items.map(item => `${item.version} (${item.commits ?? 0} commits, ${item.newGroups ?? 0} new groups) ${item.url}`).join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Releases in ${args.project}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; items?: Array<{ version: string }> }
        if (!v.found) return { card: 'generic', title: 'Releases not accessible' }
        return { card: 'generic', title: `${(v.items ?? []).length} release(s)` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, items: [], reason: 'Listing Sentry releases requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, items: [], reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        const limit = args.limit === undefined ? 10 : Math.max(1, Math.min(Number(args.limit), 100))
        const items = await client.listReleases(organization, args.project as string, { perPage: limit, signal: exec.signal })
        return { found: true, items }
      },
    }),

    defineTool({
      name: 'sentry_get_release',
      description: 'Get one Sentry release: projects, commit count, and release timestamps.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        project: { type: 'string', required: true, description: 'Project slug' },
        version: { type: 'string', required: true, description: 'Release version, e.g. frontend@1.4.0' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether the release was found' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            version: { type: 'string', description: 'Release version' },
            shortVersion: { type: 'string', description: 'Short version' },
            url: { type: 'string', description: 'Release URL' },
            dateCreated: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Creation timestamp' },
            dateReleased: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Release timestamp' },
            commits: { type: 'integer', description: 'Commit count' },
            newGroups: { type: 'integer', description: 'New issue group count' },
            commitCount: { type: 'integer', description: 'Commit count from the API' },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Release not found.' }]
          const lines = [
            value.version,
            value.url ?? '',
            `commits: ${value.commits ?? 0}`,
            `new groups: ${value.newGroups ?? 0}`,
            value.dateCreated ? `created: ${value.dateCreated}` : '',
            value.dateReleased ? `released: ${value.dateReleased}` : '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Release ${args.version}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; version?: string; commits?: number }
        if (!v.found) return { card: 'generic', title: 'Release not found' }
        return { card: 'generic', title: v.version ?? '', content: [{ type: 'text', text: `${v.commits ?? 0} commits` }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, reason: 'Getting Sentry release data requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        try {
          const info = await client.getRelease(organization, args.project as string, args.version as string, exec.signal)
          return { found: true, ...info }
        } catch (error) {
          if (error instanceof SentryError && error.status === 404) return { found: false }
          throw error
        }
      },
    }),

    defineTool({
      name: 'sentry_list_teams',
      description: 'List Sentry organization teams and their member/project counts.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        limit: { type: 'integer', description: 'Maximum results, 1-100 (default 20)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether teams are accessible' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', description: 'Team id' },
                  slug: { type: 'string', description: 'Team slug' },
                  name: { type: 'string', description: 'Team name' },
                  organizationSlug: { type: 'string', description: 'Organization slug' },
                  memberCount: { type: 'integer', description: 'Member count' },
                  projectCount: { type: 'integer', description: 'Project count' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Teams are not accessible.' }]
          const items = value.items ?? []
          if (items.length === 0) return [{ type: 'text', text: 'No teams found.' }]
          return [{ type: 'text', text: items.map(item => `${item.slug} (${item.memberCount} members, ${item.projectCount} projects)`).join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Teams in ${resolveOrganizationLabel(client, args)}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; items?: Array<{ slug: string }> }
        if (!v.found) return { card: 'generic', title: 'Teams not accessible' }
        return { card: 'generic', title: `${(v.items ?? []).length} team(s)` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, items: [], reason: 'Listing Sentry teams requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, items: [], reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(Number(args.limit), 100))
        const items = await client.listTeams(organization, { perPage: limit, signal: exec.signal })
        return { found: true, items }
      },
    }),

    defineTool({
      name: 'sentry_get_team',
      description: 'Get one Sentry team with member and project counts.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        slug: { type: 'string', required: true, description: 'Team slug, e.g. frontend-eng' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether the team was found' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            id: { type: 'string', description: 'Team id' },
            slug: { type: 'string', description: 'Team slug' },
            name: { type: 'string', description: 'Team name' },
            organizationSlug: { type: 'string', description: 'Organization slug' },
            hasAccess: { type: 'boolean', description: 'Whether the token can access the team' },
            isPending: { type: 'boolean', description: 'Whether the team is pending' },
            memberCount: { type: 'integer', description: 'Member count' },
            projectCount: { type: 'integer', description: 'Project count' },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Team not found.' }]
          const lines = [
            `${value.name} (${value.slug})`,
            `organization: ${value.organizationSlug}`,
            `members: ${value.memberCount ?? 0}`,
            `projects: ${value.projectCount ?? 0}`,
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Team ${args.slug}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; name?: string; slug?: string }
        if (!v.found) return { card: 'generic', title: 'Team not found' }
        return { card: 'generic', title: `${v.name} (${v.slug})` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, reason: 'Getting Sentry team data requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        try {
          const info = await client.getTeam(organization, args.slug as string, exec.signal)
          return { found: true, ...info }
        } catch (error) {
          if (error instanceof SentryError && error.status === 404) return { found: false }
          throw error
        }
      },
    }),

    defineTool({
      name: 'sentry_list_members',
      description: 'List Sentry organization members with role, pending state, and invite email.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        limit: { type: 'integer', description: 'Maximum results, 1-100 (default 20)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', description: 'Whether members are accessible' },
            reason: { type: 'string', description: 'Explanation when not accessible' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', description: 'Member id' },
                  email: { type: 'string', description: 'Member email' },
                  name: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Member name' },
                  role: { type: 'string', description: 'Member role' },
                  pending: { type: 'boolean', description: 'Whether the invite is pending' },
                  expired: { type: 'boolean', description: 'Whether the invite expired' },
                  dateCreated: { type: 'string', description: 'Invite creation timestamp' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: 'Members are not accessible.' }]
          const items = value.items ?? []
          if (items.length === 0) return [{ type: 'text', text: 'No members found.' }]
          return [{ type: 'text', text: items.map(item => `${item.name ?? item.email} <${item.email}> (${item.role}${item.pending ? ', pending' : ''})`).join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Members in ${resolveOrganizationLabel(client, args)}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { found?: boolean; items?: Array<{ email: string }> }
        if (!v.found) return { card: 'generic', title: 'Members not accessible' }
        return { card: 'generic', title: `${(v.items ?? []).length} member(s)` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { found: false, items: [], reason: 'Listing Sentry members requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { found: false, items: [], reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(Number(args.limit), 100))
        const items = await client.listMembers(organization, { perPage: limit, signal: exec.signal })
        return { found: true, items }
      },
    }),

    defineTool({
      name: 'sentry_update_issue',
      description: 'Update a Sentry issue status or assignee. WRITE operation: requires an auth token with issue write access.',
      parameters: {
        organization: { type: 'string', description: 'Organization slug; defaults to plugin config when omitted' },
        issueId: { type: 'string', required: true, description: 'Sentry issue id' },
        status: { type: 'string', enum: ['unresolved', 'resolved', 'ignored'], description: 'New issue status' },
        assignedTo: { type: 'string', description: 'Assignee email or username' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', description: 'Whether the update succeeded' },
            id: { type: 'string', description: 'Issue id' },
            status: { type: 'string', description: 'Updated status' },
            assignedTo: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Updated assignee' },
            reason: { type: 'string', description: 'Explanation when not updated' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `Could not update issue: ${value.reason}` }]
          return [{ type: 'text', text: `Issue ${value.id} updated (${value.status ?? 'unchanged'}, ${value.assignedTo ?? 'no assignee'})` }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Update issue ${args.issueId}`, kind: 'edit' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { ok?: boolean; id?: string; status?: string }
        if (!v.ok) return { card: 'generic', title: 'Update issue failed' }
        return { card: 'generic', title: `Issue ${v.id} updated`, content: [{ type: 'text', text: v.status ?? '' }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { ok: false, id: args.issueId as string, reason: 'Updating a Sentry issue requires a Sentry auth token.' }
        const organization = resolveOrganization(client, args)
        if (!organization) return { ok: false, id: args.issueId as string, reason: 'Sentry organization is required. Set plugin config or pass organization.' }
        return client.updateIssue(organization, args.issueId as string, {
          status: args.status as 'unresolved' | 'resolved' | 'ignored' | undefined,
          assignedTo: args.assignedTo,
          signal: exec.signal,
        })
      },
    }),
  ]
}

function resolveOrganization(client: SentryClient, args: Record<string, unknown>): string | null {
  const explicit = typeof args.organization === 'string' ? args.organization : undefined
  return explicit ?? client.getDefaultOrganization() ?? null
}

function resolveOrganizationLabel(client: SentryClient, args: Record<string, unknown>): string {
  return resolveOrganization(client, args) ?? 'unknown organization'
}
