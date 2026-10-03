import Link from "next/link";
import { buttonClass, Card, inputClass, PageHeader, StatePanel } from "@/components/ui";
import { can, ROLE_LABELS, type Role } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { listAuditEvents } from "@/lib/domain/audit";

export const metadata = { title: "Audit" };

const ACTION_GROUPS = [
  ["", "All actions"],
  ["catalog", "Catalog imports"],
  ["analysis", "Analysis"],
  ["review", "Review decisions"],
  ["taxonomy", "Taxonomy"],
  ["release", "Releases and exports"],
  ["merchant", "Merchants"],
] as const;

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { actor } = await requirePageSession();
  const q = await searchParams;
  if (!can(actor.role, "audit.read")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Audit" title="Audit log" />
        <StatePanel kind="denied" title="Taxonomists and administrators only">
          Your role is {ROLE_LABELS[actor.role]}. The audit log records who changed what and why.
        </StatePanel>
      </div>
    );
  }
  const data = await listAuditEvents(actor, { action: q.action, entityType: q.entityType, q: q.q, cursor: q.cursor, limit: 50 });
  const carried = new URLSearchParams();
  for (const k of ["action", "entityType", "q"]) if (q[k]) carried.set(k, q[k]!);
  const next = new URLSearchParams(carried);
  if (data.nextCursor) next.set("cursor", data.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Audit" title="Audit log" description="Append-only record of imports, decisions, taxonomy changes, publications and exports. Events are written in the same transaction as the change they describe and cannot be edited." />
      <form method="get" className="rise rise-1 grid gap-3 rounded-md border border-rule bg-surface p-4 sm:grid-cols-[1.5fr_1fr_1fr_auto]" aria-label="Audit filters">
        <div>
          <label htmlFor="a-q" className="eyebrow mb-1 block">
            Search entity ID, request ID or reason
          </label>
          <input id="a-q" name="q" type="search" defaultValue={q.q ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor="a-action" className="eyebrow mb-1 block">
            Action
          </label>
          <select id="a-action" name="action" defaultValue={q.action ?? ""} className={inputClass}>
            {ACTION_GROUPS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="a-entity" className="eyebrow mb-1 block">
            Entity
          </label>
          <select id="a-entity" name="entityType" defaultValue={q.entityType ?? ""} className={inputClass}>
            <option value="">All entities</option>
            {data.entityTypes.map((t) => (
              <option key={t} value={t}>
                {t.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button type="submit" className={buttonClass.secondary}>
            Apply
          </button>
        </div>
      </form>

      {data.items.length === 0 ? (
        <StatePanel kind="empty" title="No matching events">
          {carried.size ? "Change or clear the filters." : "Nothing has been recorded in this workspace yet."}
        </StatePanel>
      ) : (
        <Card className="rise rise-2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Audit events, newest first</caption>
              <thead className="border-b border-rule-strong bg-sunken/60">
                <tr className="eyebrow [&>th]:px-4 [&>th]:py-2.5 [&>th]:font-normal">
                  <th scope="col">Time (UTC)</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Reason and details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {data.items.map((e) => (
                  <tr key={e.id} className="align-top [&>td]:px-4 [&>td]:py-2.5">
                    <td className="font-mono text-xs whitespace-nowrap">{e.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                    <td>
                      {e.actorName ?? "System"}
                      <span className="block text-xs text-muted">{ROLE_LABELS[e.actorRole as Role] ?? e.actorRole}</span>
                    </td>
                    <td className="font-mono text-xs">{e.action}</td>
                    <td>
                      <span className="text-ink-soft">{e.entityType.replaceAll("_", " ")}</span>
                      {e.entityId ? <span className="block font-mono text-[0.65rem] break-all text-muted">{e.entityId}</span> : null}
                    </td>
                    <td className="max-w-md">
                      {e.reason ? <p className="text-ink-soft">“{e.reason}”</p> : null}
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted">Before, after and request ID</summary>
                        <dl className="mt-1 space-y-1 font-mono">
                          <div>
                            <dt className="text-muted">request</dt>
                            <dd className="break-all">{e.requestId}</dd>
                          </div>
                          <div>
                            <dt className="text-muted">before</dt>
                            <dd className="break-all whitespace-pre-wrap">{e.before ? JSON.stringify(e.before, null, 1) : "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted">after</dt>
                            <dd className="break-all whitespace-pre-wrap">{e.after ? JSON.stringify(e.after, null, 1) : "—"}</dd>
                          </div>
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-rule px-5 py-3 text-sm">
            <span className="text-muted">{data.items.length} events on this page</span>
            <span className="flex gap-4">
              {q.cursor ? (
                <Link href={`/audit?${carried}`} className="font-semibold underline underline-offset-4">
                  Newest
                </Link>
              ) : null}
              {data.nextCursor ? (
                <Link href={`/audit?${next}`} className="font-semibold underline underline-offset-4">
                  Older
                </Link>
              ) : null}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
