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

  // AUDIT #7: credits inbound USDC that carries no Solana Pay reference —
  // exchange withdrawals and memo-less wallets. Independent of the hedge
  // watcher above: one failing must not take the other down.
  try {
    const { startOrderWatcher } = await import("./lib/server/order-watcher");
    startOrderWatcher();
  } catch (error) {
    // A watcher that fails to start must be LOUD: money can be accepted
    // that nothing will ever credit — an outage, not a warning.
    const configured = !!process.env.DATA_REVENUE_WALLET?.trim();
    console.error(
      `[instrumentation] order watcher FAILED TO START` +
        (configured
          ? " — DATA_REVENUE_WALLET is set, so manual payments will not be" +
            " credited. Buyers who pay from an exchange will not be delivered."
          : " (data sales are not configured, so nothing is at risk yet)"),
      error,
    );
  }
}
