/**
 * Generic poll-until-terminal helper behind every `waitFor*` method.
 */

import { PollTimeoutError, TerminalStateError } from "./errors.js";
import { sleep } from "./http.js";

export interface PollOptions {
  /** First wait between polls. Default 1500 ms. */
  intervalMs?: number;
  /** Cap on the growing wait. Default 5000 ms. */
  maxIntervalMs?: number;
  /** Give up after this long. Default 120 000 ms. */
  timeoutMs?: number;
  /** Multiplier applied to the interval after each poll. Default 1.5. */
  backoffFactor?: number;
  signal?: AbortSignal;
  /** Observe each intermediate value (progress UI, logging). */
  onPoll?: (value: unknown, attempt: number) => void;
}

export interface PollSpec<T> {
  fetch: () => Promise<T>;
  /** Terminal success. */
  isDone: (value: T) => boolean;
  /** Terminal failure → return the state name to throw `TerminalStateError`. */
  isFailed?: (value: T) => string | false | undefined;
  /** Name for error messages, e.g. "purchase 123". */
  label: string;
}

export async function poll<T>(spec: PollSpec<T>, opts: PollOptions = {}): Promise<T> {
  const interval0 = opts.intervalMs ?? 1500;
  const maxInterval = opts.maxIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const factor = opts.backoffFactor ?? 1.5;
  const started = Date.now();
  let interval = interval0;
  let attempt = 0;
  let last: T | undefined;

  for (;;) {
    last = await spec.fetch();
    attempt++;
    opts.onPoll?.(last, attempt);
    if (spec.isDone(last)) return last;
    const failed = spec.isFailed?.(last);
    if (failed) {
      throw new TerminalStateError(`${spec.label} ended in ${failed}`, failed, last);
    }
    const elapsed = Date.now() - started;
    if (elapsed + interval > timeoutMs) {
      throw new PollTimeoutError(`Timed out after ${timeoutMs}ms waiting for ${spec.label}`, last);
    }
    await sleep(interval, opts.signal);
    interval = Math.min(maxInterval, interval * factor);
  }
}
