/** Display labels shared by server and client components. Status is always shown as text. */
export const REVIEW_STATES = ["needs_analysis", "suggested", "needs_investigation", "needs_review", "approved", "deferred", "no_suitable_category", "stale"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const STATE_LABELS: Record<ReviewState, string> = {
  needs_analysis: "Needs analysis",
  suggested: "Suggested",
  needs_investigation: "Needs investigation",
  needs_review: "Needs review",
  approved: "Approved",
  deferred: "Deferred",
  no_suitable_category: "No suitable category",
  stale: "Stale",
};
export const STATE_TONES: Record<ReviewState, "neutral" | "ok" | "warn" | "danger" | "info"> = {
  needs_analysis: "neutral",
  suggested: "info",
  needs_investigation: "warn",
  needs_review: "warn",
  approved: "ok",
  deferred: "neutral",
  no_suitable_category: "danger",
  stale: "warn",
};

export const SIGNAL_BANDS = ["high", "medium", "low", "none"] as const;
export type SignalBand = (typeof SIGNAL_BANDS)[number];
export const BAND_LABELS: Record<SignalBand, string> = { high: "High signal", medium: "Medium signal", low: "Low signal", none: "No recommendation" };
export const BAND_TONES: Record<SignalBand, "neutral" | "ok" | "warn" | "danger" | "info"> = { high: "ok", medium: "info", low: "warn", none: "neutral" };

export const ACTION_LABELS = { approve: "Approved", change: "Changed mapping", reject: "Rejected suggestion", defer: "Deferred", no_suitable: "No suitable category" } as const;
export const ORIGIN_LABELS = { manual: "Manual", suggestion: "Accepted suggestion", bulk: "Bulk approval", carried_forward: "Carried forward", revalidated: "Revalidated" } as const;
