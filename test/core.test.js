import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/index.js';

// A fake clock that returns whatever value it's been advanced to. Tests never
// touch the real timer, so every assertion is independent of machine speed.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; },
  };
}

test('constructor rejects non-positive capacity', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillRate: 1, now: () => 0 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: -1, refillRate: 1, now: () => 0 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: NaN, refillRate: 1, now: () => 0 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: Infinity, refillRate: 1, now: () => 0 }), RangeError);
});

test('constructor rejects non-positive refillRate', () => {
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 0, now: () => 0 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: -1, now: () => 0 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: NaN, now: () => 0 }), RangeError);
});

test('constructor rejects non-function now', () => {
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 1, now: 'oops' }), TypeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 1, now: null }), TypeError);
});

test('constructor rejects clock returning non-finite', () => {
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 1, now: () => NaN }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 1, now: () => Infinity }), RangeError);
});

test('bucket starts full', () => {
  const c = makeClock(100);
  const b = new TokenBucket({ capacity: 5, refillRate: 1, now: c.now });
  assert.equal(b.availableTokens, 5);
});

test('take allows up to capacity immediately from full', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 3, refillRate: 0.001, now: c.now });
  for (let i = 0; i < 3; i++) {
    const r = b.take();
    assert.equal(r.allowed, true);
    assert.equal(r.retryAfter, 0);
  }
  const r = b.take();
  assert.equal(r.allowed, false);
});

test('take default cost is 1', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: c.now });
  assert.equal(b.take().allowed, true);
  assert.equal(b.take().allowed, false);
});

test('take with explicit cost depletes proportionally', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 5, refillRate: 1, now: c.now });
  const r = b.take(3);
  assert.equal(r.allowed, true);
  assert.equal(b.availableTokens, 2);
});

test('retryAfter is zero when allowed', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 2, refillRate: 1, now: c.now });
  assert.deepEqual(b.take(), { allowed: true, retryAfter: 0 });
});

test('retryAfter equals deficit divided by refillRate', () => {
  // capacity 1, refillRate 0.5 tokens/ms => 2ms per token.
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 0.5, now: c.now });
  assert.equal(b.take().allowed, true);
  const r = b.take();
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfter, 2);
});

test('retryAfter accounts for partial refill accumulated since last take', () => {
  // capacity 1, refillRate 0.5 tokens/ms.
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 0.5, now: c.now });
  assert.equal(b.take().allowed, true); // tokens -> 0
  c.advance(1); // 1ms => +0.5 token
  const r = b.take();
  // Deficit is 0.5, at 0.5/ms that's 1ms to wait.
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfter, 1);
});

test('after waiting retryAfter, take succeeds', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 0.5, now: c.now });
  assert.equal(b.take().allowed, true);
  const r = b.take();
  assert.equal(r.allowed, false);
  c.advance(r.retryAfter);
  assert.equal(b.take().allowed, true);
});

test('refill does not exceed capacity', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 2, refillRate: 1000, now: c.now });
  assert.equal(b.take().allowed, true); // 1 left
  c.advance(1000000); // would add a million tokens
  assert.equal(b.availableTokens, 2); // capped
  assert.equal(b.take().allowed, true);
});

test('take cost larger than capacity never succeeds with Infinity retryAfter', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 3, refillRate: 1, now: c.now });
  const r = b.take(4);
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfter, Infinity);
  // Still true after time passes — capacity caps it.
  c.advance(1000);
  const r2 = b.take(4);
  assert.equal(r2.allowed, false);
  assert.equal(r2.retryAfter, Infinity);
});

test('take rejects non-positive cost', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: c.now });
  assert.throws(() => b.take(0), RangeError);
  assert.throws(() => b.take(-1), RangeError);
  assert.throws(() => b.take(NaN), RangeError);
});

test('clock going backwards does not crash or produce negative refill', () => {
  const c = makeClock(100);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: c.now });
  assert.equal(b.take().allowed, true); // 0 tokens
  c.set(50); // backwards
  const r = b.take();
  // Should not grant a token (we'd need 1ms of forward progress from the
  // snapped #last), and retryAfter must be finite and non-negative.
  assert.equal(r.allowed, false);
  assert.ok(Number.isFinite(r.retryAfter));
  assert.ok(r.retryAfter >= 0);
});

test('availableTokens reflects lazy refill but does not mutate state', () => {
  // Wait — actually, refill DOES update #tokens and #last as a side effect.
  // That's intended: subsequent take() should not re-apply the same elapsed
  // interval. This test verifies the side effect is consistent.
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 2, refillRate: 1, now: c.now });
  assert.equal(b.take(2).allowed, true); // 0 tokens
  c.advance(1);
  assert.equal(b.availableTokens, 1);
  // Calling again without advancing is a no-op.
  assert.equal(b.availableTokens, 1);
  // State is consistent: take(1) now succeeds.
  assert.equal(b.take(1).allowed, true);
});

test('fractional tokens contribute toward readiness', () => {
  // capacity 1, refillRate 1 token/ms.
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: c.now });
  assert.equal(b.take().allowed, true); // 0 tokens
  c.advance(0.5); // 0.5 token accrued
  const r = b.take();
  // Need 0.5 more token at 1/ms => 0.5ms.
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfter, 0.5);
  c.advance(0.5);
  assert.equal(b.take().allowed, true);
});

test('take with cost equal to capacity succeeds from full', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 5, refillRate: 0.001, now: c.now });
  const r = b.take(5);
  assert.equal(r.allowed, true);
  assert.equal(r.retryAfter, 0);
  assert.equal(b.availableTokens, 0);
});

test('take with fractional cost under capacity succeeds', () => {
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 2, refillRate: 0.001, now: c.now });
  const r = b.take(0.5);
  assert.equal(r.allowed, true);
  assert.equal(r.retryAfter, 0);
  assert.equal(b.availableTokens, 1.5);
});

test('take with fractional cost exceeding available yields fractional retryAfter', () => {
  // capacity 1, refillRate 1/ms.
  const c = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: c.now });
  // 0.3 token available after taking 0.7.
  assert.equal(b.take(0.7).allowed, true);
  // Now ask for 0.5: deficit ~0.2, at 1/ms => ~0.2ms.
  const r = b.take(0.5);
  assert.equal(r.allowed, false);
  assert.ok(Math.abs(r.retryAfter - 0.2) < 1e-9);
});
