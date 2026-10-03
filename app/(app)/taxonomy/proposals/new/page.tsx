import Link from "next/link";
import { PageHeader, StatePanel } from "@/components/ui";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getReviewItem } from "@/lib/domain/review";
import { getTaxonomyVersion, listTaxonomyVersions } from "@/lib/domain/taxonomy";
import { ProposalForm } from "./proposal-form";

export const metadata = { title: "New taxonomy proposal" };
const UUID = /^[0-9a-f-]{36}$/i;

export default async function NewProposalPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { actor } = await requirePageSession();
  const q = await searchParams;
  const back = (
    <Link href="/taxonomy/proposals" className="text-sm font-semibold text-stamp underline underline-offset-4">
      Back to proposals
    </Link>
  );
  if (!can(actor.role, "taxonomy.propose")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxonomy · Proposals" title="New proposal" actions={back} />
        <StatePanel kind="denied" title="Taxonomists and administrators only">Proposing taxonomy changes requires a taxonomist or administrator.</StatePanel>
      </div>
    );
  }
  const { activeVersionId } = await listTaxonomyVersions(actor);
  if (!activeVersionId) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxonomy · Proposals" title="New proposal" actions={back} />
        <StatePanel kind="empty" title="No published taxonomy">Publish a taxonomy version before proposing changes to it.</StatePanel>
      </div>
    );
  }
  const { concepts, version } = await getTaxonomyVersion(actor, activeVersionId);
  const listing = q.listing && UUID.test(q.listing) ? await getReviewItem(actor, q.listing).catch(() => null) : null;
  const active = concepts.filter((c) => c.status === "active");
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Taxonomy · Proposals" title="New proposal" description={`Proposed against active taxonomy version ${version.sequence}. An administrator reviews it; nothing changes until they approve and publish.`} actions={back} />
      <ProposalForm
        parents={active.filter((c) => !c.mappingAllowed).map((c) => ({ id: c.conceptId, path: c.path }))}
        concepts={active.map((c) => ({ id: c.conceptId, path: c.path }))}
        initial={{ type: q.type === "synonym" ? "synonym" : "new_leaf", name: q.name?.slice(0, 120) ?? "", parent: q.parent && UUID.test(q.parent) ? q.parent : "", concept: q.concept && UUID.test(q.concept) ? q.concept : "" }}
        listing={listing ? { id: listing.listing.id, title: listing.listing.title, sku: listing.listing.sku } : null}
      />
    </div>
  );
}
