<a href="https://tailcove.dev/docs/sending-logs/react-native"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/react-native-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/react-native-light.svg"><img alt="@tailcove/react-native: Tailcove for React Native. Version, platforms and license." src="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/react-native-dark.svg" width="100%"></picture></a>

<p align="center">
  <a href="https://tailcove.dev/docs/sending-logs/react-native">Documentation</a> &nbsp;·&nbsp;
  <a href="https://tailcove.dev/register">Get started free</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@tailcove/react-native">View on npm</a> &nbsp;·&nbsp;
  <a href="https://github.com/tailcove/react-native/issues/new/choose">Report a bug</a>
</p>

<h3 align="center">Send logs and JavaScript errors from your React Native app to Tailcove.</h3>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/features-react-native-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/features-react-native-light.svg">
  <img alt="@tailcove/react-native features" src="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/features-react-native-dark.svg" width="100%">
</picture>

## Install

```bash
npm install @tailcove/react-native @react-native-async-storage/async-storage
```

Plain JavaScript, no native module: it works in Expo (managed and bare) and in bare React Native 0.70 and later. AsyncStorage is optional; with it, logs written offline or just before a crash are sent on the next launch.

## Quick start

**1. Get an app key.** In your [Tailcove dashboard](https://tailcove.dev), open your source's **Settings** tab, generate a key under **Mobile apps**, and add your app's iOS bundle id or Android package name (for example `com.acme.shop`, or `com.acme.*` for all of them).

> The app key ships inside your app, so it is **public by design**. It only works for the app ids you allowed, and it has its own rate limit, so a copied key cannot use up your source's quota. It is not the server-side ingest token, which must stay secret.

**2. Start the client once, as early as possible** (for example in `index.js` or your root layout):

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Tailcove } from '@tailcove/react-native';

export const tailcove = Tailcove.init({
    appKey: 'tca_your_app_key',
    appId: 'com.acme.shop',
    release: '2.4.0',
    environment: 'production',
    storage: AsyncStorage,
});
```

**3. Log.**

```ts
tailcove.info('Checkout opened', { items: 3 });
tailcove.warning('Slow image load', { ms: 2400 });
tailcove.error('Payment failed', { provider: 'stripe' });
```

Anywhere else in the app, `Tailcove.instance` is the same client.

## Errors and crashes

Uncaught JavaScript errors (the red screen in development, a crash in release builds) and promise rejections nothing handled are reported on their own, as `error` lines, or `critical` when the error is fatal. Each carries the exception (class, message, location, stack) and the last 20 log calls before it, and Tailcove groups them into issues. A fatal error is saved and sent before the app goes down, and if the app dies first, it is sent on the next launch.

Report an error you caught yourself:

```ts
try {
    await placeOrder();
} catch (error) {
    tailcove.captureException(error, { orderId });
}
```

Add a step to the trail without sending a line: `tailcove.addBreadcrumb('Tapped pay')`.

Promise rejections are tracked through Hermes, React Native's default engine. On JavaScriptCore, report them in your own `.catch()`.

Native crashes (in Swift, Objective-C, Kotlin or Java code) are outside JavaScript. For those, add a Sentry SDK and point it at the DSN from your source's **Error tracking** section.

## Users and context

```ts
tailcove.setUser(user.id);           // only the id is sent, never a name or email
tailcove.setContext({ plan: 'pro' }); // on every following line
tailcove.setUser(null);              // on sign-out
```

## What gets added automatically

- `app.id` and `app.version`: your app id and `release`
- `os.name` and `os.version`: `ios` or `android` and the OS version
- `device`: the model, brand and manufacturer on Android, `phone` or `pad` on iOS
- `environment`: when you set it
- `session_id`: a random id for this launch, so one session's lines are easy to find together
- `host`: `ios` or `android`

## Options

- `appKey` (required): the source's app key.
- `appId` (required): the app's bundle id or package name, as allowed in Settings.
- `endpoint`: defaults to `https://ingest.tailcove.dev/api/v1/app/logs`. Change it only if you self-host.
- `storage`: an AsyncStorage-like object (`getItem`, `setItem`, `removeItem`). Keeps unsent lines across restarts.
- `release`, `environment`: added to every line.
- `context`: fields added to every line. Per-call context wins when keys clash.
- `batchSize`: send once this many lines are waiting. Default `50`.
- `flushIntervalMs`: send this long after the first waiting line. Default `5000`.
- `maxQueueSize`: lines kept while offline; past it the oldest go first. Default `1000`.
- `timeoutMs`: how long one delivery attempt may take. Default `10000`.
- `captureErrors`, `captureRejections`: report uncaught errors and unhandled rejections. Default `true`.
- `traceLimit`: stack frames kept per error. Default `20`.
- `enabled`: set `false` to turn the client off, for example in tests.
- `onError`: called when a batch cannot be sent or is refused. Failures are otherwise silent.

## How delivery works

Lines wait in a queue and go out in batches, when `batchSize` is reached, `flushIntervalMs` after the first one, or when the app goes to the background. A line leaves the queue only once Tailcove has accepted it. If the phone is offline or the server asks it to slow down, the batch stays queued and is tried again with backoff (honouring `Retry-After`). A batch refused for good, for example after the key was revoked, is dropped and reported to `onError`. The client never throws into your app.

Call `await tailcove.flush()` to send now, and `await tailcove.close()` to send, save and detach the error hooks.

## Help and feedback

- **Docs:** [tailcove.dev/docs/sending-logs/react-native](https://tailcove.dev/docs/sending-logs/react-native)
- **Bugs and feature requests:** [open an issue](https://github.com/tailcove/react-native/issues/new/choose)
- **Security problems:** please email **security@tailcove.dev** instead of opening a public issue.

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/footer-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/footer-light.svg">
  <img alt="Tailcove." src="https://raw.githubusercontent.com/tailcove/.github/main/profile/assets/packages/footer-dark.svg" width="100%">
</picture>

<p align="center">
  <a href="https://tailcove.dev/docs/sending-logs/react-native">Documentation</a> &nbsp;·&nbsp;
  <a href="https://tailcove.dev/register">Get started free</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@tailcove/react-native">View on npm</a>
</p>
