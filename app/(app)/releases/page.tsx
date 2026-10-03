import Link from "next/link";
import { Badge, buttonClass, Card, PageHeader, StatePanel } from "@/components/ui";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { listMerchants } from "@/lib/domain/merchants";
import { listReleases } from "@/lib/domain/releases";
import { ReleaseRowActions } from "./release-actions";
import { PublishPanel } from "./publish-panel";

export const metadata = { title: "Releases" };
const formatUtc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function ReleasesPage() {
  const { actor } = await requirePageSession();
  const [releases, merchants] = await Promise.all([listReleases(actor), listMerchants(actor)]);
  const canPublish = can(actor.role, "release.publish");
  const withCatalog = merchants.filter((m) => m.activeCatalogRevisionId);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Releases"
        title="Mapping releases"
        description="A release is an immutable set of approved mappings bound to one catalog revision and one taxonomy version. Publishing moves the merchant's current-release pointer; history is never deleted."
      />

      <section aria-labelledby="publish-heading" className="space-y-3">
        <h2 id="publish-heading" className="font-display text-xl font-medium">
          Publish
        </h2>
        {withCatalog.length === 0 ? (
          <StatePanel kind="empty" title="No catalog to publish" action={<Link href="/catalogs" className={buttonClass.secondary}>Go to catalogs</Link>}>
            Import and review a merchant catalog first.
          </StatePanel>
        ) : !canPublish ? (
          <StatePanel kind="denied" title="Administrators publish releases">
            You can read and export published releases below. Publishing and rollback require an administrator.
          </StatePanel>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {withCatalog.map((m) => {
              const current = releases.find((r) => r.merchantId === m.id && r.isCurrent);
              return <PublishPanel key={m.id} merchant={{ id: m.id, name: m.name, revisionSequence: m.revisionSequence ?? 0, activeListings: m.activeListings ?? 0 }} currentRelease={current ? { releaseNumber: current.releaseNumber, compatible: current.compatible } : null} />;
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="font-display text-xl font-medium">
          Release history
        </h2>
        {releases.length === 0 ? (
          <StatePanel kind="empty" title="No releases published yet">
            Published coverage is zero for every merchant until its first release.
          </StatePanel>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Mapping releases, newest first</caption>
                <thead className="border-b border-rule-strong bg-sunken/60">
                  <tr className="eyebrow [&>th]:px-4 [&>th]:py-2.5 [&>th]:font-normal">
                    <th scope="col">Release</th>
                    <th scope="col">Merchant</th>
                    <th scope="col">Bound to</th>
                    <th scope="col">Mapped / unresolved</th>
                    <th scope="col">Published</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {releases.map((r) => (
                    <tr key={r.id} className="align-top [&>td]:px-4 [&>td]:py-3">
                      <th scope="row" className="px-4 py-3 text-left font-medium whitespace-nowrap">
                        Release {r.releaseNumber}
                        <span className="mt-1 flex flex-wrap gap-1">
                          {r.isCurrent ? <Badge tone="ok">Current</Badge> : <Badge>Historical</Badge>}
                          {r.partial ? <Badge tone="warn">Partial</Badge> : <Badge tone="info">Full</Badge>}
                          {r.isCurrent && !r.compatible ? (
                            <Badge tone="danger" title="The merchant has a newer catalog revision. Published coverage of the current catalog is zero until a new release.">
                              Catalog superseded
                            </Badge>
                          ) : null}
                        </span>
                      </th>
                      <td>{r.merchantName}</td>
                      <td className="text-ink-soft">
                        Catalog revision {r.revisionSequence}
                        <br />
                        Taxonomy v{r.taxonomySequence}
                      </td>
                      <td>
                        <span className="font-mono">{r.counts.mapped}</span> / <span className="font-mono">{r.counts.unresolved}</span>
                        <span className="block text-xs text-muted">of {r.counts.activeListings} active listings</span>
                      </td>
                      <td className="text-xs text-ink-soft">
                        {formatUtc(r.publishedAt)}
                        <br />
                        {r.publishedByName}
                        <span className="mt-1 block max-w-[16rem] text-muted">“{r.reason}”</span>
                      </td>
                      <td>
                        <ReleaseRowActions release={{ id: r.id, releaseNumber: r.releaseNumber, isCurrent: r.isCurrent, compatible: r.compatible, pointerLock: r.pointerLock ?? 0, revisionSequence: r.revisionSequence }} canActivate={canPublish} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
