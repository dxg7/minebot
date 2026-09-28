"""Shared bits for the MCP <-> TUI control bridge (no heavy imports).

The TUI opens a tiny newline-JSON server on 127.0.0.1:47654 while it runs;
mcp_server.py forwards tool calls to it and only runs its own headless
engine when no TUI is listening. Override the port with MINEBOT_CTL_PORT.
"""

import asyncio
import json
import os

from script import ScriptError, parse

HOST = "127.0.0.1"
PORT = int(os.environ.get("MINEBOT_CTL_PORT", "47654"))


class TuiNotRunning(ConnectionError):
    pass


def looks_like_script(raw: str) -> bool:
    if ";" in raw:
        return True
    head = raw.split()[0]
    if head.startswith("/"):
        return True
    head = head.lower()
    return (head in ("all", "sel", "me", "wait", "tpa", "tpaccept",
                     "gather", "craft", "prep", "chunkmine", "cmd", "goto")
            or head.startswith("#") or head.startswith("name:"))


def fmt_status(store, config, engine) -> str:
    rows = [f"server: {config.server}  (join_delay={config.join_delay}s)",
            f"bots: {len(store.bots)}"]
    for b in store.bots:
        u = b["uuid"]
        state = engine.status_of(u) if engine else "?"
        task = engine.task_of(u) if engine else "?"
        detail = (engine.detail_of(u) or "") if engine else ""
        rows.append(f"  {str(b.get('name') or '?'):<12} {state:<10} "
                    f"{task:<10} {detail[:60]}")
    return "\n".join(rows)


async def execute_run(engine, raw, roster_len, current_target="ALL",
                      bare_prefix="all", timeout=25.0) -> str:
    raw = (raw or "").strip()
    if not raw:
        return "empty command"
    if not looks_like_script(raw):
        raw = bare_prefix + " " + raw
    try:
        steps = parse(raw, roster_len)
    except ScriptError as e:
        return f"script error: {e}"
    results = await engine.run_sequence(steps, current_target=current_target,
                                        step_timeout=timeout)
    return "\n".join(results)


async def client_call(cmd, args=None, timeout=60.0, connect_timeout=2.0) -> str:
    """One command to a running TUI.

    Raises TuiNotRunning when nobody is listening (caller may fall back);
    other errors mean the call reached the TUI and failed there (caller must
    NOT retry elsewhere, or the action could run twice).
    """
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(HOST, PORT), connect_timeout)
    except (OSError, asyncio.TimeoutError) as e:
        raise TuiNotRunning(str(e))
    try:
        writer.write((json.dumps({"cmd": cmd, "args": args or {}}) + "\n")
                     .encode("utf-8"))
        await writer.drain()
        try:
            line = await asyncio.wait_for(reader.readline(), timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"tui did not answer {cmd} in {timeout:g}s")
        if not line:
            raise ConnectionError("tui closed the connection")
        resp = json.loads(line.decode("utf-8"))
    finally:
        writer.close()
    if not resp.get("ok"):
        raise RuntimeError(resp.get("error", "unknown tui error"))
    return str(resp.get("result", ""))
