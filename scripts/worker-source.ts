import path from 'node:path'
import { rolldown } from 'rolldown'
import type { Plugin } from 'rolldown'

const QUERY = '?worker-source'

export interface WorkerSourceOptions {
    /** Browsers the script is compiled for, as in tsdown's `target`. */
    target?: string[]
    /**
     * Also emits the script as an asset with this file name (ending in `.js`), for builds, with an empty
     * declaration file next to it, so the script can be a typed package export.
     */
    emit?: string
}

/**
 * Makes `import source from './worker.ts?worker-source'` return the worker entry bundled with everything it
 * imports into one self-contained, minified classic script, as a string. A library can then start its worker
 * from a `blob:` URL, which works whatever bundler the app uses. Works in rolldown (tsdown) and in Vite.
 */
export function workerSource(options: WorkerSourceOptions = {}): Plugin {
    return {
        name: 'timecat:worker-source',
        async resolveId(source, importer) {
            if (!source.endsWith(QUERY)) {
                return null
            }
            const resolved = await this.resolve(source.slice(0, -QUERY.length), importer, { skipSelf: true })
            return resolved === null ? null : resolved.id + QUERY
        },
        async load(id) {
            if (!id.endsWith(QUERY)) {
                return null
            }
            const bundle = await rolldown({
                input: id.slice(0, -QUERY.length),
                platform: 'browser',
                // Workspace packages are bundled from source, so they need no build first.
                resolve: { conditionNames: ['@timecat-js/source', 'import', 'browser', 'default'] },
                transform: options.target === undefined ? {} : { target: options.target }
            })
            try {
                const { output } = await bundle.generate({ format: 'iife', minify: true })
                const [chunk] = output
                for (const module of chunk.moduleIds) {
                    if (path.isAbsolute(module)) {
                        this.addWatchFile(module)
                    }
                }
                if (options.emit !== undefined) {
                    this.emitFile({ type: 'asset', fileName: options.emit, source: chunk.code })
                    this.emitFile({
                        type: 'asset',
                        fileName: options.emit.replace(/\.js$/u, '.d.ts'),
                        source: '// A worker script, which exports nothing.\nexport {}\n'
                    })
                }
                return `export default ${JSON.stringify(chunk.code)}`
            } finally {
                await bundle.close()
            }
        }
    }
}
