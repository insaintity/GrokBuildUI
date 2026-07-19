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
- **Model / effort / session** controls (`-m`, `--effort`, continue / resume / fresh)
- **Always approve** or interactive permission cards
- **Plan review** + ask-user questions (ACP)
- **Tool + shell command** activity in the transcript
- **GitHub**: Commit all · Push · Open PR (`git` + `gh`)
- **Commands**: Login, Device login, Inspect JSON, MCP list, Export MD, Update CLI
- **Docs links** to Overview / Headless+ACP / CLI reference

## Docs

- [Overview](https://docs.x.ai/build/overview)
- [Headless & ACP](https://docs.x.ai/build/cli/headless-scripting)
- [CLI reference](https://docs.x.ai/build/cli/reference)

## Custom models

Add entries in `%USERPROFILE%\.grok\config.toml` per the docs, then refresh Models.

## Not affiliated

Unofficial community UI. Grok / Grok Build / xAI are trademarks of xAI.
