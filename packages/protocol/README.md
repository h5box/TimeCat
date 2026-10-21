# @timecat-js/protocol

The TimeCat recording format (TCR): binary primitives, string tables, the chunk container and the event codec
shared by the recorder, the player and any tooling that reads recordings.

> Pre-release. The wire format is a v0 draft and may change without notice until 1.0.
> Specification: [RFC 0002](../../rfcs/0002-tcr-format.md).

## What is inside

| Export | Purpose |
| --- | --- |
| `ByteWriter` / `ByteReader` | Little-endian primitives: `u8`, LEB128 `varuint`, zigzag `varint`, `f64`, length-prefixed `bytes` and UTF-8 `string`. Every read is bounds-checked and throws `TcrDecodeError` on malformed input. |
| `StringTableWriter` / `StringTableReader` | Writes repeated strings once and references them afterwards. The writer decides what to intern; the reader follows the tags. |
| `writeFileHeader` / `readFileHeader` | Segment header: magic bytes, format version, session id, segment index, start time and JSON metadata. |
| `writeChunk` / `readChunk` / `readFile` | Chunk framing: kind, flags, track, sequence, time range and payload. |
| `gzip` / `gunzip` | Compression through the platform `CompressionStream`, so it adds no bundle weight. |
| `encodeEvent` / `decodeEvent` | Event bodies: DOM snapshots and mutations, input, pointer, scroll, viewport and navigation. Node ids are implied by document order, so decoding carries an `IdCounter` from event to event. |
| `EventWriter` | Streaming encoder for event bodies. The recorder writes DOM trees through it while walking the page, without building objects first. |
| `writeEventFrame` / `readEventFrames` | Event framing inside an events chunk: type, time delta and body. |
| `Track`, `ChunkKind`, `ChunkFlag`, `EventType`, `NodeKind`, … | Protocol constants. |

## Example

```ts
import { ByteWriter, ChunkFlag, ChunkKind, Track, gzip, readFile, writeChunk, writeFileHeader } from '@timecat-js/protocol'

const writer = new ByteWriter()
writeFileHeader(writer, { sessionId: 's-1', segment: 0, startedAt: Date.now(), meta: {} })
writeChunk(writer, {
    kind: ChunkKind.Events,
    track: Track.Dom,
    flags: ChunkFlag.Keyframe | ChunkFlag.Gzip,
    sequence: 0,
    startTime: 0,
    duration: 1000,
    payload: await gzip(new Uint8Array([1, 2, 3]))
})

const { header, chunks } = readFile(writer.finish())
```

Events go into the payload of an events chunk:

```ts
import { ByteWriter, EventType, decodeEvent, encodeEvent, readEventFrames, writeEventFrame } from '@timecat-js/protocol'

const payload = new ByteWriter()
writeEventFrame(payload, EventType.Viewport, 0, encodeEvent({ type: EventType.Viewport, width: 1280, height: 720 }))

const ids = { next: 1 }
for (const frame of readEventFrames(payload.finish(), 0)) {
    const event = decodeEvent(frame.type, frame.body, ids) // undefined for event types this version does not know
}
```

## License

GPL-3.0-or-later
