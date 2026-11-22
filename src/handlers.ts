type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsShape {
    getGlobalHandler(): GlobalHandler | undefined;
    setGlobalHandler(handler: GlobalHandler): void;
}

interface HermesShape {
    enablePromiseRejectionTracker?: (options: {
        allRejections: boolean;
        onUnhandled: (id: number, rejection: unknown) => void;
        onHandled: (id: number) => void;
    }) => void;
}

const scope = globalThis as typeof globalThis & {
    ErrorUtils?: ErrorUtilsShape;
    HermesInternal?: HermesShape;
};

/**
 * Hooks React Native's global error handler: every uncaught JavaScript error is reported, then handed to the handler
 * that was there before (the red screen in development, the crash in release). A fatal error waits for the report to
 * be saved or sent, at most `fatalWaitMs`, since the app is gone the moment the previous handler returns.
 */
export function hookUncaughtErrors(
    report: (error: unknown, isFatal: boolean) => Promise<void>,
    fatalWaitMs = 1500,
): () => void {
    const errorUtils = scope.ErrorUtils;

    if (errorUtils === undefined) {
        return () => undefined;
    }

    const previous = errorUtils.getGlobalHandler();
    let handling = false;

    const handler: GlobalHandler = (error, isFatal) => {
        // An error thrown while reporting must not loop back into the reporter.
        if (handling) {
            previous?.(error, isFatal);

            return;
        }

        handling = true;
        const reported = report(error, isFatal === true).catch(() => undefined);

        const handOver = (): void => {
            handling = false;
            previous?.(error, isFatal);
        };

        if (isFatal === true) {
            void Promise.race([reported, wait(fatalWaitMs)]).then(handOver);
        } else {
            handOver();
        }
    };

    errorUtils.setGlobalHandler(handler);

    return () => {
        if (previous !== undefined) {
            errorUtils.setGlobalHandler(previous);
        }
    };
}

/**
 * Reports promise rejections nothing handled, through Hermes (React Native's engine since 0.70). Without Hermes this
 * does nothing; call captureException() in your own `.catch()` there.
 */
export function hookUnhandledRejections(report: (reason: unknown) => void): boolean {
    const tracker = scope.HermesInternal?.enablePromiseRejectionTracker;

    if (tracker === undefined) {
        return false;
    }

    tracker({
        allRejections: true,
        onUnhandled: (_id, rejection) => report(rejection),
        onHandled: () => undefined,
    });

    return true;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
