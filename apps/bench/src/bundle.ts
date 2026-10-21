import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { workerSource } from '../../../scripts/worker-source.ts'

const pagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page')

/**
 * Bundles a script of `src/page` into one classic script, to run as an init script. Workspace packages are
 * bundled from source, their workers included, so the bench needs no build first.
 */
export async function bundlePage(file: string): Promise<string> {
    const build = await rolldown({
        input: path.join(pagesDir, file),
        platform: 'browser',
        resolve: { conditionNames: ['@timecat-js/source', 'import', 'browser', 'default'] },
        plugins: [workerSource()]
    })
    try {
        const { output } = await build.generate({ format: 'iife', minify: true, codeSplitting: false })
        return output[0].code
    } finally {
        await build.close()
    }
}
