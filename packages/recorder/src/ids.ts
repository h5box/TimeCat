/**
 * Ids of recorded nodes. A snapshot numbers its nodes 1, 2, 3, ... in document order and later additions
 * continue from there, the same way a reader numbers them while decoding, so ids never appear in the data.
 */
export class NodeIds {
    #ids = new WeakMap<Node, number>()
    /** Id the next written node gets. */
    next = 1

    get(node: Node): number | undefined {
        return this.#ids.get(node)
    }

    has(node: Node): boolean {
        return this.#ids.has(node)
    }

    /** Gives `node` the next id; call in the order nodes are written. */
    assign(node: Node): number {
        const id = this.next++
        this.#ids.set(node, id)
        return id
    }

    delete(node: Node): void {
        this.#ids.delete(node)
    }

    /** Starts a new id space, as a snapshot does. */
    reset(): void {
        this.#ids = new WeakMap()
        this.next = 1
    }
}
