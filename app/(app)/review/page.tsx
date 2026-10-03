import { NotBuiltYet } from "@/components/ui";
import { requirePageSession } from "@/lib/auth/session";

export const metadata = { title: "Review Queue" };

export default async function Page() {
  await requirePageSession();
  return <NotBuiltYet eyebrow="Review Queue" title="Review queue" phase="Phase 1" requirements="TAX08, TAX09" summary="The filtered queue and the three-panel review workspace: source listing, proposed canonical concept with evidence and alternatives, and review actions." />;
}
