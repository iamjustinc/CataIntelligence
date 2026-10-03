import { Badge, Card, PageHeader, StatePanel } from "@/components/ui";
import { can } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { listMerchants } from "@/lib/domain/merchants";
import { CreateMerchantForm } from "./create-merchant-form";

export const metadata = { title: "Merchants & Catalogs" };

export default async function CatalogsPage() {
  const { actor } = await requirePageSession();
  const merchants = await listMerchants(actor);
  const canManage = can(actor.role, "catalog.import");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Merchants & Catalogs"
        title="Merchants"
        description="A merchant owns its catalog revisions. Listings are mapped per merchant; products are never merged across merchants on name similarity."
      />

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="rise rise-1 overflow-hidden">
          {merchants.length === 0 ? (
            <div className="p-5">
              <StatePanel kind="empty" title="No merchants yet">
                {canManage ? "Add the first merchant with the form on this page, then import its catalog." : "A taxonomist or administrator can add merchants."}
              </StatePanel>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Merchants in {actor.workspace.name}</caption>
                <thead className="border-b border-rule-strong bg-sunken/60">
                  <tr className="eyebrow [&>th]:px-5 [&>th]:py-2.5 [&>th]:font-normal">
                    <th scope="col">Merchant</th>
                    <th scope="col">External key</th>
                    <th scope="col">Region</th>
                    <th scope="col">Status</th>
                    <th scope="col">Current catalog</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {merchants.map((m) => (
                    <tr key={m.id} className="[&>td]:px-5 [&>td]:py-3">
                      <th scope="row" className="px-5 py-3 font-medium text-ink">
                        {m.name}
                      </th>
                      <td className="font-mono text-xs text-ink-soft">{m.externalKey ?? "—"}</td>
                      <td className="text-ink-soft">{m.region ?? "—"}</td>
                      <td>{m.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                      <td className="text-muted">{m.activeCatalogRevisionId ? <span className="font-mono text-xs">{m.activeCatalogRevisionId.slice(0, 8)}</span> : "No catalog imported"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <aside className="rise rise-2 space-y-4">
          {canManage ? (
            <Card className="p-5">
              <h2 className="font-display text-lg font-medium">Add merchant</h2>
              <CreateMerchantForm />
            </Card>
          ) : (
            <StatePanel kind="denied" title="Read-only access">
              Your role can view merchants and catalogs. Adding merchants and importing catalogs requires a taxonomist or administrator.
            </StatePanel>
          )}
          <StatePanel kind="pending" title="Catalog import: Phase 1">
            CSV upload, column mapping, validation and revisions (TAX03, TAX04) are the next milestone. No import data is simulated.
          </StatePanel>
        </aside>
      </div>
    </div>
  );
}
