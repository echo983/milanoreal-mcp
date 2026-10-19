# 实施与验证记录

日期：2026-10-19。最初部署为仅注册 `connection_test` 的认证验证版本；用户确认 ChatGPT 与 Claude 均成功后，已实现并部署六个正式工具。下文先保留认证阶段的验证记录，再记录正式工具结果。

## 已完成

- Node 24.22.0 官方发行包的 SHA-256 校验。
- 应用和测试代码的 TypeScript 类型检查。
- 生产构建。
- 16 项自动化测试：完整授权、真实 SDK MCP 握手及工具调用、错误输入、浏览器绑定、PKCE/回调/客户端/resource 绑定、一次性授权码、刷新轮换及重放、独立进程撤销、密码变更、异步密码验证期间撤销、并发刷新、跨重启持久化、到期、注册清理与独立到期检查及失败口令限速。
- 编译后的管理命令在伪终端中成功设置测试口令，验证口令不回显；只使用临时测试目录。
- 目标 VPS SSH 可连接，管理账号免密 sudo 可用；新建普通用户 `mcp`，未授予 sudo。
- 目标 VPS 安装 Node 24.22.0、应用生产构建与锁定依赖；以 `mcp` 身份成功加载 SQLite、Argon2 与应用模块。
- 安装 systemd 单元及私有配置；生产默认数据库权限实测为 0600。
- 部署初期以 `mcp` 身份启动未初始化服务时，正确拒绝运行；之后用户在自己的终端完成口令初始化并启动服务。
- 以 `mcp` 身份运行生产构建的临时自检：使用临时目录及临时随机口令哈希启动 loopback 服务，验证健康检查、OAuth 发现及匿名 MCP 请求得到 401；自检结束关闭监听并删除临时状态，未初始化真实服务口令。

生产依赖安装使用 `npm ci --omit=dev --ignore-scripts`；未安装开发依赖或运行 npm 安装脚本。用户数据与实际配置未加入版本库。

## 公网入口验证

- 应用与 cloudflared 服务均为 active，公网 `/healthz` 返回 200。
- 授权服务器元数据和两个资源发现路径均返回 200；issuer、resource 和端点为正确的公网 HTTPS 地址。
- 匿名 `/mcp` 请求返回 401，并附带正确的资源发现 challenge。
- 配置精确回调 `https://chatgpt.com/connector_platform_oauth_redirect` 和 `https://claude.ai/api/mcp/auth_callback`；保留原配置备份，未修改口令与授权数据库。
- 使用无授权的诊断注册分别验证这两个回调：DCR 返回 201，带有效 PKCE challenge 的授权页返回 200，Cookie 包含 Secure 与 HttpOnly。未输入口令、未签发令牌，不能将此标记为真实客户端成功。
- 两条诊断注册记录均未获得批准，按未授权记录清理策略自动到期。

回调依据：[OpenAI issuer/callback 配置](https://developers.openai.com/plugins/build/auth)、[Claude 服务端接入文档](https://claude.com/docs/connectors/building)。实际客户端若使用其他地址，应核对其来源后精确配置，不使用通配符。

## 尚未完成

- ChatGPT / Claude 的正式工具回归、刷新、撤销和重新登录；两端临时 `connection_test` 已由用户确认成功。
- 公网调用等待时长、真实手机端入口和服务重启后的客户端行为。
- 双客户端正式工具验收及部署恢复验收。

## 结论边界

本地测试证明 provider、HTTP 适配、SQLite 状态和 SDK 客户端的组合行为；两端基础互通另由用户报告确认。没有据此推断所有网页/app、手机端入口及刷新行为都已通过。服务未初始化时不开放匿名入口，正式工具在用户确认两端基础连接成功后推进。

## 浏览器表单修复

用户联调时在 `/oauth/approve` 遇到 `invalid_origin`。真实 Chromium 在正式 Tunnel 上复现：原授权页的 `Referrer-Policy: no-referrer` 使 HTML 表单 POST 带 `Origin: null`，被服务端返回 403。此前 Node HTTP 测试手动指定或省略 Origin，未覆盖浏览器生成该头部的行为。

将策略改为 `same-origin`，保留本站表单来源，并避免把授权页面地址作为跨站 referrer。真实浏览器继续检查时还发现 `form-action 'self'` 会阻断 OAuth 表单提交后的跨站回调，因此 CSP 仅增加配置白名单中的回调 origin，其他限制保留。

新增独立的 `npm run test:browser`，使用临时数据及隔离 Chromium 验证拒绝、批准、Cookie/CSRF、回调 issuer/state、跨站 referrer 不泄露及授权码兑换。回归测试先在旧代码下失败，再在修复后通过；16 项原测试、类型检查及构建也通过。浏览器测试不使用个人浏览器配置或真实口令。

修复已部署并重启服务。通过正式 Tunnel 再次用 Chromium 验证拒绝流程：POST 的 Origin 为正确的本站地址，响应 302 并到达预期 `access_denied` 回调。公网检查未输入用户口令，也未签发用户授权；批准与令牌兑换通过本地浏览器测试。之后用户分别确认 ChatGPT 和 Claude 的 `connection_test` 成功。服务重启使旧的未完成授权页面失效。

机制参考：[Fetch 的 Origin 头处理](https://fetch.spec.whatwg.org/#append-a-request-origin-header)。

## 双客户端基础互通

用户分别报告 ChatGPT 成功、Claude 也测试完成；临时工具返回 `Authenticated connection is working.`。这证明这两次实际客户端接入的认证与工具调用可用。当前服务只支持 DCR public client + PKCE，因此不另加兼容注册层。SDK 为锁定的 `@modelcontextprotocol/sdk` 1.32.1。

没有要求用户提供口令或 token，也没有使用用户认证状态运行诊断。账号套餐、具体网页/app/手机端入口未记录；不能扩展为所有入口均已验证。

## 六个正式工具

- 30 项自动化测试通过，包含原认证边界、真实 SDK 调用六个工具、同一 access token 跨应用重启使用及文件保留。
- HTTP 层验证独立无状态请求共享两个执行槽；断开命令请求不会自动重复执行，该命令按既定逻辑继续完成。
- 实际 Bash 验证工作目录、环境隔离、stdin EOF、非零退出、Node PATH、128 KiB 输出限制、UTF-8 截断、stderr 丢弃仍排空、busy、spawn 失败恢复，以及显式脱离的后台任务。
- 超时测试仅启动自己的父子进程，让两者忽略 TERM，验证宽限期后 KILL；没有终止其他进程。Shell 先退出、后代继续持有管道的场景也验证了有界收尾。
- 文件测试覆盖 Unicode、空格、相对/绝对/file URI 路径、隐藏文件、目录读取、二进制资源、覆盖、1 MiB 限制、符号链接删除、权限失败、FIFO/设备拒绝及目录截断。
- 真实 Chromium 授权回归、类型检查和构建通过。
- 新增 `deploy/smoke.mjs`：以普通用户加载编译产物和生产依赖，使用独立临时配置、随机口令及数据库，完成 DCR、PKCE、批准、令牌兑换、刷新及真实 SDK 六工具调用，结束后清理。该自检在本地和目标 VPS 的 `mcp` 用户下均通过。
- 正式服务已替换为六工具版本，移除 `connection_test`。保留口令、正式配置和认证数据库，保存部署前构建以备回退。安装后的生产目录再次运行隔离自检通过，服务及 cloudflared 为 active。
- 在正式工作目录创建专用临时标记，重启真实 systemd 服务后确认内容保留，再删除该标记。运行身份为 `mcp`，工作目录及 `KillMode=control-group` 与单元一致。重启完成后，公网健康与 OAuth 发现返回 200，匿名 MCP 请求返回 401。

目标用户未配置免密 sudo，因此没有验证提权命令或修改 sudoers。生产构建自检采用临时认证，不代表已用两个真实客户端调用新版工具。真实客户端的正式工具实测另记如下；刷新、撤销与最终恢复验收仍保留为未完成项。

## ChatGPT 正式工具实测

用户确认本轮仅在 ChatGPT 通过 Sandbox Milano 执行，结果如下（用户报告，未由开发侧重复读取项目文件）：

| 检查 | 结果 |
| --- | --- |
| `container_ping` | `ok: true` |
| 命令工作目录 | `/home/mcp/workspace` |
| 执行身份 | `uid=1001(mcp) gid=1004(mcp) groups=1004(mcp)` |
| 文件写入 | `io-test.t5mKpQPT/probe.txt`，报告 38 字节 |
| 文件读取 | 与写入内容一致，显示 `sandbox-milano read-write-delete test` |
| 文件删除 | 成功，随后确认文件不存在 |
| 清理 | 测试目录已删除 |
| Shell 状态 | 所有命令退出码均为 0，无 stderr |

报告没有单列 `container_files_list`，因此不把本轮扩展为六工具全部逐项验收；该工具已通过自动化和 VPS 隔离自检。

## Claude 正式工具实测

用户随后确认 Claude 的正式工具测试也通过，结果如下（用户报告）：

| 检查 | 结果 |
| --- | --- |
| `container_ping` | 状态 ok，用户 `mcp`，uid 1001 |
| 工作区与 Shell | `/home/mcp/workspace`，`/bin/bash` |
| Node | v24.22.0 |
| `pwd` / `id` | 工作目录正确；`uid=1001(mcp) gid=1004(mcp) groups=1004(mcp)`，退出码 0，报告耗时 7 ms |
| 文件写入 | `test/claude_rw_test.txt`，报告成功写入 54 字节，含中文与 ✓ |
| 文件读取 | 与写入完全一致，UTF-8 正常 |
| 文件删除 | `deleted: true`，使用 `test -e` 复查文件不存在 |
| 父目录 | 写入时自动创建原先不存在的 `test/`，权限 `drwx------`；删除文件后空目录保留 |

这轮报告也未单列 `container_files_list`，仍保留两端列表工具的单独确认项。文件删除保留父目录符合当前工具语义；开发侧未为清理这一空目录而重新连接或修改工作区。两端核心执行与文件读写删除均已有用户实测证据，刷新、撤销与重新登录尚未确认。

## 预览快照发布检查

`v0.1.0-preview.1` 的发布准备再次通过类型检查、30 项自动化测试、1 项真实 Chromium 授权回归、生产构建及本地隔离生产自检。检查了文档的相对链接、Bash 示例语法及 JSON 示例，并核对包元数据、锁文件与 MCP 上报版本一致。

此次首次将已部署实现提交入库，补齐从零部署、运维恢复、客户端验收与版本记录；版本标识从 `0.1.0-dev` 统一为 `0.1.0-preview.1`。此次操作不重新部署 VPS，线上实测对应此前同功能的开发构建，不将本次本地发布检查写成新版本在 VPS 的再次验收。

M2/M3/M4 的剩余项目保持未完成：两端列表工具单独确认、实际客户端刷新/撤销/重启后继续使用、等待预算及完整恢复演练。预览标签用于保存可运行实现快照，不表示所有验收项均已通过。

## 两端列表补测与 50 秒等待差异

用户补充报告：

| 检查 | ChatGPT | Claude |
| --- | --- | --- |
| 实际 `container_files_list` | 通过 | 通过 |
| 工作目录与条目 | `/home/mcp/workspace`，一项 `test` 目录，`truncated: false` | 相同；URI 为 `file:///home/mcp/workspace` |
| 命令 | `sleep 50; printf 'wait-test complete\n'`，timeout 60000 ms | 相同 |
| 返回 | stdout 为 `wait-test complete\n`，stderr 空，退出码 0，`timedOut: false`，50013 ms | 连接器错误，未得到 stdout/退出码/timedOut/durationMs |
| 重试 | 无 | 无 |

Claude 的错误为 `The connector's server isn't responding. You can try again.`，诊断 request ID 为 `req_011CgAcfGqG1raajWb2ZezjX`。没有实际错误发生耗时或 HTTP 状态，因此只记录这次调用失败，不把模型关于短于 50 秒等待上限的判断视为测量结果。

开发侧随后通过 SSH 只读检查：应用和 cloudflared 均为 active，`NRestarts=0`；当前专用用户下未见遗留的延时测试进程。最近日志只显示此前部署重启期间的一次 loopback 连接拒绝，没有证据将其关联到此次 Claude 请求。现有日志不记录逐请求执行结果，无法追溯确认那条 Claude 命令的执行/退出状态。此次没有重跑该命令、重启服务或修改生产状态。

核对 [Claude 官方接入文档](https://claude.com/docs/connectors/building)，其标注的 claude.ai/Desktop 工具调用超时为 240 秒。不能据一次连接器错误归因于固定平台上限；ChatGPT 同时长成功也表明当前整体链路可以完成至少一次 50 秒调用，但不排除客户端路径差异或偶发连接故障。当时安排 Claude 单次 10 秒/30 秒分级诊断，后续结果见下一节。必要时用独立临时标记确认完成状态，预算暂不更改。

至此两端六个正式工具均有用户实测证据，M3 完成。M2 的实际刷新/撤销、重启后客户端续用及等待问题定位，M4 的恢复演练继续待办。

## Claude 10 秒与 30 秒诊断

用户报告两次独立诊断均成功，无连接中断：

| 字段 | 10 秒测试 | 30 秒测试 |
| --- | --- | --- |
| stdout | `10s complete` | `30s complete` |
| stderr | 空 | 空 |
| exitCode | 0 | 0 |
| timedOut | false | false |
| signal | null | null |
| truncated / outputIncomplete | false / false | false / false |
| durationMs | 10012 | 30007 |

这些耗时来自服务端执行结果，用户明确没有客户端墙钟计时，不将其改写为客户端端到端延时。Claude 可成功完成上述两次调用，但此前一次 50 秒连接器错误不足以证明固定等待上限处于 30–50 秒；没有测得该次失败实际耗时，也未验证同条件下稳定复现。40/45 秒调用即使成功，也不能单独排除偶发网络或连接器故障。

当前保持默认 60 秒、最大 90 秒，不据此修改传输或增加工具。后续定位如需新的诊断，应带请求前后计时及独立完成标记，避免反复无记录地探测 sleep 阈值。刷新、撤销与恢复验收可以独立推进。

## 隔离归档恢复演练

新增 `deploy/smoke.mjs --recovery`，保留默认自检方式。仅使用临时随机口令、配置、SQLite 与项目；不复制或读取正式配置和认证数据库。执行流程及实测结果：

- 通过真实 SDK 六工具及 OAuth 流程建立临时项目和授权，完成一次 refresh 轮换，再关闭临时服务与数据库。
- 复制当前构建、已安装依赖和包元数据，连同临时配置、完整状态目录与工作区使用 tar 归档，计算并核对 SHA-256；归档权限 0600。
- 删除原临时副本，在新位置解包，加载恢复出的代码/依赖与配置，核对相对工作目录、状态目录 0700、数据库 0600、SQLite integrity_check 与 foreign_key_check。
- 恢复后原 access token 和项目文件仍可使用，refresh 可继续轮换；备份前已消费的 refresh 哈希仍能触发重放拒绝及该授权撤销。
- 原口令与已批准 client ID 可重新授权。仅对恢复出的临时数据库调用与管理命令相同的撤销操作，验证 access/refresh 拒绝及随后重新授权；这不是正式两端撤销实测。
- 本地默认自检与恢复自检通过；类型检查、30 项自动化测试及构建通过。目标 VPS 以 `mcp` 用户运行恢复自检也通过，线上服务 PID 与启动时间在演练前后不变，健康检查正常。

独立自检脚本已更新到 VPS；没有重新部署或修改运行中的应用代码、正式口令及授权。临时数据均已清理。该演练覆盖同架构/运行时下的归档与数据恢复，不覆盖 root 文件所有权/systemd 单元替换或真实客户端重新授权。

随后仅查询正式数据库的汇总刷新指标，没有查询或输出口令哈希、令牌值/哈希或 client ID。2026-10-19 00:14 UTC，ChatGPT 与 Claude 各有一项当前有效授权，已消费 refresh 数均为 0；最近 access 签发时间分别为 2026-10-18 23:30:43 UTC、23:35:57 UTC。因此此时尚无真实自动刷新证据，符合当前 token 尚未到期；共同测试时间可选 2026-10-19 00:37 UTC 之后（马德里 02:37），无需修改正式有效期。

## 服务重启后的客户端续用

检查专用用户进程，仅有应用进程与诊断用 ps；在执行前再次检查没有额外的活跃用户任务后，于 2026-10-19 00:14:40 UTC 重启正式应用。PID 更新、服务 active，loopback 健康及公网健康/发现返回正常，匿名 MCP 仍为 401；没有改变口令、授权版本、token 有效期或应用运行代码。

用户随后报告 ChatGPT 和 Claude 均直接在原连接调用 `container_ping` 成功，未手动重连、重新登录或遇到授权提示。Claude 返回的用户、工作区及运行时与首次 ping 一致；ChatGPT 返回 `ok: true`、用户 `mcp`、工作区 `/home/mcp/workspace`。因此两端服务重启后的客户端续用通过。此次成功也表明此前 Claude 的单次 50 秒连接器错误没有使当前连接或授权失效，但不能据此推断那条命令的实际执行结果。

2026-10-19 00:18 UTC 后再次只读查询正式数据库汇总：两端各有一项当前有效授权、已消费 refresh 数均为 0，最近 access 签发时间仍分别为 2026-10-18 23:30:43 UTC、23:35:57 UTC。按服务端 1 小时有效期，原 access token 分别到 2026-10-19 00:30:43 UTC、00:35:57 UTC 才到期。这两次 ping 验证了重启后现有有效授权可用，尚未验证到期后的自动刷新。可在 2026-10-19 00:37 UTC 之后（马德里 02:37）仅通过现有连接各调用一次 ping，再结合汇总刷新记录验证自然刷新；不手动断开或重新授权。正式全部撤销安排在刷新验收之后，避免先撤销导致无法验证这批授权的自然刷新。

## 专用用户获得免密 sudo

此前“未授予 sudo”的记录对应部署初期。用户随后明确要求授予 `mcp` sudo 权限。管理员先确认目标规则文件不存在且现有 sudoers 语法正常，再安装 root 拥有、权限 0440 的 `/etc/sudoers.d/milanoreal-mcp`，内容为 `mcp ALL=(ALL:ALL) NOPASSWD:ALL`。新规则及整份 sudoers 均通过 `visudo` 语法检查；以 `mcp` 身份执行 `sudo -n id -u` 返回 `0`，`sudo -l -U mcp` 显示 `(ALL : ALL) NOPASSWD: ALL`。未更改 MCP 服务的运行身份、授权数据库或应用代码；已认证的 Shell 命令现在可显式使用 `sudo -n` 提权。

## 两端实际自动刷新

用户在原访问令牌到期后，分别沿用 ChatGPT 与 Claude 的现有连接调用 `container_ping`。两端都返回 `ok: true`、用户 `mcp`（uid 1001）、工作区 `/home/mcp/workspace`、Shell `/bin/bash`、Node v24.22.0；Claude 明确报告未遇到登录或授权提示，也未手动重连。随后开发侧仅查询正式数据库的客户端类别、有效授权数、已消费 refresh 数及最新 access 签发时间，不读取或输出令牌值、哈希、口令或 client ID。2026-10-19 00:41 UTC，ChatGPT 与 Claude 各有一项有效授权、各有一次已消费 refresh；新 access 分别于 00:33:42 UTC、00:40:32 UTC 签发。此前 00:18 UTC 查询时两端该计数均为 0，且原 access 分别于 00:30:43 UTC、00:35:57 UTC 到期。这同时证明两端在正式环境中完成了至少一次自然刷新和后续认证调用；不推断长期多次轮换或其他未测试入口。

## 正式授权撤销后的客户端验收

两端自动刷新确认后，用户明确同意立即执行正式 `revoke-all`。管理员通过交互式管理命令输入 `REVOKE`，命令返回 `All authorizations revoked.`。随后只读查询正式数据库的非敏感汇总：授权版本为 2，仍有口令配置，当前有效授权数为 0，已批准客户端数为 2。公网 `/healthz` 返回 200。未读取或输出口令、令牌及其哈希、客户端 ID；未更改口令或重启服务。两端旧连接被拒绝及重新登录后的实际工具结果仍待用户确认。
