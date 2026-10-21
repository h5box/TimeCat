/** A picture of a canvas's bitmap, of the size the bitmap had. */
interface Picture {
    readonly url: string
    readonly width: number
    readonly height: number
    /** Pictures made later have higher numbers. */
    readonly order: number
}

/**
 * Shows the replayed canvases. A document without scripts, as the replay is, shows a canvas's fallback content
 * rather than its bitmap, which leaves it with no size. A picture of the bitmap, put in as the canvas's `content`,
 * shows in its place, and makes it the replaced element of the bitmap's size it was: a canvas nothing was drawn in
 * gets an empty picture of its size.
 */
export class Canvases {
    readonly #pictures = new Map<HTMLCanvasElement, Picture>()
    /** Canvases whose bitmap is being made into a picture, and those drawn in again meanwhile. */
    readonly #encoding = new Set<HTMLCanvasElement>()
    readonly #stale = new Set<HTMLCanvasElement>()
    #made = 0
    #revoked = false

    /** Puts the picture of `canvas` in its style, once the replay made it or changed its attributes. */
    show(canvas: HTMLCanvasElement): void {
        const { width, height } = canvas
        const picture = this.#pictures.get(canvas)
        // A bitmap of another size is a new, empty one.
        const url = picture?.width === width && picture.height === height ? picture.url : emptyPicture(width, height)
        canvas.style.setProperty('content', `url("${url}")`)
    }

    /** Something was drawn in `canvas`: its bitmap becomes the picture it shows. */
    drawn(canvas: HTMLCanvasElement): void {
        if (this.#encoding.has(canvas)) {
            // Taken once the picture being made is done, which spares making those that would show for no time.
            this.#stale.add(canvas)
            return
        }
        const { width, height } = canvas
        const order = this.#made++
        this.#encoding.add(canvas)
        const done = (blob: Blob | null): void => {
            this.#encoding.delete(canvas)
            if (this.#revoked) {
                return
            }
            if (blob !== null) {
                void this.#show(canvas, { url: URL.createObjectURL(blob), width, height, order })
            }
            if (this.#stale.delete(canvas)) {
                this.drawn(canvas)
            }
        }
        try {
            canvas.toBlob(done)
        } catch {
            // A bitmap the replay cannot read.
            done(null)
        }
    }

    /** Revokes the pictures' URLs, once the replay is gone. */
    revoke(): void {
        this.#revoked = true
        for (const { url } of this.#pictures.values()) {
            URL.revokeObjectURL(url)
        }
        this.#pictures.clear()
    }

    async #show(canvas: HTMLCanvasElement, picture: Picture): Promise<void> {
        // Decoded first, so the canvas does not show nothing while its new picture loads.
        const image = new Image()
        image.src = picture.url
        await image.decode().catch(() => undefined)
        const old = this.#pictures.get(canvas)
        // Pictures take turns being made, but not being decoded.
        if (this.#revoked || (old !== undefined && old.order > picture.order)) {
            URL.revokeObjectURL(picture.url)
            return
        }
        this.#pictures.set(canvas, picture)
        this.show(canvas)
        if (old !== undefined) {
            URL.revokeObjectURL(old.url)
        }
        // Canvases the replay no longer shows do not come back: the replay builds new ones for them.
        for (const [shown, { url }] of this.#pictures) {
            if (!shown.isConnected) {
                this.#pictures.delete(shown)
                URL.revokeObjectURL(url)
            }
        }
    }
}

/** An empty picture of a bitmap's size. */
function emptyPicture(width: number, height: number): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
