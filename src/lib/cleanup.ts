export interface ExpiredImage {
  /** Firestore doc path, e.g. repairs/abc/images/xyz */
  docPath: string;
  storagePath?: string | null;
  previewPath?: string | null;
}

export interface CleanupDeps {
  /** images with status 'active' and uploadedAt <= cutoff */
  listExpired(cutoff: Date, limit: number): Promise<ExpiredImage[]>;
  /** returns "missing" when the file was already gone (not an error) */
  deleteFile(path: string): Promise<"deleted" | "missing">;
  markExpired(img: ExpiredImage, info: { missingFiles: string[] }): Promise<void>;
}

export interface CleanupSummary {
  cutoff: string;
  scanned: number;
  expired: number;
  filesDeleted: number;
  filesMissing: number;
  errors: Array<{ docPath: string; error: string }>;
}

export const DAY_MS = 86_400_000;

/**
 * Deletes image FILES older than retention. Repair records and image metadata documents stay;
 * metadata is flipped to status "expired". Idempotent: expired docs are never listed again,
 * missing files are tolerated, and a failed doc stays "active" to be retried next run.
 */
export async function runImageCleanup(
  deps: CleanupDeps,
  now: Date,
  retentionDays = 60,
  batchSize = 200,
  maxBatches = 20,
): Promise<CleanupSummary> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const summary: CleanupSummary = { cutoff: cutoff.toISOString(), scanned: 0, expired: 0, filesDeleted: 0, filesMissing: 0, errors: [] };
  const seen = new Set<string>();

  for (let b = 0; b < maxBatches; b++) {
    const batch = (await deps.listExpired(cutoff, batchSize)).filter((i) => !seen.has(i.docPath));
    if (batch.length === 0) break;
    for (const img of batch) {
      seen.add(img.docPath);
      summary.scanned++;
      try {
        const missing: string[] = [];
        for (const p of [img.storagePath, img.previewPath]) {
          if (!p) continue;
          const r = await deps.deleteFile(p);
          if (r === "deleted") summary.filesDeleted++;
          else {
            summary.filesMissing++;
            missing.push(p);
          }
        }
        await deps.markExpired(img, { missingFiles: missing });
        summary.expired++;
      } catch (e) {
        summary.errors.push({ docPath: img.docPath, error: (e as Error).message });
      }
    }
  }
  return summary;
}
