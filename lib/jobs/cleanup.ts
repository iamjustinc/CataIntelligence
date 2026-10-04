import { eq, sql } from "drizzle-orm";
import { db, withContext } from "@/db/client";
import { exportFiles, importJobs } from "@/db/schema";
import { objectStore } from "@/lib/storage";

/**
 * Deletes storage objects past their retention (PRD 14.5): staged files of imports that were not
 * committed within 24 hours, and export objects older than 7 days. The database rows remain as
 * history; only the stored bytes are removed. Committed import files are retained.
 */
export async function cleanupExpiredObjects(now = new Date()): Promise<{ imports: number; exports: number; errors: number }> {
  const expired = await db().execute<{ kind: "import" | "export"; id: string; workspace_id: string; storage_key: string }>(sql`select kind, id, workspace_id, storage_key from expired_storage_objects(${now.toISOString()}::timestamptz)`);
  const result = { imports: 0, exports: 0, errors: 0 };
  for (const row of expired.rows) {
    try {
      await objectStore().remove(row.workspace_id, row.storage_key);
      await withContext({ workspaceId: row.workspace_id }, async (tx) => {
        if (row.kind === "import") await tx.update(importJobs).set({ stagedFileKey: null, status: "expired" }).where(eq(importJobs.id, row.id));
        else await tx.update(exportFiles).set({ deletedAt: now }).where(eq(exportFiles.id, row.id));
      });
      if (row.kind === "import") result.imports++;
      else result.exports++;
    } catch {
      result.errors++;
    }
  }
  return result;
}
