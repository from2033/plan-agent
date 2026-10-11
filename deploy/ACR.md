# 旧版远程蓝绿部署工具

> 这不是当前生产发布入口。当前应用容器运行在 Mac mini，公共域名通过香港入口机接入。基础设施位置与限制以全局 `~/.codex/AGENTS.md` 为准。

`build-and-deploy.sh` 仅保留给受控迁移或恢复操作使用。它不再包含默认服务器，且会拒绝退役主机和仅承担入口职责的主机。

如确需在获准的独立应用主机上运行：

```bash
DEPLOY_SERVER=<explicit-ssh-target> ./deploy/build-and-deploy.sh
```

发布前必须确认目标、备份 SQLite 数据文件，并准备可验证的回滚路径。不要把应用容器部署到 Windows 支付服务器、香港入口服务器或已退役服务器。
