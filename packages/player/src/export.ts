import type { RecordingSource } from '@timecat-js/player-core'
import { ByteReader, readFileHeader } from '@timecat-js/protocol'
import { RECORDING_TYPE, toBase64 } from './embed.ts'

export interface ExportOptions {
    /** Title of the page. By default, when recording started. */
    title?: string | undefined
    /** Starts playing once the page opens. */
    autoplay?: boolean | undefined
}

/**
 * Writes a recording, one segment or all of a session, as one HTML page that plays it: the `<timecat-player>`
 * element as a script and the segments in base64, with nothing to fetch. Rejects with a `TcrDecodeError` for a
 * segment that is not a recording, and with a `RangeError` for segments of different sessions.
 */
export async function exportHtml(
    recording: RecordingSource | readonly RecordingSource[],
    options: ExportOptions = {}
): Promise<Blob> {
    const segments = await Promise.all((isList(recording) ? recording : [recording]).map(toBytes))
    const headers = segments.map(bytes => readFileHeader(new ByteReader(bytes)))
    const [first] = headers
    if (first === undefined) {
        throw new TypeError('a recording has at least one segment')
    }
    if (headers.some(header => header.sessionId !== first.sessionId)) {
        throw new RangeError('the segments are of different sessions')
    }
    // The element's script is large, so it loads when a page is written.
    const { default: standalone } = await import('./standalone.ts?script-source')
    const title = options.title ?? `TimeCat recording, ${new Date(first.startedAt).toISOString().slice(0, 16)}Z`
    const parts: string[] = [
        '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
        '<meta name="color-scheme" content="light dark">\n',
        `<title>${escapeHtml(title)}</title>\n`,
        '<style>html, body { height: 100%; margin: 0 } timecat-player { height: 100% }</style>\n',
        `</head>\n<body>\n<timecat-player${options.autoplay === true ? ' autoplay' : ''}>\n`
    ]
    for (const bytes of segments) {
        parts.push(`<script type="${RECORDING_TYPE}">\n`, ...toBase64(bytes).map(line => `${line}\n`), '</script>\n')
    }
    // After the element, so that its children are there when it is defined.
    parts.push('</timecat-player>\n<script>', escapeScript(standalone), '</script>\n</body>\n</html>\n')
    return new Blob(parts, { type: 'text/html' })
}

function isList(source: RecordingSource | readonly RecordingSource[]): source is readonly RecordingSource[] {
    return Array.isArray(source)
}

async function toBytes(source: RecordingSource): Promise<Uint8Array> {
    if (ArrayBuffer.isView(source)) {
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    }
    return new Uint8Array('arrayBuffer' in source ? await source.arrayBuffer() : source)
}

function escapeHtml(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Keeps a script from ending its `<script>` element early, with escapes that mean the same in strings and regexps. */
function escapeScript(script: string): string {
    return script.replaceAll(/<\/(script)/giu, '<\\/$1').replaceAll('<!--', '<\\x21--')
}
