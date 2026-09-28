"""veilbot MCP server -- control your Minecraft bots from any MCP client.

Run:  python mcp_server.py     (stdio transport)

If the TUI (python tui.py) is running, every command is forwarded to it over
the local control bridge (127.0.0.1:47654): the TUI stays the single owner
of the bot accounts, honors its target field, and shows each MCP action in
its console. Only when no TUI is listening does this server run its own
headless engine -- if you join bots headless, run `leave` before starting
the TUI so the two never own the same accounts.
"""

import time
from contextlib import asynccontextmanager

from mcp.server.mcpserver import MCPServer

import ctl
from store import BotStore, Config
from engine import Engine
from script import HELP

store = BotStore()
config = Config()
console_lines: list[str] = []
engine: Engine | None = None


def _on_event(uuid, msg) -> None:
    name = uuid[:8]
    for b in store.bots:
        if b.get("uuid") == uuid:
            name = str(b.get("name") or uuid[:8])
            break
    et = msg.get("evt", "?")
    if et == "status":
        body = f"state {msg.get('state')} {msg.get('detail') or ''}".strip()
    elif et == "task":
        body = (f"task {msg.get('id', '')[:4]} {msg.get('state', '')} "
                f"{msg.get('detail') or ''}").strip()
    elif et == "say":
        body = f"chat {msg.get('message')}"
    elif et == "log":
        body = f"log {msg.get('msg')}"
    else:
        body = f"{et} {msg}"
    _log(f"{name:<12} {body}")


def _log(text: str) -> None:
    console_lines.append(f"{time.strftime('%H:%M:%S')}  {text}".replace("\u00a7", " "))
    if len(console_lines) > 6000:
        console_lines[:] = console_lines[-5000:]


def _need() -> Engine:
    if engine is None:
        raise RuntimeError("engine not started yet")
    return engine


async def _via_tui(cmd, args=None, timeout=60.0):
    """Forward to a running TUI. Returns None = no TUI, fall back headless."""
    try:
        return await ctl.client_call(cmd, args, timeout=timeout)
    except ctl.TuiNotRunning:
        return None
    except Exception as e:
        return f"tui error: {e}"


@asynccontextmanager
async def lifespan(server: MCPServer):
    global engine
    engine = Engine(store, config, on_event=_on_event)
    _log(f"== mcp engine up (headless fallback), server={config.server}")
    try:
        yield {}
    finally:
        try:
            await engine.shutdown()
        except Exception:
            pass


mcp = MCPServer(
    "veilbot",
    instructions=("Minecraft bot farm controller. If the veilbot TUI is "
                  "running it stays in control and commands are forwarded to "
                  "it (visible in its console, honoring its target field); "
                  "otherwise commands run on a headless engine. Use status "
                  "first, then join, then run. Commands use the same "
                  "mini-script language as the TUI, e.g. 'all tpa Bob; wait "
                  "6; near 64'."),
    lifespan=lifespan,
)


@mcp.tool()
async def status() -> str:
    """List every bot: name, uuid, connection state, current task, detail,
    plus the configured server."""
    r = await _via_tui("status")
    if r is not None:
        return r
    return ctl.fmt_status(store, config, engine)


@mcp.tool()
async def join() -> str:
    """Join the configured server with every bot (staggered by join_delay)."""
    r = await _via_tui("join", timeout=180.0)
    if r is None:
        r = str(await _need().join_all() or "join ok")
        _log(f"== join: {r}")
    return r


@mcp.tool()
async def leave() -> str:
    """Disconnect every bot from the server."""
    r = await _via_tui("leave", timeout=60.0)
    if r is None:
        r = str(await _need().leave_all() or "leave ok")
        _log(f"== leave: {r}")
    return r


@mcp.tool()
async def rejoin() -> str:
    """Reconnect only the bots that are currently dead/offline."""
    r = await _via_tui("rejoin", timeout=180.0)
    if r is None:
        r = str(await _need().rejoin_dead() or "rejoin ok")
        _log(f"== rejoin: {r}")
    return r


@mcp.tool()
async def run(command: str, timeout: float = 25.0) -> str:
    """Run one task or a whole script on the bots and wait for results.

    Bare commands use the TUI's current target when the TUI is open (all
    bots when headless); script syntax with selectors ('all', 'sel', '#0,2',
    'name:Bob') and ';' separators is passed through unchanged. Examples:
      near 64
      rclick SomeNpc
      all tpa Bob; wait 6; goto 0.5 100 5.5
    timeout = per-step seconds to wait for a blocking action (default 25).
    """
    r = await _via_tui("run", {"command": command, "timeout": timeout},
                       timeout=max(600.0, timeout + 60.0))
    if r is None:
        r = await ctl.execute_run(_need(), command, len(store.bots),
                                  current_target="ALL", bare_prefix="all",
                                  timeout=timeout)
        _log(f"== run -> {r}")
    return r


@mcp.tool()
async def cmd(command: str) -> str:
    """Execute a Minecraft server command (slash command) on the bots, e.g.
    '/spawn', '/home base', '/warp list'. Sent as a real chat_command packet
    from the TUI's current target (all bots when headless). A leading '/' is
    optional. Check console for the 'cmds(...)' line to see what the server
    offers and for 'cmd-reply:' lines showing command feedback."""
    text = command.strip()
    if not text:
        return "empty command"
    if not text.startswith("/"):
        text = "/" + text
    r = await _via_tui("cmd", {"text": text})
    if r is None:
        n = _need().broadcast_chat(text, "ALL")
        _log(f"== cmd: {text} -> {n} bot(s)")
        r = f"cmd {text} -> {n} bot(s)"
    return r


@mcp.tool()
async def say(text: str) -> str:
    """Broadcast a chat message (from the TUI's current target when open)."""
    r = await _via_tui("say", {"text": text})
    if r is None:
        n = _need().broadcast_chat(text, "ALL")
        _log(f"== say -> {n} bot(s)")
        r = f"sent to {n} bot(s)"
    return r


@mcp.tool()
async def console(last: int = 30) -> str:
    """Return the last N lines of the bot console/event log (the TUI's own
    log when it is running)."""
    r = await _via_tui("console", {"last": last})
    if r is None:
        r = "\n".join(console_lines[-max(1, last):]) or "<empty>"
    return r


@mcp.tool()
async def set_server(server: str, join_delay: float = 0.0) -> str:
    """Set the Minecraft server host (adds :25565 if missing) and join
    delay in seconds, and save it to data/config.json."""
    r = await _via_tui("set_server", {"server": server,
                                      "join_delay": join_delay})
    if r is None:
        s = server.strip()
        if ":" not in s:
            s += ":25565"
        config.server = s
        config.join_delay = float(join_delay)
        config.save()
        _log(f"== set_server {s} delay={join_delay}")
        r = f"server={config.server} join_delay={config.join_delay}"
    return r


@mcp.tool()
def help_commands() -> str:
    """Cheat sheet for the task/script mini-language."""
    return HELP


if __name__ == "__main__":
    mcp.run(transport="stdio")
