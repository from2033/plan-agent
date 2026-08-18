
  # Personal Assistant App

  This is a code bundle for Personal Assistant App. The original project is available at https://www.figma.com/design/SZE0QhRJD4H1qaBT9dQmMw/Personal-Assistant-App.

  ## Running the code

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

## Personal Assistant worker

The macOS worker processes queued assistant input and on-demand reports. It uses
the local Ollama model `qwen3:14b` by default and falls back to Codex if Ollama
is unavailable, times out, or returns invalid structured data.

Runtime defaults can be overridden with `ASSISTANT_LLM_PROVIDER`,
`ASSISTANT_OLLAMA_URL`, `ASSISTANT_OLLAMA_MODEL`,
`ASSISTANT_OLLAMA_TIMEOUT_MS`, `ASSISTANT_OLLAMA_KEEP_ALIVE`, and
`ASSISTANT_CODEX_FALLBACK`. The checked-in LaunchAgent only connects to Ollama
on `127.0.0.1`; no local model endpoint is exposed publicly.
