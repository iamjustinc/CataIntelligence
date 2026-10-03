import { Badge, Card, PageHeader, StatePanel } from "@/components/ui";
import { can, ROLE_LABELS } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getProviderStatus, getWorkspace, listMembers } from "@/lib/domain/workspace";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { actor } = await requirePageSession();
  if (!can(actor.role, "workspace.manage")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Settings" title="Workspace settings" />
        <StatePanel kind="denied" title="Administrators only">
          Workspace members, AI provider mode and spending caps are managed by administrators. Your role in {actor.workspace.name} is {ROLE_LABELS[actor.role]}.
        </StatePanel>
      </div>
    );
  }
  const [workspace, members, provider] = await Promise.all([getWorkspace(actor), listMembers(actor), getProviderStatus(actor)]);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Settings" title="Workspace settings" description="Read-only in this build. Editing members, provider mode and budgets arrives with the live AI phase." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rise rise-1 p-5">
          <h2 className="font-display text-lg font-medium">Workspace</h2>
          <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Name</dt>
            <dd>{workspace.name}</dd>
            <dt className="text-muted">Timezone</dt>
            <dd className="font-mono text-xs">{workspace.timezone}</dd>
            <dt className="text-muted">Data</dt>
            <dd>{workspace.isDemo ? "Synthetic demo data" : "Workspace data"}</dd>
          </dl>
        </Card>
        <Card className="rise rise-2 p-5">
          <h2 className="font-display text-lg font-medium">AI provider</h2>
          <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Mode</dt>
            <dd>
              <Badge tone={provider.state === "demo" ? "warn" : provider.state === "live" ? "ok" : provider.state === "unavailable" ? "danger" : "neutral"}>{provider.label}</Badge>
            </dd>
            <dt className="text-muted">Status</dt>
            <dd className="leading-relaxed text-ink-soft">{provider.detail}</dd>
            <dt className="text-muted">Per-job token cap</dt>
            <dd className="font-mono text-xs">{workspace.jobTokenCap.toLocaleString("en-US")}</dd>
            <dt className="text-muted">Per-job spend cap</dt>
            <dd className="font-mono text-xs">USD {workspace.jobSpendCapUsd}</dd>
            <dt className="text-muted">Daily spend cap</dt>
            <dd className="font-mono text-xs">USD {workspace.dailySpendCapUsd}</dd>
          </dl>
        </Card>
      </div>
      <Card className="rise rise-3 overflow-hidden">
        <h2 className="border-b border-rule px-5 py-3 font-display text-lg font-medium">Members</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Workspace members and roles</caption>
            <thead className="border-b border-rule-strong bg-sunken/60">
              <tr className="eyebrow [&>th]:px-5 [&>th]:py-2.5 [&>th]:font-normal">
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {members.map((m) => (
                <tr key={m.id} className="[&>td]:px-5 [&>td]:py-3">
                  <th scope="row" className="px-5 py-3 font-medium">
                    {m.name}
                  </th>
                  <td className="font-mono text-xs text-ink-soft">{m.email}</td>
                  <td>{ROLE_LABELS[m.role]}</td>
                  <td>{m.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
