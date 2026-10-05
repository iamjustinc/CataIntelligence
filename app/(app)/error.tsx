"use client";

import { buttonClass, StatePanel } from "@/components/ui";

/** `retry` re-fetches the failed server render; clearing the error alone would show the same failure again. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <StatePanel
      kind="error"
      title="This view failed to load"
      action={
        <button type="button" onClick={() => retry()} className={buttonClass.secondary}>
          Try again
        </button>
      }
    >
      <p>Your saved work is not affected. Retry, and if it keeps failing share the reference below with an administrator.</p>
      {error.digest ? <p className="mt-1 font-mono text-xs text-muted">Reference: {error.digest}</p> : null}
    </StatePanel>
  );
}
