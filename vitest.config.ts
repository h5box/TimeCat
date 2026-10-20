import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const engines = ['chromium', 'firefox', 'webkit'] as const
type Engine = (typeof engines)[number]
const isEngine = (name: string): name is Engine => (engines as readonly string[]).includes(name)

// CI runs every engine; locally, e.g. VITEST_BROWSERS=chromium narrows the run.
const browsers = (process.env.VITEST_BROWSERS ?? engines.join(',')).split(',').map(name => {
    if (!isEngine(name)) {
        throw new Error(`Unknown browser "${name}" in VITEST_BROWSERS, expected one of: ${engines.join(', ')}`)
    }
    return name
})
// Reuse a pre-installed Chromium instead of Playwright's pinned build when set.
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'node',
                    include: ['packages/*/test/**/*.test.ts'],
                    exclude: ['**/*.browser.test.ts'],
                    environment: 'node'
                }
            },
            {
                test: {
                    name: 'browser',
                    include: ['packages/*/test/**/*.test.ts'],
                    exclude: ['**/*.node.test.ts'],
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: playwright(),
                        instances: browsers.map(browser =>
                            browser === 'chromium' && chromiumPath
                                ? { browser, provider: playwright({ launchOptions: { executablePath: chromiumPath } }) }
                                : { browser }
                        )
                    }
                }
            }
        ]
    }
})
