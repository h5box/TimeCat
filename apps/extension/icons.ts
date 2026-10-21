import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Renders assets/icon.svg into the PNG icons of the manifest, which Chrome takes for extensions in place of SVG.
const root = path.dirname(fileURLToPath(import.meta.url))
const svg = await readFile(path.join(root, 'assets/icon.svg'), 'utf8')
const executablePath = process.env['CHROMIUM_EXECUTABLE_PATH']
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
try {
    await Promise.all(
        [16, 32, 48, 128].map(async size => {
            const page = await browser.newPage({ viewport: { width: size, height: size } })
            await page.setContent(
                `<style>html, body { margin: 0; background: transparent } svg { display: block; width: ${size}px; height: ${size}px }</style>${svg}`
            )
            await page.screenshot({ path: path.join(root, `static/icons/icon-${size}.png`), omitBackground: true })
            await page.close()
        })
    )
} finally {
    await browser.close()
}
