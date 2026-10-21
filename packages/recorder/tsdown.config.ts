import { defineConfig } from 'tsdown'
import { workerSource } from '../../scripts/worker-source.ts'

// Recorder baseline from RFC 0001: browsers released in the first half of 2023.
const target = ['chrome111', 'edge111', 'firefox115', 'safari16.4']

export default defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'browser',
    target,
    sourcemap: true,
    dts: true,
    exports: {
        devExports: '@timecat-js/source',
        // The worker as a standalone script, for pages that serve it themselves.
        customExports: { './worker': { types: './dist/worker.d.ts', default: './dist/worker.js' } }
    },
    publint: { strict: true },
    attw: { profile: 'esm-only', level: 'error' },
    failOnWarn: true,
    plugins: [workerSource({ target, emit: 'worker.js' })]
})
