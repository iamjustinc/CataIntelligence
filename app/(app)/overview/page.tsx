import Link from "next/link";
import { BarList, ChartFrame, Distribution, LineChart } from "@/components/charts";
import { Badge, buttonClass, Card, PageHeader } from "@/components/ui";
import { drilldownHref, formatFraction, formatValue } from "@/lib/analytics/format";
import { baseSpec } from "@/lib/analytics/metric-service";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getDashboard } from "@/lib/domain/analytics";
import { getSetupProgress } from "@/lib/domain/workspace";
import { STATE_TONES, type ReviewState } from "@/lib/review-labels";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const { actor } = await requirePageSession();
  const [progress, dashboard] = await Promise.all([getSetupProgress(actor), getDashboard(actor)]);

  const steps = [
    {
      title: "Publish a canonical taxonomy",
      detail: "Load the concept tree, validate it and publish version 1. Mappings can only target a published version.",
      count: progress.publishedTaxonomyVersions,
      unit: "published version",
      href: "/taxonomy",
      action: "Open taxonomy",
      allowed: can(actor.role, "taxonomy.manage"),
      who: "an administrator",
    },
    {
      title: "Add merchants",
      detail: "Each catalog import belongs to one merchant and creates an immutable revision.",
      count: progress.merchants,
      unit: "active merchant",
      href: "/catalogs",
      action: "Manage merchants",
      allowed: can(actor.role, "catalog.import"),
      who: "a taxonomist or administrator",
    },
    {
      title: "Import a merchant catalog",
      detail: "Upload a CSV, map its columns, review the validation summary and commit the valid rows.",
      count: progress.catalogRevisions,
      unit: "catalog revision",
      href: "/catalogs",
      action: "Open catalogs",
      allowed: can(actor.role, "catalog.import"),
      who: "a taxonomist or administrator",
    },
    {
      title: "Review and publish a mapping release",
      detail: "Approve or correct mappings, then publish a release bound to one catalog revision and one taxonomy version.",
      count: progress.mappingReleases,
      unit: "mapping release",
      href: "/releases",
      action: "Open releases",
      allowed: can(actor.role, "release.publish"),
      who: "an administrator",
    },
  ];
  const done = steps.filter((s) => s.count > 0).length;
  // Only the next actionable step is emphasised.
  const next = steps.find((s) => s.count === 0 && s.allowed);
  const hasListings = progress.activeListings > 0;
  const pending = dashboard.cards.find((c) => c.metricId === "pending_review_count")?.raw ?? 0;
  const asOf = `${dashboard.observedAt.slice(0, 16).replace("T", " ")} UTC`;
  const cardLink = (metricId: (typeof dashboard.cards)[number]["metricId"]) => (metricId === "listing_count" ? { href: "/review", label: "Open all listings" } : drilldownHref(baseSpec(metricId), metricId));
  const rate = (v: { value: number | null }) => (v.value === null ? 0 : v.value * 100);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Overview · ${actor.workspace.name}`}
        title={hasListings ? "Operational dashboard" : "Workspace setup"}
        description={hasListings ? `Every figure is computed from this workspace's records by the same metric service that answers analytics questions. As of ${asOf}. Counts are as-of counts of current catalogs, not history.` : "Counts are live queries over this workspace's records."}
        actions={
          <>
            {hasListings ? (
              <Link href="/analytics" className={buttonClass.secondary}>
                Ask a question
              </Link>
            ) : null}
            {pending > 0 ? (
              <Link href="/review?state=unresolved" className={buttonClass.primary}>
                Continue review
              </Link>
            ) : null}
          </>
        }
      />

      {hasListings ? (
        <>
          <dl className="rise grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3" data-testid="dashboard-cards">
            {dashboard.cards.map((card) => {
              const link = cardLink(card.metricId);
              return (
                <div key={card.metricId} className="flex flex-col bg-surface px-5 py-4" data-metric={card.metricId}>
                  <dt className="eyebrow">{card.label}</dt>
                  <dd className="mt-1 flex items-baseline gap-3">
                    <span className="font-display text-4xl" data-testid="card-value">
                      {card.value}
                    </span>
                    {card.fraction ? (
                      <span className="font-mono text-xs text-muted" data-testid="card-fraction">
                        {card.fraction}
                      </span>
                    ) : null}
                  </dd>
                  <dd className="mt-2 flex-1 text-xs leading-relaxed text-muted">{card.scope}</dd>
                  {link ? (
                    <dd className="mt-3">
                      <Link href={link.href} className="text-sm font-semibold text-stamp underline underline-offset-4">
                        {link.label}
                      </Link>
                    </dd>
                  ) : null}
                </div>
              );
            })}
          </dl>
          {dashboard.publishedWarnings.map((w) => (
            <p key={w} className="rounded-sm border border-warn/40 bg-warn-bg px-4 py-3 text-sm text-warn">
              {w}
            </p>
          ))}
          {progress.staleListings > 0 ? (
            <p className="rounded-sm border border-warn/40 bg-warn-bg px-4 py-3 text-sm text-warn">
              {progress.staleListings} listing{progress.staleListings === 1 ? " is" : "s are"} stale after a taxonomy change.{" "}
              <Link href="/taxonomy" className="font-semibold underline underline-offset-4">
                Open taxonomy to revalidate
              </Link>
            </p>
          ) : null}

          <ChartFrame
            title="Merchant comparison"
            scope="Each merchant's current catalog revision. Published coverage uses the merchant's current release for that revision; a merchant without one has zero published mappings. The Total row sums numerators and denominators; merchant rates are never averaged."
            action={
              <Link href="/releases" className="text-sm font-semibold underline underline-offset-4">
                View releases
              </Link>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm" data-testid="merchant-comparison">
                <thead>
                  <tr className="border-b border-rule-strong text-left">
                    {["Merchant", "Active listings", "Published coverage", "Approved draft coverage", "Pending review", "Failed analysis", "Current release"].map((h, i) => (
                      <th key={h} scope="col" className={`eyebrow py-2 pr-4 font-normal ${i === 1 || i === 4 || i === 5 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {dashboard.merchants.map((m) => (
                    <tr key={m.id}>
                      <th scope="row" className="py-2.5 pr-4 text-left font-medium">
                        <Link href={`/review?merchant=${m.id}`} className="underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                          {m.name}
                        </Link>
                      </th>
                      <td className="py-2.5 pr-4 text-right font-mono">{m.listings.value}</td>
                      {([["published_mapping_coverage", m.published, "bg-ink-soft", `/review?merchant=${m.id}&published=unmapped`], ["approved_draft_coverage", m.draft, "bg-ok", `/review?merchant=${m.id}&state=unresolved`]] as const).map(([id, v, fill, href]) => (
                        <td key={id} className="py-2.5 pr-4">
                          <span className="flex items-center gap-2">
                            <span aria-hidden className="h-2.5 w-20 shrink-0 rounded-[1px] bg-sunken">
                              <span className={`block h-full rounded-[1px] ${fill}`} style={{ width: `${rate(v)}%` }} />
                            </span>
                            <Link href={href} className="font-mono whitespace-nowrap underline decoration-rule-strong underline-offset-4 hover:decoration-ink" title="Open the listings not yet counted">
                              {formatValue(id, v)}
                            </Link>
                            <span className="font-mono text-xs whitespace-nowrap text-muted">{formatFraction(v)}</span>
                          </span>
                        </td>
                      ))}
                      <td className="py-2.5 pr-4 text-right font-mono">{m.pending.value}</td>
                      <td className="py-2.5 pr-4 text-right font-mono">{m.failed.value}</td>
                      <td className="py-2.5 text-ink-soft">{m.releaseNumber ? `Release ${m.releaseNumber}, revision ${m.revisionSequence}` : m.releaseSuperseded ? "None for the current revision" : "Never published"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-rule-strong font-medium">
                    <th scope="row" className="py-2.5 pr-4 text-left">
                      Total
                    </th>
                    {dashboard.cards.slice(0, 3).map((c, i) => (
                      <td key={c.metricId} className={`py-2.5 pr-4 font-mono ${i === 0 ? "text-right" : ""}`}>
                        {c.value}
                        {c.fraction ? <span className="ml-2 text-xs font-normal text-muted">{c.fraction}</span> : null}
                      </td>
                    ))}
                    <td className="py-2.5 pr-4 text-right font-mono">{dashboard.cards[3].value}</td>
                    <td className="py-2.5 pr-4 text-right font-mono">{dashboard.cards[5].value}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </ChartFrame>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartFrame title="Review-state distribution" scope="Active listings in current catalog revisions by their latest workflow state. Each state links to the same listings in the review queue.">
              <Distribution label="Listings by review state" unit="active listings" segments={dashboard.states.map((s) => ({ key: s.state, label: s.label, value: s.count, tone: STATE_TONES[s.state as ReviewState] ?? "neutral", href: `/review?state=${s.state}` }))} />
            </ChartFrame>
            <ChartFrame
              title="Review completions"
              scope={`Distinct listings with a human review decision per UTC day, last 30 days. Carried-forward decisions are excluded. ${dashboard.activity.total} distinct listings in the period; a listing reviewed on two days appears on both.`}
            >
              <LineChart label="Listings reviewed per day" yLabel="Listings reviewed per UTC day" points={dashboard.activity.days.map((d) => ({ key: d.day, label: d.day, value: d.count, text: `${d.count} reviewed` }))} />
            </ChartFrame>
          </div>

          <ChartFrame
            title="Publications"
            scope={`Mapping releases by the UTC day they were published, from the release records: ${dashboard.publications.releases} release${dashboard.publications.releases === 1 ? "" : "s"} containing ${dashboard.publications.mappings} mappings in total. A listing republished in a later release is counted in each. This is publication activity, not coverage over time; past coverage is not recorded and is not estimated.`}
            action={
              <Link href="/releases" className="text-sm font-semibold underline underline-offset-4">
                View releases
              </Link>
            }
          >
            {dashboard.latestRelease ? (
              <p className="mb-4 text-sm" data-testid="latest-release">
                Most recent: <span className="font-display text-lg">Release {dashboard.latestRelease.releaseNumber}</span> · {dashboard.latestRelease.merchantName} · {dashboard.latestRelease.mapped} mappings{dashboard.latestRelease.partial ? " (partial)" : ""} · {dashboard.latestRelease.publishedAt.slice(0, 16).replace("T", " ")} UTC
              </p>
            ) : (
              <p className="text-sm text-ink-soft">Nothing has been published yet, so published coverage is zero for every merchant.</p>
            )}
            {dashboard.publications.days.length > 0 ? (
              <div data-testid="publication-trend">
                <BarList label="Mappings published per UTC day" data={dashboard.publications.days.map((d) => ({ key: d.day, label: d.day, value: d.mappings, text: `${d.mappings} mappings`, detail: `${d.releases} release${d.releases === 1 ? "" : "s"}` }))} />
              </div>
            ) : null}
          </ChartFrame>
        </>
      ) : null}

      {done < steps.length || !hasListings ? (
        <Card className="rise rise-1">
        <div className="flex items-baseline justify-between border-b border-rule px-5 py-3">
          <h2 className="font-display text-lg font-medium">Setup checklist</h2>
          <p className="font-mono text-xs text-muted" aria-label={`${done} of ${steps.length} steps have records`}>
            {done} / {steps.length}
          </p>
        </div>
        <ol className="divide-y divide-rule">
          {steps.map((step, i) => (
            <li key={step.title} className="grid gap-3 px-5 py-4 sm:grid-cols-[2.5rem_1fr_auto] sm:items-center">
              <span aria-hidden className="font-mono text-sm text-muted">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-ink">{step.title}</h3>
                  {step.count > 0 ? (
                    <Badge tone="ok">
                      {step.count} {step.unit}
                      {step.count === 1 ? "" : "s"}
                    </Badge>
                  ) : (
                    <Badge>None yet</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">{step.detail}</p>
                {!step.allowed ? <p className="mt-1 text-xs text-muted">Your role can view this. Changes require {step.who}.</p> : null}
              </div>
              <Link href={step.href} className={step === next ? buttonClass.primary : buttonClass.secondary}>
                {step.action}
              </Link>
            </li>
          ))}
        </ol>
      </Card>
      ) : null}
    </div>
  );
}
