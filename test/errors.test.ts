import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatError } from '../src/index.js';
import { client, fakeFetch, linesOf, memoryStorage, settle } from './helpers.js';

type Handler = (error: unknown, isFatal?: boolean) => void;

const scope = globalThis as unknown as {
    ErrorUtils?: { getGlobalHandler(): Handler; setGlobalHandler(handler: Handler): void };
    HermesInternal?: { enablePromiseRejectionTracker?: (options: { onUnhandled: (id: number, reason: unknown) => void }) => void };
};

let installed: Handler;
let previous: ReturnType<typeof vi.fn>;

beforeEach(() => {
    previous = vi.fn();
    installed = previous as unknown as Handler;
    scope.ErrorUtils = {
        getGlobalHandler: () => installed,
        setGlobalHandler: (handler) => {
            installed = handler;
        },
    };
});

afterEach(() => {
    delete scope.ErrorUtils;
    delete scope.HermesInternal;
    vi.useRealTimers();
});

describe('uncaught errors', () => {
    it('reports an uncaught error with its exception and breadcrumbs, then hands it on', async () => {
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn, captureErrors: true });

        tailcove.info('opened cart');
        tailcove.addBreadcrumb('tapped pay');
        installed(new TypeError("undefined is not an object (evaluating 'cart.total')"), false);

        expect(previous).toHaveBeenCalledTimes(1);
        await tailcove.flush();

        const line = linesOf(calls[0]).find((entry) => entry.level === 'error');
        const context = line?.context as Record<string, unknown>;
        expect(line?.message).toBe("undefined is not an object (evaluating 'cart.total')");
        expect(context.exception).toMatchObject({ class: 'TypeError' });
        expect(context).toMatchObject({ fatal: false, handled: false });
        expect((context.breadcrumbs as Array<{ message: string }>).map((crumb) => crumb.message)).toEqual(['opened cart', 'tapped pay']);
    });

    it('saves and sends a fatal error before the app is handed to the crash', async () => {
        const storage = memoryStorage();
        const { fn, calls } = fakeFetch(202);
        client({ fetch: fn, captureErrors: true, storage });

        installed(new Error('render crashed'), true);
        expect(previous).not.toHaveBeenCalled();
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(previous).toHaveBeenCalledTimes(1);
        expect(linesOf(calls[0])[0]).toMatchObject({ level: 'critical', message: 'render crashed' });
    });

    it('hands a fatal error on after a while even when nothing can be sent', async () => {
        vi.useFakeTimers();
        const fetchFn = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
        client({ fetch: fetchFn, captureErrors: true, timeoutMs: 60_000 });

        installed(new Error('stuck'), true);
        await vi.advanceTimersByTimeAsync(1499);
        expect(previous).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(previous).toHaveBeenCalledTimes(1);
    });

    it('puts the previous handler back on close', async () => {
        const { fn } = fakeFetch(202);
        const tailcove = client({ fetch: fn, captureErrors: true });

        expect(installed).not.toBe(previous);
        await tailcove.close();
        expect(installed).toBe(previous);
    });
});

describe('unhandled rejections', () => {
    it('reports rejections through Hermes', async () => {
        let onUnhandled: ((id: number, reason: unknown) => void) | undefined;
        scope.HermesInternal = { enablePromiseRejectionTracker: (options) => (onUnhandled = options.onUnhandled) };
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn, captureRejections: true });

        onUnhandled?.(1, new Error('fetch /api/cart failed'));
        await tailcove.flush();

        expect(linesOf(calls[0])[0]).toMatchObject({ level: 'error', message: 'fetch /api/cart failed' });
        expect(linesOf(calls[0])[0].context).toMatchObject({ unhandled_rejection: true });
    });
});

describe('formatError', () => {
    it('reads Hermes and JavaScriptCore frames', () => {
        const hermes = new Error('boom');
        hermes.stack = 'Error: boom\n    at onPress (address at index.android.bundle:1:23456)\n    at anonymous (index.android.bundle:1:999)';
        const jsc = new Error('boom');
        jsc.stack = 'onPress@main.jsbundle:1:5678\nanonymous@main.jsbundle:1:12';

        expect(formatError(hermes)).toMatchObject({ class: 'Error', location: 'index.android.bundle:1', trace: [expect.stringContaining('onPress'), expect.any(String)] });
        expect(formatError(jsc).location).toBe('main.jsbundle:1');
        expect(formatError('a string')).toEqual({ class: 'Error', message: 'a string', location: 'unknown:0', trace: [] });
    });
});
