# milanoreal-mcp

让 ChatGPT / Claude 通过远程 MCP 使用 VPS 上的持久执行环境。

当前预览标签：`v0.1.0-preview.1`。原始设计基线：`v0.1.0-design`。本项目直接操作 Linux VPS，文件和依赖长期保留，每次命令独立启动 Bash，任务进度使用项目自己的 `PROGRESS.md`。

已实现并部署六个正式工具。ChatGPT 和 Claude 均已通过正式域名完成认证、命令执行、文件写入、读取和删除的用户实测。两端目录列表及服务重启后的继续调用也已确认通过。同步调用在 ChatGPT 的 50 秒测试及 Claude 的 10/30 秒测试中成功；Claude 的 50 秒测试曾遇到一次连接器错误，原因待定位；刷新与撤销验证仍待完成。自动化检查与实际客户端验收分别记录，见 [PLAN.md](PLAN.md) 和 [验证记录](docs/verification.md)。设计见 [DESIGN.md](DESIGN.md)。

| 文档 | 用途 |
| --- | --- |
| [从零部署](docs/deployment.md) | Node 校验、构建、用户与目录、配置、口令、systemd、Tunnel 及客户端连接 |
| [运维与恢复](docs/operations.md) | 更新、备份恢复、授权管理、日志和故障定位 |
| [客户端验收](docs/client-validation.md) | 两端实测矩阵及剩余验证步骤 |
| [验证记录](docs/verification.md) | 自动化、VPS 自检和用户报告的证据与边界 |
| [设计说明](DESIGN.md) / [实施计划](PLAN.md) | 当前架构及逐项进度 |
| [依赖说明](docs/dependencies.md) / [版本记录](CHANGELOG.md) | 锁定版本、选型依据和标签范围 |

## 本地开发

使用 Node.js 24.22.0（见 `.node-version`），运行：

```bash
npm ci
npm run check
npm test
npm run build
```

浏览器表单回归检查使用独立 Chromium（默认 `/usr/bin/chromium`，可通过 `CHROMIUM_BIN` 指定），不使用个人浏览器配置或真实口令：

```bash
npm run test:browser
```

复制 `config.example.json` 为私有 `config.json`，设置公网 HTTPS 域名、已存在的工作目录、独立状态目录和允许的客户端回调 URI。相对目录相对于配置文件所在目录解析。配置文件和数据库已加入忽略规则。

应用与管理命令都必须由专用普通用户执行。先在终端初始化强口令，再启动：

```bash
node dist/admin.js password /absolute/path/config.json
node dist/main.js /absolute/path/config.json
```

口令需要至少 20 个字符，推荐密码管理器生成。终端输入不回显；不要将口令放进命令参数、聊天或环境变量。更换口令会撤销所有已有授权。未初始化时应用拒绝启动，不提供匿名降级。

## VPS 安装布局

| 内容 | 位置 |
| --- | --- |
| Node 24 运行时 | `/opt/milanoreal-node` |
| 编译产物、生产依赖及包元数据 | `/opt/milanoreal-mcp` |
| 私有配置 | `/etc/milanoreal-mcp/config.json` |
| SQLite 状态 | `/var/lib/milanoreal-mcp/state.sqlite` |
| 专用用户及工作目录 | `mcp`，`/home/mcp/workspace` |
| 服务单元 | [deploy/milanoreal-mcp.service](deploy/milanoreal-mcp.service) |

安装目录由管理员管理；`mcp` 对状态目录和工作目录有写权限。服务使用 `UMask=0077`。不会自动给 `mcp` 授予 sudo。

当前 Milano VPS 已由管理员在 `/etc/sudoers.d/milanoreal-mcp` 授予 `mcp` 对所有用户和命令的免密 sudo；服务仍以 `mcp` 身份运行，需要提权时在 Shell 命令中显式使用 `sudo -n`。

管理员通过自己的 SSH 终端为专用用户设置口令：

```bash
sudo -u mcp /opt/milanoreal-node/bin/node /opt/milanoreal-mcp/dist/admin.js password /etc/milanoreal-mcp/config.json
sudo systemctl enable --now milanoreal-mcp
curl http://127.0.0.1:3000/healthz
sudo journalctl -u milanoreal-mcp -n 50 --no-pager
```

服务只监听 `127.0.0.1:3000`。在 Cloudflare 创建或配置长期 Tunnel，将整个正式域名的所有路径指向 `http://127.0.0.1:3000`，并让 `cloudflared` 在 VPS 运行。不要只转发 `/mcp`；不要给 OAuth 或 MCP 路径叠加浏览器挑战、额外登录或缓存。

本项目不收集 Cloudflare tunnel token。请通过自己的 Cloudflare 控制台和 SSH 终端完成安装。仅知道域名并不代表 Tunnel 已配置。

## ChatGPT / Claude 联调

1. 在客户端添加 `https://你的域名/mcp`，选择 OAuth 和 DCR/自动注册。
2. 将客户端管理页面提供的**准确回调 URI**加入 `allowedRedirectUris`，重启服务后重新尝试连接。默认空列表拒绝注册。
3. 在本站的授权页输入强口令，批准连接。
4. 刷新客户端工具列表，调用 `container_ping`；再用 `container_exec` 执行 `pwd; id; node --version`。
5. 在专门的测试目录内完成文件写入、读取、列出及删除，并验证刷新、应用重启、全部撤销及重新登录。

当前只接受显式 `token_endpoint_auth_method=none` 的 public client，授权使用 PKCE S256，resource 固定为完整 `/mcp` 地址。不支持 client secret、CIMD 或预注册客户端。若真实客户端不接受这组参数，记录失败环节后再调整，不把本地测试当成兼容性结论。

全部撤销在终端二次确认后执行，已批准客户端 ID 保留，可以重新登录：

```bash
sudo -u mcp /opt/milanoreal-node/bin/node /opt/milanoreal-mcp/dist/admin.js revoke-all /etc/milanoreal-mcp/config.json
```

服务重启保留已完成授权及刷新状态；尚未完成的登录需重新开始。刷新令牌只能用一次，重放会撤销该连接；网络重试或并发刷新导致重放时需要重新登录。

## 正式工具

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `container_ping` | 无 | 检查执行能力，返回用户、工作目录及运行时 |
| `container_exec` | `{ "args": { "args": "pwd", "timeout": 60000, "streamStderr": true } }` | 独立 Bash 命令，返回输出、退出码及超时/截断状态 |
| `container_file_write` | `{ "args": { "path": "project/PROGRESS.md", "text": "进度" } }` | 创建父目录并覆盖 UTF-8 文件 |
| `container_files_list` | 无 | 列出固定工作目录第一层，包含隐藏文件 |
| `container_file_read` | `{ "args": { "path": "project/PROGRESS.md" } }` | 返回文本、二进制资源或目录列表 |
| `container_file_delete` | `{ "args": { "path": "project/test.txt" } }` | 删除文件、链接或递归删除目录 |

执行直接使用 `mcp` 的系统权限。每次命令的 `cd` 和环境变量独立，文件与安装的依赖持久保留。路径支持相对路径、绝对路径、本地 file URI 和 `~/`；没有容器或自定义路径沙箱，也不需要初始化工具。

命令默认 60 秒、最长 90 秒；全服务共享两个执行槽，槽满返回 busy。stdout/stderr 合计保留至多 128 KiB；`streamStderr=false` 仍会排空 stderr，但不展示。超时向本次进程组发送 TERM，1 秒后尝试 KILL；结果报告实际退出与清理状态。文件读写各限 1 MiB；列表最多 1000 项、列表 JSON 数据 256 KiB（MCP 包装及文本副本另有开销），超过标记截断。

执行结果包含 `stdout`、`stderr`、`exitCode`、`signal`、`timedOut`、`truncated`、`outputIncomplete`、`durationMs` 和 `cleanupErrors`；启动失败另有 `error`。非零退出和超时返回工具 `isError: true`，保留已有输出。`timedOut` 表示已尝试终止，不能据此断言所有后代已结束。

文件读取返回带 URI/MIME 的 MCP embedded resource：UTF-8 文本或 base64 二进制；目录读取返回一层列表。文件工具不提供公开下载地址或 `resources/read`。写入覆盖全量内容，不承诺原子替换；新文件使用 0600，父目录权限取决于 umask（部署单元为 0077），已有文件权限保留。删除文件不自动删除空父目录，删除符号链接只删除链接本身。

长任务需明确使用 `setsid`，关闭 stdin，把输出写入日志，并记录可核实的任务身份。停止聊天不保证进程停止；systemd 服务重启会清理所属 cgroup，包括脱离 Shell 的任务。sudo 或脱离进程组的后代不保证能由普通用户终止。服务不会配置 sudo；需要提权时由管理员授予免密 sudo，命令显式使用 `sudo -n`。

每个项目用自己的 `PROGRESS.md` 记录完成事项、路径、日志、任务身份和下一步；恢复时核对实际文件和进程。服务启动说明已包含这些约定，进度文件不得保存口令或 token。

生产构建可用独立自检验证，不读取正式配置或认证数据库；只创建临时状态、随机测试口令和临时项目，退出时删除：

```bash
node deploy/smoke.mjs
```

当前未发布改动另提供 `node deploy/smoke.mjs --recovery`：将临时应用、配置、认证状态与项目归档，删除原副本后从归档恢复验证。该模式已在本地与目标 VPS 通过；不读取正式配置或数据库。`v0.1.0-preview.1` 的原始脚本尚无此参数，需使用更新后的脚本。

## 更新与备份

更新前停服，一致性备份整个状态目录和私有配置，再替换编译产物、锁文件及匹配的生产依赖。备份包含敏感认证状态，不提交仓库，不以公共下载地址分享。

恢复时同样停服，恢复完整状态目录和对应配置，核对所有者 `mcp:mcp`、目录 0700 和数据库 0600 后再启动。不用只拷贝活跃数据库主文件的方式备份。

具体命令见 [运维与恢复](docs/operations.md)。隔离恢复演练已通过，正式数据的替换式恢复未执行；两端刷新/撤销等验收尚未完成，因此当前使用预览标签；两端已通过的核心功能和剩余范围见 [客户端验收](docs/client-validation.md)。生产更新先通过类型检查、测试与构建，不把标签本身当作全部验收完成的证据。
