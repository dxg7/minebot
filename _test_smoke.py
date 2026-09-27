import asyncio

from textual.widgets import Input, Label, Static
from tui import VeilBotApp, DashboardScreen, HomeScreen, AddBotScreen, SetupScreen


async def main():
    app = VeilBotApp()
    async with app.run_test(size=(110, 32)) as pilot:
        await pilot.pause()
        assert isinstance(app.screen, HomeScreen)
        await pilot.click("#add")
        await pilot.pause()
        assert isinstance(app.screen, AddBotScreen), type(app.screen)
        await pilot.click("#back")
        await pilot.pause()
        assert isinstance(app.screen, HomeScreen), type(app.screen)

        await pilot.click("#ready")
        await pilot.pause()
        assert isinstance(app.screen, SetupScreen), type(app.screen)

        scr_ok = True
        await pilot.click("#go")
        await pilot.pause()
        scr = app.screen
        assert isinstance(scr, DashboardScreen), type(scr)

        cmd = scr.query_one("#cmd", Input)
        hint = scr.query_one("#enginehint", Static)

        # say button
        cmd.value = "hello"
        await pilot.click("#say")
        await pilot.pause()
        assert "sent to" in str(hint.content), hint.content

        # single task (fast path)
        cmd.value = "look 90"
        await pilot.click("#task")
        await pilot.pause()
        assert "task look" in str(hint.content), hint.content
        print("single task:", hint.content)

        # target cycle
        await pilot.click("#target")
        await pilot.pause()
        title = str(scr.query_one("#title", Label).content)
        assert "target:" in title
        await pilot.click("#target")
        await pilot.pause()

        # script via enter
        cmd.value = "all move forward 2; wait 0.1; all stop"
        await pilot.click("#cmd")
        await pilot.press("enter")
        done = False
        for _ in range(30):
            await pilot.pause(0.1)
            h = str(hint.content)
            if h.startswith("script done") or h.startswith("script issue"):
                done = True
                break
        assert done, hint.content
        print("script:", hint.content)

        # home skips setup
        await pilot.click("#home")
        await pilot.pause()
        assert isinstance(app.screen, HomeScreen), type(app.screen)

    print("FULL SMOKE OK")


asyncio.run(main())
