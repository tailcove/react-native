import type { FormattedException } from './types.js';

// Hermes and V8: "    at fnName (file:line:col)" or "    at file:line:col"; Hermes may add "(address at file:line:col)".
const V8_FRAME = /at\s+(?:.*?\s+)?\(?(?:address at\s+)?(.+?):(\d+):(\d+)\)?$/;

// JavaScriptCore: "fnName@file:line:col".
const JSC_FRAME = /@(.+):(\d+):(\d+)$/;

/**
 * Renders a caught value into the exception shape the other Tailcove clients send (`{class, message, location,
 * trace}`), so a React Native error groups into an issue the way a server one does. The location is the first frame;
 * in a release build that is a position in the bundle, readable once the bundle's source map is applied.
 */
export function formatError(error: unknown, traceLimit = 20): FormattedException {
    if (!(error instanceof Error)) {
        return {
            class: 'Error',
            message: typeof error === 'string' ? error : safeStringify(error),
            location: 'unknown:0',
            trace: [],
        };
    }

    const frames = stackFrames(error.stack);

    return {
        class: error.name || 'Error',
        message: error.message,
        location: frames.length > 0 ? frameLocation(frames[0]) : 'unknown:0',
        trace: frames.slice(0, traceLimit),
    };
}

function stackFrames(stack: string | undefined): string[] {
    if (!stack) {
        return [];
    }

    const lines = stack
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const looksLikeFrame = (line: string): boolean => V8_FRAME.test(line) || JSC_FRAME.test(line);

    return lines.length > 0 && !looksLikeFrame(lines[0]) ? lines.slice(1) : lines;
}

function frameLocation(frame: string): string {
    const match = frame.match(V8_FRAME) ?? frame.match(JSC_FRAME);

    return match ? `${match[1]}:${match[2]}` : 'unknown:0';
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
