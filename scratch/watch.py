#!/usr/bin/env python3
"""Interleaved wire-diff + cloud-label view of a live capture, from a given time offset.

Usage: python3 scratch/watch.py <capture.jsonl> [since_seconds]
"""
import json
import sys

path = sys.argv[1]
since = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0

events = [json.loads(l) for l in open(path) if l.strip()]
t0 = events[0]["ts"]
NOISE = ("messageId", "timestamp", "mid", "allDeviceInfoUpdate", "online", "countryCode", "deviceType", "deviceId")


def leaves(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, (dict, list)):
                leaves(v, out)
            else:
                out[k] = v
    return out


rows = []
prev = {}
for e in events:
    rel = (e["ts"] - t0) / 1000
    if e.get("k") == "cloud" and e.get("state"):
        f = leaves(e["state"], {})
        ch = {k: v for k, v in f.items() if prev.get(k) != v}
        for n in NOISE:
            ch.pop(n, None)
        prev.update(f)
        if ch and rel >= since:
            rows.append((rel, "CLOUD", json.dumps(ch)[:110]))
    elif e.get("k") == "wire" and e.get("dir") == "fromDevice" and e.get("hex"):
        raw = bytes.fromhex(e["hex"])
        if len(raw) < 4 or raw[0] != 0xAA:
            continue
        body = raw[2:-2]
        if rel < since:
            continue
        if len(body) == 60 and body[1] == 0xEC:
            a, b = body[3:32], body[32:]
            d = [f"[{i}] {a[i]:02x}->{b[i]:02x}" for i in range(min(len(a), len(b))) if a[i] != b[i]]
            rows.append((rel, "WIRE", ", ".join(d) if d else "(no record diff)"))
        elif len(body) == 31 and body[1] == 0xEB:
            rows.append((rel, "WIRE", f"0xEB single-record: {body[3:].hex()}"))
        else:
            rows.append((rel, "WIRE", f"type=0x{body[1]:02x} len={len(body)} {body.hex()[:60]}"))
    elif e.get("k") == "marker" and rel >= since:
        rows.append((rel, "MARK", e.get("phase", "")))

rows.sort(key=lambda r: r[0])
for rel, kind, text in rows:
    print(f"{rel:9.1f}s  {kind:5s}  {text}")
print(f"\n({len(rows)} rows since {since}s; capture has {len(events)} events)")
