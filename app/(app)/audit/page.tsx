import { NotBuiltYet } from "@/components/ui";
import { requirePageSession } from "@/lib/auth/session";

export const metadata = { title: "Audit" };

export default async function Page() {
  await requirePageSession();
  return <NotBuiltYet eyebrow="Audit" title="Audit log" phase="Phase 1" requirements="TAX13" summary="Searchable audit events. Events are already recorded append-only in the database for every change made so far." />;
}
