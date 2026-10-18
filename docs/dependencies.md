# 依赖与许可证说明

核实日期：2026-10-19。用于 `v0.1.0-preview.1`，精确安装版本以 `package-lock.json` 为准。

| 依赖 | 选择与核实 |
| --- | --- |
| Node.js 24.22.0 LTS | 官方分发，SHA-256 校验；使用内置 `node:sqlite` 和 `node:test` |
| `@modelcontextprotocol/sdk` 1.32.1 | 1.x 完整包；实查其安装产物的 provider、注册、授权、token、Bearer 校验和无状态传输 API |
| Express 5.3.0 | 与 SDK 处理器共用 HTTP 框架 |
| `@node-rs/argon2` 2.2.2 | 使用 Argon2id 默认参数进行哈希与验证，具备 Linux x64 预编译支持 |
| Zod 4.6.7 | 与 SDK 已使用的校验库共用 |
| TypeScript 7.0.2 / tsx 4.23.15 | 构建、类型检查及执行 TypeScript 测试；测试断言使用 Node 内置模块 |
| `playwright-core` 1.64.1 | 仅开发依赖，用独立 Chromium 回归实际浏览器的表单 Origin、CSP 跳转及 Cookie 行为；不打包浏览器、不进入生产依赖 |

SDK 2.x 已拆分包；本阶段选用仍发布的 1.x 完整接口，减少认证适配涉及的包和迁移工作。未据此宣称 2.x 不支持这些能力。

应用复用 SDK `authorizationHandler`、`clientRegistrationHandler`、`tokenHandler`、`requireBearerAuth` 和 `StreamableHTTPServerTransport`。provider 负责应用状态；SDK 负责其覆盖的请求校验、客户端加载、PKCE 验证和协议处理。测试包含真正的 SDK MCP 客户端，不只测 provider 方法。

实查发现 SDK 的默认元数据、端点路径、OAuth 错误回调及 CORS 不完全符合本设计，因此分别挂载处理器，并提供准确元数据、issuer/state 回调补充和受限 Origin。没有修改依赖源码。

SQLite 采用本地事务和默认 journal，不引入原生 SQLite npm 扩展；口令验证并发限制为 2。短期授权事务与授权码放在有界内存中。未增加外部身份平台或通用存储接口。

许可证：SDK 为 MIT，依赖包自带其许可证；本次没有复制 Cloudflare 应用源码，仅参考工具接口。后续若复制实现代码，须先核对对应源码许可证及保留要求。本项目当前尚未指定自己的开源许可证。

资料与产物：

- [官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [已安装版本的 npm 元数据](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.1)
- [Node 24.22.0 官方分发与校验文件](https://nodejs.org/dist/v24.22.0/)
- [OpenAI OAuth 接入](https://developers.openai.com/plugins/build/auth)
- [DCR 规范](https://datatracker.ietf.org/doc/html/rfc7591)
