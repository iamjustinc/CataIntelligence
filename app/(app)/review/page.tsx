import Link from "next/link";
import { buttonClass, Card, inputClass, PageHeader, StatePanel } from "@/components/ui";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { listMerchants } from "@/lib/domain/merchants";
import { listReviewItems, parseReviewFilters } from "@/lib/domain/review";
import { BAND_LABELS, REVIEW_STATES, SIGNAL_BANDS, STATE_LABELS } from "@/lib/review-labels";
import { QueueTable } from "./queue-table";

export const metadata = { title: "Review Queue" };

export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { actor } = await requirePageSession();
  const params = await searchParams;
  const filters = parseReviewFilters((k) => params[k]);
  const [data, merchants] = await Promise.all([listReviewItems(actor, { ...filters, limit: 50 }), listMerchants(actor)]);
  const canDecide = can(actor.role, "review.decide");

  // Filters (without the cursor) are carried into item links so the workspace keeps the same queue.
  const carried = new URLSearchParams();
  for (const k of ["merchant", "revision", "state", "band", "warning", "q", "sort", "concept", "flag", "published", "unanalyzed"]) if (params[k]) carried.set(k, params[k]!);
  const withCursor = new URLSearchParams(carried);
  if (filters.cursor) withCursor.set("cursor", filters.cursor);
  const next = new URLSearchParams(carried);
  if (data.nextCursor) next.set("cursor", data.nextCursor);
  const filtered = [...carried.keys()].some((k) => k !== "sort");
  const { progress } = data;
  // Filters that only metric drilldowns set; shown in words because the form has no control for them.
  const drill = [
    filters.flag === "ambiguous" ? "flagged as ambiguous" : null,
    filters.flag === "failed" ? "whose latest analysis failed" : null,
    filters.published === "mapped" ? "mapped in the merchant's current release" : null,
    filters.published === "unmapped" ? "not mapped in a current release for the current catalog revision" : null,
    filters.unanalyzed ? "with no recommendation yet" : null,
  ].filter((d): d is string => !!d);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Review Queue"
        title="Review queue"
        description="Listings from each merchant's current catalog revision. Suggestions are proposals; a mapping exists only once a reviewer decides."
        actions={
          data.items[0] ? (
            <Link href={`/review/${data.items[0].id}?${withCursor}`} className={buttonClass.primary}>
              Open first item
            </Link>
          ) : undefined
        }
      />

      <form method="get" className="rise rise-1 grid gap-3 rounded-md border border-rule bg-surface p-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_auto]" aria-label="Queue filters">
        <div>
          <label htmlFor="f-q" className="eyebrow mb-1 block">
            Search title or SKU
          </label>
          <input id="f-q" name="q" type="search" defaultValue={params.q ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor="f-merchant" className="eyebrow mb-1 block">
            Merchant
          </label>
          <select id="f-merchant" name="merchant" defaultValue={params.merchant ?? ""} className={inputClass}>
            <option value="">All merchants</option>
            {merchants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-state" className="eyebrow mb-1 block">
            Decision status
          </label>
          <select id="f-state" name="state" defaultValue={params.state ?? ""} className={inputClass}>
            <option value="">Any status</option>
            <option value="unresolved">All unresolved</option>
            {REVIEW_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-band" className="eyebrow mb-1 block">
            Signal band
          </label>
          <select id="f-band" name="band" defaultValue={params.band ?? ""} className={inputClass}>
            <option value="">Any signal</option>
            {SIGNAL_BANDS.map((b) => (
              <option key={b} value={b}>
                {BAND_LABELS[b]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-sort" className="eyebrow mb-1 block">
            Sort
          </label>
          <select id="f-sort" name="sort" defaultValue={filters.sort} className={inputClass}>
            <option value="age">Oldest unresolved first</option>
            <option value="merchant">Merchant, then title</option>
            <option value="signal">Strongest signal first</option>
          </select>
        </div>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-2 pb-2 text-sm whitespace-nowrap">
            <input type="checkbox" name="warning" value="1" defaultChecked={params.warning === "1"} className="size-4 accent-[var(--color-stamp)]" />
            Has warnings
          </label>
          <button type="submit" className={buttonClass.secondary}>
            Apply
          </button>
        </div>
        {(["concept", "flag", "published", "unanalyzed"] as const).map((k) => (params[k] ? <input key={k} type="hidden" name={k} value={params[k]} /> : null))}
      </form>

      <p className="text-sm text-ink-soft" role="status">
        <span className="font-mono">{progress.approved}</span> approved, <span className="font-mono">{progress.remaining}</span> remaining of <span className="font-mono">{progress.total}</span> active listings
        {params.merchant ? " for this merchant" : " across current catalogs"}.{params.concept ? " Showing listings proposed or decided under the selected canonical concept." : ""}
        {drill.length ? (
          <>
            {" "}
            <span data-testid="drilldown-scope">
              Showing <span className="font-mono">{data.matching}</span> {drill.join(", ")}.
            </span>
          </>
        ) : null}{" "}
        {filtered ? (
          <Link href="/review" className="font-semibold text-stamp underline underline-offset-4">
            Clear filters
          </Link>
        ) : null}
      </p>

      {progress.total === 0 ? (
        <StatePanel kind="empty" title="Nothing to review yet" action={<Link href="/catalogs" className={buttonClass.secondary}>Go to catalogs</Link>}>
          Import a merchant catalog to create a review batch.
        </StatePanel>
      ) : data.items.length === 0 ? (
        <StatePanel kind="empty" title="No listings match these filters">
          Change or clear the filters to see more of the queue.
        </StatePanel>
      ) : (
        <Card className="rise rise-2 overflow-hidden">
          <QueueTable items={data.items} linkQuery={withCursor.toString()} canDecide={canDecide} />
          <div className="flex items-center justify-between border-t border-rule px-5 py-3 text-sm">
            <span className="text-muted">
              {data.items.length} listing{data.items.length === 1 ? "" : "s"} on this page
            </span>
            <span className="flex gap-4">
              {filters.cursor ? (
                <Link href={`/review?${carried}`} className="font-semibold underline underline-offset-4">
                  First page
                </Link>
              ) : null}
              {data.nextCursor ? (
                <Link href={`/review?${next}`} className="font-semibold underline underline-offset-4">
                  Next page
                </Link>
              ) : null}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
