import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { bucket } from "./admin";
import { randomToken } from "./crypto";
import { ImageError, processImage } from "./imageProcessor";
import { LIMITS } from "../config";

export type ImageStage = "report" | "completion";

export interface ImageRecord {
  imageId: string;
  stage: ImageStage;
  storagePath: string;
  previewPath: string;
  width: number;
  height: number;
  sizeBytes: number;
  sourceFormat: string;
  uploadedAt: Timestamp;
  uploadedBy: string;
  repairId: string;
  status: "active" | "expired";
}

export interface UploadRef {
  uploadId: string;
  fileName?: string;
}

/**
 * Takes originals that the client placed in tmp/{uid}/{uploadId}, converts each to the standard
 * Full HD JPEG (+ LINE preview), stores them under repairs/{repairId}/..., and deletes the originals.
 * All-or-nothing: on any failure everything written so far and all temp files are removed.
 */
export async function ingestUploads(opts: {
  uid: string;
  repairId: string;
  stage: ImageStage;
  uploads: UploadRef[];
}): Promise<ImageRecord[]> {
  const b = bucket();
  const written: string[] = [];
  const tmpPaths = opts.uploads.map((u) => `tmp/${opts.uid}/${u.uploadId}`);
  const records: ImageRecord[] = [];
  try {
    for (const [i, u] of opts.uploads.entries()) {
      const tmp = b.file(tmpPaths[i]);
      const [exists] = await tmp.exists();
      if (!exists) throw new HttpsError("failed-precondition", `ไม่พบไฟล์ที่อัปโหลด${u.fileName ? ` (${u.fileName})` : ""} กรุณาอัปโหลดใหม่`);
      const [meta] = await tmp.getMetadata();
      if (Number(meta.size) > LIMITS.maxOriginalBytes) {
        throw new HttpsError("invalid-argument", `ไฟล์ ${u.fileName ?? ""} ใหญ่เกิน ${LIMITS.maxOriginalBytes / 1024 / 1024} MB`);
      }
      const [buf] = await tmp.download();
      let out;
      try {
        out = await processImage(buf);
      } catch (e) {
        if (e instanceof ImageError) throw new HttpsError("invalid-argument", `${u.fileName ?? "รูปภาพ"}: ${e.message}`);
        throw e;
      }
      const imageId = randomToken(9);
      const base = `repairs/${opts.repairId}/${opts.stage}/${imageId}`;
      const storagePath = `${base}.jpg`;
      const previewPath = `${base}_preview.jpg`;
      const contentType = "image/jpeg";
      await b.file(storagePath).save(out.jpeg, { contentType, resumable: false, metadata: { cacheControl: "private, max-age=3600" } });
      written.push(storagePath);
      await b.file(previewPath).save(out.preview, { contentType, resumable: false, metadata: { cacheControl: "private, max-age=3600" } });
      written.push(previewPath);
      records.push({
        imageId,
        stage: opts.stage,
        storagePath,
        previewPath,
        width: out.width,
        height: out.height,
        sizeBytes: out.sizeBytes,
        sourceFormat: out.sourceFormat,
        uploadedAt: Timestamp.now(),
        uploadedBy: opts.uid,
        repairId: opts.repairId,
        status: "active",
      });
    }
  } catch (e) {
    await Promise.all(written.map((p) => b.file(p).delete({ ignoreNotFound: true }).catch(() => undefined)));
    await deleteTemp(tmpPaths);
    throw e;
  }
  await deleteTemp(tmpPaths);
  return records;
}

export async function deleteTemp(paths: string[]): Promise<void> {
  const b = bucket();
  await Promise.all(paths.map((p) => b.file(p).delete({ ignoreNotFound: true }).catch(() => undefined)));
}

export async function deleteStored(records: ImageRecord[]): Promise<void> {
  const b = bucket();
  await Promise.all(
    records.flatMap((r) => [r.storagePath, r.previewPath]).map((p) => b.file(p).delete({ ignoreNotFound: true }).catch(() => undefined)),
  );
}

/** V4 signed read URL – private files, time limited. */
export async function signedUrl(path: string, hours: number): Promise<string> {
  const ms = Math.min(hours * 3600_000, 7 * 24 * 3600_000 - 60_000);
  const [url] = await bucket().file(path).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + ms });
  return url;
}
