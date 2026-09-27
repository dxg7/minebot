import asyncio

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Button, DataTable, Footer, Header, Input, Label, Static

from store import BotStore, Config
from verify import verify
from engine import Engine


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
        table.clear()
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
        with Vertical():
            yield Label("dashboard  target: ALL", id="title")
            yield DataTable(id="live")
            with Horizontal(id="btnrow"):
                yield Button("join all", id="join", variant="primary")
                yield Button("leave all", id="leave")
                yield Button("rejoin dead", id="rejoin")
                yield Button("target: ALL", id="target")
                yield Button("< home", id="home")
            with Horizontal(id="btnrow2"):
                yield Input(placeholder="script: all tpa Bob; wait 6; prep; chunkmine 100 -300 16  (or: help)", id="cmd")
                yield Button("say", id="say")
                yield Button("run task", id="task", variant="warning")
            yield Static("synced tasks share one start tick across every bot", id="enginehint")
        yield Footer()

    def on_screen_resume(self) -> None:
        table = self.query_one("#live", DataTable)
        table.clear()
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
        if not hasattr(self, "_ticker"):
            self._ticker = self.set_interval(1.0, self.refresh_live)

    def refresh_live(self) -> None:
        table = self.query_one("#live", DataTable)
        table.clear()
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
            self.run_worker(self.app.engine.join_all(), exclusive=True)
        elif eid == "leave":
            self.run_worker(self.app.engine.leave_all(), exclusive=True)
        elif eid == "rejoin":
            self.run_worker(self.app.engine.rejoin_dead(), exclusive=True)
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
        elif eid == "say":
            text = self.query_one("#cmd", Input).value.strip()
            if text:
                n = self.app.engine.broadcast_chat(text, self.target)
                self.query_one("#enginehint", Static).update(f"sent to {n} bot(s)")
        elif eid == "task":
            self.run_task()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "cmd":
            self.run_task()

    def _looks_like_script(self, raw: str) -> bool:
        if ";" in raw:
            return True
        head = raw.split()[0].lower()
        return (head in ("all", "sel", "me", "wait",
                         "tpa", "tpaccept", "gather", "craft", "prep", "chunkmine")
                or head.startswith("#") or head.startswith("name:"))

    def run_task(self) -> None:
        raw = self.query_one("#cmd", Input).value.strip()
        if not raw:
            return
        hint = self.query_one("#enginehint", Static)
        if raw in ("help", "?", "h"):
            from script import HELP
            hint.update(HELP)
            return
        if self._looks_like_script(raw):
            from script import parse, ScriptError
            try:
                steps = parse(raw, len(self.app.store.bots))
            except ScriptError as e:
                hint.update(f"script error: {e}")
                return
            hint.update(f"script: {len(steps)} step(s) queued")
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
        elif kind == "rightclick":
            kind = "rclick"
        elif kind == "leftclick":
            kind = "lclick"
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

    async def _run_script(self, steps, progress) -> None:
        results = await self.app.engine.run_sequence(
            steps, current_target=self.target, on_progress=progress)
        bad = [r for r in results
               if any(w in r for w in ("TIMEOUT", "no online", "failed", "unknown"))]
        hint = self.query_one("#enginehint", Static)
        if bad:
            hint.update("script issue: " + " | ".join(bad))
        else:
            hint.update(f"script done ({len(results)} step(s), all ok)")


class VeilBotApp(App):
    CSS = """
    Screen { align: center middle; }
    DashboardScreen { align: left top; }
    #title { text-style: bold; color: $accent; margin: 1 0; }
    #addbox { width: 80; height: auto; border: round $accent; padding: 1 2; }
    #btnrow { height: auto; margin-top: 1; }
    #btnrow2 { height: auto; margin-top: 1; }
    #cmd { width: 1fr; }
    #btnrow2 Button { width: auto; }
    Button { margin: 0 1; }
    DataTable { height: 1fr; margin: 0 1; min-height: 5; }
    #enginehint { color: $text-muted; margin: 1; }
    #result { margin-top: 1; }
    """
    TITLE = "veilbot"
    BINDINGS = [("q", "quit", "quit")]

    def __init__(self):
        super().__init__()
        self.store = BotStore()
        self.config = Config()
        self.engine = None

    def on_mount(self) -> None:
        from engine import Engine
        self.engine = Engine(self.store, self.config)
        self.push_screen(HomeScreen())

    async def _shutdown(self) -> None:
        if self.engine:
            try:
                await self.engine.shutdown()
            except Exception:
                pass
        await super()._shutdown()


def run():
    VeilBotApp().run()


if __name__ == "__main__":
    run()
