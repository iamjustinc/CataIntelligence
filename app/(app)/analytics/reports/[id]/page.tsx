import Link from "next/link";
import { Badge, buttonClass, PageHeader, StatePanel } from "@/components/ui";
import { ApiError } from "@/lib/api/errors";
import { requirePageSession } from "@/lib/auth/session";
import { getReport } from "@/lib/domain/analytics";
import { ReportView } from "./report-view";

export const metadata = { title: "Saved report" };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await requirePageSession();
  const { id } = await params;
  let report: Awaited<ReturnType<typeof getReport>> | null = null;
  try {
    report = /^[0-9a-f-]{36}$/i.test(id) ? await getReport(actor, id) : null;
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "not_found")) throw err;
  }
  if (!report || !report.snapshot) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Analytics · Saved report" title="Report not available" />
        <StatePanel kind="denied" title="You cannot open this report" action={<Link href="/analytics" className={buttonClass.secondary}>Back to analytics</Link>}>
          It does not exist, is private to another member, or belongs to a different workspace.
        </StatePanel>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/analytics" className="underline underline-offset-4">
              Analytics
            </Link>{" "}
            · Saved report
          </>
        }
        title={report.name}
        description={`Saved by ${report.mine ? "you" : report.ownerName} on ${report.createdAt.slice(0, 10)}. The saved result is kept exactly as it was; refreshing computes a separate result from current data.`}
        actions={<Badge tone={report.visibility === "workspace" ? "info" : "neutral"}>{report.visibility === "workspace" ? "Shared with workspace" : "Private"}</Badge>}
      />
      <ReportView report={report} />
    </div>
  );
}
