import json
import os
import time

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
BOTS_FILE = os.path.join(DATA_DIR, "bots.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")


def _load(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


class BotStore:
    def __init__(self):
        self.bots = _load(BOTS_FILE, [])

    def add(self, token, verify_result):
        entry = {
            "name": verify_result.get("name"),
            "uuid": verify_result.get("uuid"),
            "token": token,
            "xuid": verify_result.get("xuid"),
            "added_at": int(time.time()),
            "status": "ready",
            "last_seen": None,
        }
        self.bots = [b for b in self.bots if b.get("uuid") != entry["uuid"]]
        self.bots.append(entry)
        self.save()
        return entry

    def remove(self, uuid):
        self.bots = [b for b in self.bots if b.get("uuid") != uuid]
        self.save()

    def set_status(self, uuid, status):
        for b in self.bots:
            if b.get("uuid") == uuid:
                b["status"] = status
                b["last_seen"] = int(time.time())
        self.save()

    def save(self):
        _save(BOTS_FILE, self.bots)


class Config:
    def __init__(self):
        d = _load(CONFIG_FILE, {})
        self.server = d.get("server", "")
        self.join_delay = d.get("join_delay", 5.0)

    def save(self):
        _save(CONFIG_FILE, {"server": self.server, "join_delay": self.join_delay})
