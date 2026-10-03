import Link from "next/link";
import { TaxonomyBrowser } from "@/components/taxonomy-browser";
import { Badge, buttonClass, PageHeader, StatePanel } from "@/components/ui";
import { ApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getTaxonomyVersion, listTaxonomyVersions } from "@/lib/domain/taxonomy";
import { DraftActions } from "./version-actions";

export const metadata = { title: "Taxonomy" };

const formatUtc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function TaxonomyPage({ searchParams }: { searchParams: Promise<{ version?: string }> }) {
  const { actor } = await requirePageSession();
  const { version: requested } = await searchParams;
  const { activeVersionId, versions } = await listTaxonomyVersions(actor);
  const canManage = can(actor.role, "taxonomy.manage");
  const importLink = (
    <Link href="/taxonomy/import" className={buttonClass.secondary}>
      Import taxonomy CSV
    </Link>
  );

  if (versions.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxonomy" title="Canonical taxonomy" />
        <StatePanel
          kind="empty"
          title="No taxonomy has been loaded"
          action={
            canManage ? (
              <Link href="/taxonomy/import" className={buttonClass.primary}>
                Import taxonomy CSV
              </Link>
            ) : undefined
          }
        >
          {canManage
            ? "Import a CSV with concept_id, parent_id, name, definition, synonyms, status and mapping_allowed. It is validated before anything is saved."
            : "An administrator must import and publish the canonical taxonomy before catalogs can be mapped."}
        </StatePanel>
      </div>
    );
  }

  const selectedId = versions.find((v) => v.id === requested)?.id ?? activeVersionId ?? versions[0].id;
  let data;
  try {
    data = await getTaxonomyVersion(actor, selectedId);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return <StatePanel kind="error" title="This taxonomy version is not available">{err.message}</StatePanel>;
  }
  const meta = versions.find((v) => v.id === selectedId)!;
  const draft = versions.find((v) => v.state === "draft");
  const isActive = selectedId === activeVersionId;
  const mappable = data.concepts.filter((c) => c.mappingAllowed).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Taxonomy"
        title="Canonical taxonomy"
        description="Each version is an immutable snapshot once published. Products map to exactly one active leaf concept."
        actions={canManage ? importLink : undefined}
      />

      <div className="rise rise-1 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border border-rule bg-surface px-4 py-3">
        <nav aria-label="Taxonomy versions" className="flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-1">Version</span>
          {versions.map((v) => (
            <Link
              key={v.id}
              href={`/taxonomy?version=${v.id}`}
              aria-current={v.id === selectedId ? "page" : undefined}
              className={`rounded-sm border px-2.5 py-1 font-mono text-xs ${v.id === selectedId ? "border-ink bg-ink text-white" : "border-rule-strong hover:bg-sunken"}`}
            >
              v{v.sequence}
              {v.state === "draft" ? " draft" : v.id === activeVersionId ? " active" : ""}
            </Link>
          ))}
        </nav>
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <div className="flex items-center gap-2">
            <dt className="sr-only">State</dt>
            <dd>{meta.state === "draft" ? <Badge tone="warn">Draft · not live</Badge> : isActive ? <Badge tone="ok">Published · active</Badge> : <Badge>Published · historical</Badge>}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-muted">Concepts</dt>
            <dd className="font-mono text-xs">{data.concepts.length}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-muted">Mappable leaves</dt>
            <dd className="font-mono text-xs">{mappable}</dd>
          </div>
          {meta.publishedAt ? (
            <div className="flex items-baseline gap-1.5">
              <dt className="text-muted">Published</dt>
              <dd className="font-mono text-xs">
                {formatUtc(meta.publishedAt)}
                {meta.publishedByName ? ` by ${meta.publishedByName}` : ""}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      {meta.state === "draft" ? (
        <StatePanel kind="stale" title={`Draft version ${meta.sequence} is not live`} action={canManage ? <div className="flex flex-wrap gap-2"><DraftActions versionId={meta.id} sequence={meta.sequence} lockVersion={meta.lockVersion} conceptCount={data.concepts.length} /></div> : undefined}>
          {activeVersionId ? "Mappings and analytics keep using the active published version until an administrator publishes this draft." : "No version is published yet, so catalogs cannot be mapped."}
          {meta.note ? <span className="mt-1 block font-mono text-xs text-muted">{meta.note}</span> : null}
        </StatePanel>
      ) : !isActive ? (
        <StatePanel kind="stale" title={`Historical version ${meta.sequence}`}>
          You are inspecting an earlier published version. It is read-only and viewing it does not change the active taxonomy.
        </StatePanel>
      ) : draft && can(actor.role, "taxonomy.propose") ? (
        <p className="text-sm text-ink-soft">
          Draft version {draft.sequence} is in progress.{" "}
          <Link href={`/taxonomy?version=${draft.id}`} className="font-semibold text-stamp underline underline-offset-4">
            Review the draft
          </Link>
        </p>
      ) : null}

      <div className="rise rise-2">
        <TaxonomyBrowser key={selectedId} versionId={selectedId} concepts={data.concepts} />
      </div>
    </div>
  );
}
