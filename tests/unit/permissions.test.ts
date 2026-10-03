import { describe, expect, it } from "vitest";
import { can, CAPABILITIES, ROLES, type Capability, type Role } from "@/lib/auth/permissions";

/** PRD section 3.2 role matrix, row by row: [administrator, taxonomist, analyst, viewer]. */
const PRD_MATRIX: Record<Capability, [boolean, boolean, boolean, boolean]> = {
  "catalog.read": [true, true, true, true],
  "catalog.import": [true, true, false, false],
  "analysis.run": [true, true, false, false],
  "review.decide": [true, true, false, false],
  "taxonomy.propose": [true, true, false, false],
  "taxonomy.manage": [true, false, false, false],
  "release.publish": [true, false, false, false],
  "analytics.ask": [true, true, true, true],
  "report.share": [true, true, true, false],
  "audit.read": [true, true, false, false],
  "workspace.manage": [true, false, false, false],
};

describe("role matrix", () => {
  it("covers every capability", () => {
    expect(Object.keys(PRD_MATRIX).sort()).toEqual([...CAPABILITIES].sort());
  });
  it.each(CAPABILITIES)("%s matches the PRD", (capability) => {
    const order: Role[] = ["administrator", "taxonomist", "analyst", "viewer"];
    expect(order.map((role) => can(role, capability))).toEqual(PRD_MATRIX[capability]);
    expect(ROLES).toEqual(order);
  });
});
