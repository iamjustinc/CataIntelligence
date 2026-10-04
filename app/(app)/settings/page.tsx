import { Badge, Card, PageHeader, StatePanel } from "@/components/ui";
import { can, ROLE_LABELS } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getSettings } from "@/lib/domain/settings";
import { getWorkspace, listMembers } from "@/lib/domain/workspace";
import { SettingsForm } from "./settings-form";

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
  const [workspace, members, settings] = await Promise.all([getWorkspace(actor), listMembers(actor), getSettings(actor)]);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Settings" title="Workspace settings" description={`${workspace.name} · timezone ${workspace.timezone} · ${workspace.isDemo ? "synthetic demo data" : "workspace data"}. Changes are recorded in the audit log.`} />
      <Card className="rise rise-1 p-5">
        <SettingsForm settings={settings} />
      </Card>
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
