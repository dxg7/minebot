# minebot setup (Windows)

1. Install Python 3.11+ from https://python.org (check "Add to PATH")
2. Install Node.js 18+ from https://nodejs.org
3. Unzip this folder anywhere, e.g. `C:\minebot`
4. Open PowerShell **inside the folder** and run:

```
pip install textual
npm install
```

5. Quick live test (replace TOKEN with a real access token):

```
$env:MT="TOKEN"; python _test_live.py
```

6. Real app:

```
python main.py
```

Notes:
- The tool stores tokens in `data/bots.json` (created on first add).
- Server is preconfigured to `stablesmp.xyz` in `data/config.json`.
- If joining fails with connection refused, the SRV/DNS fix is already
  built into `engine/bot.js` (auto-resolves mc.stablesmp.xyz:25565).
