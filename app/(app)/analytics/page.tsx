import { NotBuiltYet } from "@/components/ui";
import { requirePageSession } from "@/lib/auth/session";

export const metadata = { title: "Analytics" };

export default async function Page() {
  await requirePageSession();
  return <NotBuiltYet eyebrow="Analytics" title="Ask the catalog" phase="Phase 3" requirements="ANA01 to ANA06" summary="Governed natural-language analytics over the same persisted records. The metric registry and AnalysisSpec contract already exist on the server." />;
}
