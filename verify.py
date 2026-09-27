import json
import time
import urllib.request
import urllib.error

PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile"
ENTITLE_URL = "https://api.minecraftservices.com/entitlements/mcstore"


def _get(url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "User-Agent": "Minecraft/1.20.6",
    })
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def decode_claims(token):
    parts = token.split(".")
    if len(parts) != 3:
        return None
    pad = parts[1].replace("-", "+").replace("_", "/")
    pad += "=" * (-len(pad) % 4)
    try:
        return json.loads(__import__("base64").b64decode(pad))
    except Exception:
        return None


def verify(token):
    """Returns dict status: ok / expired / no_profile / invalid."""
    claims = decode_claims(token)
    if claims is None:
        return {"status": "invalid", "detail": "not a jwt"}

    now = time.time()
    exp = claims.get("exp", 0)
    if exp and now >= exp:
        return {"status": "expired", "detail": "token expired", "claims": claims}

    try:
        prof = _get(PROFILE_URL, token)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return {"status": "expired", "detail": "mojang rejected token", "claims": claims}
        if e.code == 404:
            return {"status": "no_profile", "detail": "account owns no minecraft", "claims": claims}
        return {"status": "invalid", "detail": f"http {e.code}", "claims": claims}
    except Exception as e:
        return {"status": "invalid", "detail": str(e), "claims": claims}

    try:
        ent = _get(ENTITLE_URL, token)
        owns = bool(ent.get("items"))
    except Exception:
        owns = None

    exp_in = int(exp - now) if exp else None
    return {
        "status": "ok",
        "name": prof.get("name"),
        "uuid": prof.get("id"),
        "owns_game": owns,
        "expires_in": exp_in,
        "xuid": claims.get("xuid"),
        "claims": claims,
    }


if __name__ == "__main__":
    import sys
    tok = sys.argv[1] if len(sys.argv) > 1 else input("token: ").strip()
    print(json.dumps(verify(tok), indent=2))
