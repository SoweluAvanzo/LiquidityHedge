/**
 * Server boot hook — starts the settlement watcher.
 *
 * AUDIT FINDING #1 (critical). `startSettlementScheduler()` existed, was
 * correct, and was called from nowhere. Without it `runSettlementCycle` —
 * the only production caller of `observePayment` / `settle` /
 * `refundPayment` — never ran, so a buyer could be told to send premium +
 * collateral to the treasury and NOTHING would observe it: no activation,
 * no settlement, no refund. The money would sit in the treasury
 * unaccounted for.
 *
 * `register()` runs once per server instance, before the first request is
 * served. It must not throw: an exception here fails the whole boot.
 *
 * The scheduler itself returns early when hedging is disabled
 * (`HedgeUnavailableError`), so this is safe to run unconditionally.
 */

export async function register(): Promise<void> {
  // Edge and browser runtimes have no timers we want and no chain access.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { startSettlementScheduler } = await import(
      "./lib/server/settlement-scheduler"
    );
    startSettlementScheduler();
  } catch (error) {
    // A watcher that fails to start must be LOUD. If hedging is configured
    // and this line appears in the logs, money can be accepted that nothing
    // will ever settle — treat it as an outage, not a warning.
    const configured = !!process.env.HEDGE_TREASURY_ADDRESS?.trim();
    console.error(
      `[instrumentation] settlement watcher FAILED TO START` +
        (configured
          ? " — HEDGE_TREASURY_ADDRESS is set, so payments may be accepted" +
            " with no observer. Take the hedge product offline."
          : " (hedging is not configured, so nothing is at risk yet)"),
      error,
    );
  }
}
