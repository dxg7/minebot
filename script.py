class ScriptError(Exception):
    pass


BLOCKING = {
    "move", "look", "jump", "rclick", "lclick", "swing",
    "sneak", "sprint", "drop", "mine", "goto", "stop",
    "gather", "craft", "chunkmine", "near", "silent", "defy", "beat",
    "inv",
}
NON_BLOCKING = {"chat", "follow", "wander", "tpa", "tpaccept"}

TIMEOUTS = {"chunkmine": 3600.0, "gather": 300.0, "craft": 90.0, "mine": 300.0}

PREP_STEPS = [
    ("gather", {"what": "wood", "count": 10}),
    ("craft", {"what": "woodpick"}),
    ("gather", {"what": "cobble", "count": 12}),
    ("craft", {"what": "stonepick"}),
]


def _num(tok, what, where):
    try:
        return float(tok)
    except ValueError:
        raise ScriptError(f"{where}: {what} must be a number, got '{tok}'")


def _int(tok, what, where):
    try:
        return int(tok)
    except ValueError:
        raise ScriptError(f"{where}: {what} must be a whole number, got '{tok}'")


def _parse_action(kind, rest, where):
    if kind == "move":
        d = rest[0].lower() if rest else "forward"
        if d not in ("forward", "back", "left", "right"):
            raise ScriptError(f"{where}: move dir = forward|back|left|right")
        n = _num(rest[1], "blocks", where) if len(rest) > 1 else 1.0
        if n <= 0 or n > 64:
            raise ScriptError(f"{where}: blocks must be 1-64")
        return {"dir": d, "blocks": n}
    if kind == "look":
        if not rest:
            raise ScriptError(f"{where}: look <yaw> [pitch]  (degrees)")
        yaw = _num(rest[0], "yaw", where)
        pitch = _num(rest[1], "pitch", where) if len(rest) > 1 else 0.0
        return {"yaw": yaw, "pitch": pitch}
    if kind in ("sneak", "sprint"):
        on = True
        if rest:
            if rest[0].lower() not in ("on", "off"):
                raise ScriptError(f"{where}: {kind} on|off")
            on = rest[0].lower() == "on"
        return {"on": on}
    if kind in ("rclick", "lclick"):
        if len(rest) > 1:
            raise ScriptError(f"{where}: {kind} [player]")
        return {"player": rest[0]} if rest else {}
    if kind in ("jump", "swing", "drop", "stop", "inv"):
        return {}
    if kind == "near":
        r = _num(rest[0], "view radius", where) if rest else 48.0
        if r < 4 or r > 128:
            raise ScriptError(f"{where}: view radius must be 4-128")
        return {"radius": r}
    if kind == "silent":
        s = _num(rest[0], "seconds", where) if rest else 15.0
        if s < 0 or s > 300:
            raise ScriptError(f"{where}: silent seconds must be 0-300")
        return {"s": s}
    if kind == "defy":
        s = _num(rest[0], "seconds", where) if rest else 30.0
        if s < 0 or s > 300:
            raise ScriptError(f"{where}: defy seconds must be 0-300")
        return {"s": s}
    if kind == "beat":
        s = _num(rest[0], "seconds", where) if rest else 60.0
        if s < 0 or s > 300:
            raise ScriptError(f"{where}: beat seconds must be 0-300")
        return {"s": s}
    if kind == "chat":
        text = " ".join(rest)
        if not text:
            raise ScriptError(f"{where}: say <text>")
        return {"text": text}
    if kind == "cmd":
        text = " ".join(rest)
        if not text:
            raise ScriptError(f"{where}: cmd <command>  (e.g. cmd /home)")
        if not text.startswith("/"):
            text = "/" + text
        return {"text": text}
    if kind == "goto":
        if len(rest) == 3:
            def _axis(tok, what):
                # minecraft-style ~ / ~2 = bot-relative, resolved in taskGoto
                if tok.startswith("~"):
                    if tok != "~":
                        _num(tok[1:], what + " offset", where)
                    return tok
                return _num(tok, what, where)
            return {
                "x": _axis(rest[0], "x"),
                "y": _axis(rest[1], "y"),
                "z": _axis(rest[2], "z"),
            }
        if len(rest) == 1:
            return {"player": rest[0]}
        raise ScriptError(f"{where}: goto <x y z> or goto <player>")
    if kind == "follow":
        if not rest:
            raise ScriptError(f"{where}: follow <player>")
        return {"player": rest[0]}
    if kind == "wander":
        return {"radius": _num(rest[0], "radius", where) if rest else 24.0}
    if kind == "mine":
        r = _num(rest[0], "radius", where) if rest else 3.0
        l = _num(rest[1], "layers", where) if len(rest) > 1 else 1.0
        return {"radius": r, "layers": l}
    if kind == "tpa":
        if not rest:
            raise ScriptError(f"{where}: tpa <player>")
        return {"player": rest[0]}
    if kind == "tpaccept":
        return {}
    if kind == "gather":
        w = rest[0].lower() if rest else ""
        if w in ("wood", "logs", "log", "tree"):
            w = "wood"
        elif w in ("cobble", "cobbles", "stone", "rock"):
            w = "cobble"
        else:
            raise ScriptError(f"{where}: gather wood|cobble [count]")
        n = _int(rest[1], "count", where) if len(rest) > 1 else (8 if w == "wood" else 12)
        if n < 1 or n > 256:
            raise ScriptError(f"{where}: count must be 1-256")
        return {"what": w, "count": n}
    if kind == "craft":
        w = rest[0].lower() if rest else ""
        w = {
            "planks": "planks", "stick": "sticks", "sticks": "sticks",
            "table": "table", "crafting_table": "table",
            "woodpick": "woodpick", "wpick": "woodpick",
            "wooden_pickaxe": "woodpick",
            "stonepick": "stonepick", "spick": "stonepick",
            "stone_pickaxe": "stonepick",
        }.get(w)
        if not w:
            raise ScriptError(
                f"{where}: craft planks|sticks|table|woodpick|stonepick")
        return {"what": w}
    if kind == "chunkmine":
        if len(rest) < 2:
            raise ScriptError(f"{where}: chunkmine <x> <z> [layers]")
        x = _int(rest[0], "x", where)
        z = _int(rest[1], "z", where)
        layers = _int(rest[2], "layers", where) if len(rest) > 2 else 16
        if layers < 1 or layers > 64:
            raise ScriptError(f"{where}: layers must be 1-64")
        return {"x": x, "z": z, "layers": layers}
    raise ScriptError(f"{where}: unknown action '{kind}'")


ALIASES = {
    "rightclick": "rclick", "rc": "rclick",
    "leftclick": "lclick", "lc": "lclick",
    "say": "chat", "wait": "wait",
    "gotoplayer": "goto",
    "w": "wander", "m": "mine",
}


def parse(text, roster_len):
    steps = []
    target = "sel"
    stmts = [s.strip() for s in text.split(";")]
    for n, raw in enumerate(stmts, 1):
        if not raw:
            continue
        where = f"stmt {n}"
        parts = raw.split()
        head = parts[0]
        head_l = head.lower()
        sel_seen = False
        if head_l in ("all", "all:", "sel", "sel:", "me", "me:"):
            target = "all" if head_l.startswith("all") else "sel"
            sel_seen = True
        elif head.startswith("#"):
            idxs = []
            for piece in head[1:].split(","):
                idxs.append(_int(piece, "bot index", where))
            for i in idxs:
                if i < 0 or i >= roster_len:
                    raise ScriptError(
                        f"{where}: bot #{i} does not exist (roster has {roster_len})"
                    )
            target = "#" + ",".join(str(i) for i in idxs)
            sel_seen = True
        elif head_l.startswith("name:"):
            name = head[5:]
            if not name:
                raise ScriptError(f"{where}: name:<botname>")
            target = "name:" + name
            sel_seen = True

        rest = parts[1:] if sel_seen else parts
        if not rest:
            raise ScriptError(f"{where}: selector with no action")
        if rest[0].startswith("/"):
            # bare /command statement -> chat packet on the wire
            steps.append({"sel": target, "kind": "chat",
                          "args": {"text": " ".join(rest)}})
            continue
        kind = rest[0].lower()
        kind = ALIASES.get(kind, kind)

        if kind == "wait":
            sec = _num(rest[1], "seconds", where) if len(rest) > 1 else 1.0
            if sec < 0 or sec > 600:
                raise ScriptError(f"{where}: wait must be 0-600 sec")
            steps.append({"wait": sec})
            continue

        if kind == "prep":
            for pk, pa in PREP_STEPS:
                steps.append({"sel": target, "kind": pk, "args": dict(pa)})
            continue

        args = _parse_action(kind, rest[1:], where)
        if kind == "cmd":
            kind = "chat"
        if kind in BLOCKING or kind in NON_BLOCKING:
            steps.append({"sel": target, "kind": kind, "args": args})
        else:
            raise ScriptError(f"{where}: unknown action '{kind}'")
    if not steps:
        raise ScriptError("nothing to run")
    return steps


HELP = (
    "sel: all|sel|#0,2 | name:Bob  ;  act: move fwd 3 | look 90 -10 | rclick [Bob] | "
    "lclick [Bob] | near [48] | silent [15] | defy [30] | beat [60] | jump | sneak on | drop | say hi | wait 2 | "
    "goto 10 64 10 (or ~ ~2 ~5 relative) | "
    "follow Bob | wander 24 | mine 3 1 | stop | tpa Bob | tpaccept | "
    "gather wood 10 | craft woodpick | prep | chunkmine 100 -300 16 | "
    "cmd /home  (or bare /home)   (sep: ;)"
)
