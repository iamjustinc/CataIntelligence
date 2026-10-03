import { NotBuiltYet } from "@/components/ui";
import { requirePageSession } from "@/lib/auth/session";

export const metadata = { title: "Releases" };

export default async function Page() {
  await requirePageSession();
  return <NotBuiltYet eyebrow="Releases" title="Mapping releases" phase="Phase 1" requirements="TAX12, TAX13" summary="Publication preview, immutable mapping releases, rollback and exports." />;
}
