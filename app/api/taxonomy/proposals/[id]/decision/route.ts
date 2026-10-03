import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { proposalDecisionSchema } from "@/lib/contracts/taxonomy";
import { decideProposal } from "@/lib/domain/proposals";

export const POST = route({ capability: "taxonomy.manage", body: proposalDecisionSchema, idempotent: true }, async ({ actor, params, body, requestId }) => ({
  data: await decideProposal(actor, uuidParam(params.id, "Proposal"), body, requestId),
}));
