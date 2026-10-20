import { defineConfig } from 'tsdown'

export default defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'neutral',
    // Recorder baseline from RFC 0001: browsers released in the first half of 2023.
    target: ['chrome111', 'edge111', 'firefox115', 'safari16.4'],
    sourcemap: true,
    dts: true,
    exports: { devExports: '@timecat-js/source' },
    publint: { strict: true },
    attw: { profile: 'esm-only', level: 'error' },
    failOnWarn: true
})
