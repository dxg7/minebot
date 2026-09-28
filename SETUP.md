# minebot setup (Windows)

1. Install Python 3.11+ from https://python.org (check "Add to PATH")
2. Install Node.js 18+ from https://nodejs.org
3. Unzip this folder anywhere, e.g. `C:\minebot`
4. Open PowerShell **inside the folder** and run:

```
pip install textual mcp
npm install
```

5. Quick live test (replace TOKEN with a real access token):

```
$env:MT="TOKEN"; python _test_live.py
```

6. Real app:

```
python main.py
```

Notes:
- The tool stores tokens in `data/bots.json` (created on first add).
- Server is preconfigured to `stablesmp.xyz` in `data/config.json`.
- If joining fails with connection refused, the SRV/DNS fix is already
  built into `engine/bot.js` (auto-resolves mc.stablesmp.xyz:25565).

## MCP server (control bots from an AI agent)

`mcp_server.py` exposes the same bot controls over MCP:

```
python mcp_server.py
```

Tools: `status`, `join`, `leave`, `rejoin`, `run` (task/script), `cmd`
(Minecraft slash command, e.g. `/spawn`), `say`, `console`, `set_server`,
`help_commands`. Commands use the same mini-script
language as the TUI (`all tpa Bob; wait 6; near 64`).

- Wired in `opencode.json` (project config) — restart opencode to load it.
- **With the TUI open, MCP forwards every command to it** (bridge on
  `127.0.0.1:47654`): one owner for the bot accounts, actions show up in
  the TUI console, and `run`/`say` honor the TUI's target field.
- With the TUI closed, MCP runs headless on its own engine. If you joined
  bots headless, run MCP `leave` before starting the TUI so the same
  account is never in two places.
