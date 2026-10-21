import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import type { Browser, CDPSession } from 'playwright'
import { FIXTURE_ORIGIN, serveFixtures } from './fixtures.ts'
import { installHarness } from './harness.ts'
import { recorders } from './recorders.ts'
import type { RecordedData, RecorderAdapter } from './recorders.ts'
import { scenarios } from './scenarios.ts'
import type { Scenario } from './scenarios.ts'

interface RunResult extends RecordedData {
    /** Main-thread time the start call blocked. */
    startMs: number
    /** Main-thread task time from recording start to the end of the scenario (CDP TaskDuration). */
    taskMs: number
    /**
     * Parts of it, in the results file only: script, layout and style (CDP ScriptDuration, LayoutDuration and
     * RecalcStyleDuration). Script leaves out code that resumes after `scheduler.yield()`, such as most of a
     * time-sliced snapshot.
     */
    scriptMs: number
    layoutMs: number
    styleMs: number
    longTasks: number
    longestTaskMs: number
}

const { values: args } = parseArgs({
    options: {
        runs: { type: 'string', default: '5' },
        warmup: { type: 'string', default: '1' },
        scenario: { type: 'string', multiple: true },
        recorder: { type: 'string', multiple: true },
        'cpu-throttle': { type: 'string', default: '1' }
    }
})

const runs = Number(args.runs)
const warmup = Number(args.warmup)
const cpuThrottle = Number(args['cpu-throttle'])
const selectedScenarios = pick(scenarios, args.scenario, s => s.name)
// The control run is always included: recorder overhead is measured against it.
const selectedRecorders = pick(
    Object.values(recorders),
    ['none', ...(args.recorder ?? Object.keys(recorders))],
    r => r.name
)

const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../results')

// Lets local runs reuse a pre-installed Chromium instead of Playwright's pinned build.
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const environment = {
    date: new Date().toISOString(),
    browser: `chromium ${browser.version()}`,
    node: process.version,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'} x ${os.cpus().length}`,
    cpuThrottle,
    runs,
    warmup
}
console.log(
    `TimeCat bench | ${environment.browser} | ${environment.cpu} | CPU throttle ${cpuThrottle}x | ${runs} runs\n`
)

const report: Record<string, Record<string, RunResult>> = {}
try {
    for (const scenario of selectedScenarios) {
        const samples = new Map<string, RunResult[]>(selectedRecorders.map(r => [r.name, []]))
        for (let i = 0; i < warmup + runs; i++) {
            // Interleave recorders so slow drift on the machine affects all of them alike.
            for (const recorder of selectedRecorders) {
                const result = await measure(browser, scenario, recorder)
                if (i >= warmup) {
                    samples.get(recorder.name)?.push(result)
                }
            }
        }
        report[scenario.name] = Object.fromEntries([...samples].map(([name, results]) => [name, medianOf(results)]))
        print(scenario, report[scenario.name] ?? {})
    }
} finally {
    await browser.close()
}

await mkdir(resultsDir, { recursive: true })
const file = path.join(resultsDir, `${environment.date.replaceAll(':', '-')}.json`)
await writeFile(file, JSON.stringify({ environment, results: report }, null, 2) + '\n')
console.log(`Results written to ${path.relative(process.cwd(), file)}`)

async function measure(target: Browser, scenario: Scenario, recorder: RecorderAdapter): Promise<RunResult> {
    const context = await target.newContext({ viewport: { width: 1280, height: 800 } })
    try {
        await serveFixtures(context)
        const page = await context.newPage()
        await page.addInitScript(installHarness)
        if (recorder.initScript) {
            await page.addInitScript(recorder.initScript)
        }
        await page.goto(`${FIXTURE_ORIGIN}/${scenario.fixture}`, { waitUntil: 'load' })

        const cdp = await context.newCDPSession(page)
        await cdp.send('Performance.enable')
        if (cpuThrottle > 1) {
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
        }

        const before = await mainThreadTime(cdp)
        const startMs = await page.evaluate(recorder.start, { canvas: scenario.canvas ?? false })
        await scenario.run(page)
        if (recorder.settle) {
            await page.evaluate(recorder.settle)
        }
        const after = await mainThreadTime(cdp)

        const longTasks = await page.evaluate(() => window.timecatBench?.longTasksSinceRecordStart() ?? [])
        const data = await page.evaluate(recorder.stop)
        return {
            startMs,
            taskMs: after.taskMs - before.taskMs,
            scriptMs: after.scriptMs - before.scriptMs,
            layoutMs: after.layoutMs - before.layoutMs,
            styleMs: after.styleMs - before.styleMs,
            longTasks: longTasks.length,
            longestTaskMs: Math.max(0, ...longTasks.map(task => task.duration)),
            ...data
        }
    } finally {
        await context.close()
    }
}

/** Cumulative main-thread time of the page, in milliseconds. */
async function mainThreadTime(
    cdp: CDPSession
): Promise<Pick<RunResult, 'taskMs' | 'scriptMs' | 'layoutMs' | 'styleMs'>> {
    const { metrics } = await cdp.send('Performance.getMetrics')
    const ms = (name: string): number => (metrics.find(metric => metric.name === name)?.value ?? 0) * 1000
    return {
        taskMs: ms('TaskDuration'),
        scriptMs: ms('ScriptDuration'),
        layoutMs: ms('LayoutDuration'),
        styleMs: ms('RecalcStyleDuration')
    }
}

function medianOf(results: RunResult[]): RunResult {
    const median = (key: keyof RunResult): number => {
        const sorted = results.map(result => result[key]).toSorted((a, b) => a - b)
        const middle = Math.floor(sorted.length / 2)
        return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    }
    return {
        startMs: median('startMs'),
        taskMs: median('taskMs'),
        scriptMs: median('scriptMs'),
        layoutMs: median('layoutMs'),
        styleMs: median('styleMs'),
        longTasks: median('longTasks'),
        longestTaskMs: median('longestTaskMs'),
        events: median('events'),
        rawBytes: median('rawBytes'),
        gzipBytes: median('gzipBytes'),
        serializeMs: median('serializeMs')
    }
}

function print(scenario: Scenario, results: Record<string, RunResult>): void {
    const control = results['none']?.taskMs ?? 0
    console.log(`${scenario.name}: ${scenario.description}`)
    console.table(
        Object.fromEntries(
            Object.entries(results).map(([name, r]) => [
                name,
                {
                    'start (ms)': round(r.startMs),
                    'main thread (ms)': round(r.taskMs),
                    'overhead (ms)': name === 'none' ? '-' : round(r.taskMs - control),
                    'long tasks': r.longTasks,
                    'longest (ms)': round(r.longestTaskMs),
                    events: r.events,
                    'raw (KB)': round(r.rawBytes / 1024),
                    'gzip (KB)': round(r.gzipBytes / 1024),
                    'serialize (ms)': round(r.serializeMs)
                }
            ])
        )
    )
}

function round(value: number): number {
    return Math.round(value * 10) / 10
}

function pick<T>(items: T[], names: string[] | undefined, nameOf: (item: T) => string): T[] {
    if (!names) {
        return items
    }
    const unique = [...new Set(names)]
    const unknown = unique.filter(name => !items.some(item => nameOf(item) === name))
    if (unknown.length) {
        throw new Error(`Unknown name(s): ${unknown.join(', ')}. Available: ${items.map(nameOf).join(', ')}`)
    }
    return items.filter(item => unique.includes(nameOf(item)))
}
