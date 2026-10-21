// Init script of the `timecat` recorder adapter: the recorder as a global, and a summary of what it recorded.
import { ChunkFlag, ChunkKind, gunzip, readEventFrames, readFile } from '@timecat-js/protocol'
import { canvasPlugin } from '@timecat-js/plugin-canvas'
import { record } from '@timecat-js/recorder'

window.timecat = {
    record: canvas => record(canvas ? { plugins: [canvasPlugin()] } : {}),
    recorder: undefined,
    async summarize(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let events = 0
        let rawBytes = bytes.length
        for (const chunk of readFile(bytes).chunks) {
            if (chunk.kind !== ChunkKind.Events) {
                continue
            }
            const payload = chunk.flags & ChunkFlag.Gzip ? await gunzip(chunk.payload) : chunk.payload
            rawBytes += payload.length - chunk.payload.length
            events += readEventFrames(payload, chunk.startTime).length
        }
        return { events, rawBytes }
    }
}
