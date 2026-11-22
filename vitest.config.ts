import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // react-native itself does not load under node: the tests use a small stand-in.
        alias: {
            'react-native': fileURLToPath(
                new URL('./test/react-native-stub.ts', import.meta.url),
            ),
        },
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
