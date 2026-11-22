import type { LogLine } from './types.js';

/** What became of one delivery attempt. */
export type SendResult =
    | { kind: 'sent' }
    /** Worth trying again later (offline, timeout, 429, 5xx); `retryAfterMs` when the server said how long. */
    | { kind: 'retry'; error: Error; retryAfterMs?: number }
    /** Refused for good (a bad key, an app id not allowed, a malformed batch): sending it again changes nothing. */
    | { kind: 'drop'; error: Error };

export interface Destination {
    endpoint: string;
    appKey: string;
    appId: string;
    timeoutMs: number;
    fetch: typeof fetch;
}

/**
 * POSTs one batch as a JSON array, with the app key and app id in headers (a native app can set them, unlike a
 * browser's sendBeacon). Never throws: the outcome says whether the lines may be sent again.
 */
export async function sendBatch(destination: Destination, batch: readonly LogLine[]): Promise<SendResult> {
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timeout = setTimeout(() => controller?.abort(), destination.timeoutMs);

    try {
        const response = await destination.fetch(destination.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Tailcove-App-Key': destination.appKey,
                'X-Tailcove-App-Id': destination.appId,
            },
            body: JSON.stringify(batch),
            signal: controller?.signal,
        });

        if (response.ok) {
            return { kind: 'sent' };
        }

        const error = new Error(`tailcove: ingest endpoint responded with status ${response.status}`);

        if (response.status === 429 || response.status >= 500 || response.status === 408) {
            return { kind: 'retry', error, retryAfterMs: retryAfter(response.headers.get('Retry-After')) };
        }

        return { kind: 'drop', error };
    } catch (error) {
        return { kind: 'retry', error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
        clearTimeout(timeout);
    }
}

function retryAfter(header: string | null): number | undefined {
    if (header === null) {
        return undefined;
    }

    const seconds = Number(header);

    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) * 1000 : undefined;
}
