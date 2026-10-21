import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import type { RolldownPluginOption } from 'rolldown'
import { workerSource } from '../../scripts/worker-source.ts'

const root = path.dirname(fileURLToPath(import.meta.url))
/** The manifest's `minimum_chrome_version`. */
const target = 'chrome120'

/**
 * The scripts of the extension, each one classic script with all it imports: content scripts and the service
 * worker cannot load modules of their own. The player's page also gets the player's worker as a script of the
 * extension's, since its pages cannot start workers from `blob:` URLs.
 */
const scripts: Record<string, RolldownPluginOption[]> = {
    background: [],
    bridge: [],
    main: [workerSource({ target: [target] })],
    popup: [],
    recordings: [workerSource({ target: [target], query: '?script-source' })],
    player: [
        workerSource({ target: [target], emit: 'player-worker.js' }),
        workerSource({ target: [target], query: '?script-source' })
    ]
}

/** Builds the unpacked extension into `outDir`, which Chrome loads as it is. */
export async function build(outDir: string = path.join(root, 'dist')): Promise<void> {
    await rm(outDir, { recursive: true, force: true })
    await cp(path.join(root, 'static'), outDir, { recursive: true })
    const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const manifestPath = path.join(outDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 4)}\n`)
    await Promise.all(Object.entries(scripts).map(([name, plugins]) => bundle(name, plugins, outDir)))
    // The worker plugin declares what it emits for packages, which the extension has no use for.
    await rm(path.join(outDir, 'player-worker.d.ts'), { force: true })
}

async function bundle(name: string, plugins: RolldownPluginOption[], outDir: string): Promise<void> {
    const bundler = await rolldown({
        input: path.join(root, 'src', `${name}.ts`),
        platform: 'browser',
        // Workspace packages are bundled from source, so the extension needs no build of them first.
        resolve: { conditionNames: ['@timecat-js/source', 'import', 'browser', 'default'] },
        transform: { target },
        plugins
    })
    try {
        await bundler.write({
            dir: outDir,
            format: 'iife',
            entryFileNames: `${name}.js`,
            minify: true,
            sourcemap: true,
            codeSplitting: false
        })
    } finally {
        await bundler.close()
    }
}

if (import.meta.main) {
    await build()
}
