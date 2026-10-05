import Link from "next/link";
import { Badge, Card, PageHeader, StatePanel } from "@/components/ui";
import { ApiError } from "@/lib/api/errors";
import { requirePageSession } from "@/lib/auth/session";
import { getAnalyticsContext, getConversation, listConversations, listReports } from "@/lib/domain/analytics";
import { getSetupProgress } from "@/lib/domain/workspace";
import { AnalyticsWorkspace } from "./analytics-workspace";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { actor } = await requirePageSession();
  const { c } = await searchParams;
  const [context, conversations, reports, progress] = await Promise.all([getAnalyticsContext(actor), listConversations(actor), listReports(actor), getSetupProgress(actor)]);
  let conversation: Awaited<ReturnType<typeof getConversation>> | null = null;
  let missing = false;
  if (c) {
    try {
      conversation = /^[0-9a-f-]{36}$/i.test(c) ? await getConversation(actor, c) : null;
      missing = !conversation;
    } catch (err) {
      // Someone else's conversation looks exactly like one that does not exist.
      if (err instanceof ApiError && err.code === "not_found") missing = true;
      else throw err;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Analytics"
        title="Ask the catalog"
        description="Questions are answered only through registered metrics. The server builds every query, scoped to this workspace, and computes every number from stored records; the same service feeds the dashboard."
      />
      {missing ? (
        <StatePanel kind="denied" title="Conversation not found">
          It does not exist or belongs to another member. Conversations are private to the person who started them.
        </StatePanel>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <AnalyticsWorkspace key={conversation?.id ?? "new"} planner={context.planner} vocabulary={context.vocabulary} initialRuns={conversation?.runs ?? []} initialConversationId={conversation?.id ?? null} hasData={progress.activeListings > 0} />
        <aside className="space-y-6">
          <Card>
            <h2 className="eyebrow border-b border-rule px-4 py-2.5">Saved reports</h2>
            {reports.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-soft">None yet. Run an analysis and choose “Save as report”.</p>
            ) : (
              <ul className="divide-y divide-rule" data-testid="report-list">
                {reports.map((r) => (
                  <li key={r.id} className="px-4 py-2.5 text-sm">
                    <Link href={`/analytics/reports/${r.id}`} className="font-medium underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                      {r.name}
                    </Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <Badge tone={r.visibility === "workspace" ? "info" : "neutral"}>{r.visibility === "workspace" ? "Shared" : "Private"}</Badge>
                      {r.mine ? "Yours" : `By ${r.ownerName}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h2 className="eyebrow border-b border-rule px-4 py-2.5">Your conversations</h2>
            {conversations.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-soft">Nothing yet. Only you can see your conversations.</p>
            ) : (
              <ul className="divide-y divide-rule" data-testid="conversation-list">
                {conversations.map((cv) => (
                  <li key={cv.id} className="px-4 py-2.5 text-sm">
                    <Link href={`/analytics?c=${cv.id}`} aria-current={cv.id === conversation?.id ? "page" : undefined} className="line-clamp-2 underline decoration-rule-strong underline-offset-4 hover:decoration-ink aria-[current=page]:font-semibold">
                      {cv.title}
                    </Link>
                    <p className="mt-0.5 font-mono text-[0.6875rem] text-muted">
                      {cv.createdAt.slice(0, 10)} · {cv.runs} {cv.runs === 1 ? "analysis" : "analyses"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-rule px-4 py-2.5 text-xs text-muted">Private to you. Other members see an analysis only if you save and share it as a report.</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
