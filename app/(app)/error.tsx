"use client";

import { buttonClass, StatePanel } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <StatePanel
      kind="error"
      title="This view failed to load"
      action={
        <button type="button" onClick={reset} className={buttonClass.secondary}>
          Try again
        </button>
      }
    >
      <p>Your saved work is not affected. Retry, and if it keeps failing share the reference below with an administrator.</p>
      {error.digest ? <p className="mt-1 font-mono text-xs text-muted">Reference: {error.digest}</p> : null}
    </StatePanel>
  );
}
