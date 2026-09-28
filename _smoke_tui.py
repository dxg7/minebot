import asyncio

from textual.widgets import DataTable, Input, Label, Static

from tui import VeilBotApp


def hint_text(w):
    for attr in ("content", "renderable"):
        r = getattr(w, attr, None)
        if r is not None:
            return str(r)
    return "<empty>"


async def main():
    app = VeilBotApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        home = app.screen
        print("1 home screen:", type(home).__name__)
        assert type(home).__name__ == "HomeScreen", "expected HomeScreen"
        roster = home.query_one("#roster", DataTable)
        print("   roster rows:", roster.row_count)

        await pilot.click("#add")
        await pilot.pause()
        print("2 after +add:", type(app.screen).__name__)
        assert type(app.screen).__name__ == "AddBotScreen"

        await pilot.click("#verify")
        await pilot.pause()
        res = app.screen.query_one("#result", Label)
        print("   verify(empty token):", hint_text(res))

        await pilot.click("#back")
        await pilot.pause()
        assert type(app.screen).__name__ == "HomeScreen"
        print("3 back at:", type(app.screen).__name__)

        await pilot.click("#ready")
        await pilot.pause()
        assert type(app.screen).__name__ == "SetupScreen"
        srv = app.screen.query_one("#server", Input)
        dly = app.screen.query_one("#delay", Input)
        print("4 setup prefilled:", repr(srv.value), repr(dly.value))

        await pilot.click("#go")
        await pilot.pause()
        dash = app.screen
        print("5 dashboard:", type(dash).__name__)
        assert type(dash).__name__ == "DashboardScreen"
        # stored join_delay must not gate this test: a slow join_all gets
        # cancelled by the exclusive leave-worker before its console line logs
        app.config.join_delay = 0
        live = dash.query_one("#live", DataTable)
        print("   live rows:", live.row_count)

        cmd = dash.query_one("#cmd", Input)
        hint = dash.query_one("#enginehint", Static)

        cmd.value = "help"
        await pilot.click("#task")
        await pilot.pause()
        await asyncio.sleep(0.3)
        await pilot.pause()
        print("6 help ->", hint_text(hint)[:70])

        cmd.value = "wander 10"
        await pilot.click("#task")
        await pilot.pause()
        await asyncio.sleep(0.3)
        await pilot.pause()
        print("7 task ->", hint_text(hint)[:70])

        cmd.value = "near 64"
        await pilot.click("#task")
        await pilot.pause()
        await asyncio.sleep(0.3)
        await pilot.pause()
        h7b = hint_text(hint)
        print("7b near ->", h7b[:70])
        assert h7b.startswith("task near -> 0 bot(s)"), h7b

        cmd.value = "all tpa Bob"
        await pilot.click("#task")
        await pilot.pause()
        await asyncio.sleep(0.5)
        await pilot.pause()
        print("8 script ->", hint_text(hint)[:90])

        cmd.value = "all nope"
        await pilot.click("#task")
        await pilot.pause()
        print("9 bad cmd ->", hint_text(hint)[:70])

        await pilot.click("#target")
        await pilot.pause()
        print("10 target ->", hint_text(dash.query_one("#title", Label))[:60])

        await pilot.click("#join")
        await pilot.pause()
        await asyncio.sleep(0.8)
        await pilot.pause()
        print("10a join hint ->", hint_text(hint)[:80])

        await pilot.click("#leave")
        await pilot.pause()
        await asyncio.sleep(4.2)
        await pilot.pause()
        print("10b leave hint ->", hint_text(hint)[:80])
        assert hint_text(hint).startswith("leave:"), "leave hint missing"

        await asyncio.sleep(1.2)
        await pilot.pause()
        ncols = len(live.columns)
        print("10c live columns after ticks:", ncols)
        assert ncols == 4, f"column leak: {ncols}"

        lines = app.console_lines
        print("10d console lines:", len(lines), "| last:", (lines[-1] if lines else ""))
        assert any("== join" in l for l in lines), "join line missing from console"
        assert any("== leave" in l for l in lines), "leave line missing from console"
        dash.query_one("#console").refresh()

        console = dash.query_one("#console")
        print("10e layout live.x=%d console.x=%d" % (live.region.x, console.region.x))
        assert console.region.x > live.region.x, "console not on the right"
        assert console.region.width >= 40, console.region.width

        from tui import _os_clip_get, _os_clip_set
        clip_saved = _os_clip_get()
        await pilot.mouse_down(console, offset=(3, 2))
        await pilot.hover(console, offset=(45, 3))
        await pilot.pause(0.2)
        await pilot.mouse_up(console, offset=(45, 3))
        await pilot.pause(0.2)
        selected = app.screen.get_selected_text()
        joined = "\n".join(s.text for s in console.lines)
        print("10f selected:", repr(selected)[:80])
        assert selected and len(selected) > 10, f"no selection: {selected!r}"
        assert selected in joined, "selection not a precise slice of console"
        assert len(selected) < len(joined), "selection looks like select-all"
        await pilot.press("ctrl+c")
        await pilot.pause(0.2)
        assert app.clipboard == selected, "ctrl+c did not copy selection"
        assert _os_clip_get() == selected, "OS clipboard not written"
        okset = _os_clip_set("PASTE_OK_42")
        cmd.value = ""
        cmd.focus()
        await pilot.pause(0.1)
        await pilot.press("ctrl+v")
        await pilot.pause(0.2)
        print("10g paste ->", repr(cmd.value))
        if okset:
            assert cmd.value == "PASTE_OK_42", cmd.value
        app.screen.clear_selection()
        if clip_saved is not None:
            _os_clip_set(clip_saved)

        await pilot.click("#home")
        await pilot.pause()
        print("11 home again:", type(app.screen).__name__)
        assert type(app.screen).__name__ == "HomeScreen"

        await pilot.press("q")
        await pilot.pause()
    print("SMOKE OK")


asyncio.run(main())
