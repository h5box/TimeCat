/** The URLs of style sheets: `url(...)`, quoted or not, and `@import` with a string. */
const CSS_URL = /\burl\(\s*(['"]?)((?:\\.|[^\\])*?)\1\s*\)|@import\s+(['"])((?:\\.|[^\\])*?)\3/gi

/**
 * `text`, a style sheet loaded from `base`, with its relative URLs made absolute, so it can load from elsewhere.
 * `replace` can give another URL for an absolute `http:` or `https:` one, such as the replay's for a recorded one.
 */
export function cssUrls(text: string, base: string, replace?: (url: string) => string | undefined): string {
    return text.replaceAll(
        CSS_URL,
        (match, _quote: string, url: string | undefined, _importQuote: string, imported: string | undefined) => {
            const value = url ?? imported ?? ''
            // A fragment alone refers to the document the sheet applies to, wherever it came from.
            if (value === '' || value.startsWith('#')) {
                return match
            }
            const absolute = /^[a-z][\w+.-]*:/i.test(value)
            if (absolute && (replace === undefined || !/^https?:/i.test(value))) {
                return match
            }
            const href = URL.parse(value, base)?.href
            if (href === undefined) {
                return match
            }
            const replaced = replace?.(href)
            if (replaced === undefined && absolute) {
                return match
            }
            // URLs serialize `"` and `\` escaped.
            return url === undefined ? `@import "${replaced ?? href}"` : `url("${replaced ?? href}")`
        }
    )
}
