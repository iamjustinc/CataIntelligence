import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, buttonClass, Card, PageHeader, StatePanel } from "@/components/ui";
import { ApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { listCatalogListings, listCatalogRevisions } from "@/lib/domain/catalog-import";
import { latestAnalysisJob } from "@/lib/domain/analysis";
import { getProviderStatus, getWorkspace } from "@/lib/domain/workspace";
import { STATE_LABELS, STATE_TONES } from "@/lib/review-labels";
import { AnalysisPanel } from "./analysis-panel";

export const metadata = { title: "Merchant catalog" };
const UUID = /^[0-9a-f-]{36}$/i;
const formatUtc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

interface RevisionCounts {
  input: number;
  accepted: number;
  rejected: number;
  collapsed: number;
  active: number;
  new: number;
  changed: number;
  unchanged: number;
  carriedForward: number;
  deactivated: number;
  decisionsCarried: number;
}

export default async function MerchantCatalogPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ revision?: string; cursor?: string }> }) {
  const { actor } = await requirePageSession();
  const { id } = await params;
  const query = await searchParams;
  if (!UUID.test(id)) notFound();
  let data;
  try {
    data = await listCatalogRevisions(actor, id);
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") notFound();
    throw err;
  }
  const { merchant, revisions } = data;
  const canImport = can(actor.role, "catalog.import");
  const importLink = canImport ? (
    <Link href={`/catalogs/${merchant.id}/import`} className={revisions.length === 0 ? buttonClass.primary : buttonClass.secondary}>
      Import catalog
    </Link>
  ) : undefined;

  const selected = revisions.find((r) => r.id === query.revision) ?? revisions.find((r) => r.id === merchant.activeCatalogRevisionId) ?? revisions[0];
  const listings = selected ? await listCatalogListings(actor, selected.id, { cursor: query.cursor, limit: 50, includeInactive: true }) : null;
  const isCurrent = selected?.id === merchant.activeCatalogRevisionId;
  const [provider, workspace, job] = await Promise.all([getProviderStatus(actor), getWorkspace(actor), isCurrent && selected ? latestAnalysisJob(actor, selected.id) : null]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/catalogs" className="underline underline-offset-4">
              Merchants
            </Link>{" "}
            · {merchant.region ?? "No region"}
          </>
        }
        title={merchant.name}
        actions={
          <>
            {isCurrent && selected ? (
              <Link href={`/review?merchant=${merchant.id}`} className={buttonClass.secondary}>
                Review listings
              </Link>
            ) : null}
            {importLink}
          </>
        }
      />

      {revisions.length === 0 ? (
        <StatePanel kind="empty" title="No catalog imported yet" action={importLink}>
          {canImport ? "Import a CSV to create the first catalog revision and its review batch." : "A taxonomist or administrator can import this merchant's catalog."}
        </StatePanel>
      ) : (
        <>
          <Card className="rise rise-1 overflow-hidden">
            <h2 className="border-b border-rule px-5 py-3 font-display text-lg font-medium">Catalog revisions</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Catalog revisions for {merchant.name}, newest first</caption>
                <thead className="border-b border-rule-strong bg-sunken/60">
                  <tr className="eyebrow [&>th]:px-5 [&>th]:py-2.5 [&>th]:font-normal">
                    <th scope="col">Revision</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Active listings</th>
                    <th scope="col">Rows: in / accepted / rejected / collapsed</th>
                    <th scope="col">Compared with previous</th>
                    <th scope="col">Imported</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {revisions.map((r) => {
                    const c = r.counts as RevisionCounts;
                    return (
                      <tr key={r.id} className={`[&>td]:px-5 [&>td]:py-3 ${r.id === selected?.id ? "bg-sunken/40" : ""}`}>
                        <th scope="row" className="px-5 py-3 font-medium whitespace-nowrap">
                          <Link href={`/catalogs/${merchant.id}?revision=${r.id}`} className="underline underline-offset-4" aria-current={r.id === selected?.id ? "true" : undefined}>
                            Revision {r.sequence}
                          </Link>{" "}
                          {r.id === merchant.activeCatalogRevisionId ? <Badge tone="ok">Current</Badge> : <Badge>Superseded</Badge>}
                        </th>
                        <td className="capitalize">{r.mode}</td>
                        <td className="font-mono text-xs">{c.active}</td>
                        <td className="font-mono text-xs">
                          {c.input} / {c.accepted} / {c.rejected} / {c.collapsed}
                        </td>
                        <td className="text-xs text-ink-soft">
                          {r.sequence === 1 ? "First revision" : `${c.new} new, ${c.changed} changed, ${c.unchanged} unchanged, ${c.carriedForward} carried forward, ${c.deactivated} deactivated; ${c.decisionsCarried} decisions kept`}
                        </td>
                        <td className="text-xs text-muted">
                          {formatUtc(r.createdAt)}
                          <br />
                          {r.createdByName}
                          {r.fileName ? ` · ${r.fileName}` : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {isCurrent && selected ? (
            <AnalysisPanel
              key={job?.id ?? "none"}
              revisionId={selected.id}
              provider={provider}
              canRun={can(actor.role, "analysis.run")}
              hasTaxonomy={workspace.activeTaxonomyVersionId !== null}
              job={job ? JSON.parse(JSON.stringify(job)) : null}
            />
          ) : null}

          {selected && listings ? (
            <Card className="rise rise-2 overflow-hidden">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-5 py-3">
                <h2 className="font-display text-lg font-medium">Listings in revision {selected.sequence}</h2>
                {!isCurrent ? <Badge tone="warn">Historical revision · read-only</Badge> : null}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Listing population of revision {selected.sequence}, ordered by SKU</caption>
                  <thead className="border-b border-rule-strong bg-sunken/60">
                    <tr className="eyebrow [&>th]:px-5 [&>th]:py-2.5 [&>th]:font-normal">
                      <th scope="col">SKU</th>
                      <th scope="col">Title</th>
                      <th scope="col">Merchant category</th>
                      <th scope="col">Price</th>
                      <th scope="col">Review state</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {listings.items.map((l) => (
                      <tr key={l.id} className={`[&>td]:px-5 [&>td]:py-2.5 ${l.active ? "" : "text-muted"}`}>
                        <td className="font-mono text-xs whitespace-nowrap">{l.sku}</td>
                        <td>
                          {l.active && isCurrent ? (
                            <Link href={`/review/${l.id}`} className="underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                              {l.title}
                            </Link>
                          ) : (
                            l.title
                          )}
                        </td>
                        <td className="text-ink-soft">{l.merchantCategoryPath ?? "—"}</td>
                        <td className="font-mono text-xs whitespace-nowrap">{l.price ? `${Number(l.price).toFixed(2)} ${l.currency}` : "—"}</td>
                        <td>{!l.active ? <Badge>Inactive in this revision</Badge> : l.state ? <Badge tone={STATE_TONES[l.state]}>{STATE_LABELS[l.state]}</Badge> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-rule px-5 py-3 text-sm">
                <span className="text-muted">
                  Showing {listings.items.length} listing{listings.items.length === 1 ? "" : "s"}
                  {query.cursor ? ` after ${query.cursor}` : ""}
                </span>
                <span className="flex gap-3">
                  {query.cursor ? (
                    <Link href={`/catalogs/${merchant.id}?revision=${selected.id}`} className="font-semibold underline underline-offset-4">
                      First page
                    </Link>
                  ) : null}
                  {listings.nextCursor ? (
                    <Link href={`/catalogs/${merchant.id}?revision=${selected.id}&cursor=${encodeURIComponent(listings.nextCursor)}`} className="font-semibold underline underline-offset-4">
                      Next page
                    </Link>
                  ) : null}
                </span>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
