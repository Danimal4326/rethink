// Local analysis helper (not part of the upstream PR).
//
// Replays a rethink-capture JSONL through an existing device driver and prints a timeline of what
// that driver decodes, interleaved with the human notes and the LG cloud's own decoded state. This
// is the instrument for deciding whether a new model can simply reuse a cousin driver, and for
// spotting which byte offsets disagree when it can't.
//
// Usage:
//   npx tsx scratch/decode-preview.ts --driver RV13B6BSD_D_US_WIFI --capture captures/dryer.jsonl
//   npx tsx scratch/decode-preview.ts --driver F3L2CYU__ --hex aa4020ec...bb
//
//   --raw        also dump every frame's body hex, including ones the driver ignores
//   --cloud-keys limit the printed cloud fields to this comma-separated list

import fs from 'node:fs'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import type { Metadata } from '@/cloud/thinq'

type Args = { driver?: string; capture?: string; hex?: string; raw: boolean; cloudKeys?: string[] }

function parseArgs(argv: string[]): Args {
    const a: Args = { raw: false }
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]
        if (k === '--driver') a.driver = argv[++i]
        else if (k === '--capture') a.capture = argv[++i]
        else if (k === '--hex') a.hex = argv[++i]
        else if (k === '--raw') a.raw = true
        else if (k === '--cloud-keys') a.cloudKeys = argv[++i].split(',')
    }
    return a
}

const args = parseArgs(process.argv.slice(2))
if (!args.driver || (!args.capture && !args.hex)) {
    console.error('usage: decode-preview.ts --driver <ModelId> (--capture <file.jsonl> | --hex <hex>) [--raw]')
    process.exit(2)
}

const DEVICE_ID = 'preview'

// The driver modules are default-exported classes with the (Connection, Thinq2Device, Metadata)
// shape; importing by name keeps this generic across every AABB model.
const mod = await import(`@/cloud/devices/${args.driver}`)
const DUT = mod.default

function makeDevice(modelId: string) {
    const meta: Metadata = { modelId, modelName: modelId, swVersion: '0.0.0' }
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, meta)
    const dev = new DUT(ha.asConnection(), thinq, meta)
    return { ha, thinq, dev }
}

// A frame the driver ignores leaves the property set untouched, which is exactly how we detect
// "this offset/frame-type does not apply to the new model".
function propsOf(ha: MockHAConnection): Record<string, string | number> {
    return { ...(ha.devices[DEVICE_ID]?.properties ?? {}) }
}

function diff(before: Record<string, string | number>, after: Record<string, string | number>) {
    const out: string[] = []
    for (const k of Object.keys(after)) {
        if (before[k] !== after[k]) out.push(`${k}=${after[k]}`)
    }
    return out
}

function classify(hex: string): string {
    const b = Buffer.from(hex, 'hex')
    if (b.length >= 4 && b[0] === 0xaa && b[b.length - 1] === 0xbb) {
        const body = b.subarray(2, b.length - 2)
        return `prefix=0x${body[0]?.toString(16).padStart(2, '0')} type=0x${body[1]
            ?.toString(16)
            .padStart(2, '0')} bodylen=${body.length}`
    }
    return `non-AABB len=${b.length}`
}

function ts(t: number, t0: number) {
    const d = (t - t0) / 1000
    return `+${d.toFixed(1).padStart(7)}s`
}

// ---- single-frame mode -------------------------------------------------------------------------

if (args.hex) {
    const { ha, thinq } = makeDevice(args.driver!)
    thinq.emit('data', buf(args.hex))
    console.log(`frame: ${classify(args.hex)}`)
    const p = propsOf(ha)
    if (Object.keys(p).length === 0) console.log('  (driver produced nothing — frame not recognised)')
    for (const [k, v] of Object.entries(p)) console.log(`  ${k} = ${v}`)
    process.exit(0)
}

// ---- capture-replay mode -----------------------------------------------------------------------

const lines = fs.readFileSync(args.capture!, 'utf8').split('\n').filter(Boolean)
const events = lines.map((l) => JSON.parse(l))
const t0 = events[0]?.ts ?? 0

const { ha, thinq } = makeDevice(args.driver!)

const frameStats = new Map<string, { count: number; decoded: number; sample: string }>()
let decodedFrames = 0
let totalFrames = 0

console.log(`# replaying ${events.length} events through driver ${args.driver}\n`)

for (const e of events) {
    if (e.k === 'marker') {
        console.log(`${ts(e.ts, t0)}  -- ${e.phase}${e.meta ? ` ${JSON.stringify(e.meta)}` : ''}`)
        continue
    }

    if (e.k === 'note') {
        console.log(`${ts(e.ts, t0)}  ## NOTE: ${e.text}`)
        continue
    }

    if (e.k === 'cloud') {
        if (e.matchesDevice === false) continue
        const state = e.state
        let shown: string
        if (state && typeof state === 'object') {
            const flat = JSON.stringify(state)
            if (args.cloudKeys) {
                const picked: Record<string, unknown> = {}
                const walk = (o: any) => {
                    if (!o || typeof o !== 'object') return
                    for (const [k, v] of Object.entries(o)) {
                        if (args.cloudKeys!.includes(k)) picked[k] = v
                        else walk(v)
                    }
                }
                walk(state)
                shown = JSON.stringify(picked)
            } else shown = flat.length > 600 ? flat.slice(0, 600) + '…' : flat
        } else shown = String(e.text ?? '')
        console.log(`${ts(e.ts, t0)}  ~~ CLOUD ${shown}`)
        continue
    }

    if (e.k !== 'wire') continue
    if (e.dir !== 'fromDevice') {
        if (e.hex) console.log(`${ts(e.ts, t0)}  <- toDevice ${e.hex}`)
        continue
    }
    if (!e.hex) continue

    totalFrames++
    const cls = classify(e.hex)
    const before = propsOf(ha)
    thinq.emit('data', buf(e.hex))
    const after = propsOf(ha)
    const changes = diff(before, after)

    const stat = frameStats.get(cls) ?? { count: 0, decoded: 0, sample: e.hex }
    stat.count++
    if (changes.length > 0) {
        stat.decoded++
        decodedFrames++
    }
    frameStats.set(cls, stat)

    if (changes.length > 0) {
        console.log(`${ts(e.ts, t0)}  ${cls}\n              ${changes.join('  ')}`)
    } else if (args.raw) {
        console.log(`${ts(e.ts, t0)}  ${cls}  (no change)  ${e.body ?? e.hex}`)
    }
}

console.log(`\n# frame-type summary (fromDevice)`)
for (const [cls, s] of [...frameStats.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const mark = s.decoded > 0 ? 'DECODED' : 'ignored'
    console.log(`  ${String(s.count).padStart(5)}  ${cls.padEnd(42)} ${mark}`)
    if (s.decoded === 0) console.log(`         sample: ${s.sample}`)
}
console.log(`\n# ${decodedFrames}/${totalFrames} fromDevice frames produced a property change`)

console.log(`\n# final decoded state`)
const finalProps = propsOf(ha)
if (Object.keys(finalProps).length === 0) console.log('  (nothing — this driver does not fit this model)')
for (const [k, v] of Object.entries(finalProps).sort()) console.log(`  ${k} = ${v}`)
