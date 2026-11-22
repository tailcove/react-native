/** Syslog-style levels, the set the ingest endpoint normalizes to. Anything else becomes `info`, as on the server. */
export type LogLevel =
    | 'debug'
    | 'info'
    | 'notice'
    | 'warning'
    | 'error'
    | 'critical'
    | 'alert'
    | 'emergency';

export const LOG_LEVELS: readonly LogLevel[] = [
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'critical',
    'alert',
    'emergency',
];

export type LogContext = Record<string, unknown>;

/** The exception shape every Tailcove client sends, so errors group into issues the same way on every platform. */
export interface FormattedException {
    class: string;
    message: string;
    location: string;
    trace: string[];
}

/** One line on the wire. */
export interface LogLine {
    message: string;
    level: LogLevel;
    context: LogContext;
    host: string;
    ts: string;
}

/**
 * Where unsent lines are kept between app launches. `@react-native-async-storage/async-storage` fits as it is; so does
 * any object with these three methods (MMKV, expo-secure-store and the like through a small wrapper).
 */
export interface QueueStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export interface TailcoveOptions {
    /** The source's app key (Settings > Mobile apps). It ships inside the app: public by design. */
    appKey: string;
    /** The app's iOS bundle id or Android package name. It must be one of the app ids allowed for the key. */
    appId: string;
    /** Defaults to `https://ingest.tailcove.dev/api/v1/app/logs`. */
    endpoint?: string;
    /** Send once this many lines are waiting. Defaults to 50. */
    batchSize?: number;
    /** Send this many milliseconds after the first waiting line. Defaults to 5000. */
    flushIntervalMs?: number;
    /** Lines kept while offline; the oldest go first past it. Defaults to 1000. */
    maxQueueSize?: number;
    /** Milliseconds before one delivery attempt gives up. Defaults to 10000. */
    timeoutMs?: number;
    /** Keeps unsent lines across restarts and crashes. Without it they live in memory only. */
    storage?: QueueStorage;
    /** The app version, added to every line as `app.version` (for example from expo-application). */
    release?: string;
    /** `production`, `staging` and the like, added to every line as `environment`. */
    environment?: string;
    /** Merged into every line's context, under the per-call context. */
    context?: LogContext;
    /** Report uncaught JavaScript errors (the red screen, or a crash in release builds). Defaults to true. */
    captureErrors?: boolean;
    /** Report promise rejections nothing handled. Defaults to true. */
    captureRejections?: boolean;
    /** Frames kept per reported error. Defaults to 20. */
    traceLimit?: number;
    /** Set false to keep the client silent: nothing is queued or sent. Defaults to true. */
    enabled?: boolean;
    /** Called when a batch cannot be sent or is refused. Failures are otherwise silent. */
    onError?: (error: unknown) => void;
    /** For tests and custom networking. Defaults to the global fetch. */
    fetch?: typeof fetch;
}
