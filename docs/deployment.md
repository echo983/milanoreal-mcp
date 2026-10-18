# 从零部署

本页使用 Debian/Ubuntu 风格的 Linux、systemd、Linux x64 和管理员 sudo。已实测环境为 Node 24.22.0、普通用户 `mcp`；其他发行版或架构需自行验证。安装过程不创建容器，也不自动授予 sudo。

## 1. 安装 Node

准备 `git`、`curl`、`tar`、`xz-utils`、`ca-certificates` 和 `/bin/bash`。以下命令将官方固定版本安装到服务单元使用的路径；已有可用运行时时先核对版本，无需重复覆盖。

```bash
runtime_work=$(mktemp -d)
cd "$runtime_work"
curl --fail --show-error --location --remote-name https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz
curl --fail --show-error --location --remote-name https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
sha256sum --check --ignore-missing SHASUMS256.txt
sudo install -d -o root -g root -m 0755 /opt/milanoreal-node
sudo tar -xJf node-v24.22.0-linux-x64.tar.xz -C /opt/milanoreal-node --strip-components=1 --no-same-owner
cd -
rm -r "$runtime_work"
export PATH=/opt/milanoreal-node/bin:$PATH
node --version
```

校验失败就停止，不继续解包。运行时依据：[官方发行与校验文件](https://nodejs.org/dist/v24.22.0/)。

## 2. 构建与检查

在普通管理员账号的构建目录执行：

```bash
git clone https://github.com/echo983/milanoreal-mcp.git
cd milanoreal-mcp
git checkout v0.1.0-preview.1
npm ci
npm run check
npm test
npm run build
node deploy/smoke.mjs
```

源码和依赖由锁文件固定。浏览器回归另外执行 `npm run test:browser`，需要独立 Chromium；默认路径为 `/usr/bin/chromium`，可通过 `CHROMIUM_BIN` 指定。生产服务器无需安装浏览器或开发依赖，可在另一台同架构、同版本 Node 的构建机完成构建后传入产物。

## 3. 准备用户和目录

先检查 `id mcp`。如果尚无该专用账号，再创建：

```bash
sudo useradd --create-home --user-group --shell /bin/bash mcp
```

账号已存在时，核对其 home、组和权限，不重复创建。以下布局与仓库的 systemd 单元一致：

```bash
sudo install -d -o root -g root -m 0755 /opt/milanoreal-mcp
sudo install -d -o root -g mcp -m 0750 /etc/milanoreal-mcp
sudo install -d -o mcp -g mcp -m 0700 /var/lib/milanoreal-mcp
sudo install -d -o mcp -g mcp -m 0700 /home/mcp/workspace
sudo cp -R dist /opt/milanoreal-mcp/
sudo install -o root -g root -m 0644 package.json package-lock.json .npmrc /opt/milanoreal-mcp/
sudo install -d -o root -g root -m 0755 /opt/milanoreal-mcp/deploy
sudo install -o root -g root -m 0644 deploy/smoke.mjs /opt/milanoreal-mcp/deploy/
sudo chown -R root:root /opt/milanoreal-mcp
sudo env PATH=/opt/milanoreal-node/bin:/usr/bin:/bin /opt/milanoreal-node/bin/npm ci --prefix /opt/milanoreal-mcp --omit=dev --ignore-scripts
```

上述复制适用于首次安装。已有服务按 [更新流程](operations.md) 操作。当前生产依赖的预编译 Argon2 在已测 Linux x64 上可用，不依赖 npm 安装脚本。

`mcp` 默认没有 sudo。若部署者选择授予免密 sudo，通过自己的 sudoers 管理流程配置并用 `sudo -n` 验证。应用不会修改 sudoers，也不接受 sudo 密码。

## 4. 配置与初始化

```bash
sudo install -o root -g mcp -m 0640 config.example.json /etc/milanoreal-mcp/config.json
sudoedit /etc/milanoreal-mcp/config.json
```

配置示例中的域名必须替换为自己的 HTTPS 域名。五项配置如下，不支持其他键：

| 配置 | 要求 |
| --- | --- |
| `publicBaseUrl` | HTTPS origin，例如 `https://mcp.example.com`；不带路径、query、fragment 或用户名密码 |
| `listenPort` | 1–65535，缺省 3000；始终监听 `127.0.0.1` |
| `workspaceDir` | 已存在且专用用户可读写进入的目录；相对路径以配置文件所在目录为基准 |
| `stateDir` | SQLite 目录；相对路径以配置文件所在目录为基准，归专用用户所有 |
| `allowedRedirectUris` | 最多 16 个精确 HTTPS 回调；默认空列表，拒绝注册；不允许 fragment 或凭据 |

当前实测的两个回调是：

```json
[
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://claude.ai/api/mcp/auth_callback"
]
```

将其填入 `allowedRedirectUris`，并核对实际客户端显示的地址。来源见 [OpenAI OAuth 配置](https://developers.openai.com/plugins/build/auth) 与 [Claude 服务端接入](https://claude.com/docs/connectors/building)。回调精确匹配，不根据陌生注册请求自动扩充白名单。

在自己的交互式 SSH 终端初始化口令：

```bash
sudo -u mcp /opt/milanoreal-node/bin/node /opt/milanoreal-mcp/dist/admin.js password /etc/milanoreal-mcp/config.json
```

至少 20 个字符，推荐密码管理器随机生成；输入不回显，要求输入两次。口令不放进命令参数、环境变量、聊天、进度文件或仓库。管理命令和服务必须使用同一个配置文件；再次设置口令会使所有旧授权失效。

## 5. 安装服务

```bash
sudo install -o root -g root -m 0644 deploy/milanoreal-mcp.service /etc/systemd/system/milanoreal-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now milanoreal-mcp
sudo systemctl status milanoreal-mcp --no-pager
curl --fail http://127.0.0.1:3000/healthz
cd /opt/milanoreal-mcp
sudo -u mcp /opt/milanoreal-node/bin/node deploy/smoke.mjs
```

自检使用临时配置、随机测试口令和临时数据库，不读取正式配置或认证数据库。它验证生产构建、OAuth/刷新及六工具，结束后清理临时状态。它不能替代真实客户端验收。

单元使用 `User=mcp`、固定工作目录、`Restart=on-failure`、`UMask=0077`、`KillMode=control-group`。更改路径或端口时同步配置及单元；不要把服务改为 root。启动失败看 `sudo journalctl -u milanoreal-mcp -n 50 --no-pager`。

## 6. 接入 Cloudflare Tunnel

使用长期 Tunnel 和固定自有域名。在自己的 Cloudflare 控制台创建/选择 Tunnel，按控制台给出的命令在 VPS 安装 `cloudflared` 服务。凭据只在自己的控制台和终端处理，不存入本仓库。

将该域名的全部路径指向 `http://127.0.0.1:3000`。如果用本地 ingress 配置，路由部分形如：

```yaml
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Tunnel ID 与凭据文件按现有隧道配置管理。不要只转发 `/mcp`；`/.well-known/`、`/oauth/`、`/healthz` 也必须可达。这些路径不叠加 Cloudflare Access 登录、浏览器挑战或缓存。参考 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)。

公网检查应得到：

| 请求 | 预期 |
| --- | --- |
| GET `/healthz` | 200，`{"ok":true}` |
| GET `/.well-known/oauth-authorization-server` | 200，issuer 和端点为正式 HTTPS 域名 |
| GET `/.well-known/oauth-protected-resource/mcp` | 200，resource 为完整 `/mcp` 地址 |
| 未认证 POST `/mcp` | 401，带资源发现 `WWW-Authenticate` |

## 7. 连接客户端

在 ChatGPT/Claude 的自定义远程 MCP 入口填写 `https://你的域名/mcp`，使用 OAuth 与 DCR/自动注册。批准授权后刷新工具列表，依次验证 ping、命令、列目录和文件操作。测试步骤及尚未完成的验收见 [客户端验收](client-validation.md)。

服务不提供固定 bearer 口令、client secret、CIMD 或旧式 `/sse` 入口。已有部署的 `connection_test` 已移除，客户端继续显示它时先刷新工具列表；必要时重新连接。
