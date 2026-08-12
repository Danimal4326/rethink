import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG front-load washer — matched on modelId "F3L7CYK5W_US_WIFI". Shares the AABB record layout of the
// F3L2CYU__ sibling exactly (25-byte record led by a 0x18 marker), but it is NOT an alias of it:
//   * rec[4:6] carries a persistent initial-cycle-time estimate. The sibling's notes state that model has
//     no such field and reuse the countdown bytes for both purposes; this model genuinely has both.
//   * rec[11] behaves differently. On the sibling it is a static setting whose HIGH nibble holds the
//     extra-rinse count. Here the high nibble is never set (so the sibling's `>>4` would report a
//     permanent 0) and the LOW nibble counts DOWN as the cycle progresses — see the note at
//     RINSE_COUNTDOWN_OFFSET below.
//   * rec[22] and rec[24] carry fields the sibling does not decode.
//
// Frames are discriminated by buf[1] (buf[0] == 0x20 on every frame):
//   0xEC        status frame — two stacked 25-byte records (old state, then current), each led by a 0x18
//               marker; we read record B (buf[29:]). Verified across a 172-frame capture: record A is
//               byte-identical to the previous frame's record B in 171/171 consecutive pairs.
//   0xEB        single-record status frame, record at buf[3:] — same 25-byte layout, no preceding "old
//               state" record. Seen right after the appliance reconnects.
//   0xE2        NOT decoded, deliberately. It has the same 28-byte shape as 0xEB with a valid 0x18 record
//               at buf[3:], so it is tempting to treat as status — but it is emitted in a burst
//               immediately AFTER a cycle finishes and replays a stale snapshot of that cycle's START
//               (phase Sensing, the pre-run time estimate, and the pre-increment rec[22]). Decoding it
//               would knock the machine back from "Complete" to "Sensing" every time a wash ended.
//   0xBD / 0xCD full status dump / idle keepalive (~405-476 bytes) — not decoded.
//   0x31        one-time device-ID/serial frame at connect — not decoded.
//   0x72, 0xD8  short heartbeat/ping frames — not decoded.
//
// PROVENANCE, and it differs from the sibling's: these offsets were confirmed from a passive capture of
// three complete real wash cycles (plus one dial sweep) taken WITHOUT the LG cloud bridge, so unlike the
// sibling there are no authoritative cloud field names behind them. Everything published below is
// therefore confirmed *behaviourally* — by how the byte moves through a real cycle — and every field whose
// behaviour did not pin it down is omitted rather than guessed. See the omission list at the end.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 54 // 3B header + 26B record A (old) + 25B record B (current)
const RECORD_B_OFFSET = 29

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 28 // 3B header + 25B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

const RECORD_MARKER = 0x18

// Offsets below are relative to the record's own 0x18 marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute], the live countdown. Confirmed over three full cycles counting down
// monotonically to 1 immediately before the machine reported Complete.
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute], the cycle's total/initial time estimate. While the machine is Selecting this
// tracks rec[2:4] exactly; the moment a cycle starts it PINS and stays fixed while rec[2:4] counts down
// (observed pinned at 80 minutes for one run and 58 for two others, across 161 frames). This is the field
// the F3L2CYU__ sibling does not have.
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
// rec[6]: course/dial-position identifier. 0x00 and 0xFE are both no-selection sentinels (0xFE is what
// this model parks on at power-off and after Complete).
const COURSE_OFFSET = 6
const SOIL_OFFSET = 8
const SPIN_OFFSET = 9
const TEMP_OFFSET = 10
// rec[15]/rec[16] are the sibling's two option bitfields. Only the rec[16] door-lock bit is published —
// see the omission list; the option bits were never observed toggling on this unit, and the RV13B6ES
// dryer proved that bit positions genuinely do move between otherwise byte-identical LG siblings.
const OPT2_OFFSET = 16
const OPT2_DOOR_LOCKED = 0x80
// rec[17]: door-closed sensor, independent of the rec[16] lock bit. Confirmed toggling mid-capture when
// the door was shut ~18s after the machine was switched on, and again when it unlocked at Complete.
const DOOR_OFFSET = 17
const DOOR_CLOSED = 0x02
// rec[20]: the phase the machine was in BEFORE the current one (not the previous frame's phase — it holds
// steady across every frame of a phase). Verified against the full phase sequence of three cycles with no
// disagreement. Not published as an entity (the dryer driver treats its equivalent the same way), but it
// is what makes a frame self-describing when read in isolation.
const PREV_PHASE_OFFSET = 20
// rec[22]: a completed-cycle counter. It incremented by exactly one at each Spinning -> Complete
// transition and at no other point in a 12.7-hour capture (43 -> 44 -> 45 -> 46 over three washes).
// Published for what it is observed to do; whether LG scopes it to "since last Tub Clean" or to the life
// of the machine is not determinable from this capture.
const CYCLE_COUNT_OFFSET = 22

const PHASE_OFF = 0x00
const PHASE_COMPLETE = 0x3c

// Phase/status byte. Off/Selecting/Sensing/Washing/Rinsing/Spinning/Complete were each observed directly,
// in that order, on three real cycles. Paused and Delay Wash are carried over from the F3L2CYU__ sibling
// and were NOT exercised here — they are harmless to include because anything genuinely unmapped falls
// back to 'Running'.
// Worth noting for the sibling: it lists 0x14 as unconfirmed because its capture went straight from
// Selecting to Washing. This model emits 0x14 as a distinct ~45-second step before Washing on every run,
// which corroborates the Sensing reading.
const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x05: 'Selecting',
    0x06: 'Paused',
    0x0a: 'Delay Wash',
    0x14: 'Sensing',
    0x17: 'Washing',
    0x1e: 'Rinsing',
    0x28: 'Spinning',
    0x3c: 'Complete',
}

// Course identifier -> name, inherited from the F3L2CYU__ sibling, whose table was confirmed against the
// LG cloud's own apCourseFLUpper25inchBaseUS enum.
// CAVEAT, and it is the weakest claim in this file: only 0x02, 0x06, 0x07, 0x09 and 0x0c were seen on this
// unit, and without the cloud bridge there is nothing here that confirms the NAMES — only that every value
// observed falls inside the sibling's table and carries a plausible default cycle time. Course tables are
// the most market- and model-specific part of these protocols. A single dial sweep captured with
// `rethink-capture --cloud` would settle all fourteen positions.
const COURSE: Record<number, string> = {
    0x01: 'Tub Clean',
    0x02: 'Bright Whites',
    0x03: 'Allergiene',
    0x04: 'Sanitary',
    0x05: 'Bedding',
    0x06: 'Heavy Duty',
    0x07: 'Normal',
    0x08: 'Sportswear',
    0x09: 'Perm Press',
    0x0a: 'Delicates',
    0x0b: 'Towels',
    0x0c: 'Speed Wash',
    0x0d: 'Rinse+Spin',
    0x0e: 'Small Load',
}

// Soil / Spin / Temp index tables, also inherited from the sibling. These are sequential index encodings
// rather than bitfields, which is the kind of mapping LG shares across a platform, and every value seen on
// this unit (soil 0/3, spin 0/3/4/5, temp 0/2/4/6) lands inside the sibling's table. Index 0 means "not
// applicable" and is reported as unknown — it is what the machine shows once it stops using the setting
// (soil drops to 0 when washing ends, temp when spinning starts).
const SOIL: Record<number, string> = {
    1: 'Light',
    2: 'Light-Normal',
    3: 'Normal',
    4: 'Normal-Heavy',
    5: 'Heavy',
}

const SPIN: Record<number, string> = {
    1: 'No Spin',
    2: 'Low',
    3: 'Medium',
    4: 'High',
    5: 'Extra High',
}

const TEMP: Record<number, string> = {
    1: 'Tap Cold',
    2: 'Cold',
    4: 'Warm',
    6: 'Hot',
    7: 'Extra Hot',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): unmapped phase codes emit 'Running'.
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door', // payload ON = open, OFF = closed
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // NOT device_class 'lock' — that class is inverted (on = unlocked)
                        entity_category: 'diagnostic',
                    },
                    cycle_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle_count',
                        state_topic: '$this/cycle_count',
                        name: 'Cycles completed',
                        icon: 'mdi:counter',
                        state_class: 'total_increasing',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0xE2 is intentionally NOT handled here despite looking like a valid single-record status frame —
        // see the header note; it is a post-cycle replay of stale data.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== RECORD_MARKER) return // the record should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF
        // Both timers are zeroed once there is no cycle in flight. The raw bytes park on a stale 1 minute
        // at Off and at Complete, and a washer that has just finished should not be advertising "1 minute
        // remaining" to an automation.
        const idle = isOff || phase === PHASE_COMPLETE

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? 'Running')
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('remaining_time', idle ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            idle ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('soil', SOIL[rec[SOIL_OFFSET]] ?? 'unknown')
        this.publishProperty('spin', SPIN[rec[SPIN_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        this.publishProperty('door', rec[DOOR_OFFSET] === DOOR_CLOSED ? 'OFF' : 'ON')
        this.publishProperty('door_lock', (rec[OPT2_OFFSET] & OPT2_DOOR_LOCKED) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cycle_count', rec[CYCLE_COUNT_OFFSET])

        // Declared entities intentionally omitted rather than published wrong. The capture behind this
        // driver is passive — three real Heavy Duty cycles with no options toggled and no cloud bridge —
        // so the following are known to EXIST but are not pinned down, and a session driving the panel
        // with `rethink-capture --cloud` would close all of them out:
        //   * The rec[15] option bitfield (extra rinse / pre-wash / steam / TurboWash / delay-active) and
        //     the rec[16] cold-wash bit. Only one bit was ever seen set (rec[15] 0x04, on the course
        //     default of a single dial position). Inheriting the sibling's bit positions unverified is
        //     exactly the mistake the RV13B6ES dryer caught: Wrinkle Care had moved bitfields there and
        //     would have read permanently OFF.
        //   * rec[11], the low nibble of which counts down through the cycle (a per-course value of 2-3
        //     while selecting, decrementing during Rinsing, reaching 0 by Spinning). This looks like
        //     rinses remaining, but it is NOT the sibling's static extra-rinse-count setting, so the
        //     sibling's decoding of this byte is not reused.
        //   * rec[24], which is 0 while idle and then latches to a per-cycle constant (4, 2 and 3 on the
        //     three runs) the instant Sensing hands over to Washing. Consistent with a measured load
        //     level, but one dial-sweep frame broke the pattern, so it is left alone.
        //   * rec[13:15], the sibling's Delay Wash reserve clock: constant zero here, never exercised.
        //   * rec[19] and rec[21] change with no interpretation yet; error codes, child lock and remote
        //     start remain unlocated, as on the sibling.
    }
}
