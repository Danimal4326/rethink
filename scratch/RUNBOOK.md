# Reverse-engineering session runbook

Two appliances to decode:

| Role   | modelId              | Device UUID                            |
| ------ | -------------------- | -------------------------------------- |
| Dryer  | `RV13B6ES_D_US_WIFI` | `a92b9d79-4b42-1484-93e1-44cb8b6dee6b` |
| Washer | `F3L7CYK5W_US_WIFI`  | `a833fae0-7080-11d3-acb1-7440be76225c` |

Working directory for every command below:

```
/Users/danc/Projects/rethink/.claude/worktrees/lg-driver-work
```

---

## Step 0 — one-time LG login (you run this, once)

The capture tool's cloud feed uses its own credential file, separate from the bridge's.
It has to be created interactively one time. In your terminal:

```
npx tsx tools/rethink-capture.ts --cloud --state state/oauth.json \
  192.168.0.150:44401 a92b9d79-4b42-1484-93e1-44cb8b6dee6b captures/login.jsonl
```

It asks for:

1. **Country code** — `US`
2. It prints a sign-in URL. Open it, log into your LG account, and when you land on a
   blank page, copy that final URL from the address bar and paste it back.

Once it prints `[cloud] ...connected`, press **Ctrl-C**. The token is now saved to
`state/oauth.json` and every later capture runs without prompting. `state/` is gitignored.

Verify it worked:

```
ls -l state/oauth.json
```

---

## Step 1 — dryer session

Tell me when you are at the dryer and I will start the capture in the background. Then work
through the list. **The single most important rule: change one thing at a time, and pause
5–10 seconds after each change** so its frame is unambiguous.

### 1a. Baseline

- Dryer powered **off**. Wait ~15 s.
- Press **Power**. Do not start anything. Wait ~15 s.

### 1b. Course sweep — nails down the course byte

Turn the dial one position at a time through **every** course, pausing 5–10 s at each.
Say the name of each as you go (or just tell me the order you went in). Also press the
**Time Dry** button if your unit has one — on the cousin model it shares the same byte
rather than being a dial position.

### 1c. Option isolation — nails down the two option bitfields

Return the dial to **Normal**. Now change exactly one setting, wait 5–10 s, then set it
back before moving to the next:

- **Dry Level** — step through all levels
- **Temperature** — step through all levels
- **Wrinkle Care** — on, then off
- **Energy Saver** — on, then off
- **Turbo Steam / Steam** — on, then off (if present)
- **Damp Dry Signal** — on, then off
- **Reduce Static** — on, then off
- **Child Lock** — on, then off

### 1d. A real cycle — nails down phases and the two timers

- Select a **short** cycle (Speed Dry, or Time Dry set to ~20 min) and press **Start**.
- Let it run. Around the middle: press **Pause**, wait ~15 s, press **Start** again.
- A minute later: **open the door**, wait ~15 s, **close it**, and resume.
- Let it run all the way to the end so I capture Drying → Cooling → End.

### 1e. Power off

- Press **Power** to turn it off. Wait ~15 s. Tell me you are done.

---

## Step 2 — washer session

Same shape, against UUID `a833fae0-7080-11d3-acb1-7440be76225c`. Variables to isolate one
at a time: course dial sweep, Soil level, Spin, Temperature, Extra Rinse (0→3), Pre-Wash,
Steam, Cold Wash, TurboWash, Delay Wash, plus door open/close and the door lock during a
run. Finish with one **Speed Wash** run to completion.

---

## Why the pauses matter

The appliance reports a status frame containing *both* the previous and the current state.
Two settings changed inside the same frame are indistinguishable from each other — that is
exactly how an earlier pass on the cousin washer mistook the time-estimate bytes for a
course code. Ten quiet seconds per change removes the ambiguity entirely.

## What is already done

- Bridge mode is **enabled** on both appliances, so LG's own decoded field names stream in
  alongside the raw bytes and every offset gets confirmed against a real label.
- The replay harness is built and self-tested (`scratch/decode-preview.ts`).
- You can turn bridge mode back off from `http://192.168.0.150:44401/` when we are finished.
