import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tailcove } from '../src/index.js';
import { client, fakeFetch, linesOf, memoryStorage, settle } from './helpers.js';
import { setAppState } from './react-native-stub.js';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('sending', () => {
    it('batches lines and sends them with the app key and app id in headers', async () => {
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn, release: '2.4.0', environment: 'production' });

        tailcove.info('App started', { screen: 'Home' });
        tailcove.error('Payment failed');
        await tailcove.flush();

        expect(calls).toHaveLength(1);
        const headers = calls[0].init.headers as Record<string, string>;
        expect(calls[0].url).toBe('https://ingest.example.test/api/v1/app/logs');
        expect(headers['X-Tailcove-App-Key']).toBe('tca_' + 'a'.repeat(32));
        expect(headers['X-Tailcove-App-Id']).toBe('com.acme.shop');

        const [first, second] = linesOf(calls[0]);
        expect(first).toMatchObject({ message: 'App started', level: 'info', host: 'ios' });
        expect(first.context).toMatchObject({
            screen: 'Home',
            app: { id: 'com.acme.shop', version: '2.4.0' },
            environment: 'production',
            os: { name: 'ios', version: '18.1' },
            device: { type: 'phone' },
        });
        expect(typeof (first.context as Record<string, unknown>).session_id).toBe('string');
        expect(second).toMatchObject({ message: 'Payment failed', level: 'error' });
    });

    it('sends on its own after the flush interval, and at once when a batch is full', async () => {
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn, batchSize: 3, flushIntervalMs: 5000 });

        tailcove.info('one');
        await vi.advanceTimersByTimeAsync(4999);
        expect(calls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(1);

        tailcove.info('a');
        tailcove.info('b');
        tailcove.info('c');
        await settle();
        expect(calls).toHaveLength(2);
        expect(linesOf(calls[1])).toHaveLength(3);
    });

    it('normalizes unknown levels to info', async () => {
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn });

        tailcove.log('LOUD', 'hi');
        await tailcove.flush();

        expect(linesOf(calls[0])[0].level).toBe('info');
    });

    it('sends what is waiting when the app goes to the background', async () => {
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn });

        tailcove.info('before background');
        setAppState('background');
        await settle();

        expect(calls).toHaveLength(1);
        await tailcove.close();
    });

    it('stays silent when disabled or without a key, and before init', async () => {
        const { fn, calls } = fakeFetch(202);

        client({ fetch: fn, enabled: false }).error('nope');
        client({ fetch: fn, appKey: '' }).error('nope');
        Tailcove.instance.error('before init');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(calls).toHaveLength(0);
    });
});

describe('failures', () => {
    it('keeps a batch the server could not take and retries it with backoff', async () => {
        const errors: unknown[] = [];
        const { fn, calls } = fakeFetch(new TypeError('Network request failed'), 503, 202);
        const tailcove = client({ fetch: fn, flushIntervalMs: 100, onError: (error) => errors.push(error) });

        tailcove.info('offline line');
        await tailcove.flush();
        expect(calls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(2000);
        expect(calls).toHaveLength(3);
        expect(linesOf(calls[2])[0].message).toBe('offline line');
        expect(errors).toHaveLength(2);

        await tailcove.flush();
        expect(calls).toHaveLength(3);
    });

    it('waits as long as Retry-After says on a 429', async () => {
        const calls: number[] = [];
        const fetchFn = (async () => {
            calls.push(Date.now());

            return calls.length === 1
                ? new Response(null, { status: 429, headers: { 'Retry-After': '30' } })
                : new Response(null, { status: 202 });
        }) as unknown as typeof fetch;
        const tailcove = client({ fetch: fetchFn, flushIntervalMs: 100 });

        tailcove.info('rate limited');
        await tailcove.flush();
        await vi.advanceTimersByTimeAsync(29_000);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_100);
        expect(calls).toHaveLength(2);
    });

    it('drops a batch the server refuses for good, and moves on', async () => {
        const errors: unknown[] = [];
        const { fn, calls } = fakeFetch(403, 202);
        const tailcove = client({ fetch: fn, batchSize: 1, onError: (error) => errors.push(error) });

        tailcove.info('refused');
        await settle();
        tailcove.info('accepted');
        await tailcove.flush();

        expect(calls.map((call) => linesOf(call)[0].message)).toEqual(['refused', 'accepted']);
        expect(String(errors[0])).toContain('403');
    });

    it('never throws, even when onError does', async () => {
        const { fn } = fakeFetch(new Error('boom'));
        const tailcove = client({
            fetch: fn,
            onError: () => {
                throw new Error('onError broke');
            },
        });

        expect(() => tailcove.info('x')).not.toThrow();
        await expect(tailcove.flush()).resolves.toBeUndefined();
    });

    it('drops the oldest lines past maxQueueSize', async () => {
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn, maxQueueSize: 2, batchSize: 10 });

        tailcove.info('1');
        tailcove.info('2');
        tailcove.info('3');
        await tailcove.flush();

        expect(linesOf(calls[0]).map((line) => line.message)).toEqual(['2', '3']);
    });
});

describe('the persistent queue', () => {
    it('saves unsent lines and sends them on the next launch', async () => {
        const storage = memoryStorage();
        const offline = fakeFetch(new TypeError('offline'));
        const first = client({ fetch: offline.fn, storage });

        first.error('written offline');
        await first.flush();
        await vi.advanceTimersByTimeAsync(1000);
        await first.close();
        expect(JSON.parse(storage.data['@tailcove/queue'])[0].message).toBe('written offline');

        const online = fakeFetch(202);
        const second = client({ fetch: online.fn, storage, flushIntervalMs: 100 });
        await vi.advanceTimersByTimeAsync(200);

        expect(online.calls).toHaveLength(1);
        expect(linesOf(online.calls[0])[0].message).toBe('written offline');

        await second.close();
        expect(storage.data['@tailcove/queue']).toBeUndefined();
    });

    it('ignores a stored queue it cannot read', async () => {
        const storage = memoryStorage({ '@tailcove/queue': '{not json' });
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn, storage });

        tailcove.info('fresh');
        await tailcove.flush();

        expect(linesOf(calls[0]).map((line) => line.message)).toEqual(['fresh']);
    });
});

describe('context', () => {
    it('adds the user id (only the id) and custom context to following lines', async () => {
        const { fn, calls } = fakeFetch(202);
        const tailcove = client({ fetch: fn, context: { tenant: 'acme' } });

        tailcove.setUser(42);
        tailcove.setContext({ build: 'beta' });
        tailcove.info('signed in');
        tailcove.setUser(null);
        tailcove.setContext({ build: undefined });
        tailcove.info('signed out');
        await tailcove.flush();

        const [signedIn, signedOut] = linesOf(calls[0]);
        expect(signedIn.context).toMatchObject({ tenant: 'acme', build: 'beta', user: { id: '42' } });
        expect(signedOut.context).not.toHaveProperty('user');
        expect(signedOut.context).not.toHaveProperty('build');
    });

    it('makes init() the shared instance', () => {
        const { fn } = fakeFetch(202);
        const tailcove = Tailcove.init({ appKey: 'tca_' + 'b'.repeat(32), appId: 'com.acme.shop', fetch: fn, captureErrors: false, captureRejections: false });

        expect(Tailcove.instance).toBe(tailcove);
    });
});
