import asyncio

from engine import Engine, BotProc
from tui import DashboardScreen
from script import parse, ScriptError, BLOCKING, NON_BLOCKING, TIMEOUTS, PREP_STEPS


class FakeStore:
    def __init__(self, n):
        self.bots = [
            {"uuid": f"u{i}", "name": f"Bot{i}", "token": "x", "status": "ready"}
            for i in range(n)
        ]

    def set_status(self, u, s):
        pass


class FakeProc(BotProc):
    def __init__(self, entry, on_event, reply=True):
        super().__init__(entry, on_event)
        self.state = "online"
        self.reply = reply
        self.sent = []

    def send(self, msg):
        self.sent.append(msg)
        if msg.get("cmd") == "task" and self.reply:
            asyncio.get_event_loop().call_later(0.05, lambda: self._finish(msg))
        return True

    def _finish(self, msg):
        evt = {"evt": "task", "id": msg["id"], "state": "done", "detail": "x"}
        self._handle(evt)
        self.on_event(self.uuid, evt)


def expect_error(text, roster=3, frag=""):
    try:
        parse(text, roster)
    except ScriptError as e:
        if frag:
            assert frag in str(e), (text, str(e))
        return
    raise AssertionError("no error: " + text)


def test_parse():
    s = parse("all tpa Bob; tpaccept", 3)
    assert len(s) == 2, s
    assert s[0] == {"sel": "all", "kind": "tpa", "args": {"player": "Bob"}}, s[0]
    assert s[1]["kind"] == "tpaccept" and s[1]["args"] == {}, s[1]

    s = parse("gather wood; gather cobble 30", 1)
    assert s[0]["args"] == {"what": "wood", "count": 8}, s[0]
    assert s[1]["args"] == {"what": "cobble", "count": 30}, s[1]
    s = parse("gather logs", 1)
    assert s[0]["args"]["what"] == "wood", s

    s = parse("craft planks; craft sticks; craft table; craft woodpick; craft stonepick", 1)
    kinds = [st["args"]["what"] for st in s]
    assert kinds == ["planks", "sticks", "table", "woodpick", "stonepick"], kinds

    s = parse("chunkmine 100 -300", 1)
    assert s[0]["args"] == {"x": 100, "z": -300, "layers": 16}, s[0]
    s = parse("chunkmine 100 -300 8", 1)
    assert s[0]["args"]["layers"] == 8, s[0]

    s = parse("all prep", 4)
    assert len(s) == len(PREP_STEPS) == 4, s
    assert all(st["sel"] == "all" for st in s), s
    assert [st["kind"] for st in s] == ["gather", "craft", "gather", "craft"], s
    assert s[1]["args"] == {"what": "woodpick"}, s[1]

    expect_error("tpa", frag="tpa <player>")
    expect_error("gather dirt", frag="gather wood|cobble")
    expect_error("gather wood 0", frag="1-256")
    expect_error("craft banana", frag="craft planks")
    expect_error("chunkmine 100", frag="chunkmine <x> <z>")
    expect_error("chunkmine 100 -300 99", frag="1-64")

    assert "gather" in BLOCKING and "craft" in BLOCKING
    assert "chunkmine" in BLOCKING
    assert "tpa" in NON_BLOCKING and "tpaccept" in NON_BLOCKING
    assert TIMEOUTS["chunkmine"] >= 600 and TIMEOUTS["gather"] > 60
    print("PARSE OK")


def test_slices():
    for n in (1, 2, 3, 4, 7, 15, 16):
        sl = Engine._chunk_slices([None] * n, {"x": 100, "z": -300, "layers": 16})
        assert len(sl) == n
        covered = set()
        for s in sl:
            assert s["z0"] == -304 and s["z1"] == -289, s
            assert s["layers"] == 16
            for x in range(s["x0"], s["x1"] + 1):
                assert x not in covered, (n, x, covered)
                covered.add(x)
        assert covered == set(range(96, 112)), (n, covered)

    for n in (17, 20, 33):
        sl = Engine._chunk_slices([None] * n, {"x": 100, "z": -300, "layers": 16})
        covered = set()
        for s in sl:
            covered.update(range(s["x0"], s["x1"] + 1))
        assert covered == set(range(96, 112)), (n, covered)

    sl = Engine._chunk_slices([None] * 4, {"x": -1, "z": -1, "layers": 8})
    cx = -1 // 16 * 16
    assert sl[0]["x0"] == cx and sl[0]["x1"] == cx + 3, sl[0]
    assert all(s["layers"] == 8 for s in sl)
    print("SLICES OK")


async def main():
    store = FakeStore(4)
    eng = Engine(store, None)
    for i in range(4):
        eng.procs[f"u{i}"] = FakeProc(store.bots[i], eng._event)

    steps = parse("all chunkmine 100 -300 16", 4)
    results = await eng.run_sequence(
        steps, current_target="ALL", step_timeout=2.0)
    print("chunkmine results:", results)
    assert "chunkmine done x4" in results[0], results[0]

    ids = set()
    boxes = []
    for i in range(4):
        msgs = [m for m in eng.procs[f"u{i}"].sent if m.get("cmd") == "task"]
        assert len(msgs) == 1, msgs
        m = msgs[0]
        assert m["kind"] == "chunkmine" and "startAt" in m, m
        ids.add(m["id"])
        boxes.append((m["args"]["x0"], m["args"]["x1"]))
    assert len(ids) == 1, ids  # one barrier across all slices
    covered = set()
    for x0, x1 in boxes:
        covered.update(range(x0, x1 + 1))
    assert covered == set(range(96, 112)), boxes
    print("broadcast boxes:", boxes)

    # tpa is non-blocking even when bots never reply
    quiet = Engine(store, None)
    for i in range(4):
        quiet.procs[f"u{i}"] = FakeProc(store.bots[i], quiet._event, reply=False)
    t0 = asyncio.get_event_loop().time()
    results = await quiet.run_sequence(
        parse("all tpa Bob", 4), current_target="ALL", step_timeout=5.0)
    dt = asyncio.get_event_loop().time() - t0
    print("tpa results:", results, "dt %.2f" % dt)
    assert "tpa -> 4 bot(s)" in results[0], results[0]
    assert dt < 1.0, dt

    # craft/gather blocking waits honor the extended timeout table
    fast = Engine(store, None)
    fast.procs["u0"] = FakeProc(store.bots[0], fast._event, reply=False)
    TIMEOUTS["gather"] = 0.3
    try:
        results = await fast.run_sequence(
            [{"sel": "all", "kind": "gather", "args": {"what": "wood", "count": 8}}],
            current_target="ALL", step_timeout=0.1)
    finally:
        TIMEOUTS["gather"] = 300.0
    assert "gather TIMEOUT after 0.3s" in results[0], results[0]

    # TUI routes bare new-style heads through the script path
    dash = DashboardScreen
    for head in ("all tpa Bob", "gather wood", "prep", "chunkmine 1 2",
                 "tpaccept", "craft stonepick", "#0 gather cobble"):
        assert dash._looks_like_script(None, head), head
    for head in ("wander", "move", "mine"):
        assert not dash._looks_like_script(None, head), head
    assert dash._looks_like_script(None, "mine 3; wait 1")

    print("ENGINE + TUI OK")


test_parse()
test_slices()
asyncio.run(main())
