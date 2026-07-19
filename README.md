# GrokBuildUI

Desktop / browser GUI for [Grok Build](https://docs.x.ai/build/overview) — vibe-code without living in the terminal.

## Engines

| Engine | What it uses | When |
|---|---|---|
| **ACP (default)** | `grok --no-auto-update agent stdio` | Full coding agent: tools, permissions, plan cards, multi-turn |
| **Headless** | `grok -p … --output-format streaming-json` | Simple one-shot / script-style runs |

Both follow [xAI Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting).

## Quick start

```bash
npm install
npm run dev          # Electron + Vite + API
npm run dev:web      # Browser only → http://127.0.0.1:5173
```

Requires [Grok Build CLI](https://docs.x.ai/build/overview) (`grok`) and login (`grok login` or **Login** in the UI / `XAI_API_KEY`).

## Features

- **Chat** with streaming thoughts + assistant text
- **ACP (default)** with tools, permission cards, plan review
- **Auto-fallback** — if ACP hits a spending limit (402), retry via Headless
- **Model / effort / session** controls
- **Always approve** or interactive permission cards
- **Clear chat / New session / Restart agent**
- **GitHub**: Commit all · Push · Open PR
- **Commands**: Login, Inspect JSON, MCP list, Export MD, Update CLI

## Scripts

```bash
npm run dev        # Electron app
npm run dev:web    # Browser UI
npm test           # Unit tests (ACP dispatch + parsers)
npm run build      # Production UI build
npm start          # Build + serve on :3921
```

## Docs

- [Overview](https://docs.x.ai/build/overview)
- [Headless & ACP](https://docs.x.ai/build/cli/headless-scripting)
- [CLI reference](https://docs.x.ai/build/cli/reference)

## Custom models

Add entries in `%USERPROFILE%\.grok\config.toml` per the docs, then refresh Models.

## Not affiliated

Unofficial community UI. Grok / Grok Build / xAI are trademarks of xAI.

## License

MIT — see [LICENSE](LICENSE).
