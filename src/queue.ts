import type { LogLine, QueueStorage } from './types.js';

const STORAGE_KEY = '@tailcove/queue';

/**
 * The lines waiting to be sent, oldest first, mirrored to storage when the app gives one, so lines written while
 * offline, or just before a crash, go out on the next launch. Lines leave the queue only once the server took them
 * (take, send, then ack), so an attempt that fails or is cut short loses nothing. Past `maxSize` the oldest go first.
 */
export class PersistentQueue {
    private lines: LogLine[] = [];
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private restored: Promise<void>;

    constructor(
        private readonly maxSize: number,
        private readonly storage: QueueStorage | undefined,
        private readonly onError: (error: unknown) => void,
    ) {
        this.restored = this.restore();
    }

    /** Resolves once the lines of an earlier launch are back in the queue. */
    ready(): Promise<void> {
        return this.restored;
    }

    get size(): number {
        return this.lines.length;
    }

    push(line: LogLine): void {
        this.lines.push(line);
        this.trim();
        this.scheduleSave();
    }

    /** The oldest lines, up to `count`; they stay queued until ack(). */
    peek(count: number): LogLine[] {
        return this.lines.slice(0, count);
    }

    /** Removes lines the server took. By identity, so lines dropped or added meanwhile do not shift anything. */
    ack(batch: readonly LogLine[]): void {
        const sent = new Set(batch);
        this.lines = this.lines.filter((line) => !sent.has(line));
        this.scheduleSave();
    }

    /** Writes the queue to storage now: before a crash handler hands over, or when the app goes to the background. */
    async save(): Promise<void> {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        if (this.storage === undefined) {
            return;
        }

        try {
            if (this.lines.length === 0) {
                await this.storage.removeItem(STORAGE_KEY);
            } else {
                await this.storage.setItem(STORAGE_KEY, JSON.stringify(this.lines));
            }
        } catch (error) {
            this.onError(error);
        }
    }

    private async restore(): Promise<void> {
        if (this.storage === undefined) {
            return;
        }

        try {
            const stored = await this.storage.getItem(STORAGE_KEY);
            const parsed: unknown = stored === null ? [] : JSON.parse(stored);

            if (Array.isArray(parsed)) {
                const earlier = parsed.filter(isLogLine);
                this.lines = [...earlier, ...this.lines];
                this.trim();
            }
        } catch (error) {
            this.onError(error);
        }
    }

    private trim(): void {
        if (this.lines.length > this.maxSize) {
            this.lines.splice(0, this.lines.length - this.maxSize);
        }
    }

    private scheduleSave(): void {
        if (this.storage === undefined || this.saveTimer !== null) {
            return;
        }

        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, 1000);
    }
}

function isLogLine(value: unknown): value is LogLine {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as LogLine).message === 'string' &&
        typeof (value as LogLine).level === 'string' &&
        typeof (value as LogLine).ts === 'string'
    );
}
