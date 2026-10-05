# dsh-tool-sentry

[English](README.md) | [中文](README.zh.md)

面向 **DeepSeek Harness**(`dsh`) 的 Cordis 工具插件，为 Agent 提供聚焦的 Sentry 工作流：项目健康、未解决 issue、事件上下文、release、团队以及组织成员查看。

插件按官方 `ctx.tools.register(defineTool(...))` 契约注册 12 个工具，使用 `presentCall`/`presentResult` 提供紧凑、可回放的界面卡片，并把认证、超时和取消作为一等行为。

## 安装

直接从 GitHub 安装（无需发布 npm）：

```sh
npm install github:LJH-snow/dsh-tool-sentry
# 或指定分支/标签
npm install github:LJH-snow/dsh-tool-sentry#main
```

或从本地安装：

```sh
git clone https://github.com/LJH-snow/dsh-tool-sentry
cd dsh-tool-sentry
npm install && npm run build   # 构建到 lib/
npm install /path/to/dsh-tool-sentry
```

需要 `@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6）作为 peer 依赖，由 dsh 运行时提供。

## 配置

在 dsh 组合配置（`cordis.yml`）中加载插件：

```yaml
- name: 'dsh-tool-sentry'
  config:
    token: 'sntrys_xxx'        # 必需的 Sentry API token
    organization: 'acme'       # 可选默认组织 slug，单次调用仍可覆盖
    baseUrl: 'https://sentry.io/api/0'   # 可选；自托管时改为你的 Sentry API 根地址
    timeoutMs: 15000           # 可选请求超时毫秒数（默认 15000）
```

完整示例见 [examples/cordis.yml](examples/cordis.yml)。

每次请求前都会校验目标地址。链路本地地址（`169.254.0.0/16`、`fe80::/10`，含其 IPv4-mapped 与 NAT64 形式）始终被拒绝——它们不可能是合法的 API 端点，且包含云元数据地址。内网自建端点默认保持可用。设置 `enforcePublicEndpoint: true` 可额外要求主机公网可达；该模式还会解析普通域名，并拒绝环回、私有、CGNAT、组播、保留以及全部 IANA 特殊用途地址段。

## 工具列表

### 只读

| 工具 | 功能 | 组织来源 |
|---|---|---|
| `sentry_get_organization` | 组织元信息、2FA 策略、待处理访问请求、URL | 配置或参数 |
| `sentry_list_projects` | 当前 token 可见项目列表，可按 query 过滤 | 配置或参数 |
| `sentry_get_project` | 单个项目：团队、平台、首个事件、最新 release、功能 | 配置或参数 |
| `sentry_list_issues` | 项目 issue 列表，支持 query/status 过滤 | 配置或参数 |
| `sentry_get_issue` | issue 详情：计数、状态、负责人、链接 | 配置或参数 |
| `sentry_list_issue_events` | issue 最近事件列表 | 配置或参数 |
| `sentry_list_releases` | 项目 release 列表 | 配置或参数 |
| `sentry_get_release` | 单个 release：项目、commit/new-group 数量 | 配置或参数 |
| `sentry_list_teams` | 组织团队列表，含成员/项目数量 | 配置或参数 |
| `sentry_get_team` | 单个团队，含访问与 pending 状态 | 配置或参数 |
| `sentry_list_members` | 组织成员列表，含角色与邀请状态 | 配置或参数 |

### 写操作

| 工具 | 功能 | 组织来源 |
|---|---|---|
| `sentry_update_issue` | 更新 issue 状态或负责人 | 配置或参数 |

## 行为约定

- Sentry REST API 是 auth-first，因此每个工具都需要插件 `token`。
- 业务失败返回规范值：资源不存在返回 `{ found: false }`；`sentry_update_issue` 将 400/404 映射为 `{ ok: false, reason }`。
- 基础设施错误（401、403、429、超时、网络失败等）抛 `SentryError` 或原始 fetch 错误。
- 所有请求透传 `exec.signal`，默认 15 秒超时。
- 输出 schema、`render`、`presentCall`、`presentResult` 均为纯函数，便于调用与结果回放。

## 开发

```sh
npm install
npm run typecheck   # 类型检查
npm test            # 单元测试（vitest）
npm run build       # 构建到 lib/
```

技术说明与决策见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 发布

1. 确认 `npm run typecheck`、`npm test`、`npm run build` 全部通过。
2. 执行 `npm publish --access public`。
3. 为 GitHub 仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic，便于生态发现。

## License

[MIT](LICENSE)
