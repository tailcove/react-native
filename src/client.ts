import { formatError } from './exception.js';
import { hookUncaughtErrors, hookUnhandledRejections } from './handlers.js';
import { normalizeLevel } from './levels.js';
import { deviceContext, onBackground, osName } from './native.js';
import { PersistentQueue } from './queue.js';
import { sendBatch } from './transport.js';
import type { Destination } from './transport.js';
import type { LogContext, LogLevel, LogLine, TailcoveOptions } from './types.js';

const DEFAULT_ENDPOINT = 'https://ingest.tailcove.dev/api/v1/app/logs';
const MAX_BREADCRUMBS = 20;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

interface Breadcrumb {
    ts: string;
    level: LogLevel;
    message: string;
}

/**
 * Sends a React Native app's logs and errors to a Tailcove source. Lines wait in a queue and go out in batches (up to
 * `batchSize`, or `flushIntervalMs` after the first), with the app key and app id in headers. A batch that fails for a
 * reason that may pass (offline, 429, 5xx) stays queued and is retried with backoff; with `storage` the queue survives
 * restarts and crashes. Every line carries the app id and version, the OS, the device and a session id. Never throws.
 */
export class Tailcove {
    private static current: Tailcove | null = null;

    private readonly destination: Destination;
    private readonly batchSize: number;
    private readonly flushIntervalMs: number;
    private readonly traceLimit: number;
    private readonly enabled: boolean;
    private readonly onError?: (error: unknown) => void;
    private readonly queue: PersistentQueue;
    private readonly baseContext: LogContext;
    private readonly host: string;
    private readonly cleanups: Array<() => void> = [];

    private context: LogContext;
    private closed = false;
    private breadcrumbs: Breadcrumb[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private sending: Promise<void> | null = null;
    private backoffMs = 0;
    private retryAt = 0;

    /** Creates the client and makes it `Tailcove.instance`. */
    static init(options: TailcoveOptions): Tailcove {
        Tailcove.current?.close();
        Tailcove.current = new Tailcove(options);

        return Tailcove.current;
    }

    /** The client init() made; a silent one before that, so a log call never crashes the app. */
    static get instance(): Tailcove {
        Tailcove.current ??= new Tailcove({ appKey: '', appId: '', enabled: false });

        return Tailcove.current;
    }

    constructor(options: TailcoveOptions) {
        this.enabled = (options.enabled ?? true) && options.appKey !== '';
        this.onError = options.onError;
        this.destination = {
            endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
            appKey: options.appKey,
            appId: options.appId,
            timeoutMs: options.timeoutMs ?? 10_000,
            fetch: options.fetch ?? ((...args) => fetch(...args)),
        };
        this.batchSize = Math.max(1, options.batchSize ?? 50);
        this.flushIntervalMs = options.flushIntervalMs ?? 5000;
        this.traceLimit = options.traceLimit ?? 20;
        this.host = osName();
        this.baseContext = {
            ...deviceContext(),
            app: { id: options.appId, ...(options.release ? { version: options.release } : {}) },
            ...(options.environment ? { environment: options.environment } : {}),
            session_id: sessionId(),
        };
        this.context = { ...(options.context ?? {}) };
        this.queue = new PersistentQueue(
            Math.max(1, options.maxQueueSize ?? 1000),
            this.enabled ? options.storage : undefined,
            (error) => this.handleError(error),
        );

        if (!this.enabled) {
            return;
        }

        // Lines kept from an earlier launch go out as soon as they are back.
        void this.queue.ready().then(() => this.queue.size > 0 && this.scheduleFlush());

        this.cleanups.push(onBackground(() => void this.flush().then(() => this.queue.save())));

        if (options.captureErrors ?? true) {
            this.cleanups.push(
                hookUncaughtErrors((error, isFatal) => this.reportUncaught(error, isFatal)),
            );
        }

        if (options.captureRejections ?? true) {
            hookUnhandledRejections((reason) =>
                this.captureException(reason, { unhandled_rejection: true }),
            );
        }
    }

    log(level: LogLevel | string, message: string, context: LogContext = {}): void {
        if (!this.enabled) {
            return;
        }

        try {
            const normalized = normalizeLevel(level);
            const ts = new Date().toISOString();

            this.queue.push({
                message,
                level: normalized,
                context: { ...this.baseContext, ...this.context, ...context },
                host: this.host,
                ts,
            });
            this.remember({ ts, level: normalized, message });

            if (this.queue.size >= this.batchSize) {
                void this.flush();
            } else {
                this.scheduleFlush();
            }
        } catch (error) {
            this.handleError(error);
        }
    }

    debug(message: string, context?: LogContext): void {
        this.log('debug', message, context);
    }

    info(message: string, context?: LogContext): void {
        this.log('info', message, context);
    }

    notice(message: string, context?: LogContext): void {
        this.log('notice', message, context);
    }

    warning(message: string, context?: LogContext): void {
        this.log('warning', message, context);
    }

    /** Alias for warning(), the name console.warn suggests. */
    warn(message: string, context?: LogContext): void {
        this.warning(message, context);
    }

    error(message: string, context?: LogContext): void {
        this.log('error', message, context);
    }

    critical(message: string, context?: LogContext): void {
        this.log('critical', message, context);
    }

    alert(message: string, context?: LogContext): void {
        this.log('alert', message, context);
    }

    emergency(message: string, context?: LogContext): void {
        this.log('emergency', message, context);
    }

    /**
     * Reports a caught error as an `error` line with the exception shape every Tailcove client sends (so it groups into
     * an issue) and the last log calls before it as breadcrumbs.
     */
    captureException(error: unknown, context: LogContext = {}, level: LogLevel = 'error'): void {
        if (!this.enabled) {
            return;
        }

        const exception = formatError(error, this.traceLimit);

        this.log(level, exception.message === '' ? exception.class : exception.message, {
            ...context,
            exception,
            breadcrumbs: this.breadcrumbs.slice(),
        });
    }

    /** Adds a step to the trail sent with the next error, without sending a line of its own. */
    addBreadcrumb(message: string, level: LogLevel = 'info'): void {
        this.remember({ ts: new Date().toISOString(), level, message });
    }

    /** The signed-in user's id on every following line (only an id: no name or email is ever sent). Null clears it. */
    setUser(id: string | number | null): void {
        if (id === null) {
            delete this.context.user;
        } else {
            this.context.user = { id: String(id) };
        }
    }

    /** Merges keys into the context of every following line; a key set to undefined is removed. */
    setContext(values: LogContext): void {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) {
                delete this.context[key];
            } else {
                this.context[key] = value;
            }
        }
    }

    /** Sends what is waiting now, batch after batch, until the queue is empty or a send fails. Never throws. */
    flush(): Promise<void> {
        if (!this.enabled) {
            return Promise.resolve();
        }

        this.sending ??= this.drain().finally(() => {
            this.sending = null;

            // Lines left after a failed attempt, or written meanwhile, wait for the next timer (backoff included).
            if (this.queue.size > 0 && !this.closed) {
                this.scheduleFlush();
            }
        });

        return this.sending;
    }

    /** Sends and saves what is waiting, and stops the timers and error hooks. */
    async close(): Promise<void> {
        this.closed = true;
        this.cleanups.splice(0).forEach((cleanup) => cleanup());

        if (Tailcove.current === this) {
            Tailcove.current = null;
        }

        await this.flush();
        await this.queue.save();

        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private async drain(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        await this.queue.ready();

        if (Date.now() < this.retryAt) {
            return;
        }

        while (this.queue.size > 0) {
            const batch = this.queue.peek(this.batchSize);
            const result = await sendBatch(this.destination, batch);

            if (result.kind === 'retry') {
                this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs === 0 ? 1000 : this.backoffMs * 2);
                this.retryAt = Date.now() + (result.retryAfterMs ?? this.backoffMs);
                this.handleError(result.error);

                return;
            }

            if (result.kind === 'drop') {
                this.handleError(result.error);
            }

            this.queue.ack(batch);
            this.backoffMs = 0;
            this.retryAt = 0;
        }
    }

    private async reportUncaught(error: unknown, isFatal: boolean): Promise<void> {
        this.captureException(error, { fatal: isFatal, handled: false }, isFatal ? 'critical' : 'error');

        if (isFatal) {
            // Saved first: if the app dies before the send completes, the next launch sends it.
            await this.queue.save();
            await this.flush();
        }
    }

    private remember(breadcrumb: Breadcrumb): void {
        this.breadcrumbs.push({ ...breadcrumb, message: breadcrumb.message.slice(0, 200) });

        if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
            this.breadcrumbs.shift();
        }
    }

    private scheduleFlush(): void {
        if (this.timer !== null || this.sending !== null) {
            return;
        }

        const delay = Math.max(this.flushIntervalMs, this.retryAt - Date.now());

        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, delay);
    }

    private handleError(error: unknown): void {
        try {
            this.onError?.(error);
        } catch {
            // onError itself must never throw back into the app.
        }
    }
}

/** A random id for this launch, so one session's lines can be found together. */
function sessionId(): string {
    const bytes = new Uint8Array(8);
    const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;

    if (crypto?.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

