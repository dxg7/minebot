import asyncio
import time

from engine import Engine, BotProc
import script as script_mod


class FakeStore:
    def __init__(self, n):
        self.bots = [
            {"uuid": f"u{i}", "name": f"Bot{i}", "token": "x", "status": "ready"}
            for i in range(n)
        ]

    def set_status(self, u, s):
        pass


class FakeProc(BotProc):
    def __init__(self, entry, on_event, delay=0.05, reply=True):
        super().__init__(entry, on_event)
        self.state = "online"
        self.delay = delay
        self.reply = reply
        self.sent = []

    def send(self, msg):
        self.sent.append(msg)
        if msg.get("cmd") == "task" and self.reply:
            asyncio.get_event_loop().call_later(
                self.delay, lambda: self._finish(msg))
        return True

    def _finish(self, msg):
        evt = {"evt": "task", "id": msg["id"], "state": "done", "detail": "x"}
        self._handle(evt)
        self.on_event(self.uuid, evt)


async def main():
    store = FakeStore(3)
    eng = Engine(store, None)
    for i in range(3):
        eng.procs[f"u{i}"] = FakeProc(store.bots[i], eng._event)

    raw = ("all move forward 2; #0,1 look 90; wait 0.2; name:Bot2 say hi; "
           "all follow Bob; all stop")
    steps = script_mod.parse(raw, 3)
    assert len(steps) == 6, len(steps)

    prog = []
    t0 = time.time()
    results = await eng.run_sequence(
        steps, current_target="ALL",
        on_progress=lambda i, t, n: prog.append((i, t, n)),
        step_timeout=2.0)
    dt = time.time() - t0

    print("results:")
    for r in results:
        print("  ", r)
    print("progress:", prog)
    print("elapsed %.2fs" % dt)

    # order: every blocking step waited for done, wait slept, non-blocking moved on
    assert "1/6 move done x3" in results[0], results[0]
    assert "2/6 look done x2" in results[1], results[1]
    assert "waited" in results[2], results[2]
    assert "3/6" not in results[3] and "chat" in results[3], results[3]
    assert "follow" in results[4] and "TIMEOUT" not in results[4], results[4]
    assert "stop" in results[5] and "done" in results[5], results[5]
    assert dt >= 0.2, dt  # wait really waited
    assert len(prog) >= 6, prog

    # selectors routed correctly
    move_ids = [m["id"] for m in eng.procs["u0"].sent if m.get("cmd") == "task"]
    look_msgs = [m for m in eng.procs["u2"].sent if m.get("cmd") == "task"]
    say_u2 = [m for m in eng.procs["u2"].sent if m.get("cmd") == "chat"]
    say_u0 = [m for m in eng.procs["u0"].sent if m.get("cmd") == "chat"]
    assert len(say_u2) == 1 and not say_u0, (say_u2, say_u0)
    assert len(move_ids) >= 3  # move, follow, stop

    # timeout path: bot never answers
    slow = Engine(store, None)
    slow.procs["u0"] = FakeProc(store.bots[0], slow._event, reply=False)
    r = await slow.run_sequence(
        [{"sel": "all", "kind": "jump", "args": {}}],
        current_target="ALL", step_timeout=0.3)
    assert "TIMEOUT" in r[0], r

    # no targets: nobody online
    dead = Engine(store, None)
    dead.procs["u0"] = FakeProc(store.bots[0], dead._event)
    dead.procs["u0"].state = "offline"
    r = await dead.run_sequence(
        [{"sel": "name:Bot0", "kind": "jump", "args": {}}],
        current_target="ALL", step_timeout=0.3)
    assert "no online targets" in r[0], r

    print("ENGINE SEQUENCE OK")


asyncio.run(main())
