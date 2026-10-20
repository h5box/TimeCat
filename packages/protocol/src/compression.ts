import { TcrDecodeError } from './errors.ts'

/** gzip via the platform CompressionStream (native code, no bundle cost). */
export function gzip(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    return pipe(data, new CompressionStream('gzip'))
}

/** Inverse of `gzip`. Corrupt input rejects with `TcrDecodeError`. */
export async function gunzip(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    try {
        return await pipe(data, new DecompressionStream('gzip'))
    } catch (error) {
        throw new TcrDecodeError('payload is not valid gzip data', { cause: error })
    }
}

async function pipe(
    data: Uint8Array,
    transform: CompressionStream | DecompressionStream
): Promise<Uint8Array<ArrayBuffer>> {
    // Streams only accept ArrayBuffer-backed chunks; views over shared memory are copied.
    const chunk = isArrayBufferBacked(data) ? data : new Uint8Array(data)
    const source = new ReadableStream<BufferSource>({
        start(controller) {
            controller.enqueue(chunk)
            controller.close()
        }
    })
    return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer())
}

function isArrayBufferBacked(data: Uint8Array): data is Uint8Array<ArrayBuffer> {
    return data.buffer instanceof ArrayBuffer
}
