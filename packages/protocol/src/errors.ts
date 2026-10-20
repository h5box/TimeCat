/** Thrown when bytes do not form a valid TCR structure: truncated, malformed or from an unsupported version. */
export class TcrDecodeError extends Error {
    override name = 'TcrDecodeError'
}
