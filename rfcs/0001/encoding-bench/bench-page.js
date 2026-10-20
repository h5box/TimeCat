// Runs inside Chromium. Compares wire encodings for session-replay data.
// Exposes window.runBench() -> results object.

function buildPage(cards) {
    const star =
        '<svg class="h-4 w-4 text-yellow-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>'
    const parts = []
    parts.push(
        '<header class="site-header sticky top-0 z-50 bg-white shadow"><nav class="container mx-auto flex items-center justify-between px-4 py-3">'
    )
    for (let i = 0; i < 12; i++) {
        parts.push(
            `<a class="nav-link text-sm font-medium text-gray-700 hover:text-black" href="/category/${i}">Category ${i}</a>`
        )
    }
    parts.push('</nav></header><main class="container mx-auto grid grid-cols-4 gap-6 px-4">')
    for (let i = 0; i < cards; i++) {
        const id = 100000 + i
        parts.push(`
<article class="product-card rounded-lg border border-gray-200 p-4 shadow-sm hover:shadow-md" data-product-id="${id}" data-testid="product-card">
  <a class="block aspect-square overflow-hidden rounded" href="/p/${id}/awesome-product-${i}"><img class="h-full w-full object-cover" src="https://cdn.example.com/img/${id}.jpg?w=400&amp;h=400" alt="Awesome product ${i}" loading="lazy" width="400" height="400"></a>
  <h3 class="mt-3 line-clamp-2 text-base font-semibold text-gray-900">Awesome Product ${i} - Limited Edition with an Extra Long Name</h3>
  <div class="mt-1 flex items-center gap-1" aria-label="Rated 4.5 out of 5">${star.repeat(
      5
  )}<span class="ml-1 text-xs text-gray-500">(${(i * 37) % 1000} reviews)</span></div>
  <p class="mt-2 text-lg font-bold text-gray-900">$${((i * 13.37) % 500).toFixed(2)}</p>
  <div class="mt-3 flex gap-2"><button class="btn btn-primary flex-1 rounded bg-black px-3 py-2 text-sm text-white" type="button">Add to cart</button><button class="btn btn-secondary rounded border px-3 py-2 text-sm" type="button" aria-label="Add to wishlist">&#9825;</button></div>
</article>`)
    }
    parts.push('</main>')
    document.body.innerHTML = parts.join('')
}

// --- Serializers -----------------------------------------------------------

let nextId = 1

// TimeCat 1.x style: nested objects with named keys.
function toObjectTree(node) {
    const id = nextId++
    if (node.nodeType === 1) {
        const attrs = {}
        for (const a of node.attributes) attrs[a.name] = a.value
        const children = []
        for (let c = node.firstChild; c; c = c.nextSibling) children.push(toObjectTree(c))
        return { id, type: 1, tag: node.localName, attrs, children, extra: {} }
    }
    return { id, type: node.nodeType, value: node.nodeValue }
}

// Compact tuples: element = [id, tag, flatAttrs|0, children], text = [id, value].
function toTupleTree(node) {
    const id = nextId++
    if (node.nodeType === 1) {
        let attrs = 0
        if (node.attributes.length) {
            attrs = []
            for (const a of node.attributes) attrs.push(a.name, a.value)
        }
        const children = []
        for (let c = node.firstChild; c; c = c.nextSibling) children.push(toTupleTree(c))
        return [id, node.localName, attrs, children]
    }
    return [id, node.nodeValue]
}

// --- Helpers -----------------------------------------------------------------

const enc = new TextEncoder()
const dec = new TextDecoder()

async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer())
}

async function time(fn, iterations = 9) {
    await fn() // warm-up
    const samples = []
    let result
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        result = await fn()
        samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    return { ms: +samples[Math.floor(samples.length / 2)].toFixed(2), result }
}

function countNodes(n) {
    let c = 1
    for (let x = n.firstChild; x; x = x.nextSibling) c += countNodes(x)
    return c
}

// Smooth-ish pointer path, ~60 Hz with jitter.
function pointerEvents(n) {
    const out = []
    let x = 500,
        y = 400,
        t = 0,
        vx = 0,
        vy = 0
    for (let i = 0; i < n; i++) {
        vx = vx * 0.9 + (Math.random() - 0.5) * 6
        vy = vy * 0.9 + (Math.random() - 0.5) * 6
        x = Math.max(0, Math.min(1920, Math.round(x + vx)))
        y = Math.max(0, Math.min(1080, Math.round(y + vy)))
        t += 16 + Math.round(Math.random() * 3)
        out.push({ x, y, t })
    }
    return out
}

function zigzag(v) {
    return (v << 1) ^ (v >> 31)
}

// Columnar delta + LEB128 varint encoding for [t, x, y] streams.
function encodeColumnar(points) {
    const buf = new Uint8Array(points.length * 3 * 5)
    let o = 0
    const put = v => {
        v = zigzag(v) >>> 0
        while (v > 0x7f) {
            buf[o++] = (v & 0x7f) | 0x80
            v >>>= 7
        }
        buf[o++] = v
    }
    let pt = 0,
        px = 0,
        py = 0
    for (const p of points) put(p.t - pt), (pt = p.t)
    for (const p of points) put(p.x - px), (px = p.x)
    for (const p of points) put(p.y - py), (py = p.y)
    return buf.subarray(0, o)
}

// Single-pass DOM -> binary writer. Node ids are implicit (DFS order), repeated
// strings (tags, attr names, short attr values) go through a string table.
class BinaryWriter {
    constructor(size = 1 << 16) {
        this.buf = new Uint8Array(size)
        this.o = 0
        this.strings = new Map()
    }
    ensure(n) {
        if (this.o + n <= this.buf.length) return
        let size = this.buf.length * 2
        while (size < this.o + n) size *= 2
        const next = new Uint8Array(size)
        next.set(this.buf.subarray(0, this.o))
        this.buf = next
    }
    u8(v) {
        this.ensure(1)
        this.buf[this.o++] = v
    }
    varint(v) {
        this.ensure(5)
        while (v > 0x7f) {
            this.buf[this.o++] = (v & 0x7f) | 0x80
            v >>>= 7
        }
        this.buf[this.o++] = v
    }
    rawStr(s) {
        // worst case 3 bytes per UTF-16 unit; encode after a 5-byte gap, then
        // write a minimal varint length and close the gap.
        this.ensure(5 + s.length * 3)
        const start = this.o
        const { written } = enc.encodeInto(s, this.buf.subarray(start + 5))
        this.o = start
        this.varint(written)
        if (this.o !== start + 5) this.buf.copyWithin(this.o, start + 5, start + 5 + written)
        this.o += written
    }
    // Table-backed string: index ref if seen before, else inline + register.
    str(s) {
        const ref = this.strings.get(s)
        if (ref !== undefined) return this.varint(ref + 1)
        this.varint(0)
        this.rawStr(s)
        if (s.length <= 64) this.strings.set(s, this.strings.size)
    }
}

const OP_ELEMENT = 1,
    OP_TEXT = 3,
    OP_COMMENT = 8

function writeNode(w, node) {
    const t = node.nodeType
    if (t === 1) {
        w.u8(OP_ELEMENT)
        w.str(node.localName)
        const attrs = node.attributes
        w.varint(attrs.length)
        for (let i = 0; i < attrs.length; i++) {
            w.str(attrs[i].name)
            w.str(attrs[i].value)
        }
        w.varint(node.childNodes.length)
        for (let c = node.firstChild; c; c = c.nextSibling) writeNode(w, c)
    } else {
        w.u8(t === 3 ? OP_TEXT : OP_COMMENT)
        w.rawStr(node.nodeValue)
    }
}

function encodeBinarySnapshot(root) {
    const w = new BinaryWriter()
    writeNode(w, root)
    return w.buf.subarray(0, w.o)
}

// Decoder back to tuple form, to measure the read side.
function decodeBinarySnapshot(bytes) {
    let o = 0
    let id = 1
    const table = []
    const varint = () => {
        let v = 0,
            shift = 0,
            b
        do {
            b = bytes[o++]
            v |= (b & 0x7f) << shift
            shift += 7
        } while (b & 0x80)
        return v >>> 0
    }
    const rawStr = () => {
        const len = varint()
        const s = dec.decode(bytes.subarray(o, o + len))
        o += len
        return s
    }
    const str = () => {
        const ref = varint()
        if (ref) return table[ref - 1]
        const s = rawStr()
        if (s.length <= 64) table.push(s)
        return s
    }
    const readNode = () => {
        const op = bytes[o++]
        if (op === OP_ELEMENT) {
            const nodeId = id++
            const tag = str()
            const n = varint()
            const attrs = n ? [] : 0
            for (let i = 0; i < n; i++) attrs.push(str(), str())
            const count = varint()
            const children = new Array(count)
            for (let i = 0; i < count; i++) children[i] = readNode()
            return [nodeId, tag, attrs, children]
        }
        return [id++, rawStr()]
    }
    return readNode()
}

// --- Bench -------------------------------------------------------------------

window.runBench = async function (cards) {
    const { Packr, unpack } = window.msgpackr
    buildPage(cards)
    const root = document.documentElement
    const nodeCount = countNodes(root)

    const res = { browser: navigator.userAgent.match(/Chrome\/[\d.]+/)[0], nodeCount, snapshot: {}, pointer: {} }

    const serObj = await time(() => ((nextId = 1), toObjectTree(root)))
    const serTup = await time(() => ((nextId = 1), toTupleTree(root)))
    res.snapshot.serialize_ms = { objectTree: serObj.ms, tupleTree: serTup.ms }

    const objTree = serObj.result
    const tupTree = serTup.result
    const packPlain = new Packr({ useRecords: false })
    const packRecords = new Packr({ useRecords: true })

    const candidates = {
        'json(objects)': () => enc.encode(JSON.stringify(objTree)),
        'json(tuples)': () => enc.encode(JSON.stringify(tupTree)),
        'msgpackr(objects)': () => packPlain.pack(objTree),
        'msgpackr+records(objects)': () => packRecords.pack(objTree),
        'msgpackr(tuples)': () => packPlain.pack(tupTree)
    }
    const decoders = {
        'json(objects)': b => JSON.parse(dec.decode(b)),
        'json(tuples)': b => JSON.parse(dec.decode(b)),
        'msgpackr(objects)': b => packPlain.unpack(b),
        'msgpackr+records(objects)': b => packRecords.unpack(b),
        'msgpackr(tuples)': b => packPlain.unpack(b)
    }

    for (const [name, fn] of Object.entries(candidates)) {
        const encoded = await time(fn)
        const bytes = encoded.result
        const gz = await time(() => pipe(bytes, new CompressionStream('gzip')))
        const draw = await time(() => pipe(bytes, new CompressionStream('deflate-raw')))
        const decoded = await time(async () => decoders[name](await pipe(gz.result, new DecompressionStream('gzip'))))
        res.snapshot[name] = {
            encode_ms: encoded.ms,
            raw_kb: +(bytes.length / 1024).toFixed(1),
            gzip_ms: gz.ms,
            gzip_kb: +(gz.result.length / 1024).toFixed(1),
            deflateRaw_kb: +(draw.result.length / 1024).toFixed(1),
            gunzip_plus_decode_ms: decoded.ms
        }
    }

    // Main-thread cost of each strategy for handing a snapshot to a worker.
    const stringifyOnly = await time(() => JSON.stringify(tupTree))
    const clone = await time(() => structuredClone(tupTree))
    const bin = await time(() => encodeBinarySnapshot(root))
    const binBytes = bin.result.slice()
    const binGz = await time(() => pipe(binBytes, new CompressionStream('gzip')))
    const binDecode = await time(async () =>
        decodeBinarySnapshot(await pipe(binGz.result, new DecompressionStream('gzip')))
    )
    const roundTrip =
        JSON.stringify(decodeBinarySnapshot(binBytes)) === JSON.stringify(((nextId = 1), toTupleTree(root)))
    res.snapshot['single-pass binary (DOM walk included)'] = {
        encode_ms: bin.ms,
        raw_kb: +(binBytes.length / 1024).toFixed(1),
        gzip_ms: binGz.ms,
        gzip_kb: +(binGz.result.length / 1024).toFixed(1),
        gunzip_plus_decode_ms: binDecode.ms,
        roundTripMatchesTupleTree: roundTrip
    }
    res.mainThread_ms = {
        'walk + JSON.stringify + TextEncoder': +(serTup.ms + res.snapshot['json(tuples)'].encode_ms).toFixed(1),
        'walk + JSON.stringify (no TextEncoder)': +(serTup.ms + stringifyOnly.ms).toFixed(1),
        'walk + structuredClone (postMessage objects)': +(serTup.ms + clone.ms).toFixed(1),
        'walk + msgpackr(tuples), transfer buffer': +(serTup.ms + res.snapshot['msgpackr(tuples)'].encode_ms).toFixed(
            1
        ),
        'single-pass binary, transfer buffer': bin.ms
    }

    // High-frequency stream: 20k pointer moves (~5.5 minutes at 60 Hz).
    const points = pointerEvents(20000)
    const timecatStyle = points.map(p => ({
        type: 4,
        data: { type: 0, x: p.x, y: p.y },
        relatedId: 'f1d2e3c4b5a6',
        time: 1760000000000 + p.t
    }))
    const tuples = points.map(p => [p.t, p.x, p.y])
    const streams = {
        'json(timecat 1.x objects)': () => enc.encode(JSON.stringify(timecatStyle)),
        'json(tuples)': () => enc.encode(JSON.stringify(tuples)),
        'columnar delta varint': () => encodeColumnar(points)
    }
    for (const [name, fn] of Object.entries(streams)) {
        const encoded = await time(fn)
        const gz = await time(() => pipe(encoded.result, new CompressionStream('gzip')))
        res.pointer[name] = {
            encode_ms: encoded.ms,
            raw_kb: +(encoded.result.length / 1024).toFixed(1),
            gzip_kb: +(gz.result.length / 1024).toFixed(1)
        }
    }
    return res
}
