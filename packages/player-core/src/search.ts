/** Number of `values`, sorted ascending, that are at most `value`: the index of the first greater one. */
export function upperBound(values: ArrayLike<number>, value: number): number {
    let low = 0
    let high = values.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (values[middle]! <= value) {
            low = middle + 1
        } else {
            high = middle
        }
    }
    return low
}

/** Number of `values`, sorted ascending, that are less than `value`: the index of the first at least as great. */
export function lowerBound(values: ArrayLike<number>, value: number): number {
    let low = 0
    let high = values.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (values[middle]! < value) {
            low = middle + 1
        } else {
            high = middle
        }
    }
    return low
}
