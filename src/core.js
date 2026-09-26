/**
 * Token bucket rate limiter.
 *
 * The bucket holds at most `capacity` tokens. Tokens refill at a fixed
 * `refillRate` (tokens per millisecond). A refill is computed lazily on every
 * call to `take` rather than via a background timer, so the limiter is safe to
 * use without scheduling and is deterministic under a fake clock in tests.
 *
 * Refill is applied incrementally: every call tops the bucket up based on the
 * elapsed time since the last call, clamped to `capacity`. This means the
 * bucket "remembers" partial fill between calls — if you take from a near-empty
 * bucket, subsequent calls still benefit from continued refill. We chose lazy
 * refill over a setInterval pump because a pump would require real timers (a
 * dependency on the event loop) and would make deterministic testing impossible
 * without monkey-patching global timers. Lazy refill gives identical steady-state
 * behavior and is testable with a pure clock function.
 */

/**
 * @typedef {Object} TakeResult
 * @property {boolean} allowed    Whether a token was taken.
 * @property {number} retryAfter  Milliseconds to wait until a token is
 *                                available. Always 0 when `allowed` is true;
 *                                a non-negative finite number otherwise.
 */

export class TokenBucket {
  #capacity;
  #refillRate;
  #now;
  #tokens;
  #last;

  /**
   * @param {object} opts
   * @param {number} opts.capacity   Maximum tokens the bucket can hold.
   * @param {number} opts.refillRate  Tokens added per millisecond.
   * @param {() => number} opts.now   Clock returning current ms (real or fake).
   */
  constructor({ capacity, refillRate, now }) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive finite number, got ${capacity}`);
    }
    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      throw new RangeError(`refillRate must be a positive finite number, got ${refillRate}`);
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function returning milliseconds');
    }
    this.#capacity = capacity;
    this.#refillRate = refillRate;
    this.#now = now;
    const t = now();
    if (!Number.isFinite(t)) {
      throw new RangeError('clock function must return a finite number');
    }
    // Start full: a freshly constructed limiter should permit a burst equal to
    // capacity, which is the usual expectation for token bucket algorithms.
    this.#tokens = capacity;
    this.#last = t;
  }

  /** Current token count after applying pending refill. */
  get availableTokens() {
    return this.#refill();
  }

  /**
   * Attempt to take `cost` tokens.
   *
   * @param {number} [cost=1] Tokens required for this request.
   * @returns {TakeResult}
   */
  take(cost = 1) {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError(`cost must be a positive finite number, got ${cost}`);
    }
    if (cost > this.#capacity) {
      // A request larger than the bucket can never succeed at any finite wait:
      // even a full bucket lacks enough tokens, and refill cannot raise the
      // count above capacity. Returning Infinity signals "do not retry this
      // request as-is" to the caller, which is more useful than a large but
      // finite number that would cause pointless busy-retrying.
      return { allowed: false, retryAfter: Infinity };
    }

    this.#refill();

    if (this.#tokens >= cost) {
      this.#tokens -= cost;
      return { allowed: true, retryAfter: 0 };
    }

    // Fractional tokens count toward readiness: if 0.4 of a token is missing,
    // the request becomes allowed after 0.4/refillRate ms. We deliberately do
    // NOT round up to a whole token, because doing so would make the limiter
    // stricter than its configured rate and would break sub-token costs.
    const deficit = cost - this.#tokens;
    const retryAfter = deficit / this.#refillRate;
    return { allowed: false, retryAfter };
  }

  /**
   * Top up tokens based on elapsed time since the last call. Returns the
   * updated token count. Idempotent: calling it repeatedly without time
   * advancing is a no-op after the first call.
   */
  #refill() {
    const t = this.#now();
    if (!Number.isFinite(t)) {
      throw new RangeError('clock function must return a finite number');
    }
    if (t < this.#last) {
      // Clock went backwards. Real wall clocks can do this (NTP slewing), and
      // a buggy fake clock might too. We snap #last to the new time so the
      // bucket doesn't accrue a bogus huge refill from the negative delta,
      // and we do NOT throw — rate limiters should be failure-tolerant.
      this.#last = t;
      return this.#tokens;
    }
    const elapsed = t - this.#last;
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillRate);
      this.#last = t;
    }
    return this.#tokens;
  }
}
