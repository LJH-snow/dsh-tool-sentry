# dsh-tool-sentry

[English](README.md) | [中文](README.zh.md)

A Cordis tool plugin that gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) focused Sentry workflows: project health, unresolved issues, event context, releases, teams, and organization members.

The plugin registers 12 tools with the official `ctx.tools.register(defineTool(...))` contract, uses `presentCall`/`presentResult` for compact replay-friendly UI cards, and treats authentication, request timeout, and cancellation as first-class concerns.

## Install

Install directly from GitHub (no npm publish needed):

```sh
npm install github:LJH-snow/dsh-tool-sentry
# or a specific branch/tag
npm install github:LJH-snow/dsh-tool-sentry#main
```

Or from a local checkout:

```sh
git clone https://github.com/LJH-snow/dsh-tool-sentry
cd dsh-tool-sentry
npm install && npm run build   # builds to lib/
npm install /path/to/dsh-tool-sentry
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies, provided by the host dsh runtime.

## Configuration

Load the plugin in a dsh composition config (`cordis.yml`):

```yaml
- name: 'dsh-tool-sentry'
  config:
    token: 'sntrys_xxx'        # required Sentry API token
    organization: 'acme'       # optional default org slug; tools can still override it
    baseUrl: 'https://sentry.io/api/0'   # optional; use your self-hosted Sentry API root
    timeoutMs: 15000           # optional request timeout in ms (default 15000)
```

Full example: [examples/cordis.yml](examples/cordis.yml).

The endpoint is checked before every request. Link-local addresses (`169.254.0.0/16`, `fe80::/10`, including their IPv4-mapped and NAT64 forms) are always rejected: they are never a valid API endpoint and include the cloud metadata address. Self-hosted endpoints on private networks keep working by default. Set `enforcePublicEndpoint: true` to additionally require a publicly reachable host; that mode also resolves ordinary hostnames and rejects loopback, private, CGNAT, multicast, reserved, and every IANA special-purpose range.

## Tools

### Read-only

| Tool | Description | Organization |
|---|---|---|
| `sentry_get_organization` | Organization metadata, 2FA policy, pending access requests, URL | config or arg |
| `sentry_list_projects` | Projects visible to the token, optionally filtered by query | config or arg |
| `sentry_get_project` | One project: team, platform, first event, latest release, features | config or arg |
| `sentry_list_issues` | Issues in a project with query/status filters | config or arg |
| `sentry_get_issue` | Issue detail: counts, status, assignee, permalink | config or arg |
| `sentry_list_issue_events` | Recent events for an issue | config or arg |
| `sentry_list_releases` | Releases for a project | config or arg |
| `sentry_get_release` | One release with projects and commit/new-group counts | config or arg |
| `sentry_list_teams` | Organization teams with member/project counts | config or arg |
| `sentry_get_team` | One team with access and pending state | config or arg |
| `sentry_list_members` | Organization members with role and invite state | config or arg |

### Write

| Tool | Description | Organization |
|---|---|---|
| `sentry_update_issue` | Update issue status or assignee | config or arg |

## Behavior contract

- Sentry REST API is auth-first, so every tool requires a plugin `token`.
- Missing/invalid calls return canonical business values: missing objects give `{ found: false }`, and `sentry_update_issue` maps 400/404 to `{ ok: false, reason }`.
- Infrastructure errors such as 401, 403, 429, timeout, and network failures throw `SentryError` or the original fetch error.
- All requests forward `exec.signal` and use a 15 second timeout by default.
- Output schemas, `render`, `presentCall`, and `presentResult` stay pure, so tool calls and results are replay-safe.

## Development

```sh
npm install
npm run typecheck   # type check
npm test            # unit tests (vitest)
npm run build       # build to lib/
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for technical notes and decisions.

## Publishing

1. Ensure `npm run typecheck`, `npm test`, and `npm run build` all pass.
2. Publish with `npm publish --access public`.
3. Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to the GitHub repository for ecosystem discovery.

## License

[MIT](LICENSE)
