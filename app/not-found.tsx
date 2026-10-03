import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md">
        <p className="eyebrow">404</p>
        <h1 className="mt-1 font-display text-3xl font-medium">No record at this address</h1>
        <p className="mt-2 text-sm text-ink-soft">The page does not exist, or it belongs to a workspace you cannot access.</p>
        <Link href="/overview" className="mt-4 inline-block text-sm font-semibold text-stamp underline underline-offset-4">
          Back to overview
        </Link>
      </div>
    </main>
  );
}
