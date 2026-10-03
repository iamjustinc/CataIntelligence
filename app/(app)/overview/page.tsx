import Link from "next/link";
import { Badge, buttonClass, Card, PageHeader } from "@/components/ui";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getSetupProgress } from "@/lib/domain/workspace";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const { actor } = await requirePageSession();
  const progress = await getSetupProgress(actor);

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
  const remaining = progress.activeListings - progress.approvedListings;
  // Only the next actionable step is emphasised.
  const next = steps.find((s) => s.count === 0 && s.allowed);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Overview · ${actor.workspace.name}`}
        title={progress.activeListings > 0 ? "Review progress" : "Workspace setup"}
        description="Counts are live queries over this workspace's records. The governed dashboard with coverage, backlog and trends arrives with the analytics phase."
        actions={
          remaining > 0 ? (
            <Link href="/review?state=unresolved" className={buttonClass.primary}>
              Continue review
            </Link>
          ) : undefined
        }
      />

      {progress.activeListings > 0 ? (
        <dl className="rise grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-3">
          {(
            [
              ["Active listings", progress.activeListings, "In merchants' current catalog revisions", "/catalogs"],
              ["Approved (draft)", progress.approvedListings, "Reviewer-approved mappings, published or not", "/review?state=approved"],
              ["Pending review", remaining, "Active listings whose state is not Approved", "/review?state=unresolved"],
            ] as const
          ).map(([label, value, scope, href]) => (
            <div key={label} className="bg-surface px-5 py-4">
              <dt className="eyebrow">{label}</dt>
              <dd className="mt-1 font-display text-4xl">
                <Link href={href} className="underline decoration-rule-strong decoration-1 underline-offset-8 hover:decoration-ink">
                  {value}
                </Link>
              </dd>
              <dd className="mt-2 text-xs text-muted">{scope}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {progress.staleListings > 0 ? (
        <p className="rounded-sm border border-warn/40 bg-warn-bg px-4 py-3 text-sm text-warn">
          {progress.staleListings} listing{progress.staleListings === 1 ? " is" : "s are"} stale after a taxonomy change.{" "}
          <Link href="/taxonomy" className="font-semibold underline underline-offset-4">
            Open taxonomy to revalidate
          </Link>
        </p>
      ) : null}

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

    </div>
  );
}
