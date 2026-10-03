import Link from "next/link";
import { PageHeader, StatePanel } from "@/components/ui";
import { can, ROLE_LABELS } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { listTaxonomyVersions } from "@/lib/domain/taxonomy";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Import taxonomy" };

export default async function TaxonomyImportPage() {
  const { actor } = await requirePageSession();
  const back = (
    <Link href="/taxonomy" className="text-sm font-semibold text-stamp underline underline-offset-4">
      Back to taxonomy
    </Link>
  );
  if (!can(actor.role, "taxonomy.manage")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxonomy · Import" title="Import taxonomy" actions={back} />
        <StatePanel kind="denied" title="Administrators only">
          Importing and publishing the canonical taxonomy requires an administrator. Your role is {ROLE_LABELS[actor.role]}; taxonomists can propose changes once proposals are available.
        </StatePanel>
      </div>
    );
  }
  const { versions } = await listTaxonomyVersions(actor);
  const draft = versions.find((v) => v.state === "draft");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Taxonomy · Import"
        title="Import taxonomy"
        description="Upload a UTF-8 CSV. The file is validated first; nothing changes until you commit it as a draft, and nothing is live until the draft is published."
        actions={back}
      />
      <ImportWizard existingDraftSequence={draft?.sequence ?? null} />
    </div>
  );
}
