# 部署到自己的 Windows 服务器（PWA 前端 + Node 后端）

整套由两部分组成：

- **前端**（本目录）：React + Vite + Tailwind 的 PWA，构建出静态 `dist/`，部署到网站根目录 `/`。
- **后端**（[server/](server/)）：Node + Express + SQLite，提供 `/api/*`，负责数据持久化和调用 Claude 做自然语言解析。

```
iPhone Safari (PWA) ──HTTPS──> 你的域名
                                 ├─ /        → 静态前端 (dist/)
                                 └─ /api/*   → 反代到 Node 后端 (127.0.0.1:8787)
                                                  ├─ data.db (SQLite)
                                                  └─ Claude API (解析)
```

## 一、构建前端

```bash
npm install        # 第一次
npm run build      # 生成 dist/
```

`dist/` 整个复制到服务器网站根目录。前端默认请求同源的 `/api`，**同源部署无需改任何配置**（如果前后端不同域，构建前在 `.env` 里设 `VITE_API_BASE`）。

## 二、部署后端

1. 服务器装 **Node 20**。
2. 拷 [server/](server/) 到服务器，进目录执行：
   ```bash
   npm ci
   npm run build        # tsc 编译到 dist/
   ```
3. 复制 `server/.env.example` 为 `server/.env`，填写：
   - `ANTHROPIC_API_KEY`：你的 Anthropic API key（不填则自动回退到正则解析，仍可用）。
   - `ACCESS_TOKEN`：自己设一个长随机串，**前端首次进入时要输入它**。
   - `PORT`：默认 8787。`DB_PATH`：SQLite 文件路径。`CORS_ORIGIN`：同源部署可留 `*`。
4. **常驻运行**（开机自启 + 崩溃重启），用 [NSSM](https://nssm.cc/) 把它注册成 Windows 服务：
   ```
   nssm install PersonalAssistant "C:\Program Files\nodejs\node.exe" "C:\path\to\server\dist\index.js"
   nssm set PersonalAssistant AppDirectory "C:\path\to\server"
   nssm start PersonalAssistant
   ```
   （或用 `pm2` + `pm2-windows-startup`。）
5. 验证：`curl http://localhost:8787/api/health` 返回 `{"ok":true,...}`。

## 三、关键：必须用 HTTPS

- iOS 上 PWA 的「离线缓存（service worker）」**只有在 HTTPS 下才生效**（`localhost` 例外）。
- **自签名证书不行**：iOS 不信任。需要域名 + Let's Encrypt 等被信任的证书。

## 四、反向代理：前端 `/` + 后端 `/api`（IIS）

1. 安装 IIS + 「URL Rewrite」+ 「Application Request Routing (ARR)」（反代 `/api` 需要 ARR）。
2. 新建网站，物理路径指向 `dist/` 文件夹。
3. `dist/web.config` 已配好 `.webmanifest` MIME、JS 不缓存、SPA 回退。**需在它的 `<rules>` 里，把 `/api` 反代规则放在 SPA 回退规则之前**：
   ```xml
   <rule name="API proxy" stopProcessing="true">
     <match url="^api/(.*)" />
     <action type="Rewrite" url="http://127.0.0.1:8787/api/{R:1}" />
   </rule>
   ```
4. 配 HTTPS：用 [win-acme](https://www.win-acme.com/) 申请并自动续期 Let's Encrypt 证书，绑定 443。

## 四（替代）、用 Caddy（更省事，自动 HTTPS + 反代）

```
your-domain.com {
    encode gzip
    handle /api/* {
        reverse_proxy 127.0.0.1:8787
    }
    handle {
        root * C:/path/to/dist
        try_files {path} /index.html
        file_server
    }
}
```

`caddy run` 即可，证书自动申请续期。

## 五、手机安装与首次使用

1. iPhone 用 **Safari** 打开你的 HTTPS 网址。
2. 底部「分享」→「添加到主屏幕」，主屏出现「Assistant」图标。
3. 首次打开会让你**输入访问令牌**（即后端 `.env` 里的 `ACCESS_TOKEN`），输入后保存在本机，之后不再询问。

## 六、更新

- **改前端**：重新 `npm run build`，覆盖 `dist/`。已配 `registerType: 'autoUpdate'`，下次打开自动更新。
- **改后端**：`npm run build` 后 `nssm restart PersonalAssistant`。
- **数据**：都存在 `server/data.db`，记得纳入备份。

## 安全说明

- `ACCESS_TOKEN` 是「防陌生人」级别的共享令牌，够个人单用户用；不是多账号安全体系。
- `ANTHROPIC_API_KEY` 只在后端，绝不会下发到前端/手机。
