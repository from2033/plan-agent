# iOS 原生 app（Capacitor 包壳）

把现有 React 前端装进原生 WKWebView 壳，由 app 进程控制 iOS 音频会话，
**消除"开始/停止录音"提示音、录音时不打断背景音乐**——这是相对网页 PWA 的唯一关键差别。
后端不变，app 通过绝对 `https/wss` 地址连公网后端。

## 一次性前置
- Mac + Xcode（已装 26.x）、CocoaPods（已装）。
- 真机一台 iPhone（**模拟器没麦克风、也复现不了提示音，必须真机测**）。
- 公网 HTTPS 后端（已就绪）。地址配在仓库根 `.env.native` 的 `VITE_API_BASE`。

## 日常构建 / 运行
```bash
# 1. 构建原生 web 产物（dist-native，base '/'、无 PWA、绝对 API 地址）并同步进 iOS 工程
npm run ios:sync
# 2. 打开 Xcode
npm run ios:open
```
在 Xcode 里：
1. 选中 `App` target → Signing & Capabilities → Team 选你的免费 Apple ID（Personal Team），
   Bundle Identifier 若冲突就改成唯一的（如 `com.<你>.assistant`）。
2. 顶部选你的 iPhone 真机 → Run（▶）。
3. 首次在 iPhone 上：设置 → 通用 → VPN与设备管理 → 信任你的开发者证书。

> 改了前端代码后，重新 `npm run ios:sync` 再在 Xcode Run 即可。
> 注意 `ios:sync` 脚本带了 `LANG/LC_ALL=en_US.UTF-8`——因为项目路径含空格，
> CocoaPods 在默认 locale 下会报编码错。手动跑 `pod install` 时也要带这两个环境变量。

## 分发给内部几个人（免费 Apple ID，不付费）
免费签名 **7 天过期**，到期 app 打不开需重签；免费账号同时最多 3 个 app、每台设备要登记并信任一次。

- **路线 A（最简单，人少首选）**：每台 iPhone 用数据线连这台 Mac，Xcode 选该设备 Run；
  7 天后再连线重装一次。
- **路线 B（免每周连线）**：用 [AltStore](https://altstore.io/) / SideStore 侧载，同一 WiFi 下自动后台续签。
  免费但配置稍繁琐，适合不方便常连 Mac 的人。

## 真机验收清单
1. 输入访问令牌后能拉到历史记录（证明远程 API 通）。
2. 按住说话：实时出字、松手入库（证明 `wss://<域名>/app/api/asr` 流式识别通）。
3. **核心**：开始/松手说话**无提示音、不打断正在放的音乐**；反复多条不"回潮"；
   **把 app 滑走/切后台再回来，无"停止录音"提示音**。
4. 若步骤 3 仍出声 → 走计划里的兜底方案（原生 AVAudioEngine 采集，见 plan 文件）。

## 关键文件
- [capacitor.config.ts](../capacitor.config.ts)：appId / webDir=`dist-native`。
- [vite.config.ts](../vite.config.ts)：`--mode native` 分支（base '/'、关 PWA）。
- [.env.native](../.env.native)：原生构建的绝对后端地址。
- `ios/App/App/AppDelegate.swift`：AVAudioSession 配置（核心）。
- `ios/App/App/Info.plist`：`NSMicrophoneUsageDescription` 麦克风用途说明。
