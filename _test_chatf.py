import asyncio

from textual.widgets import Button, Static
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
        btn = scr.query_one("#chatf", Button)
        hint = scr.query_one("#enginehint", Static)

        # default: filtered (hidden)
        assert "chat: hidden" in str(btn.label), btn.label
        assert app.engine.chat_filter is True
        print("default ok:", btn.label)

        # click -> shown (wait out button's -active debounce between clicks)
        await pilot.click("#chatf")
        await pilot.pause(0.3)
        assert "chat: shown" in str(btn.label), btn.label
        assert app.engine.chat_filter is False
        assert "chat shown" in str(hint.content), hint.content
        assert any("== chat shown" in l for l in app.console_lines), app.console_lines[-3:]
        print("show ok:", btn.label, "|", str(hint.content))

        # click -> hidden again
        await pilot.click("#chatf")
        await pilot.pause(0.3)
        assert "chat: hidden" in str(btn.label), btn.label
        assert app.engine.chat_filter is True
        assert "chat hidden" in str(hint.content), hint.content
        assert any("== chat hidden" in l for l in app.console_lines), app.console_lines[-3:]
        print("hide ok:", btn.label, "|", str(hint.content))

        # works again after two label swaps
        await pilot.click("#chatf")
        await pilot.pause(0.3)
        assert "chat: shown" in str(btn.label), btn.label
        assert app.engine.chat_filter is False
        print("3rd click ok:", btn.label)

    print("CHATF OK")


asyncio.run(main())
