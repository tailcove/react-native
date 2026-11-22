type Listener = (state: string) => void;

const listeners = new Set<Listener>();

export const Platform = {
    OS: 'ios',
    Version: '18.1',
    constants: { systemName: 'iOS', interfaceIdiom: 'phone' },
};

export const AppState = {
    addEventListener(_type: 'change', listener: Listener) {
        listeners.add(listener);

        return { remove: () => listeners.delete(listener) };
    },
};

/** Test helper: moves the fake app to another state. */
export function setAppState(state: string): void {
    listeners.forEach((listener) => listener(state));
}
