import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, StatePanel } from "@/components/ui";
import { ApiError } from "@/lib/api/errors";
import { can, ROLE_LABELS } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getMerchant } from "@/lib/domain/merchants";
import { CatalogImportWizard } from "./import-wizard";

export const metadata = { title: "Import catalog" };

export default async function CatalogImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await requirePageSession();
  const { id } = await params;
  let merchant;
  try {
    merchant = await getMerchant(actor, id);
  } catch (err) {
    if (err instanceof ApiError || (err as { code?: string }).code === "22P02") notFound();
    throw err;
  }
  const back = (
    <Link href={`/catalogs/${merchant.id}`} className="text-sm font-semibold text-stamp underline underline-offset-4">
      Back to {merchant.name}
    </Link>
  );
  if (!can(actor.role, "catalog.import")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={`${merchant.name} · Import`} title="Import catalog" actions={back} />
        <StatePanel kind="denied" title="Taxonomists and administrators only">
          Your role is {ROLE_LABELS[actor.role]}. You can view catalogs and published releases, but not import them.
        </StatePanel>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${merchant.name} · Import`}
        title="Import catalog"
        description="Upload a UTF-8 CSV of up to 10 MB and 5,000 rows. Nothing is saved to the catalog until you review the validation summary and commit."
        actions={back}
      />
      <CatalogImportWizard merchantId={merchant.id} hasCatalog={merchant.activeCatalogRevisionId !== null} />
    </div>
  );
}
