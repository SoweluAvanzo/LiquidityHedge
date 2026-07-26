"use client";

/**
 * The one way this app tells you it is rate limited.
 *
 * Same words, same tone and a live countdown wherever it happens —
 * dashboard, simulation, hedge quote or checkout — so a 429 reads as a
 * queue rather than a failure. The retry control stays disabled until the
 * window has actually elapsed; offering a button that is guaranteed to
 * fail is worse than offering none.
 */

import { useEffect, useState } from "react";

/** Seconds remaining until `retryAtTs`, ticking once a second. */
export function useSecondsUntil(retryAtTs: number | null): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (retryAtTs === null) return;
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    // The first tick is scheduled rather than run inline: a synchronous
    // setState in an effect body cascades renders (and the lint rule that
    // catches it is right). A 0ms timeout resyncs the clock on the next
    // task, before the first painted second can be wrong.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [retryAtTs]);
  if (retryAtTs === null) return 0;
  return Math.max(0, retryAtTs - now);
}

export function RateLimitNotice({
  retryAtTs,
  what,
  onRetry,
}: {
  /** Unix seconds when the caller may try again. */
  retryAtTs: number;
  /** What was being asked for, e.g. "Portfolio refreshes". */
  what: string;
  onRetry?: () => void;
}) {
  const left = useSecondsUntil(retryAtTs);
  return (
    <div className="lh-callout" role="status">
      <p className="lh-callout-h">Slow down</p>
      <p>
        {what} are rate limited to protect the shared upstreams this app
        depends on. Nothing is wrong with your request —{" "}
        {left > 0 ? (
          <>
            try again in{" "}
            <b className="lh-num">
              {left} second{left === 1 ? "" : "s"}
            </b>
            .
          </>
        ) : (
          <>you can try again now.</>
        )}
      </p>
      {onRetry && (
        <div className="lh-btn-row" style={{ marginTop: "0.85rem" }}>
          <button
            type="button"
            className="lh-btn lh-btn-ghost"
            onClick={onRetry}
            disabled={left > 0}
          >
            {left > 0 ? `Retry in ${left}s` : "Try again"}
          </button>
        </div>
      )}
    </div>
  );
}
