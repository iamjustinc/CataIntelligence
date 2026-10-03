export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Loading…</span>
      <div className="h-16 w-2/3 animate-pulse rounded-sm bg-sunken" />
      <div className="h-40 animate-pulse rounded-md bg-sunken/70" />
      <div className="h-40 animate-pulse rounded-md bg-sunken/50" />
    </div>
  );
}
