import { vi } from 'vitest';
import { Tailcove } from '../src/index.js';
import type { QueueStorage, TailcoveOptions } from '../src/index.js';

export type FetchCall = { url: string; init: RequestInit };

/** A fetch that answers with the given statuses in turn (the last one repeats), recording each call. */
export function fakeFetch(...statuses: Array<number | Error>) {
    const calls: FetchCall[] = [];
    const answers = statuses.length > 0 ? statuses : [202];

    const fn = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)];

        if (answer instanceof Error) {
            throw answer;
        }

        return new Response(null, { status: answer });
    });

    return { fn: fn as unknown as typeof fetch, calls };
}

export function linesOf(call: FetchCall): Array<Record<string, unknown>> {
    return JSON.parse(call.init.body as string) as Array<Record<string, unknown>>;
}

export function memoryStorage(initial: Record<string, string> = {}): QueueStorage & { data: Record<string, string> } {
    const data = { ...initial };

    return {
        data,
        getItem: async (key) => data[key] ?? null,
        setItem: async (key, value) => {
            data[key] = value;
        },
        removeItem: async (key) => {
            delete data[key];
        },
    };
}

export function client(options: Partial<TailcoveOptions> & { fetch: typeof fetch }): Tailcove {
    return new Tailcove({
        appKey: 'tca_' + 'a'.repeat(32),
        appId: 'com.acme.shop',
        endpoint: 'https://ingest.example.test/api/v1/app/logs',
        captureErrors: false,
        captureRejections: false,
        ...options,
    });
}

/** Lets promise chains inside flush() settle. */
export async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
}
