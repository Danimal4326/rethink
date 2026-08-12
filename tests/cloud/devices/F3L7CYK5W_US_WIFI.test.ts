import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3L7CYK5W_US_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3L7CYK5W_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures are REAL frames, lifted from a passive capture of three complete wash cycles on the
// physical machine. Unlike the dryer driver's fixtures there is no LG cloud bridge behind these, so the
// comments name the observed behaviour that confirms each offset rather than a cloud field.

// Single-record 0xEB frame, powered off — what the machine sends on reconnect.
const EB_OFF = buf('aa2020eb00180000010000fe0000000000000000000000000005332b00001abb')

// Dial sweep, stopped on a second course: proves the course byte moves independently of everything else.
const DIAL_PERM_PRESS = buf(
    'aa3a20ec001805010c010c070003040603000000000000000000332b000000180500290029090003030202000000000000000000332b0007d6bb',
)

// Power on with a course already selected. While Selecting, rec[2:4] and rec[4:6] agree (both 63 min).
const SELECTING = buf(
    'aa3a20ec00180000010000fe0000000000000000000000000005332b000000180501030103060003040402000000008000000000332b0000d5bb',
)

// Selecting -> Sensing. This model emits 0x14 as a real, distinct step, which the F3L2CYU__ sibling
// documents as unconfirmed because its capture never produced one.
const SENSING = buf(
    'aa3a20ec00180501030103060003040402000000008000000000332b000000181401030103060003040402000000008000000005332b000065bb',
)

// Door pulled shut during Sensing: rec[17] 0x00 -> 0x02 with the rec[16] lock bit untouched.
const DOOR_CLOSES = buf(
    'aa3a20ec00181401030103060003040402000000008000000005332b000000181401030103060003040402000000008002000005332b000013bb',
)

// Sensing -> Washing. The cycle time is re-estimated to 80 min and rec[4:6] PINS there; rec[20] holds the
// previous phase (0x14 Sensing) and rec[24] latches its per-cycle value.
const WASHING_START = buf(
    'aa3a20ec00181401030103060003040402000000008002000005332b000000181701140114060003040402000000008002000014332b0004d5bb',
)

// One minute later: rec[2:4] is 79 while rec[4:6] is still 80. This pair is the whole case for a separate
// initial-time field, and would be invisible if this model were aliased to F3L2CYU__.
const WASHING_MINUTE_LATER = buf(
    'aa3a20ec00181701140114060003040402000000008002000014332b000400181701130114060003040402000000008002000114332b0004edbb',
)

// Washing -> Rinsing: soil drops to its not-applicable 0 while the initial estimate holds at 80.
const RINSING = buf(
    'aa3a20ec001817003a0114060003040402000000008002002414332b000400181e00390114060000040402000000008002002617332b000407bb',
)

// Rinsing -> Spinning: temperature drops to not-applicable in turn.
const SPINNING = buf(
    'aa3a20ec00181e00150114060000040401000000008002003f17332b00040018280014011406000004000000000000800200411e332b00041abb',
)

// Spinning -> Complete: the door unlocks and unlatches, the course parks on the 0xFE sentinel, and the
// cycle counter ticks 0x2b -> 0x2c. That increment happened at this transition and nowhere else.
const COMPLETE = buf(
    'aa3a20ec0018280001011406000004000000000000800200671e332b000400183c00010000fe0000000000000000000000006c28332c0000aabb',
)

// Complete -> Off, ~30 seconds later.
const OFF = buf(
    'aa3a20ec00183c00010000fe0000000000000000000000006c28332c000000180000010000fe0000000000000000000000006c3c332c000001bb',
)

// A 0xE2 frame captured 15s AFTER the cycle above completed. It is 28 bytes with a valid 0x18 record at
// offset 3 — structurally indistinguishable from 0xEB — but replays the START of the finished cycle
// (Sensing, 63 min, cycle counter still 0x2b). Decoding it would undo the Complete state.
const E2_STALE_REPLAY = buf('aa2020e203181401030103060003040402000000008000006c05332b000030bb')

// The second run, which started from a different estimate (58 min) — guards against the 80 above being
// baked in as a constant somewhere.
const SECOND_RUN_WASHING = buf(
    'aa3a20ec00181401030103060003040402000000008002000005332d0000001817003a003a060003040402000000008002000014332d000398bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('F3L7CYK5W_US_WIFI', () => {
    test('0xEB single-record frames decode with the same offsets as 0xEC', () => {
        const p = feed([EB_OFF])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'unknown') // 0xFE is the no-selection sentinel
        assert.equal(p.remaining_time, 0)
        assert.equal(p.cycle_count, 43)
    })

    test('while selecting, remaining and initial time agree', () => {
        const p = feed([SELECTING])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Selecting')
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.remaining_time, 63)
        assert.equal(p.initial_time, 63)
    })

    test('the course byte moves independently of the settings bytes', () => {
        const p = feed([DIAL_PERM_PRESS])
        assert.equal(p.course, 'Perm Press')
        assert.equal(p.remaining_time, 41)
        assert.equal(p.spin, 'Medium')
        assert.equal(p.temp, 'Cold')
    })

    test('Sensing is a real distinct phase on this model', () => {
        const p = feed([SELECTING, SENSING])
        assert.equal(p.status, 'Sensing')
        assert.equal(p.remaining_time, 63)
    })

    test('the door sensor is independent of the door lock', () => {
        const open = feed([SENSING])
        assert.equal(open.door, 'ON') // ON = open
        assert.equal(open.door_lock, 'ON') // already locked while the door reads open

        const shut = feed([SENSING, DOOR_CLOSES])
        assert.equal(shut.door, 'OFF')
        assert.equal(shut.door_lock, 'ON')
    })

    // This is the test that would fail if this model were aliased to F3L2CYU__.
    test('initial time pins when the cycle starts while remaining time counts down', () => {
        const start = feed([SENSING, WASHING_START])
        assert.equal(start.status, 'Washing')
        assert.equal(start.remaining_time, 80)
        assert.equal(start.initial_time, 80)

        const later = feed([SENSING, WASHING_START, WASHING_MINUTE_LATER])
        assert.equal(later.remaining_time, 79)
        assert.equal(later.initial_time, 80) // pinned, not following the countdown

        // and the pinned value is per-run, not a constant
        const second = feed([SECOND_RUN_WASHING])
        assert.equal(second.remaining_time, 58)
        assert.equal(second.initial_time, 58)
    })

    test('a real run: Washing -> Rinsing -> Spinning, settings drop out as they stop applying', () => {
        const rinsing = feed([WASHING_START, RINSING])
        assert.equal(rinsing.status, 'Rinsing')
        assert.equal(rinsing.soil, 'unknown') // soil index goes to 0 once washing ends
        assert.equal(rinsing.temp, 'Warm')
        assert.equal(rinsing.initial_time, 80)

        const spinning = feed([WASHING_START, RINSING, SPINNING])
        assert.equal(spinning.status, 'Spinning')
        assert.equal(spinning.temp, 'unknown')
        assert.equal(spinning.door_lock, 'ON')
    })

    test('completing a cycle unlocks the door and increments the cycle counter', () => {
        const before = feed([WASHING_START, SPINNING])
        assert.equal(before.cycle_count, 43)

        const done = feed([WASHING_START, SPINNING, COMPLETE])
        assert.equal(done.status, 'Complete')
        assert.equal(done.power, 'ON') // Complete is still powered on
        assert.equal(done.cycle_count, 44)
        assert.equal(done.door_lock, 'OFF')
        assert.equal(done.door, 'ON')
        // a finished washer must not advertise a stale minute of remaining time
        assert.equal(done.remaining_time, 0)
        assert.equal(done.initial_time, 0)
    })

    test('powering off clears the selection', () => {
        const p = feed([WASHING_START, SPINNING, COMPLETE, OFF])
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
        assert.equal(p.course, 'unknown')
        assert.equal(p.remaining_time, 0)
    })

    test('0xE2 post-cycle replay frames are ignored, not treated as status', () => {
        // fed straight after a completed cycle, this frame must not drag the machine back to Sensing
        const p = feed([WASHING_START, SPINNING, COMPLETE, E2_STALE_REPLAY])
        assert.equal(p.status, 'Complete')
        assert.equal(p.cycle_count, 44) // not rolled back to the frame's stale 43
        assert.equal(p.remaining_time, 0) // not the frame's stale 63
    })

    test('frames that are not status frames publish nothing', () => {
        // a 0xD8 heartbeat, a 0x72 ping and a truncated 0xEC must all be ignored rather than decoded
        // from whatever bytes happen to sit at the status offsets
        for (const junk of ['aa0720d800fcbb', 'aa09207200c9005bbb', 'aa0a20ec001805010cbb']) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(junk))
            assert.deepEqual(ha.devices[DEVICE_ID].properties, {}, `frame ${junk} should publish nothing`)
        }
    })
})
