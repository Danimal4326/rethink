#!/usr/bin/env python3
"""Correlate byte/bit changes in the appliance's own status frames against LG cloud field changes.

Each 0xEC status frame carries two stacked records: the previous state (record A) and the current
state (record B). Diffing them inside a single frame isolates exactly what that one transition
changed, with no cross-frame alignment guesswork. Pairing that with the cloud notification that
follows within a couple of seconds gives an authoritative label for the changed bits.

Usage: python3 scratch/bitdiff.py captures/dryer-session.jsonl [record_a_off record_b_off]
"""
import json
import sys
import collections

path = sys.argv[1]
REC_A = int(sys.argv[2]) if len(sys.argv) > 2 else 3
REC_B = int(sys.argv[3]) if len(sys.argv) > 3 else 32

events = [json.loads(l) for l in open(path) if l.strip()]
t0 = events[0]["ts"]


def flatten(o, out=None, prefix=""):
    """Pull the washerDryer leaf fields out of the nested cloud notification."""
    if out is None:
        out = {}
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, (dict, list)):
                flatten(v, out, k)
            else:
                out[k] = v
    return out


# Cloud notifications, in time order, reduced to their washerDryer leaves.
cloud = []
for e in events:
    if e.get("k") == "cloud" and e.get("state"):
        cloud.append((e["ts"], flatten(e["state"])))

# Track which cloud fields actually changed at each notification.
cloud_changes = []
prev = {}
for ts, fields in cloud:
    changed = {k: v for k, v in fields.items() if prev.get(k) != v}
    # meta/housekeeping fields carry no appliance meaning
    for noise in ("messageId", "timestamp", "mid", "allDeviceInfoUpdate", "online", "countryCode", "deviceType"):
        changed.pop(noise, None)
    if changed:
        cloud_changes.append((ts, changed))
    prev.update(fields)

# field name -> Counter of "byte[i] bit 0xNN" evidence
evidence = collections.defaultdict(collections.Counter)
field_seen = collections.Counter()

print(f"{'time':>9}  {'byte diffs (recA -> recB)':<52}  cloud fields changed")
print("-" * 130)

for e in events:
    if e.get("k") != "wire" or e.get("dir") != "fromDevice" or not e.get("hex"):
        continue
    raw = bytes.fromhex(e["hex"])
    if len(raw) < 4 or raw[0] != 0xAA or raw[-1] != 0xBB:
        continue
    body = raw[2:-2]
    if len(body) != 60 or body[1] != 0xEC:
        continue

    a = body[REC_A:REC_B]
    b = body[REC_B:]
    n = min(len(a), len(b))

    diffs = []
    bits = []
    for i in range(n):
        if a[i] != b[i]:
            diffs.append(f"[{i}] {a[i]:02x}->{b[i]:02x}")
            x = a[i] ^ b[i]
            # decompose into individual bits so a multi-bit byte still yields per-bit evidence
            for bit in range(8):
                m = 1 << bit
                if x & m:
                    bits.append(f"byte[{i}] bit 0x{m:02x}")

    # the cloud notification that lands within 3s after this frame
    lbl = {}
    for ts, changed in cloud_changes:
        if 0 <= (ts - e["ts"]) <= 3000:
            lbl.update(changed)

    if not diffs and not lbl:
        continue

    print(f"{(e['ts']-t0)/1000:>8.1f}s  {', '.join(diffs)[:52]:<52}  {json.dumps(lbl)[:70]}")

    # Only single-field, single-bit transitions are clean enough to be evidence.
    for fname in lbl:
        field_seen[fname] += 1
        if len(lbl) == 1:
            for bmark in bits:
                evidence[fname][bmark] += 1

print()
print("=" * 130)
print("EVIDENCE: cloud field -> byte/bit that changed with it (clean single-field transitions only)")
print("=" * 130)
for fname in sorted(evidence):
    tops = evidence[fname].most_common(4)
    if not tops:
        continue
    detail = "  ".join(f"{m} x{c}" for m, c in tops)
    print(f"  {fname:<28} {detail}")

unexplained = [f for f in field_seen if f not in evidence or not evidence[f]]
if unexplained:
    print()
    print("  fields seen but never isolated to a bit (always changed alongside something else):")
    for f in sorted(unexplained):
        print(f"    {f} (seen {field_seen[f]}x)")
