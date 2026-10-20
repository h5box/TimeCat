// Usage: npm install && node run.mjs [cards]
// Set CHROMIUM_PATH to launch a specific Chromium build instead of Playwright's default.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const cards = Number(process.argv[2] || 400)

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const page = await browser.newPage()
await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
await page.addScriptTag({ path: path.join(here, 'node_modules/msgpackr/dist/index.min.js') })
await page.addScriptTag({ path: path.join(here, 'bench-page.js') })
const result = await page.evaluate(n => window.runBench(n), cards)
console.log(JSON.stringify(result, null, 2))
await browser.close()
