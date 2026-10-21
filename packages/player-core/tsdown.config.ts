import { defineConfig } from 'tsdown'
import { workerSource } from '../../scripts/worker-source.ts'

// The player supports recent browsers only (RFC 0001, section 4.3).
const target = ['chrome130', 'edge130', 'firefox132', 'safari18']

export default defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'browser',
    target,
    sourcemap: true,
    dts: true,
    exports: {
        devExports: '@timecat-js/source',
        // The indexing worker as a standalone script, for pages that serve it themselves.
        customExports: { './worker': { types: './dist/worker.d.ts', default: './dist/worker.js' } }
    },
    publint: { strict: true },
    attw: { profile: 'esm-only', level: 'error' },
    failOnWarn: true,
    plugins: [workerSource({ target, emit: 'worker.js' })]
})
