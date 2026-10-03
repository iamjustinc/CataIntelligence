/** Role matrix from PRD section 3.2. The single source of truth for server and UI checks. */
export const ROLES = ["administrator", "taxonomist", "analyst", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  administrator: "Administrator",
  taxonomist: "Taxonomist",
  analyst: "Operations analyst",
  viewer: "Viewer",
};

const MATRIX = {
  "catalog.read": ["administrator", "taxonomist", "analyst", "viewer"],
  "catalog.import": ["administrator", "taxonomist"],
  "analysis.run": ["administrator", "taxonomist"],
  "review.decide": ["administrator", "taxonomist"],
  "taxonomy.propose": ["administrator", "taxonomist"],
  "taxonomy.manage": ["administrator"],
  "release.publish": ["administrator"],
  "analytics.ask": ["administrator", "taxonomist", "analyst", "viewer"],
  "report.share": ["administrator", "taxonomist", "analyst"],
  "audit.read": ["administrator", "taxonomist"],
  "workspace.manage": ["administrator"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof MATRIX;
export const CAPABILITIES = Object.keys(MATRIX) as Capability[];

export function can(role: Role, capability: Capability): boolean {
  return (MATRIX[capability] as readonly Role[]).includes(role);
}
