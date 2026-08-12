#!/usr/bin/env python3
"""Print the full wire hex of status frames near given capture-relative timestamps.

Used to lift real frames out of a capture and paste them into a test as fixtures.

Usage: python3 scratch/pickframes.py <capture.jsonl> <seconds> [<seconds> ...]
"""
import json
import sys

path = sys.argv[1]
wants = [float(x) for x in sys.argv[2:]]
events = [json.loads(l) for l in open(path) if l.strip()]
t0 = events[0]["ts"]

frames = []
for e in events:
    if e.get("k") != "wire" or e.get("dir") != "fromDevice" or not e.get("hex"):
        continue
    frames.append(((e["ts"] - t0) / 1000, e["hex"]))

for w in wants:
    best = min(frames, key=lambda f: abs(f[0] - w))
    raw = bytes.fromhex(best[1])
    body = raw[2:-2]
    note = ""
    if len(body) == 60 and body[1] == 0xEC:
        a, b = body[3:32], body[32:]
        d = [f"[{i}] {a[i]:02x}->{b[i]:02x}" for i in range(min(len(a), len(b))) if a[i] != b[i]]
        note = ", ".join(d)
    print(f"# t={best[0]:.1f}s  {note}")
    print(f"{best[1]}")
    print()
