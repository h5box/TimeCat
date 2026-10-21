/** A script bundled with all it imports into one classic script, as a string (see scripts/worker-source.ts). */
declare module '*?worker-source' {
    const source: string
    export default source
}

declare module '*?script-source' {
    const source: string
    export default source
}
