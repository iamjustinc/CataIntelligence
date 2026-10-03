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
      action: "Go to catalogs",
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

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Overview · ${actor.workspace.name}`}
        title="Workspace setup"
        description="Coverage, backlog and review metrics appear here once this workspace holds catalog data. Until then this page shows only what the database contains."
      />

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

      <p className="rise rise-2 max-w-3xl text-sm leading-relaxed text-muted">
        Counts above are live queries scoped to this workspace: published taxonomy versions, active merchants, catalog revisions and mapping releases.
        {progress.draftTaxonomyVersions > 0 ? ` One taxonomy draft is in progress.` : ""}
      </p>
    </div>
  );
}
