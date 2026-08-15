# 本地构建与蓝绿部署

服务器只拉取已经构建好的私有镜像并进行蓝绿切换，不执行 Node.js 构建。发布前会暂停当前容器几秒，并完整备份 SQLite 的数据库、WAL 和 SHM 文件。

```bash
./deploy/build-and-deploy.sh
```

回滚：

```bash
ssh -i ~/.ssh/briefings_deploy root@8.217.244.181 \
  /opt/personal-assistant/deploy-blue-green/rollback-blue-green.sh
```
