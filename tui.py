import asyncio
import ctypes
import json
import sys
import time
from ctypes import wintypes

from rich.segment import Segment
from rich.style import NULL_STYLE, Style as RStyle
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.strip import Strip
from textual.widgets import Button, DataTable, Footer, Header, Input, Label, RichLog, Static

from store import BotStore, Config
from verify import verify
from engine import Engine
import ctl

_CF_UNICODETEXT = 13
_GMEM_MOVEABLE = 0x0002
_clip_ready = False


def _clip_init() -> bool:
    global _clip_ready
    if _clip_ready:
        return True
    if sys.platform != "win32":
        return False
    try:
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        u.OpenClipboard.argtypes = [wintypes.HWND]
        u.OpenClipboard.restype = wintypes.BOOL
        u.CloseClipboard.argtypes = []
        u.CloseClipboard.restype = wintypes.BOOL
        u.EmptyClipboard.argtypes = []
        u.EmptyClipboard.restype = wintypes.BOOL
        u.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
        u.IsClipboardFormatAvailable.restype = wintypes.BOOL
        u.GetClipboardData.argtypes = [wintypes.UINT]
        u.GetClipboardData.restype = wintypes.HANDLE
        u.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
        u.SetClipboardData.restype = wintypes.HANDLE
        k.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
        k.GlobalAlloc.restype = wintypes.HANDLE
        k.GlobalLock.argtypes = [wintypes.HANDLE]
        k.GlobalLock.restype = ctypes.c_void_p
        k.GlobalUnlock.argtypes = [wintypes.HANDLE]
        k.GlobalUnlock.restype = wintypes.BOOL
        k.GlobalFree.argtypes = [wintypes.HANDLE]
        k.GlobalFree.restype = wintypes.HANDLE
        _clip_ready = True
        return True
    except Exception:
        return False


def _os_clip_get():
    if not _clip_init():
        return None
    try:
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        for _ in range(3):
            if u.OpenClipboard(None):
                break
            time.sleep(0.01)
        else:
            return None
        try:
            if not u.IsClipboardFormatAvailable(_CF_UNICODETEXT):
                return None
            h = u.GetClipboardData(_CF_UNICODETEXT)
            if not h:
                return None
            p = k.GlobalLock(h)
            if not p:
                return None
            try:
                return ctypes.wstring_at(p)
            finally:
                k.GlobalUnlock(h)
        finally:
            u.CloseClipboard()
    except Exception:
        return None


def _os_clip_set(text) -> bool:
    if not _clip_init():
        return False
    try:
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        for _ in range(3):
            if u.OpenClipboard(None):
                break
            time.sleep(0.01)
        else:
            return False
        try:
            u.EmptyClipboard()
            data = str(text).encode("utf-16-le") + b"\x00\x00"
            h = k.GlobalAlloc(_GMEM_MOVEABLE, len(data))
            if not h:
                return False
            p = k.GlobalLock(h)
            if not p:
                k.GlobalFree(h)
                return False
            ctypes.memmove(p, data, len(data))
            k.GlobalUnlock(h)
            if not u.SetClipboardData(_CF_UNICODETEXT, h):
                k.GlobalFree(h)
                return False
            return True
        finally:
            u.CloseClipboard()
    except Exception:
        return False


class ConsoleLog(RichLog):
    """RichLog that exposes precise per-cell selections (for copy/paste)."""

    def write(self, content, *args, **kwargs):
        before = len(self.lines)
        start_line = getattr(self, "_start_line", 0)
        super().write(content, *args, **kwargs)
        if getattr(self, "_start_line", 0) != start_line:
            for i in range(len(self.lines)):
                self.lines[i] = self._stamp(self.lines[i], i)
        else:
            for i in range(before, len(self.lines)):
                self.lines[i] = self._stamp(self.lines[i], i)
        return self

    @staticmethod
    def _stamp(strip: Strip, y: int) -> Strip:
        x = 0
        segs = []
        for seg in strip._segments:
            text = seg.text or ""
            style = (seg.style or NULL_STYLE) + RStyle.from_meta(
                {"offset": (x, y)})
            segs.append(Segment(text, style))
            x += len(text)
        return Strip(segs, strip.cell_length)

    def get_selection(self, selection):
        text = "\n".join(s.text for s in self.lines)
        return selection.extract(text), "\n"

    def render_line(self, y: int):
        strip = super().render_line(y)
        sel = self.text_selection
        if sel is None or strip.cell_length == 0:
            return strip
        span = sel.get_span(self.scroll_offset.y + y)
        if span is None:
            return strip
        x0, x1 = span
        if x1 < 0:
            x1 = strip.cell_length
        x0 = max(0, min(x0, strip.cell_length))
        x1 = max(0, min(x1, strip.cell_length))
        if x1 <= x0:
            return strip
        parts = strip.divide((x0, x1))
        if len(parts) != 3:
            return strip
        sel_style = self.screen.selection_style
        mid = Strip(
            [
                Segment(s.text, sel_style + (s.style or NULL_STYLE))
                for s in parts[1]._segments
            ],
            parts[1].cell_length,
        )
        return parts[0] + mid + parts[2]


class HomeScreen(Screen):
    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical():
            yield Label("VEILBOT -- bot roster", id="title")
            yield DataTable(id="roster")
            with Horizontal(id="btnrow"):
                yield Button("+ add bot", id="add", variant="primary")
                yield Button("remove", id="remove")
                yield Button("ready >", id="ready", variant="success")
                yield Button("quit", id="quit")
        yield Footer()

    def on_screen_resume(self) -> None:
        self.refresh_roster()

    def refresh_roster(self) -> None:
        table = self.query_one("#roster", DataTable)
        table.clear(columns=True)
        table.add_columns("name", "uuid", "status", "added")
        store = self.app.store
        for b in store.bots:
            table.add_row(
                str(b.get("name") or "?"),
                str(b.get("uuid") or "?"),
                str(b.get("status") or "?"),
                str(b.get("added_at") or ""),
                key=b.get("uuid"),
            )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "add":
            self.app.push_screen(AddBotScreen())
        elif event.button.id == "quit":
            self.app.exit()
        elif event.button.id == "ready":
            self.app.push_screen(SetupScreen())
        elif event.button.id == "remove":
            table = self.query_one("#roster", DataTable)
            if table.cursor_row is not None and table.row_count:
                row = table.coordinate_to_cell_key(table.cursor_coordinate).row_key
                if row is not None:
                    self.app.store.remove(str(row.value))
                    self.refresh_roster()


class AddBotScreen(Screen):
    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical(id="addbox"):
            yield Label("paste access token", id="title")
            yield Input(placeholder="eyJ...", id="token", password=True)
            yield Label("", id="result")
            with Horizontal(id="btnrow"):
                yield Button("verify + add", id="verify", variant="primary")
                yield Button("back", id="back")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        elif event.button.id == "verify":
            self.run_worker(self.do_verify(), exclusive=True)

    async def do_verify(self) -> None:
        token = self.query_one("#token", Input).value.strip()
        res_label = self.query_one("#result", Label)
        if not token:
            res_label.update("[red]empty token[/]")
            return
        res_label.update("checking with mojang...")
        res = await asyncio.to_thread(verify, token)
        st = res.get("status")
        if st == "ok":
            self.app.store.add(token, res)
            res_label.update(
                f"[green]OK[/] {res['name']}  uuid={res['uuid']}  "
                f"expires_in={res.get('expires_in')}s"
            )
            await asyncio.sleep(1.0)
            self.app.pop_screen()
        elif st == "expired":
            res_label.update(f"[red]EXPIRED[/] {res.get('detail')} -- get a fresh token")
        elif st == "no_profile":
            res_label.update("[red]NO MINECRAFT[/] account owns no copy of the game")
        else:
            res_label.update(f"[red]INVALID[/] {res.get('detail')}")


class SetupScreen(Screen):
    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical(id="addbox"):
            yield Label("server + timing", id="title")
            yield Input(placeholder="host:25565", id="server")
            yield Input(placeholder="join delay seconds (default 5)", id="delay")
            yield Label("", id="result")
            with Horizontal(id="btnrow"):
                yield Button("ready", id="go", variant="success")
                yield Button("back", id="back")
        yield Footer()

    def on_screen_resume(self) -> None:
        self.query_one("#server", Input).value = self.app.config.server
        self.query_one("#delay", Input).value = str(self.app.config.join_delay)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        elif event.button.id == "go":
            server = self.query_one("#server", Input).value.strip()
            delay_raw = self.query_one("#delay", Input).value.strip() or "5"
            if ":" not in server:
                server += ":25565"
            try:
                delay = float(delay_raw)
            except ValueError:
                self.query_one("#result", Label).update("[red]delay must be a number[/]")
                return
            self.app.config.server = server
            self.app.config.join_delay = delay
            self.app.config.save()
            self.app.push_screen(DashboardScreen())


class DashboardScreen(Screen):
    target = "ALL"

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="main"):
            with Vertical(id="left"):
                yield Label("dashboard  target: ALL", id="title")
                yield DataTable(id="live")
            yield ConsoleLog(id="console", wrap=True, highlight=False, markup=False)
        with Horizontal(id="btnrow"):
            yield Button("join all", id="join", variant="primary")
            yield Button("leave all", id="leave")
            yield Button("rejoin dead", id="rejoin")
            yield Button("target: ALL", id="target")
            yield Button("chat: hidden", id="chatf")
            yield Button("< home", id="home")
        with Horizontal(id="btnrow2"):
            yield Input(placeholder="script: all tpa Bob; wait 6; prep  (or: /command, cmd /home, help)", id="cmd")
            yield Button("say", id="say")
            yield Button("run task", id="task", variant="warning")
        yield Static("synced tasks share one start tick across every bot", id="enginehint")
        yield Footer()

    def on_screen_resume(self) -> None:
        table = self.query_one("#live", DataTable)
        table.clear(columns=True)
        table.add_columns("name", "state", "task", "detail")
        for b in self.app.store.bots:
            u = b["uuid"]
            table.add_row(
                str(b.get("name") or "?"),
                self.app.engine.status_of(u),
                self.app.engine.task_of(u),
                (self.app.engine.detail_of(u) or "")[:60],
                key=u,
            )
        self.query_one("#chatf", Button).label = (
            "chat: hidden" if self.app.engine.chat_filter else "chat: shown")
        if not hasattr(self, "_ticker"):
            self._ticker = self.set_interval(1.0, self.refresh_live)
        log = self.query_one("#console", RichLog)
        log.clear()
        for line in self.app.console_lines[-200:]:
            log.write(line)

    def write_console(self, line: str) -> None:
        try:
            self.query_one("#console", RichLog).write(line.replace("\u00a7", " "))
        except Exception:
            pass

    def refresh_live(self) -> None:
        table = self.query_one("#live", DataTable)
        table.clear(columns=True)
        table.add_columns("name", "state", "task", "detail")
        for b in self.app.store.bots:
            u = b["uuid"]
            table.add_row(
                str(b.get("name") or "?"),
                self.app.engine.status_of(u),
                self.app.engine.task_of(u),
                (self.app.engine.detail_of(u) or "")[:60],
                key=u,
            )

    def selected_uuid(self):
        table = self.query_one("#live", DataTable)
        if table.row_count:
            try:
                key = table.coordinate_to_cell_key(table.cursor_coordinate).row_key
                if key is not None:
                    return str(key.value)
            except Exception:
                pass
        return None

    def on_button_pressed(self, event: Button.Pressed) -> None:
        eid = event.button.id
        if eid == "home":
            # dashboard sits on top of setup + home, skip both
            self.app.pop_screen()
            self.app.pop_screen()
        elif eid == "join":
            self.run_worker(self._engine_act("join", self.app.engine.join_all()),
                            exclusive=True)
        elif eid == "leave":
            self.run_worker(self._engine_act("leave", self.app.engine.leave_all()),
                            exclusive=True)
        elif eid == "rejoin":
            self.run_worker(self._engine_act("rejoin", self.app.engine.rejoin_dead()),
                            exclusive=True)
        elif eid == "target":
            if self.target == "ALL":
                u = self.selected_uuid()
                if u:
                    self.target = u
            else:
                self.target = "ALL"
            name = "ALL"
            if self.target != "ALL":
                for b in self.app.store.bots:
                    if b["uuid"] == self.target:
                        name = b.get("name") or self.target[:8]
            self.query_one("#title", Label).update(f"dashboard  target: {name}")
            event.button.label = f"target: {name}"
        elif eid == "chatf":
            hide = not self.app.engine.chat_filter
            n = self.app.engine.set_chat_filter(hide)
            event.button.label = "chat: hidden" if hide else "chat: shown"
            state = "chat hidden" if hide else "chat shown"
            self.query_one("#enginehint", Static).update(f"{state} ({n} bot(s))")
            self.app.log_line(f"== {state}")
        elif eid == "say":
            text = self.query_one("#cmd", Input).value.strip()
            if text:
                n = self.app.engine.broadcast_chat(text, self.target)
                self.query_one("#enginehint", Static).update(f"sent to {n} bot(s)")
                self.app.log_line(f"== say -> {n} bot(s)")
        elif eid == "task":
            self.run_task()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "cmd":
            self.run_task()

    def _looks_like_script(self, raw: str) -> bool:
        return ctl.looks_like_script(raw)

    def run_task(self) -> None:
        raw = self.query_one("#cmd", Input).value.strip()
        if not raw:
            return
        hint = self.query_one("#enginehint", Static)
        if raw in ("help", "?", "h"):
            from script import HELP
            hint.update(HELP)
            return
        # /command or "cmd ..." -> run it as a Minecraft server command
        p0 = raw.split()
        if raw.startswith("/") or p0[0].lower() == "cmd":
            txt = raw if raw.startswith("/") else " ".join(p0[1:])
            if not txt:
                hint.update("cmd <command>  (e.g. cmd /home)")
                return
            if not txt.startswith("/"):
                txt = "/" + txt
            n = self.app.engine.broadcast_chat(txt, self.target)
            hint.update(f"cmd -> {n} bot(s): {txt}")
            self.app.log_line(f"== cmd -> {n} bot(s): {txt}")
            return
        if self._looks_like_script(raw):
            from script import parse, ScriptError
            try:
                steps = parse(raw, len(self.app.store.bots))
            except ScriptError as e:
                hint.update(f"script error: {e}")
                self.app.log_line(f"== script error: {e}")
                return
            hint.update(f"script: {len(steps)} step(s) queued")
            self.app.log_line(f"== script: {len(steps)} step(s) queued")
            def progress(i, total, note):
                hint.update(f"script {i}/{total}: {note}")
            self.run_worker(self._run_script(steps, progress), exclusive=True)
            return
        parts = raw.split()
        kind = parts[0].lower()
        args = {}
        if kind == "wander":
            args["radius"] = int(parts[1]) if len(parts) > 1 else 24
        elif kind == "mine":
            args["radius"] = int(parts[1]) if len(parts) > 1 else 3
            args["layers"] = int(parts[2]) if len(parts) > 2 else 1
        elif kind == "near":
            try:
                r = float(parts[1]) if len(parts) > 1 else 48.0
            except ValueError:
                hint.update("near [viewradius]  (4-128)")
                return
            if r < 4 or r > 128:
                hint.update("near [viewradius]  (4-128)")
                return
            args["radius"] = r
        elif kind in ("goto", "follow"):
            if len(parts) < 2:
                self.query_one("#enginehint", Static).update("needs a player name")
                return
            args["player"] = parts[1]
        elif kind == "move":
            d = parts[1].lower() if len(parts) > 1 else "forward"
            if d not in ("forward", "back", "left", "right"):
                self.query_one("#enginehint", Static).update("move: forward|back|left|right <blocks>")
                return
            args["dir"] = d
            try:
                args["blocks"] = float(parts[2]) if len(parts) > 2 else 1.0
            except ValueError:
                self.query_one("#enginehint", Static).update("blocks must be a number")
                return
        elif kind in ("rightclick", "rclick", "leftclick", "lclick"):
            kind = "rclick" if kind in ("rightclick", "rclick") else "lclick"
            if len(parts) > 1:
                args["player"] = parts[1]
        elif kind in ("swing", "punch"):
            kind = "swing"
        elif kind == "jump":
            pass
        elif kind == "look":
            if len(parts) < 2:
                self.query_one("#enginehint", Static).update("look <yaw> [pitch]  (degrees)")
                return
            try:
                args["yaw"] = float(parts[1])
                args["pitch"] = float(parts[2]) if len(parts) > 2 else 0.0
            except ValueError:
                self.query_one("#enginehint", Static).update("yaw/pitch must be numbers")
                return
        elif kind in ("sneak", "sprint"):
            args["on"] = (len(parts) < 2) or parts[1].lower() != "off"
        elif kind == "drop":
            pass
        elif kind == "stop":
            pass
        else:
            self.query_one("#enginehint", Static).update(f"unknown: {kind}")
            return
        n, tid = self.app.engine.broadcast_task(kind, args, self.target)
        self.query_one("#enginehint", Static).update(f"task {kind} -> {n} bot(s) [{tid}]")
        self.app.log_line(f"== task {kind} -> {n} bot(s) [{tid}]")

    async def _engine_act(self, name, coro) -> None:
        hint = self.query_one("#enginehint", Static)
        hint.update(f"{name}: working...")
        try:
            res = await coro
            hint.update(str(res or f"{name} ok"))
            self.app.log_line(f"== {name}: {res or 'ok'}")
        except Exception as e:
            hint.update(f"{name} failed: {e}")
            self.app.log_line(f"== {name} FAILED: {e}")

    async def _run_script(self, steps, progress) -> None:
        results = await self.app.engine.run_sequence(
            steps, current_target=self.target, on_progress=progress)
        bad = [r for r in results
               if any(w in r for w in ("TIMEOUT", "no online", "failed", "unknown"))]
        hint = self.query_one("#enginehint", Static)
        if bad:
            hint.update("script issue: " + " | ".join(bad))
            self.app.log_line("== script issue: " + " | ".join(bad))
        else:
            hint.update(f"script done ({len(results)} step(s), all ok)")
            self.app.log_line(f"== script done ({len(results)} step(s), all ok)")


class VeilBotApp(App):
    CSS = """
    Screen { align: center middle; }
    DashboardScreen { align: left top; }
    #main { width: 100%; height: 1fr; }
    #main > * { height: 1fr; }
    #left { width: 1fr; }
    #title { text-style: bold; color: $accent; margin: 1 0; }
    #addbox { width: 80; height: auto; border: round $accent; padding: 1 2; }
    #btnrow { height: auto; margin-top: 1; }
    #btnrow2 { height: auto; margin-top: 1; }
    #cmd { width: 1fr; }
    #btnrow2 Button { width: auto; }
    Button { margin: 0 1; }
    DataTable { height: auto; min-height: 6; margin: 0 1; }
    #enginehint { color: $text-muted; margin: 1; }
    #console { width: 1fr; min-width: 44; height: 1fr; min-height: 8; margin: 0 1; border: tall $accent; }
    #result { margin-top: 1; }
    """
    TITLE = "veilbot"
    BINDINGS = [("q", "quit", "quit")]

    def __init__(self):
        super().__init__()
        self.store = BotStore()
        self.config = Config()
        self.engine = None
        self.console_lines = []
        self._ctl_task = None
        self._ctl_server = None

    def on_mount(self) -> None:
        from engine import Engine
        self.engine = Engine(self.store, self.config, on_event=self._engine_event)
        self.push_screen(HomeScreen())
        self._ctl_task = asyncio.create_task(self._ctl_serve())

    def log_line(self, text: str) -> None:
        line = f"{time.strftime('%H:%M:%S')}  {text}".replace("\u00a7", " ")
        self.console_lines.append(line)
        if len(self.console_lines) > 6000:
            self.console_lines = self.console_lines[-5000:]
        scr = self.screen
        if isinstance(scr, DashboardScreen):
            scr.write_console(line)

    def _engine_event(self, uuid, msg) -> None:
        name = uuid[:8]
        for b in self.store.bots:
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
        self.log_line(f"{name:<12} {body}")

    def _ctl_target(self) -> str:
        scr = self.screen
        if isinstance(scr, DashboardScreen):
            return scr.target
        return "ALL"

    async def _ctl_serve(self) -> None:
        try:
            server = await asyncio.start_server(self._ctl_conn,
                                                ctl.HOST, ctl.PORT)
        except OSError as e:
            self.log_line(f"== MCP bridge off (port {ctl.PORT}: {e})")
            return
        self._ctl_server = server
        self.log_line(f"== MCP bridge on {ctl.HOST}:{ctl.PORT}")
        try:
            async with server:
                await server.serve_forever()
        finally:
            self._ctl_server = None

    async def _ctl_conn(self, reader, writer) -> None:
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    req = json.loads(line.decode("utf-8"))
                    result = await self._ctl_handle(str(req.get("cmd", "")),
                                                    req.get("args") or {})
                    resp = {"ok": True, "result": result}
                except Exception as e:
                    resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                try:
                    writer.write((json.dumps(resp) + "\n").encode("utf-8"))
                    await writer.drain()
                except Exception:
                    break
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _ctl_handle(self, cmd: str, args: dict) -> str:
        e = self.engine
        if e is None:
            raise RuntimeError("engine not ready")
        if cmd == "ping":
            return "pong"
        if cmd == "status":
            return ctl.fmt_status(self.store, self.config, e)
        if cmd in ("join", "leave", "rejoin"):
            coro = {"join": e.join_all, "leave": e.leave_all,
                    "rejoin": e.rejoin_dead}[cmd]()
            out = str(await coro or f"{cmd} ok")
        elif cmd == "console":
            n = max(1, min(5000, int(args.get("last", 30))))
            return "\n".join(self.console_lines[-n:]) or "<empty>"
        elif cmd == "say":
            n = e.broadcast_chat(str(args.get("text", "")), self._ctl_target())
            out = f"sent to {n} bot(s)"
        elif cmd == "cmd":
            text = str(args.get("text", "")).strip()
            if not text:
                raise ValueError("command required")
            if not text.startswith("/"):
                text = "/" + text
            n = e.broadcast_chat(text, self._ctl_target())
            out = f"cmd {text} -> {n} bot(s)"
        elif cmd == "set_server":
            s = str(args.get("server", "")).strip()
            if not s:
                raise ValueError("server required")
            if ":" not in s:
                s += ":25565"
            self.config.server = s
            self.config.join_delay = float(args.get("join_delay", 0.0))
            self.config.save()
            out = f"server={self.config.server} join_delay={self.config.join_delay}"
        elif cmd == "run":
            out = await ctl.execute_run(
                e, str(args.get("command", "")), len(self.store.bots),
                current_target=self._ctl_target(), bare_prefix="sel",
                timeout=float(args.get("timeout", 25.0)))
        else:
            raise ValueError(f"unknown command {cmd!r}")
        self.log_line(f"== mcp {cmd}: {out.replace(chr(10), ' | ')[:160]}")
        return out

    async def _shutdown(self) -> None:
        if self._ctl_task:
            self._ctl_task.cancel()
            try:
                await self._ctl_task
            except asyncio.CancelledError:
                pass
            self._ctl_task = None
        if self.engine:
            try:
                await self.engine.shutdown()
            except Exception:
                pass
        await super()._shutdown()

    def copy_to_clipboard(self, text: str) -> None:
        super().copy_to_clipboard(text)
        _os_clip_set(text)

    @property
    def clipboard(self) -> str:
        os_text = _os_clip_get()
        if os_text:
            return os_text
        return super().clipboard


def run():
    VeilBotApp().run()


if __name__ == "__main__":
    run()
