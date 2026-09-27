import asyncio
import os
import sys
import time

import verify as V
from store import BotStore, Config
from engine import Engine
from script import parse, TIMEOUTS

SERVER = "stablesmp.xyz"
TOKEN = os.environ.get("MT", "").strip()


async def main():
    if not TOKEN:
        print("no MT env var")
        return 1
    v = V.verify(TOKEN)
    print("verify:", {k: v.get(k) for k in
                      ("status", "name", "uuid", "owns_game", "expires_in", "detail")})
    if v.get("status") != "ok":
        return 1

    store = BotStore()
    entry = store.add(TOKEN, v)
    print("bot:", entry["name"], entry["uuid"])

    config = Config()
    config.server = SERVER
    config.join_delay = 5.0
    config.save()
    print("config server =", config.server)

    def on_event(uuid, msg):
        e = msg.get("evt")
        if e == "status":
            print(f"  [{uuid[:8]}] status {msg.get('state')}: {msg.get('detail')}")
        elif e == "task":
            print(f"  [{uuid[:8]}] task {msg.get('state')}: {msg.get('detail')}")
        elif e == "chat":
            print(f"  [{uuid[:8]}] chat <{msg.get('from')}> {msg.get('message')}")
        elif e == "log":
            print(f"  [{uuid[:8]}] log {msg.get('msg')}")

    eng = Engine(store, config, on_event=on_event)
    await eng.join_all()

    p = eng.procs[entry["uuid"]]
    t0 = time.time()
    while time.time() - t0 < 45:
        if p.state in ("online", "kicked", "error", "token_dead", "offline"):
            break
        await asyncio.sleep(0.5)
    print("join state:", p.state, "after %.1fs" % (time.time() - t0))
    if p.state != "online":
        await eng.shutdown()
        return 2

    TIMEOUTS["gather"] = 60
    steps = parse("all look 0 0; wait 1; gather wood 3", 1)
    t1 = time.time()
    results = await eng.run_sequence(steps, current_target="ALL", step_timeout=25.0)
    print("results:", results)
    print("tasks took %.1fs" % (time.time() - t1))

    await eng.shutdown()
    print("left server, bye")
    v2 = V.verify(TOKEN)
    print("token AFTER run:", v2.get("status"), v2.get("detail"))
    return 0


sys.exit(asyncio.run(main()))
