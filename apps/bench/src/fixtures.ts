import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext } from 'playwright'

/** Origin the fixtures are served from, inside the browser only. */
export const FIXTURE_ORIGIN = 'http://bench.local'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures')
const placeholderImage = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'

/** Serves the fixture pages, and a placeholder for every image, to the pages of `context`. */
export async function serveFixtures(context: BrowserContext): Promise<void> {
    await context.route(`${FIXTURE_ORIGIN}/**`, async route => {
        const { pathname } = new URL(route.request().url())
        if (pathname.startsWith('/img/')) {
            return route.fulfill({ contentType: 'image/svg+xml', body: placeholderImage })
        }
        // basename() keeps requests inside the fixtures directory; anything else (e.g. /favicon.ico) is a 404.
        const body = await readFile(path.join(fixturesDir, path.basename(pathname)), 'utf8').catch(() => undefined)
        return body === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'text/html', body })
    })
}
