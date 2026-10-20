export { gunzip, gzip } from './compression.ts'
export {
    ChunkFlag,
    ChunkKind,
    FORMAT_VERSION,
    MAGIC,
    readChunk,
    readFile,
    readFileHeader,
    writeChunk,
    writeFileHeader
} from './container.ts'
export type { Chunk, FileHeader, SegmentInfo } from './container.ts'
export { TcrDecodeError } from './errors.ts'
export { ByteReader } from './reader.ts'
export { StringTableReader, StringTableWriter } from './strings.ts'
export { FIRST_DYNAMIC_TRACK, Track } from './tracks.ts'
export { ByteWriter } from './writer.ts'
