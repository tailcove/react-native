import * as ReactNative from 'react-native';

/** The few React Native APIs the client reads, typed here so the package needs nothing from react-native's types. */
interface NativeShape {
    Platform?: {
        OS?: string;
        Version?: string | number;
        constants?: Record<string, unknown>;
    };
    AppState?: {
        addEventListener?: (
            type: 'change',
            listener: (state: string) => void,
        ) => { remove(): void } | undefined;
    };
}

const native = ReactNative as unknown as NativeShape;

/** What every line carries about the device: the OS and its version, and the model where React Native knows it. */
export function deviceContext(): Record<string, unknown> {
    try {
        const platform = native.Platform;
        const constants = platform?.constants ?? {};
        const os: Record<string, unknown> = {
            name: platform?.OS ?? 'unknown',
            version: platform?.Version === undefined ? undefined : String(platform.Version),
        };
        const device: Record<string, unknown> = {};

        // Android: Brand, Model, Manufacturer. iOS: systemName and interfaceIdiom ("phone", "pad").
        for (const [from, to] of [
            ['Brand', 'brand'],
            ['Manufacturer', 'manufacturer'],
            ['Model', 'model'],
            ['interfaceIdiom', 'type'],
        ] as const) {
            if (typeof constants[from] === 'string' && constants[from] !== '') {
                device[to] = constants[from];
            }
        }

        return Object.keys(device).length > 0 ? { os, device } : { os };
    } catch {
        return {};
    }
}

/** The OS name, used as the line's host: a phone has no hostname worth sending. */
export function osName(): string {
    return native.Platform?.OS ?? 'mobile';
}

/** Calls back when the app leaves the foreground, the moment to send what is waiting. */
export function onBackground(listener: () => void): () => void {
    try {
        const subscription = native.AppState?.addEventListener?.('change', (state) => {
            if (state !== 'active') {
                listener();
            }
        });

        return () => subscription?.remove();
    } catch {
        return () => undefined;
    }
}
