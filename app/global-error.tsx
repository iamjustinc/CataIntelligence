"use client";

/**
 * Last-resort boundary for a failure in the root layout itself. It replaces the whole document,
 * so it carries its own minimal styles and cannot rely on the application shell.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", background: "#f5f1e8", color: "#1c1a16", fontFamily: "system-ui, sans-serif" }}>
        <main role="alert" style={{ maxWidth: "32rem", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Catalog Intelligence could not load</h1>
          <p style={{ lineHeight: 1.6 }}>Nothing you saved is affected. Try again; if this keeps happening, give the reference below to an administrator.</p>
          {error.digest ? <p style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem", color: "#4a463d" }}>Reference: {error.digest}</p> : null}
          <button type="button" onClick={() => retry()} style={{ marginTop: "0.5rem", padding: "0.55rem 0.9rem", border: "1px solid #b9b09b", borderRadius: 2, background: "#fffdf8", color: "#1c1a16", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
