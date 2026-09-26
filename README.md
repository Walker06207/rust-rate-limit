# rate-limit-token-bucket

A token bucket rate limiter that tracks a refillable capacity of tokens and tells you whether a request may proceed and, if not, how many milliseconds to wait until it can.

## Usage

```js
import { TokenBucket } from 'rate-limit-token-bucket';

const bucket = new TokenBucket({
  capacity: 10,            // max burst
  refillRate: 0.01,        // tokens per millisecond (10/sec)
  now: () => Date.now(),   // injectable clock
});

const { allowed, retryAfter } = bucket.take(1);
if (!allowed) {
  // wait retryAfter ms, then retry
}
```

## Why

This exists to put a small, dependency-free ceiling on request rate in a single process. The design is a classic token bucket: tokens accrue at a steady rate up to a fixed capacity, and each request consumes some. The trade-off is that this is **not distributed** — there is no shared state across processes or machines, and no persistence. If you need coordination across a fleet, use a Redis-backed limiter instead. The payoff is simplicity, no network, and deterministic behavior under a fake clock.

Refill is computed **lazily** on each `take` rather than via a background timer, so the limiter works in any environment (timers optional) and is fully testable without patching global APIs.

## API

- `new TokenBucket({ capacity, refillRate, now })`
  - `capacity` (number, >0): maximum tokens the bucket can hold.
  - `refillRate` (number, >0): tokens added per millisecond.
  - `now` (function, returns ms): injectable clock. Pass `() => Date.now()` in production; pass a fake in tests.
- `bucket.take([cost = 1])` → `{ allowed: boolean, retryAfter: number }`
  - `cost` must be a positive finite number.
  - `retryAfter` is milliseconds until a token is available (0 when `allowed` is true, `Infinity` if `cost` exceeds `capacity` — such a request can never succeed at any wait).
- `bucket.availableTokens` (number): current count after pending refill. Reading it applies the refill as a side effect so that subsequent `take` calls do not double-count the elapsed interval.

## Edge cases worth knowing

- A `cost` larger than `capacity` returns `Infinity` for `retryAfter`. Retrying such a request verbatim will never succeed; reduce the cost or raise the capacity.
- Tokens refill fractionally, so `retryAfter` may be a non-integer (e.g. `0.5` ms). Don't compare it with strict equality against integers in your own code.
- If the clock goes backwards (NTP slew or a buggy fake), the limiter snaps to the new time rather than granting a large bogus refill; it does not throw.
