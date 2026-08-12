#!/usr/bin/env python3
"""Derive byte-value -> LG-cloud-label tables directly from a capture.

For each status frame we take the *current* record (record B) and pair the value at a chosen
offset with the cloud label reported closest after that frame. Only pairings that are always
consistent are printed as confirmed; anything ambiguous is flagged, so a lagging or coalesced
cloud notification can never quietly produce a wrong table entry.

Usage: python3 scratch/maptable.py <capture.jsonl>
"""
import json
import sys
import collections

path = sys.argv[1]
events = [json.loads(l) for l in open(path) if l.strip()]
t0 = events[0]["ts"]

# offset in record B -> cloud field it should correspond to
FIELDS = {
    6: "courseDryer27inchBase",
    8: "dryLevel",
    9: "temp",
    1: "state",
    23: "loadItem",
}


def leaves(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, (dict, list)):
                leaves(v, out)
            else:
                out[k] = v
    return out


# Build the running cloud picture at each point in time.
cloud_at = []
running = {}
for e in events:
    if e.get("k") == "cloud" and e.get("state"):
        running.update(leaves(e["state"], {}))
        cloud_at.append((e["ts"], dict(running)))

frames = []
for e in events:
    if e.get("k") != "wire" or e.get("dir") != "fromDevice" or not e.get("hex"):
        continue
    raw = bytes.fromhex(e["hex"])
    if len(raw) < 4 or raw[0] != 0xAA:
        continue
    body = raw[2:-2]
    if len(body) == 60 and body[1] == 0xEC:
        frames.append((e["ts"], body[32:]))
    elif len(body) == 31 and body[1] == 0xEB:
        frames.append((e["ts"], body[3:]))

for off, field in FIELDS.items():
    pairs = collections.defaultdict(collections.Counter)
    for ts, rec in frames:
        if off >= len(rec):
            continue
        val = rec[off]
        # the cloud snapshot immediately following this frame (within 4s)
        label = None
        for cts, snap in cloud_at:
            if 0 <= (cts - ts) <= 4000 and field in snap:
                label = snap[field]
                break
        if label is None:
            continue
        pairs[val][label] += 1

    print(f"\n=== record[{off}]  ->  cloud {field} ===")
    for val in sorted(pairs):
        counts = pairs[val].most_common()
        total = sum(c for _, c in counts)
        top, topn = counts[0]
        if len(counts) == 1:
            print(f"  0x{val:02x} = {top:<28} (n={topn})")
        else:
            others = ", ".join(f"{l}x{c}" for l, c in counts[1:])
            flag = "AMBIGUOUS" if topn < total * 0.8 else "dominant"
            print(f"  0x{val:02x} = {top:<28} (n={topn}/{total}, {flag}; also {others})")
