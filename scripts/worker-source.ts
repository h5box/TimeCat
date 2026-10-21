import path from 'node:path'
import { rolldown } from 'rolldown'
import type { Plugin } from 'rolldown'

export interface WorkerSourceOptions {
    /** Browsers the script is compiled for, as in tsdown's `target`. */
    target?: string[]
    /** The import query the plugin answers, `?worker-source` by default. */
    query?: string
    /**
     * Also emits the script as an asset with this file name (ending in `.js`), for builds, with an empty
     * declaration file next to it, so the script can be a typed package export.
     */
    emit?: string
}

/**
 * Makes `import source from './worker.ts?worker-source'` return the worker entry bundled with everything it
 * imports into one self-contained, minified classic script, as a string. A library can then start its worker
 * from a `blob:` URL, which works whatever bundler the app uses. Works in rolldown (tsdown) and in Vite. With
 * another `query`, it bundles other scripts the same way, such as one a page embeds; scripts it bundles can import
 * workers so in turn.
 */
export function workerSource(options: WorkerSourceOptions = {}): Plugin {
    const query = options.query ?? '?worker-source'
    return {
        name: `timecat:${query.slice(1)}`,
        async resolveId(source, importer) {
            if (!source.endsWith(query)) {
                return null
            }
            const resolved = await this.resolve(source.slice(0, -query.length), importer, { skipSelf: true })
            return resolved === null ? null : resolved.id + query
        },
        async load(id) {
            if (!id.endsWith(query)) {
                return null
            }
            const bundle = await rolldown({
                input: id.slice(0, -query.length),
                platform: 'browser',
                // Workspace packages are bundled from source, so they need no build first.
                resolve: { conditionNames: ['@timecat-js/source', 'import', 'browser', 'default'] },
                transform: options.target === undefined ? {} : { target: options.target },
                plugins: [workerSource(options.target === undefined ? {} : { target: options.target })]
            })
            try {
                const { output } = await bundle.generate({ format: 'iife', minify: true, codeSplitting: false })
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
                        source: '// A classic script, which exports nothing.\nexport {}\n'
                    })
                }
                return `export default ${JSON.stringify(chunk.code)}`
            } finally {
                await bundle.close()
            }
        }
    }
}
