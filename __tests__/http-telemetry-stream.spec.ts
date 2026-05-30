/**
 * Regression tests for issue #3: SSE telemetry stream leaks subscriber +
 * keepalive on every client disconnect.
 *
 * The root cause was that cancel() used `this._cleanup` but `this` inside
 * ReadableStream cancel() is the underlyingSource object, not the controller.
 * So _cleanup was never found and unsubscribe/clearInterval were never called.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { subscribe, subscriberCount } from "../src/observability/event-bus.ts";

// We need to import the raw handler (not wrapped with withObservability)
// so we can call it without the observability middleware that hits SQLite.
// We re-export the inner function from the module for test-only use.
import { _handleTelemetryStreamForTest } from "../src/http/routes/telemetry/stream.ts";

describe("SSE telemetry stream — subscriber cleanup on cancel (#3)", () => {
  test("cancel() removes subscriber from event-bus and does not leak", async () => {
    const baseline = subscriberCount();

    const res = await _handleTelemetryStreamForTest(
      new Request("http://localhost/v1/telemetry/stream"),
    );

    // After start, the subscriber should be registered
    expect(subscriberCount()).toBe(baseline + 1);

    // Simulate client disconnect: cancel the readable stream
    await res.body!.cancel();

    // After cancel, subscriber must be removed
    expect(subscriberCount()).toBe(baseline);
  });

  test("cancel() is idempotent — calling it twice does not throw or double-count", async () => {
    const baseline = subscriberCount();

    const res = await _handleTelemetryStreamForTest(
      new Request("http://localhost/v1/telemetry/stream"),
    );

    await res.body!.cancel();
    await res.body!.cancel(); // should be a no-op

    expect(subscriberCount()).toBe(baseline);
  });
});
