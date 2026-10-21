/** The type of the `<script>` elements that hold a recording's segments inside a `<timecat-player>`, in base64. */
export const RECORDING_TYPE = 'application/x-timecat-recording'

/** Bytes per line: a multiple of 3, so the lines need no padding and join into one base64 text. */
const LINE = 3 * 8192

/** Encodes bytes as base64, in lines. */
export function toBase64(bytes: Uint8Array): string[] {
    const lines: string[] = []
    for (let start = 0; start < bytes.length; start += LINE) {
        lines.push(btoa(String.fromCharCode(...bytes.subarray(start, start + LINE))))
    }
    return lines
}

/** Decodes base64 text, which may be split by white space. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text.replaceAll(/\s/gu, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}
