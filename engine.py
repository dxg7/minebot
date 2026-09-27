import asyncio
import json
import os
import time
import uuid as uuidlib

ROOT = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(ROOT, "engine", "bot.js")
ERR_LOG = os.path.join(ROOT, "data", "engine.log")


class BotProc:
    def __init__(self, entry, on_event):
        self.uuid = entry["uuid"]
        self.name = entry.get("name")
        self.token = entry.get("token")
        self.on_event = on_event
        self.proc = None
        self.state = "offline"
        self.task_state = "-"
        self.detail = ""
        self._read_task = None
        self._err_task = None

    async def start(self, server):
        if self.proc and self.proc.returncode is None:
            return
        self.state = "spawning"
        self.proc = await asyncio.create_subprocess_exec(
            "node", NODE,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=ROOT,
        )
        self._read_task = asyncio.create_task(self._read_stdout())
        self._err_task = asyncio.create_task(self._read_stderr())
        self.send({
            "cmd": "join",
            "server": server,
            "token": self.token,
            "name": self.name,
            "uuid": self.uuid,
        })

    async def _read_stdout(self):
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    break
                line = line.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                self._handle(msg)
                self.on_event(self.uuid, msg)
        except Exception:
            pass

    async def _read_stderr(self):
        try:
            os.makedirs(os.path.dirname(ERR_LOG), exist_ok=True)
            with open(ERR_LOG, "a", encoding="utf-8") as f:
                f.write(f"--- {self.name} {time.strftime('%H:%M:%S')} ---\n")
            while True:
                line = await self.proc.stderr.readline()
                if not line:
                    break
                with open(ERR_LOG, "a", encoding="utf-8") as f:
                    f.write(line.decode("utf-8", "replace"))
        except Exception:
            pass

    def _handle(self, msg):
        evt = msg.get("evt")
        if evt == "status":
            s = msg.get("state")
            self.state = s
            self.detail = msg.get("detail") or ""
            if s in ("online", "idle", "offline", "kicked", "token_dead", "error"):
                if s in ("online",):
                    self.task_state = "-"
        elif evt == "task":
            self.task_state = msg.get("state", "?")
            self.detail = msg.get("detail") or ""

    def send(self, msg):
        if not self.proc or self.proc.returncode is not None:
            return False
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode())
            asyncio.ensure_future(self.proc.stdin.drain())
            return True
        except Exception:
            return False

    async def stop(self):
        if self.proc and self.proc.returncode is None:
            self.send({"cmd": "leave"})
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.state = "offline"
        self.task_state = "-"


class Engine:
    def __init__(self, store, config, on_event=None):
        self.store = store
        self.config = config
        self.procs = {}
        self.on_event = on_event or (lambda u, m: None)
        self.logs = []
        self._task_waiters = {}

    def status_of(self, uuid):
        p = self.procs.get(uuid)
        if not p:
            entry = self._entry(uuid)
            return entry.get("status", "ready") if entry else "?"
        return p.state

    def task_of(self, uuid):
        p = self.procs.get(uuid)
        return p.task_state if p else "-"

    def detail_of(self, uuid):
        p = self.procs.get(uuid)
        return p.detail if p else ""

    def _entry(self, uuid):
        for b in self.store.bots:
            if b.get("uuid") == uuid:
                return b
        return None

    def _event(self, uuid, msg):
        if msg.get("evt") == "task" and msg.get("state") in ("done", "failed"):
            w = self._task_waiters.get(msg.get("id"))
            if w:
                w["pending"].discard(uuid)
                if not w["pending"]:
                    w["event"].set()
        if msg.get("evt") == "status":
            s = msg.get("state")
            if s == "token_dead":
                self.store.set_status(uuid, "expired")
            elif s == "online":
                self.store.set_status(uuid, "online")
            elif s in ("offline", "kicked"):
                self.store.set_status(uuid, "offline")
        if len(self.logs) > 200:
            self.logs = self.logs[-100:]
        self.logs.append((time.strftime("%H:%M:%S"), uuid[:8], msg))
        self.on_event(uuid, msg)

    async def join_all(self, delay=None):
        delay = self.config.join_delay if delay is None else delay
        tasks = []
        for b in self.store.bots:
            if b.get("status") == "expired":
                continue
            p = self.procs.get(b["uuid"])
            if not p:
                p = BotProc(b, self._event)
                self.procs[b["uuid"]] = p
            tasks.append((p, b))
        for i, (p, b) in enumerate(tasks):
            if i:
                await asyncio.sleep(delay)
            await p.start(self.config.server)

    async def join_one(self, uuid):
        b = self._entry(uuid)
        if not b:
            return False
        p = self.procs.get(uuid)
        if not p:
            p = BotProc(b, self._event)
            self.procs[uuid] = p
        await p.start(self.config.server)
        return True

    async def leave_all(self):
        for p in list(self.procs.values()):
            await p.stop()

    async def leave_one(self, uuid):
        p = self.procs.get(uuid)
        if p:
            await p.stop()

    async def rejoin_dead(self):
        for b in self.store.bots:
            if b.get("status") == "expired":
                continue
            st = self.status_of(b["uuid"])
            if st in ("offline", "kicked", "error", "idle", "ready"):
                await self.join_one(b["uuid"])

    def _targets(self, target):
        if target == "ALL":
            return [p for p in self.procs.values() if p.state == "online"]
        p = self.procs.get(target)
        return [p] if p and p.state == "online" else []

    def broadcast_chat(self, text, target="ALL"):
        sent = 0
        for p in self._targets(target):
            if p.send({"cmd": "chat", "text": text}):
                sent += 1
        return sent

    def broadcast_task(self, kind, args, target="ALL", sync=True):
        tid = uuidlib.uuid4().hex[:8]
        start_at = int((time.time() + 0.7) * 1000) if sync else None
        sent = 0
        for p in self._targets(target):
            msg = {"cmd": "task", "id": tid, "kind": kind, "args": args}
            if start_at:
                msg["startAt"] = start_at
            if p.send(msg):
                sent += 1
        return sent, tid

    def resolve_procs(self, sel, current_target="ALL"):
        store = self.store.bots

        def online_of(uuid):
            p = self.procs.get(uuid)
            return p if p and p.state == "online" else None

        if sel == "all":
            return [p for p in self.procs.values() if p.state == "online"]
        if sel == "sel":
            if current_target != "ALL":
                p = online_of(current_target)
                return [p] if p else []
            return [p for p in self.procs.values() if p.state == "online"]
        if sel.startswith("#"):
            out = []
            for piece in sel[1:].split(","):
                i = int(piece)
                if i < len(store):
                    p = online_of(store[i]["uuid"])
                    if p:
                        out.append(p)
            return out
        if sel.startswith("name:"):
            want = sel[5:]
            for b in store:
                if b.get("name") == want:
                    p = online_of(b["uuid"])
                    return [p] if p else []
            return []
        return []

    def _broadcast(self, procs, kind, args, sync=True, chat=False):
        tid = uuidlib.uuid4().hex[:8]
        start_at = int((time.time() + 0.7) * 1000) if sync and not chat else None
        pending = set()
        for p in procs:
            if chat:
                ok = p.send({"cmd": "chat", "text": args.get("text", "")})
            else:
                msg = {"cmd": "task", "id": tid, "kind": kind, "args": args}
                if start_at:
                    msg["startAt"] = start_at
                ok = p.send(msg)
            if ok:
                pending.add(p.uuid)
        return tid, pending

    @staticmethod
    def _chunk_slices(procs, args):
        cx = int(args["x"]) // 16 * 16
        cz = int(args["z"]) // 16 * 16
        layers = int(args.get("layers", 16))
        n = len(procs)
        out = []
        for i in range(n):
            x0 = cx + (16 * i) // n
            x1 = cx + (16 * (i + 1)) // n - 1
            if x1 < x0:
                x0 = x1 = cx + (i % 16)
            out.append({"x0": x0, "x1": x1, "z0": cz, "z1": cz + 15,
                        "layers": layers})
        return out

    def _broadcast_chunkmine(self, procs, args, sync=True):
        tid = uuidlib.uuid4().hex[:8]
        start_at = int((time.time() + 0.7) * 1000) if sync else None
        pending = set()
        for p, sl in zip(procs, self._chunk_slices(procs, args)):
            msg = {"cmd": "task", "id": tid, "kind": "chunkmine", "args": sl}
            if start_at:
                msg["startAt"] = start_at
            if p.send(msg):
                pending.add(p.uuid)
        return tid, pending

    async def run_sequence(self, steps, current_target="ALL", on_progress=None,
                           step_timeout=25.0, sync=True):
        from script import NON_BLOCKING, TIMEOUTS
        results = []
        total = len(steps)
        for i, step in enumerate(steps, 1):
            if on_progress:
                on_progress(i, total, "run")
            if "wait" in step:
                await asyncio.sleep(step["wait"])
                results.append(f"{i}/{total} waited {step['wait']}s")
                continue
            procs = self.resolve_procs(step.get("sel", "sel"), current_target)
            kind = step["kind"]
            args = step["args"]
            if not procs:
                results.append(f"{i}/{total} {kind}: no online targets")
                if on_progress:
                    on_progress(i, total, "no targets")
                continue
            chat = kind == "chat"
            if kind == "chunkmine":
                tid, pending = self._broadcast_chunkmine(procs, args, sync=sync)
            else:
                tid, pending = self._broadcast(procs, kind, args, sync=sync, chat=chat)
            if not pending:
                results.append(f"{i}/{total} {kind}: send failed")
                continue
            if kind in NON_BLOCKING:
                results.append(f"{i}/{total} {kind} -> {len(pending)} bot(s)")
                if on_progress:
                    on_progress(i, total, f"sent to {len(pending)}")
                continue
            ev = asyncio.Event()
            self._task_waiters[tid] = {"pending": pending, "event": ev}
            sent_count = len(pending)
            timeout = max(step_timeout, TIMEOUTS.get(kind, 0.0))
            try:
                await asyncio.wait_for(ev.wait(), timeout=timeout)
                results.append(f"{i}/{total} {kind} done x{sent_count}")
            except asyncio.TimeoutError:
                results.append(f"{i}/{total} {kind} TIMEOUT after {timeout:g}s")
            finally:
                self._task_waiters.pop(tid, None)
        return results

    async def shutdown(self):
        await self.leave_all()
