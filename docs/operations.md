# 运维与恢复

本文命令沿用 [部署布局](deployment.md)，由管理员在自己的 VPS 终端执行。实际配置、数据库、备份和 Tunnel 凭据不进入仓库。

## 日常检查

```bash
sudo systemctl is-active milanoreal-mcp cloudflared
curl --fail http://127.0.0.1:3000/healthz
sudo journalctl -u milanoreal-mcp -n 50 --no-pager
sudo systemctl show milanoreal-mcp -p User -p WorkingDirectory -p KillMode
```

应用没有请求体/命令/文件内容访问日志。诊断时仅记录时间、状态码、错误类别和客户端，不收集 Authorization、cookie、口令或授权 URL 的完整 query。`/healthz` 只检查服务存活；执行能力用已认证的 `container_ping` 或隔离生产自检核对。

## 口令与授权

更换口令（交互式输入两次）：

```bash
sudo -u mcp /opt/milanoreal-node/bin/node /opt/milanoreal-mcp/dist/admin.js password /etc/milanoreal-mcp/config.json
```

撤销全部连接（输入 `REVOKE` 确认）：

```bash
sudo -u mcp /opt/milanoreal-node/bin/node /opt/milanoreal-mcp/dist/admin.js revoke-all /etc/milanoreal-mcp/config.json
```

两者均在数据库中递增授权版本，运行中的服务无需重启即可拒绝旧 token、未兑换授权码及进行中的旧登录事务。更换口令同时撤销授权；`revoke-all` 保留原口令和已批准 client ID。撤销不追溯终止已经启动的命令；两端需分别重新登录。

Access token 最长 1 小时，连接授权 90 天固定到期，refresh 轮换不会延长期限。刷新令牌只能使用一次，旧值重放会撤销该连接。客户端断开或删除连接不等同于服务器已撤销。

## 一致性备份

先安排停止后台任务与其他文件写入者。停服会终止该服务 cgroup 内的前台及后台进程；应用启动前取得的短期登录页不会随备份恢复。

```bash
backup_dir="/var/backups/milanoreal-mcp/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o root -g root -m 0700 "$backup_dir"
sudo systemctl stop milanoreal-mcp
sudo tar -C / -cpf "$backup_dir/state-and-app.tar" etc/milanoreal-mcp var/lib/milanoreal-mcp opt/milanoreal-mcp etc/systemd/system/milanoreal-mcp.service
sudo tar -C / -cpf "$backup_dir/workspace.tar" home/mcp/workspace
sudo chmod 0600 "$backup_dir/state-and-app.tar" "$backup_dir/workspace.tar"
/opt/milanoreal-node/bin/node --version | sudo tee "$backup_dir/node-version.txt"
sudo systemctl start milanoreal-mcp
```

逐条检查成功后再继续。备份失败时保留错误，恢复服务运行，不用不完整归档覆盖现有数据。归档包括正式口令哈希与令牌状态，应只由管理员读取；不提供公共下载地址。Node 运行时、cloudflared 自身配置、用户在工作区之外安装的数据不在上述归档内，按自己的宿主机备份方案管理。

当前 SQLite 使用默认 journal；仍复制整个已停止的状态目录，避免未来出现 journal/WAL 时只复制主文件。恢复前可用 `sudo tar -tf "$backup_dir/state-and-app.tar"` 检查归档内容，并另存归档校验和。仅存在归档不等于恢复演练已完成。

## 恢复

以下针对可信、自建且相同架构/Node 版本的完整备份。先设置实际备份绝对路径，检查两个归档完整。恢复会替换当前认证状态和程序；工作区恢复单独决定，避免把较新的项目覆盖为旧版本。

```bash
backup_dir=/var/backups/milanoreal-mcp/实际备份目录
sudo tar -tf "${backup_dir:?}/state-and-app.tar" >/dev/null
sudo systemctl stop milanoreal-mcp
restore_hold=$(sudo mktemp -d /var/backups/milanoreal-restore.XXXXXX)
sudo mv /var/lib/milanoreal-mcp "$restore_hold/state"
sudo mv /opt/milanoreal-mcp "$restore_hold/app"
sudo mv /etc/milanoreal-mcp "$restore_hold/config"
sudo tar -C / -xpf "$backup_dir/state-and-app.tar"
sudo chown -R mcp:mcp /var/lib/milanoreal-mcp
sudo chmod 0700 /var/lib/milanoreal-mcp
sudo chmod 0600 /var/lib/milanoreal-mcp/state.sqlite
sudo chown -R root:root /opt/milanoreal-mcp
sudo chown root:mcp /etc/milanoreal-mcp /etc/milanoreal-mcp/config.json
sudo chmod 0750 /etc/milanoreal-mcp
sudo chmod 0640 /etc/milanoreal-mcp/config.json
sudo systemctl daemon-reload
```

备份可能包含之后已撤销或已轮换的授权。恢复旧认证快照后，先通过上面的 `revoke-all` 使备份中的旧授权失效，再启动服务，让两端重新授权；恢复也会带回备份时的口令。若要恢复项目，在服务停止且其他写入者也停止时，将当前工作区移入私有备份目录，再解包 `workspace.tar`，核对 `mcp:mcp` 所有权，避免混合新旧项目。

```bash
sudo systemctl start milanoreal-mcp
curl --fail http://127.0.0.1:3000/healthz
cd /opt/milanoreal-mcp
sudo -u mcp /opt/milanoreal-node/bin/node deploy/smoke.mjs
```

最后检查公网发现、两端重新登录及项目文件。恢复失败时停止服务，保留归档与 `restore_hold`，从隔离目录恢复之前的数据，不删除或清空数据库来绕过错误。实际目标 VPS 的完整备份恢复演练尚未完成。

## 更新与回退

1. 在构建环境检出目标标签，用匹配 Node 执行 `npm ci`、类型检查、测试、浏览器回归、构建及隔离自检。
2. 按上述方式取得一致性备份，记录当前应用标签、Node 版本和 schema 版本。当前 schema 为 1，未知版本拒绝启动；没有通用迁移框架。
3. 停止应用，把新 `dist/`、`package.json`、锁文件、`.npmrc` 和 `deploy/smoke.mjs` 放入安装目录，文件由 root 管理。保留原私有配置和状态目录。
4. 在安装目录用部署文档中的绝对 Node/npm 路径运行 `npm ci --omit=dev --ignore-scripts`，核对生产依赖和新代码匹配。
5. 若更新单元文件则重新安装并执行 `systemctl daemon-reload`。启动服务，验证 loopback、公网发现及隔离生产自检，再做客户端调用。

安装失败不要继续启动混合版本。代码回退时优先恢复旧应用及匹配依赖、保留当前认证数据库；只有旧程序支持当前 schema 时才可这样回退。需要回退数据库时执行完整恢复流程，处理旧授权快照，并重新登录。此次已部署实现有部署前构建副本，但不代替包含状态和项目的一致性备份。

普通重启保留正式授权、文件和依赖，丢弃进行中的登录事务、授权码和限速窗口。后台程序即使用了 `setsid` 仍在服务 cgroup 中，服务重启会清理它；需要跨服务重启的进程由管理员另建独立系统服务。

## 故障定位

| 现象 | 检查与处理 |
| --- | --- |
| 服务拒绝启动 | 普通用户身份、Node 版本、配置 JSON、工作目录权限、口令初始化及数据库 schema；读取 journal 的错误类别 |
| loopback 正常、公网 502/不可达 | cloudflared 状态、域名路由和实际本地端口；应用刚重启时先等其就绪 |
| 发现返回 HTML 或登录页 | 域名全部路径转发、Access/挑战和缓存；应得到应用 JSON |
| 未认证 `/mcp` 返回 401 | 正常；通过客户端 OAuth 授权，不将强口令直接当 bearer |
| `invalid_origin` | 使用当前构建、从客户端重新开始登录；不要手工提交旧批准页或放行 `Origin: null`。真实浏览器回归覆盖此问题 |
| 注册/回调被拒绝 | 精确 HTTPS 回调白名单；public client 显式 `none`、DCR、PKCE S256；不使用 client secret |
| 登录页失效 | 服务重启、页面超过 10 分钟或口令/授权版本改变；从客户端重新发起 |
| 刷新失败 | 90 天到期、撤销或刷新重放；重新登录，不复制或重复提交旧 refresh token |
| 工具仍只有 `connection_test` | 刷新客户端工具列表，必要时断开再连接；确认线上安装了正式六工具构建 |
| 命令 `busy` | 两个执行槽均占用，等已有调用结束；新开聊天不能增加槽位 |
| 超时、网络中断或输出截断 | 检查已有文件/日志/任务状态，避免自动重跑有副作用的命令；长任务显式脱离并记录日志 |
| `outputIncomplete` | Shell 已退出但后代仍持有管道等场景触发有界收尾；结果不代表所有后代结束 |
| 文件权限或 sudo 失败 | 权限属于 `mcp`；文件工具不提权，只有管理员配置后 `sudo -n` 才能使用 |
| 大文件或列表截断 | 使用有界 Shell 片段、脚本或目录过滤；列表只返回已枚举条目的排序，不是完整分页 |

当前应用与 Shell 属于同一信任主体：命令虽不继承 OAuth 或 Tunnel 环境变量，但仍可读取该用户有权读取的认证状态。完整免密 sudo 会进一步赋予宿主机权限；执行环境不提供容器隔离。
