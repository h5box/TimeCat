import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { bundlePage } from './bundle.ts'
import { FIXTURE_ORIGIN, serveFixtures } from './fixtures.ts'

// Seek benchmark (RFC 0001: a seek anywhere in a one-hour session takes at most 300 ms). Records a long session
// of the dashboard fixture on a simulated clock, then times seeks to random points of it, one after another.
// Every row of the dashboard changes, unless --live-rows says how many do.

const { values: args } = parseArgs({
    options: {
        minutes: { type: 'string', default: '60' },
        fps: { type: 'string', default: '10' },
        seeks: { type: 'string', default: '100' },
        'keyframe-interval': { type: 'string' },
        'live-rows': { type: 'string' },
        'cpu-throttle': { type: 'string', default: '1' }
    }
})

const minutes = Number(args.minutes)
const fps = Number(args.fps)
const seekCount = Number(args.seeks)
const keyframeInterval = args['keyframe-interval'] === undefined ? undefined : Number(args['keyframe-interval'])
const cpuThrottle = Number(args['cpu-throttle'])
const liveRows = args['live-rows'] === undefined ? undefined : Number(args['live-rows'])
const TARGET_MS = 300

const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../results')
const script = await bundlePage('seek.ts')
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const environment = {
    date: new Date().toISOString(),
    browser: `chromium ${browser.version()}`,
    node: process.version,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'} x ${os.cpus().length}`,
    cpuThrottle,
    minutes,
    fps,
    seeks: seekCount,
    keyframeInterval: keyframeInterval ?? 'default',
    liveRows: liveRows ?? 'all'
}
console.log(
    `TimeCat seek bench | ${environment.browser} | ${environment.cpu} | CPU throttle ${cpuThrottle}x\n` +
        `${minutes} min of dashboard updates at ${fps} frames/s, ${liveRows ?? 'all'} rows live, ${seekCount} seeks\n`
)

let result
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await serveFixtures(context)
    const page = await context.newPage()
    await page.addInitScript({ content: script })
    const query = liveRows === undefined ? '' : `?live=${liveRows}`
    await page.goto(`${FIXTURE_ORIGIN}/dashboard.html${query}`, { waitUntil: 'load' })
    const recorded = await page.evaluate(([m, f]) => window.timecatSeek!.record(m, f), [minutes, fps] as const)
    // Throttling starts after recording, which is not what is measured.
    if (cpuThrottle > 1) {
        const cdp = await context.newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
    }
    const targets = randomTargets(seekCount, 42)
    const replayed = await page.evaluate(([t, k]) => window.timecatSeek!.replay(t, k), [
        targets,
        keyframeInterval
    ] as const)
    result = { ...recorded, ...replayed }
} finally {
    await browser.close()
}

const seeks = result.seeks.toSorted((a, b) => a - b)
const summary = {
    'recorded (min)': round(result.durationMs / 60_000),
    frames: result.frames,
    'recording (KB)': round(result.bytes / 1024),
    'record (ms)': round(result.recordMs),
    'load (ms)': round(result.loadMs),
    'seek median (ms)': round(quantile(seeks, 0.5)),
    'seek p95 (ms)': round(quantile(seeks, 0.95)),
    'seek max (ms)': round(seeks.at(-1) ?? 0)
}
console.table(summary)
const slowest = seeks.at(-1) ?? 0
console.log(
    slowest <= TARGET_MS
        ? `Every seek took at most ${TARGET_MS} ms.`
        : `${seeks.filter(ms => ms > TARGET_MS).length} of ${seeks.length} seeks took longer than ${TARGET_MS} ms.`
)

await mkdir(resultsDir, { recursive: true })
const file = path.join(resultsDir, `seek-${environment.date.replaceAll(':', '-')}.json`)
await writeFile(file, JSON.stringify({ environment, summary, seeks: result.seeks }, null, 2) + '\n')
console.log(`Results written to ${path.relative(process.cwd(), file)}`)

/** Fractions of the duration to seek to, from a seeded generator so that every run seeks to the same points. */
function randomTargets(count: number, seed: number): number[] {
    let state = seed
    const next = (): number => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return Array.from({ length: count }, next)
}

function quantile(sorted: readonly number[], q: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

function round(value: number): number {
    return Math.round(value * 10) / 10
}
