import { route } from "@/lib/api/handler";
import { proposalSchema } from "@/lib/contracts/taxonomy";
import { listProposals, submitProposal } from "@/lib/domain/proposals";

export const GET = route({ capability: "taxonomy.propose" }, async ({ actor }) => ({ data: await listProposals(actor) }));

export const POST = route({ capability: "taxonomy.propose", body: proposalSchema, idempotent: true }, async ({ actor, body, requestId }) => ({
  status: 201,
  data: await submitProposal(actor, body, requestId),
}));
