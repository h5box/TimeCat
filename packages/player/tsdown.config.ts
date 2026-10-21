import { defineConfig } from 'tsdown'
import { workerSource } from '../../scripts/worker-source.ts'

// The player supports recent browsers only (RFC 0001, section 4.3).
const target = ['chrome130', 'edge130', 'firefox132', 'safari18']

export default defineConfig({
    entry: ['src/index.ts', 'src/export.ts'],
    format: 'esm',
    platform: 'browser',
    target,
    sourcemap: true,
    dts: true,
    exports: {
        devExports: '@timecat-js/source',
        // The element as one classic script with all it needs, which `exportHtml` embeds too.
        customExports: {
            './standalone': { types: './dist/timecat-player.d.ts', default: './dist/timecat-player.js' }
        }
    },
    publint: { strict: true },
    attw: { profile: 'esm-only', level: 'error' },
    failOnWarn: true,
    plugins: [workerSource({ target, query: '?script-source', emit: 'timecat-player.js' })]
})
