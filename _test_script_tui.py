import asyncio

from textual.widgets import Input, Static
from tui import VeilBotApp, DashboardScreen


async def main():
    app = VeilBotApp()
    async with app.run_test(size=(110, 32)) as pilot:
        await pilot.pause()
        await pilot.click("#ready")
        await pilot.pause()
        await pilot.click("#go")
        await pilot.pause()
        scr = app.screen
        assert isinstance(scr, DashboardScreen), type(scr)
        cmd = scr.query_one("#cmd", Input)
        hint = scr.query_one("#enginehint", Static)

        # 1. help
        cmd.value = "help"
        scr.run_task()
        await pilot.pause()
        assert "sel:" in str(hint.content), hint.content
        print("help ok:", str(hint.content)[:60])

        # 2. script error
        cmd.value = "all bogus"
        scr.run_task()
        await pilot.pause()
        assert "script error" in str(hint.content), hint.content
        print("error ok:", hint.content)

        # 3. bad bot index
        cmd.value = "#99 move forward 1"
        scr.run_task()
        await pilot.pause()
        assert "does not exist" in str(hint.content), hint.content
        print("index ok:", hint.content)

        # 4. real script via ENTER key (enter-to-run)
        cmd.value = "all move forward 1; wait 0.1; #0 say hi; all stop"
        await pilot.click("#cmd")
        await pilot.press("enter")
        for _ in range(20):
            await pilot.pause(0.1)
            h = str(hint.content)
            if h.startswith("script done") or h.startswith("script issue"):
                break
        h = str(hint.content)
        assert h.startswith("script"), h
        print("enter-run final hint:", h)

        # 5. plain single command still uses fast path
        cmd.value = "stop"
        scr.run_task()
        await pilot.pause()
        assert "task stop" in str(hint.content), hint.content
        print("single cmd ok:", hint.content)

        # 6. single selector command goes through sequence
        cmd.value = "all stop"
        scr.run_task()
        for _ in range(10):
            await pilot.pause(0.1)
            h = str(hint.content)
            if h.startswith("script"):
                break
        print("selector path:", h)
        assert h.startswith("script"), h

    print("TUI SCRIPT OK")


asyncio.run(main())
