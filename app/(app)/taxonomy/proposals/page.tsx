import Link from "next/link";
import { Badge, buttonClass, Card, PageHeader, StatePanel } from "@/components/ui";
import { can, ROLE_LABELS } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { listProposals, type NewLeafPayload, type SynonymPayload } from "@/lib/domain/proposals";
import { ProposalDecisionForm } from "./decision-form";

export const metadata = { title: "Taxonomy proposals" };
const TONE = { submitted: "info", approved: "ok", modified: "ok", rejected: "danger" } as const;
const LABEL = { submitted: "Awaiting decision", approved: "Approved", modified: "Approved with changes", rejected: "Rejected" } as const;

export default async function ProposalsPage() {
  const { actor } = await requirePageSession();
  const back = (
    <Link href="/taxonomy" className="text-sm font-semibold text-stamp underline underline-offset-4">
      Back to taxonomy
    </Link>
  );
  if (!can(actor.role, "taxonomy.propose")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxonomy · Proposals" title="Taxonomy proposals" actions={back} />
        <StatePanel kind="denied" title="Taxonomists and administrators only">
          Your role is {ROLE_LABELS[actor.role]}. Published taxonomy versions are visible on the Taxonomy page.
        </StatePanel>
      </div>
    );
  }
  const proposals = await listProposals(actor);
  const canDecide = can(actor.role, "taxonomy.manage");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Taxonomy · Proposals"
        title="Taxonomy proposals"
        description="Reviewers propose new leaf concepts and synonyms. An administrator decides; approval changes the draft taxonomy only, and nothing is live until that draft is published."
        actions={
          <>
            {back}
            <Link href="/taxonomy/proposals/new" className={buttonClass.secondary}>
              New proposal
            </Link>
          </>
        }
      />
      {proposals.length === 0 ? (
        <StatePanel kind="empty" title="No proposals yet">
          Propose a new leaf from a listing marked No suitable category, or a synonym from a concept in the taxonomy tree.
        </StatePanel>
      ) : (
        <ul className="space-y-4">
          {proposals.map((p) => {
            const leaf = p.type === "new_leaf" ? (p.payload as NewLeafPayload) : null;
            const syn = p.type === "synonym" ? (p.payload as SynonymPayload) : null;
            return (
              <li key={p.id}>
                <Card className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{p.type === "new_leaf" ? "New leaf" : "Synonym"}</Badge>
                    <Badge tone={TONE[p.state]}>{LABEL[p.state]}</Badge>
                    {p.appliedSequence ? <Badge tone={p.appliedState === "published" ? "ok" : "warn"}>{p.appliedState === "published" ? `Published in v${p.appliedSequence}` : `In draft v${p.appliedSequence}`}</Badge> : null}
                    <span className="ml-auto text-xs text-muted">
                      {p.submittedByName} · {p.createdAt.toISOString().slice(0, 10)}
                    </span>
                  </div>
                  <h2 className="mt-2 font-display text-xl font-medium">
                    {leaf ? (
                      <>
                        “{leaf.name}” <span className="text-base font-normal text-ink-soft">under {leaf.parentPath.replace(/^All Products > /, "") || "All Products"}</span>
                      </>
                    ) : (
                      <>
                        “{syn!.synonym}” <span className="text-base font-normal text-ink-soft">as a synonym of {syn!.conceptPath.replace(/^All Products > /, "")}</span>
                      </>
                    )}
                  </h2>
                  {leaf ? <p className="mt-1 text-sm text-ink-soft">Definition: {leaf.definition}</p> : null}
                  <p className="mt-1 text-sm text-ink-soft">Rationale: {p.rationale}</p>
                  {leaf?.overlaps.length ? (
                    <p className="mt-2 rounded-sm border border-warn/40 bg-warn-bg p-2 text-sm text-warn">
                      Possible overlap: this name is already used by {leaf.overlaps.map((o) => `${o.path.replace(/^All Products > /, "")} (${o.via})`).join("; ")}.
                    </p>
                  ) : null}
                  {syn?.ambiguousWith.length ? (
                    <p className="mt-2 rounded-sm border border-warn/40 bg-warn-bg p-2 text-sm text-warn">
                      Ambiguous alias: also used by {syn.ambiguousWith.map((a) => a.replace(/^All Products > /, "")).join("; ")}. It will not act as a unique exact match.
                    </p>
                  ) : null}
                  {p.evidenceListingIds.length ? (
                    <p className="mt-2 text-sm">
                      <span className="text-muted">Related listings: </span>
                      {p.evidenceListingIds.map((id, i) => (
                        <Link key={id} href={`/review/${id}`} className="mr-2 font-semibold text-stamp underline underline-offset-4">
                          Listing {i + 1}
                        </Link>
                      ))}
                    </p>
                  ) : null}
                  {p.state !== "submitted" ? (
                    <p className="mt-2 border-t border-rule pt-2 text-sm text-ink-soft">
                      {LABEL[p.state]} by {p.decidedByName}
                      {p.decidedAt ? ` on ${p.decidedAt.toISOString().slice(0, 10)}` : ""}
                      {p.decisionReason ? `: ${p.decisionReason}` : "."}
                    </p>
                  ) : canDecide ? (
                    <ProposalDecisionForm id={p.id} lockVersion={p.lockVersion} type={p.type} name={leaf?.name ?? syn!.synonym} definition={leaf?.definition ?? ""} />
                  ) : (
                    <p className="mt-2 border-t border-rule pt-2 text-sm text-muted">Waiting for an administrator decision.</p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
