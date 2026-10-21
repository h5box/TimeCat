import type { Page } from 'playwright'

export interface Scenario {
    name: string
    description: string
    /** Fixture path and query, served from http://bench.local/. */
    fixture: string
    /** Records canvases, as each recorder can: TimeCat with plugin-canvas, rrweb with `recordCanvas`. */
    canvas?: boolean
    /** User actions after recording starts. Each scenario does a fixed amount of work, not a fixed duration. */
    run: (page: Page) => Promise<void>
}

const formInput: [selector: string, text: string][] = [
    ['#name', 'Jane Doe'],
    ['#email', 'jane.doe@example.com'],
    ['#phone', '+86 138 0013 8000'],
    ['#address', '1 Infinite Loop, Building 7'],
    ['#city', 'Hangzhou'],
    ['#card', '4111 1111 1111 1111'],
    ['#password', 'correct horse battery staple'],
    ['#notes', 'Please leave the parcel at the front desk. Call before delivery.']
]

export const scenarios: Scenario[] = [
    {
        name: 'snapshot-large',
        description: 'Start recording on a ~51k-node product list; dominated by the initial full snapshot',
        fixture: 'product-list.html?cards=1600',
        run: page => page.waitForTimeout(500)
    },
    {
        name: 'mutations',
        description: '300 animation frames of cell updates, class toggles, a style animation and list inserts',
        fixture: 'dashboard.html',
        run: async page => {
            await page.evaluate(() => window.benchScenario?.run(300))
        }
    },
    {
        name: 'typing',
        description: 'Fill a checkout form: 191 keystrokes, one select change and one checkbox',
        fixture: 'checkout.html',
        run: async page => {
            for (const [selector, text] of formInput) {
                await page.locator(selector).pressSequentially(text)
            }
            await page.selectOption('#country', 'jp')
            await page.check('#terms')
        }
    },
    {
        name: 'pointer-scroll',
        description: '300 pointer moves at ~60 Hz with 20 wheel scrolls on a 400-card product list',
        fixture: 'product-list.html?cards=400',
        run: async page => {
            for (let i = 0; i < 300; i++) {
                await page.mouse.move(
                    640 + Math.round(400 * Math.sin(i / 25)),
                    400 + Math.round(250 * Math.cos(i / 17))
                )
                if (i % 15 === 0) {
                    await page.mouse.wheel(0, 240)
                }
                await page.waitForTimeout(16)
            }
        }
    },
    {
        name: 'canvas',
        description: '300 animation frames of a 960x540 2D canvas, which the recorders record at 15 fps',
        fixture: 'canvas.html',
        canvas: true,
        run: async page => {
            await page.evaluate(() => window.benchScenario?.run(300))
        }
    }
]
