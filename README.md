# Personal Assistant App

Personal Assistant 包含 React/Vite Web 客户端、Node/Express 服务端、Flutter 移动端、macOS AI worker，以及 QQ 群消息集成。

## 本地开发

```bash
npm install
npm run dev
```

服务端与 Flutter 端分别位于 `server/` 和 `flutter_app/`。

## 完整检查

提交或发布前运行：

```bash
npm run check
```

部署架构与发布约束见 [DEPLOY.md](DEPLOY.md)。

## Personal Assistant worker

The macOS worker processes queued assistant input and on-demand reports. It uses
the local Ollama model `qwen3:14b` by default and falls back to Codex if Ollama
is unavailable, times out, or returns invalid structured data.

Runtime defaults can be overridden with `ASSISTANT_LLM_PROVIDER`,
`ASSISTANT_OLLAMA_URL`, `ASSISTANT_OLLAMA_MODEL`,
`ASSISTANT_OLLAMA_TIMEOUT_MS`, `ASSISTANT_OLLAMA_KEEP_ALIVE`, and
`ASSISTANT_CODEX_FALLBACK`. The checked-in LaunchAgent only connects to Ollama
on `127.0.0.1`; no local model endpoint is exposed publicly.
