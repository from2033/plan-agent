# QQ / NapCat Windows 迁移运行手册

## 当前状态（2026-09-06）

QQ 登录端已从 Windows 正式迁回香港 Linux：

- Linux 使用官方 NapCat Docker 镜像的固定标签 `v4.18.6`，不跟随 `latest`自动漂移。
- QQ 数据与 NapCat 配置持久化在 `/opt/qq-group-center/napcat/`，容器重启后已验证自动恢复登录。
- `qq-group-center` 直连 `http://qq-group-napcat:3000`，`qq-group-monitor` 负责掉线监控和告警。
- WebUI 只绑定 Linux 本机 `127.0.0.1:6099`，需要重新登录时使用临时 SSH 隧道，不对公网开放。
- Windows `NapCatQQ-Windows` 计划任务、NapCat 文件、专用 QQ 程序和 `3000/6099` 监听已删除。
- Windows 与 Linux 间的受限 SSH 隧道服务、私钥和 Windows 授权公钥均已删除。
- Windows 支付中心在停机、切换和清理后均通过健康检查。

Linux 启动定义保存在
`/opt/qq-group-center/runtime/docker-compose.qq-linux.yml`。升级 NapCat 或 QQ 版本前，必须先备份持久化目录，并在新容器上验证登录、OneBot 接口、群消息、群文件和重启恢复。

## 架构边界

- Windows `47.103.52.174` 仅运行官方 QQ 与 NapCat 登录端。
- 香港 `8.217.244.181` 继续运行 QQ 群中心、监控、数据库、OCR、个人助理接口和公开域名。
- Windows 支付中心 `127.0.0.1:4100` 不属于迁移范围，迁移前后都必须保持健康。
- Windows NapCat WebUI 与 OneBot API 仅监听 `127.0.0.1:6099` 和 `127.0.0.1:3000`，不得增加公网防火墙规则。
- 香港群中心通过受限 SSH 本地转发访问 Windows OneBot API；群事件由 Windows 直接签名 POST 到香港 HTTPS 接口。

## 固定路径与服务

### Windows

- NapCat Shell：`C:\services\napcat\v4.18.19-shell`
- 固化用户目录：`C:\services\napcat\profile`
- 日志目录：`C:\services\napcat\logs`
- 迁移包与脚本：`C:\services\napcat-migration`
- 计划任务：`NapCatQQ-Windows`，使用 `SYSTEM` 账号运行

### 香港

- SSH 隧道密钥：`/opt/qq-group-center/runtime/windows-napcat-tunnel/`
- systemd 服务：`windows-napcat-tunnel.service`
- 香港本地转发：`172.19.0.1:3010` → Windows `127.0.0.1:3000`
- 旧容器：`qq-group-napcat`，迁移观察期内保持停止但不得删除容器、配置或登录数据

## 启动前检查

1. Windows 支付健康接口返回成功，且可用内存不少于 500MB。
2. 香港 `qq-group-center` 健康、`qq-group-monitor` 运行。
3. 香港旧 NapCat 已停止，避免同一 QQ 双端互踢。
4. Windows `3000`、`6099` 没有被其他程序占用。
5. 腾讯 QQ 安装包的 SHA-256 与预记录值一致，Authenticode 发布者签名有效且属于 Tencent。
6. NapCat Shell v4.18.19 的 SHA-256 为 `c5b7423d1d5b8c555d62cd9e4059b1908cc0986e7b5c85a0f450f4a8ed170acf`。

## 切换与验收

1. 启动 Windows 计划任务，确认进程稳定且仅监听本机端口。
2. 通过 Mac 临时 SSH 本地转发访问 WebUI，扫码完成后关闭临时管理转发。
3. Windows 本机 `/get_status` 返回在线，且 `/get_login_info` 可读取账号信息。
4. 启动香港受限 SSH 隧道，并将群中心 NapCat API 地址切到 `http://172.19.0.1:3010`。
5. 发送一条测试群消息，确认进入香港数据库与个人助理，重复事件不会重复入库。
6. 发送一张群图片和一个小文件，确认香港接口可下载、OCR 和索引。
7. 重启 NapCat 计划任务，确认固化用户目录可恢复登录，不需重新扫码。
8. 再次检查支付中心、Windows 可用内存、香港群中心和监控。
9. 整机重启验收只能安排在支付中心维护窗口内，未经明确确认不得执行。

## 回滚

触发任一条件即回滚：Windows 可用内存低于 500MB、支付健康失败、消息链路失败、产生重复副作用或 QQ 再次频繁掉线。

1. 停止并禁用 Windows `NapCatQQ-Windows` 计划任务。
2. 停止香港 `windows-napcat-tunnel.service`。
3. 恢复香港群中心原 NapCat API 配置。
4. 启动香港 `qq-group-napcat` 容器。
5. 验证群消息、群文件、OCR、索引和支付中心。
6. 保留 Windows 与香港两端包、配置、日志和数据供排查，不删除源环境。

## 观察期

切换后连续观察 3–7 天：QQ 在线状态、隧道状态、消息延迟、重复事件、群文件链路、Windows 内存以及支付健康。观察期结束前，香港 NapCat 只保持停止，不做清理。
