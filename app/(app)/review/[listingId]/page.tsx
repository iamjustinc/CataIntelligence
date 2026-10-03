import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api/errors";
import { requirePageSession } from "@/lib/auth/session";
import { getReviewItem, listReviewItems, parseReviewFilters } from "@/lib/domain/review";
import { ReviewWorkspace } from "./review-workspace";

export const metadata = { title: "Review item" };

export default async function ReviewItemPage({ params, searchParams }: { params: Promise<{ listingId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { actor } = await requirePageSession();
  const { listingId } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) notFound();
  let item;
  try {
    item = await getReviewItem(actor, listingId);
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") notFound();
    throw err;
  }
  const filters = parseReviewFilters((k) => query[k]);
  // The queue panel shows the same page the reviewer came from; default to this merchant's queue.
  const scoped = { ...filters, merchantId: filters.merchantId ?? item.merchant.id };
  const queue = await listReviewItems(actor, { ...scoped, limit: 50 });
  const carried = new URLSearchParams();
  for (const k of ["merchant", "revision", "state", "band", "warning", "q", "sort", "concept"]) if (query[k]) carried.set(k, query[k]!);
  const here = new URLSearchParams(carried);
  if (filters.cursor) here.set("cursor", filters.cursor);

  const index = queue.items.findIndex((i) => i.id === listingId);
  const hrefFor = (id: string, q: URLSearchParams) => `/review/${id}${q.size ? `?${q}` : ""}`;
  let nextHref = index >= 0 && queue.items[index + 1] ? hrefFor(queue.items[index + 1].id, here) : null;
  if (!nextHref && queue.nextCursor && (index >= 0 || queue.items.length > 0)) {
    const following = await listReviewItems(actor, { ...scoped, cursor: queue.nextCursor, limit: 1 });
    if (following.items[0]) {
      const q = new URLSearchParams(carried);
      q.set("cursor", queue.nextCursor);
      nextHref = hrefFor(following.items[0].id, q);
    }
  }
  if (index < 0 && !nextHref && queue.items[0]) nextHref = hrefFor(queue.items[0].id, here);
  const prevHref = index > 0 ? hrefFor(queue.items[index - 1].id, here) : null;

  return (
    <ReviewWorkspace
      key={`${listingId}:${item.review.lockVersion}`}
      item={JSON.parse(JSON.stringify(item))}
      queue={queue.items.map((i) => ({ id: i.id, title: i.title, sku: i.sku, state: i.state, href: hrefFor(i.id, here) }))}
      progress={queue.progress}
      prevHref={prevHref}
      nextHref={nextHref}
      queueHref={`/review${here.size ? `?${here}` : `?merchant=${item.merchant.id}`}`}
    />
  );
}
