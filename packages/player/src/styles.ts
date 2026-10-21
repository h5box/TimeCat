import { css } from 'lit'
import type { CSSResult } from 'lit'

/**
 * The look of `<timecat-player>`, which pages change through the `--timecat-*` custom properties and the `stage`,
 * `controls`, `timeline` and `panel` parts. It is light or dark as the system prefers, unless the page sets the
 * element's `color-scheme`.
 */
export const styles: CSSResult = css`
    :host {
        --accent: var(--timecat-accent, light-dark(#2563eb, #60a5fa));
        --background: var(--timecat-background, light-dark(#fff, #18181b));
        --color: var(--timecat-color, light-dark(#18181b, #e4e4e7));
        --muted: var(--timecat-muted, light-dark(#71717a, #a1a1aa));
        --border: var(--timecat-border, light-dark(#e4e4e7, #3f3f46));
        --hover: var(--timecat-hover, light-dark(rgb(0 0 0 / 0.06), rgb(255 255 255 / 0.08)));
        --screen: var(--timecat-screen, light-dark(#f4f4f5, #09090b));
        --error: var(--timecat-error, light-dark(#dc2626, #f87171));
        --warn: var(--timecat-warn, light-dark(#b45309, #fbbf24));
        --custom: var(--timecat-custom, light-dark(#7c3aed, #a78bfa));
        display: flex;
        flex-direction: column;
        position: relative;
        overflow: hidden;
        box-sizing: border-box;
        container-type: inline-size;
        color-scheme: light dark;
        color: var(--color);
        background: var(--background);
        font:
            13px/1.4 system-ui,
            sans-serif;
    }
    :host([hidden]) {
        display: none;
    }
    :host(:fullscreen) {
        width: 100%;
        height: 100%;
    }
    *,
    *::before,
    *::after {
        box-sizing: inherit;
    }
    button,
    select,
    input {
        font: inherit;
        color: inherit;
    }
    button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-width: 28px;
        height: 28px;
        padding: 0 6px;
        border: 0;
        border-radius: 6px;
        background: none;
        cursor: pointer;
    }
    button:hover:not(:disabled),
    button[aria-pressed='true'] {
        background: var(--hover);
    }
    button:disabled {
        opacity: 0.4;
        cursor: default;
    }
    :focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
    }
    svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
    }

    .main {
        position: relative;
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
    }
    .screen {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
        min-height: 150px;
        background: var(--screen);
    }
    .stage {
        width: 100%;
        height: 100%;
    }
    .overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        outline: none;
    }
    .message {
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: 80%;
        padding: 8px 12px;
        border-radius: 8px;
        background: var(--background);
        color: var(--muted);
        cursor: default;
    }
    .message.error {
        color: var(--error);
    }
    .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
        to {
            transform: rotate(1turn);
        }
    }
    .big-play {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 64px;
        height: 64px;
        border-radius: 50%;
        background: rgb(0 0 0 / 0.55);
        color: #fff;
    }
    .big-play svg {
        width: 36px;
        height: 36px;
    }

    .controls {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-top: 1px solid var(--border);
    }
    .time {
        padding: 0 4px;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }
    .timeline {
        position: relative;
        flex: 1 1 auto;
        height: 28px;
        margin: 0 6px;
        cursor: pointer;
        touch-action: none;
    }
    .timeline[aria-disabled='true'] {
        cursor: default;
    }
    @container (width < 480px) {
        .controls {
            flex-wrap: wrap;
            row-gap: 0;
        }
        .timeline {
            flex-basis: 100%;
            order: -1;
        }
        .time {
            margin-right: auto;
        }
    }
    .track {
        position: absolute;
        left: 0;
        right: 0;
        top: 12px;
        height: 4px;
        border-radius: 2px;
        background: var(--border);
    }
    .progress {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        border-radius: inherit;
        background: var(--accent);
    }
    .marker {
        position: absolute;
        top: -3px;
        width: 2px;
        height: 10px;
        margin-left: -1px;
        border-radius: 1px;
        background: var(--error);
        pointer-events: none;
    }
    .marker.custom {
        background: var(--custom);
    }
    .thumb {
        position: absolute;
        top: 8px;
        width: 12px;
        height: 12px;
        margin-left: -6px;
        border-radius: 50%;
        background: var(--accent);
        pointer-events: none;
    }
    .hover {
        position: absolute;
        bottom: 26px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--color);
        color: var(--background);
        font-size: 12px;
        white-space: nowrap;
        transform: translateX(-50%);
        pointer-events: none;
    }
    .speed {
        height: 28px;
        padding: 0 4px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--background);
    }
    .count {
        color: var(--muted);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
    }

    .panel {
        position: relative;
        flex: 0 0 var(--timecat-panel-width, 340px);
        border-left: 1px solid var(--border);
        background: var(--background);
    }
    @container (width < 640px) {
        .panel {
            position: absolute;
            inset: 0;
            z-index: 1;
            border-left: 0;
        }
    }
    .panel-content {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
    }
    .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 2px;
        padding: 6px 6px 0;
    }
    .search {
        margin: 6px;
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--background);
    }
    .none {
        margin: 12px;
        color: var(--muted);
    }
    .entries {
        flex: 1 1 auto;
        overflow: auto;
        margin: 0;
        padding: 0;
        list-style: none;
        border-top: 1px solid var(--border);
    }
    .entry {
        border-bottom: 1px solid var(--border);
    }
    .entry.past {
        background: color-mix(in srgb, var(--accent) 6%, transparent);
    }
    .entry.warn {
        background: color-mix(in srgb, var(--warn) 10%, transparent);
    }
    .entry.error {
        background: color-mix(in srgb, var(--error) 10%, transparent);
    }
    .entry-head {
        justify-content: flex-start;
        gap: 6px;
        width: 100%;
        height: auto;
        min-height: 28px;
        padding: 3px 8px;
        border-radius: 0;
        text-align: left;
    }
    .at {
        flex: none;
        color: var(--muted);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
    }
    .entry:not(.past) .at {
        opacity: 0.6;
    }
    .badge {
        flex: none;
        max-width: 8em;
        overflow: hidden;
        padding: 0 5px;
        border-radius: 4px;
        background: var(--hover);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .error .badge {
        color: var(--error);
    }
    .warn .badge {
        color: var(--warn);
    }
    .badge.custom {
        color: var(--custom);
    }
    .summary {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .detail {
        max-height: 240px;
        overflow: auto;
        margin: 0;
        padding: 4px 8px 8px;
        font:
            12px/1.4 ui-monospace,
            monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
`
