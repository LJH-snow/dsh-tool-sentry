# dsh-tool-sentry 开发文档

## 1. 项目概览

| 项目 | 说明 |
|---|---|
| 项目名 | `dsh-tool-sentry` |
| 发布名 | `@libai168/dsh-tool-sentry` |
| 定位 | DeepSeek Harness（dsh）的独立 Sentry 工具插件 |
| 工具数 | 12（11 只读 + 1 写） |
| 架构 | `apply` + `createTools(client)`，通过 `ctx.tools.register(defineTool(...))` 注册 |
| 默认 API | `https://sentry.io/api/0` |

本插件不依赖 GitHub、GitLab 或 SQL 插件的代码，只复用它们已经验证过的插件模式：`SentryClient` 注入 fetch、工具定义与 UI 分离、业务失败返回规范值、基础设施错误抛出。

## 2. 技术要点

### 2.1 客户端

- 认证：`Authorization: Bearer <token>`。
- `baseUrl` 会去掉末尾 `/`，默认 `https://sentry.io/api/0`。
- `timeoutMs` 默认 15000；`exec.signal` 会与超时合并到同一个 `AbortController`。
- 业务错误映射：
  - 404 在 `getOrganization`、`getProject`、`getIssue`、`getRelease`、`getTeam` 中由工具层映射为 `{ found: false }`。
  - `updateIssue` 直接将 400/404 映射为 `{ ok: false, id, reason }`。
  - 401、403、429、其他非 2xx 抛 `SentryError`。

### 2.2 使用的 Sentry API

| 方法 | 端点 |
|---|---|
| `getOrganization` | `GET /organizations/{org}/` |
| `listProjects` | `GET /projects/?per_page=&query=` |
| `getProject` | `GET /projects/{org}/{project}/` |
| `listIssues` | `GET /projects/{org}/{project}/issues/?query=&status=&limit=` |
| `getIssue` | `GET /organizations/{org}/issues/{id}/` |
| `listIssueEvents` | `GET /organizations/{org}/issues/{id}/events/?limit=` |
| `listReleases` | `GET /projects/{org}/{project}/releases/?per_page=` |
| `getRelease` | `GET /projects/{org}/{project}/releases/{version}/` |
| `listTeams` | `GET /organizations/{org}/teams/?per_page=` |
| `getTeam` | `GET /teams/{org}/{slug}/` |
| `listMembers` | `GET /organizations/{org}/members/?per_page=` |
| `updateIssue` | `PATCH /organizations/{org}/issues/{id}/` |

### 2.3 UI 约定

- 每个工具都有 `presentCall`/`presentResult` 和纯 `render`。
- 列表工具使用 `search` kind；详情工具使用 `read` kind；写操作用 `edit` kind。
- 输出 schema 中可空字段使用 `oneOf: [string, null]`，避免模型把缺失字段当错误。

## 3. 决策记录

| 时间 | 决策 | 说明 |
|---|---|---|
| 2026-08-27 | 选择 Sentry 作为新插件方向 | 与 GitHub/GitLab/SQL 不重叠，聚焦错误监控、release 与研发治理 |
| 2026-08-27 | 首批只做 12 个高频工具 | 避免 80+ 工具的大而全模式；后续可按 Jira/云资源等方向各自开新插件 |
| 2026-08-27 | 所有工具要求 token | Sentry REST API 本身需要认证；无 token 时返回业务值而非调用接口 |
| 2026-08-27 | 不引入运行时依赖 | HTTP 使用全局 fetch，插件打包面保持最小 |
| 2026-08-27 | 自托管通过 `baseUrl` 支持 | 和 GitHub/GitLab 插件的配置方式一致，`baseUrl` 必须包含 `/api/0` |

## 4. 验证命令

```sh
npm install
npm run typecheck
npm test
npm run build
```

验收时确认：

- `npm run typecheck` 无错误。
- `npm test` 当前 18 例全绿，覆盖客户端路径/query/body、404 映射、无 token、默认组织、limit 钳制和工具渲染。
- `npm run build` 输出 `lib/`，`exports.types` 指向生成的声明文件。

## endpoint 安全校验

`baseUrl` 默认行为不变（仅去尾斜杠），每次请求前额外做字面量链路本地校验：`169.254.0.0/16`、`fe80::/10`，以及 `::/96`、`::ffff:0:0/96`、`64:ff9b::/96` 中内嵌的 IPv4 形式。默认模式**不做 DNS 解析**，因此域名端点行为与之前完全一致。

设置 `enforcePublicEndpoint: true` 后启用完整策略：`baseUrl` 规范化为 origin + 路径前缀（禁止 credentials/query/fragment），并对解析结果做 fail-closed 校验。

两个模式的地址清单共享同一份 `src/url-security.ts`——该文件由 `.verify/gen-url-security-b.mjs` 从 A 类模板加 B 类策略层生成，网段清单与 A 类逐行一致（18 个 IPv4 + 16 个 IPv6，对齐 IANA 注册表），不得单独修改。`lookupImpl` 仅作测试注入点，不进入插件配置接口。

自建部署（内网 GitLab / GitHub Enterprise / Jira DC / 自托管 Sentry）默认不受影响，这是本插件不默认开启公网限制的原因。
