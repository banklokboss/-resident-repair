import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { LIMITS } from "../config";
import { getSystemSettings } from "./settings";
import { db } from "./admin";
import { signedUrl } from "./images";
import {
  chunkMessages,
  imageMessage,
  linePush,
  retryKeyFor,
  textMessage,
  type LineMessage,
  type LineSendResult,
} from "./lineClient";
import * as T from "./messages";

export type NotificationType =
  | "repair_created_staff"
  | "repair_created_resident"
  | "repair_scheduled"
  | "repair_completed"
  | "test";

export type RecipientType = "resident" | "staff" | "group";

export interface NotificationInput {
  /** Unique per logical notification => doc id => prevents duplicates. */
  dedupeKey: string;
  type: NotificationType;
  repairId?: string;
  recipientType: RecipientType;
  recipientId: string;
  roomLabel?: string;
}

const col = () => db.collection("notificationLogs");
const docId = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

function logData(i: NotificationInput) {
  return {
    ...i,
    status: "pending",
    attempts: 0,
    sentChunks: 0,
    lastError: null,
    nextRetryAt: null,
    sentAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** Outbox pattern: commit the notification job in the same transaction as the state change. */
export function enqueueInTx(tx: Transaction, i: NotificationInput) {
  tx.create(col().doc(docId(i.dedupeKey)), logData(i));
}

/** Returns false if a notification with this dedupeKey already exists. */
export async function enqueue(i: NotificationInput): Promise<boolean> {
  try {
    await col().doc(docId(i.dedupeKey)).create(logData(i));
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    throw e;
  }
}

export async function residentRecipients(roomId: string): Promise<string[]> {
  const snap = await db
    .collection("residents")
    .where("roomId", "==", roomId)
    .where("active", "==", true)
    .where("lineLinked", "==", true)
    .get();
  return snap.docs.map((d) => d.id);
}

export async function staffRecipients(): Promise<string[]> {
  const snap = await db.collection("users").where("active", "==", true).where("lineLinked", "==", true).get();
  return snap.docs.map((d) => d.id);
}

export const isMock = async () => {
  const s = await getSystemSettings();
  return s.lineMockMode || !s.lineChannelAccessToken;
};

export const backoffMinutes = (attempt: number) => Math.min(60, 2 ** attempt); // 2,4,8,16,32,60

/** Sends chunks sequentially starting at `from`; stops at the first failure. Pure/injectable for tests. */
export async function deliverChunks(
  chunks: LineMessage[][],
  from: number,
  push: (messages: LineMessage[], chunkIndex: number) => Promise<LineSendResult>,
  onChunkSent: (nextIndex: number) => Promise<void>,
): Promise<{ ok: true } | { ok: false; result: LineSendResult }> {
  for (let i = from; i < chunks.length; i++) {
    const r = await push(chunks[i], i);
    if (!r.ok) return { ok: false, result: r };
    await onChunkSent(i + 1);
  }
  return { ok: true };
}

interface Resolved {
  to: string | null;
  reason?: string;
}

async function resolveRecipient(type: RecipientType, id: string): Promise<Resolved> {
  if (type === "group") {
    const s = await getSystemSettings();
    return id ? { to: id } : { to: null, reason: "ไม่ได้ตั้งค่า LINE_STAFF_GROUP_ID" }; // wait, if type is group, use the actual groupId from settings instead of param? Wait, the id parameter is the groupId.
  }
  const path = type === "resident" ? `residentPrivate/${id}` : `staffPrivate/${id}`;
  const snap = await db.doc(path).get();
  const to = snap.get("lineUserId") as string | undefined;
  if (!to || snap.get("lineStatus") === "unlinked") return { to: null, reason: "ยังไม่ได้ผูกบัญชี LINE" };
  if (snap.get("lineStatus") === "blocked") return { to: null, reason: "ผู้ใช้บล็อก LINE OA (ไม่สามารถส่งข้อความได้)" };
  return { to };
}

async function loadRepairView(repairId: string) {
  const snap = await db.doc(`repairs/${repairId}`).get();
  if (!snap.exists) throw new Error(`repair ${repairId} not found`);
  const r = snap.data()!;
  const view: T.RepairView = {
    repairNo: r.repairNo,
    roomLabel: r.roomLabel,
    description: r.description,
    category: r.category ?? null,
    preferredDate: r.preferredDate,
    preferredStartTime: r.preferredStartTime,
    preferredEndTime: r.preferredEndTime,
    scheduledDate: r.scheduledDate ?? null,
    scheduledStartTime: r.scheduledStartTime ?? null,
    scheduledEndTime: r.scheduledEndTime ?? null,
    technicianName: r.assignedTechnicianName ?? null,
    note: null,
  };
  return { snap, view, data: r };
}

async function buildMessages(log: FirebaseFirestore.DocumentData, mock: boolean): Promise<LineMessage[]> {
  const s = await getSystemSettings();
  const base = s.appBaseUrl.replace(/\/$/, "");
  switch (log.type as NotificationType) {
    case "repair_created_staff": {
      const { view } = await loadRepairView(log.repairId);
      return [textMessage(T.newRepairText(view) + `\n\nเปิดดูงาน: ${base}/tech`)];
    }
    case "repair_created_resident": {
      const { view } = await loadRepairView(log.repairId);
      return [textMessage(T.repairCreatedForResidentText(view))];
    }
    case "repair_scheduled": {
      const { view, data } = await loadRepairView(log.repairId);
      view.note = data.scheduleNote ?? null;
      return [textMessage(T.scheduledText(view))];
    }
    case "repair_completed": {
      const { view, data } = await loadRepairView(log.repairId);
      view.note = data.completionNote ?? null;
      const msgs: LineMessage[] = [textMessage(T.completedText(view))];
      const imgs = await db
        .collection(`repairs/${log.repairId}/images`)
        .where("stage", "==", "completion")
        .where("status", "==", "active")
        .orderBy("uploadedAt")
        .get();
      if (!imgs.empty) {
        msgs.push(textMessage(T.photosHeaderText));
        for (const d of imgs.docs) {
          if (mock) {
            msgs.push({ type: "image", originalContentUrl: "https://mock.invalid/original.jpg", previewImageUrl: "https://mock.invalid/preview.jpg" });
          } else {
            const [o, p] = await Promise.all([
              signedUrl(d.get("storagePath"), LIMITS.signedUrlHoursLine),
              signedUrl(d.get("previewPath"), LIMITS.signedUrlHoursLine),
            ]);
            msgs.push(imageMessage(o, p));
          }
        }
      }
      const secret = await db.doc(`repairSecrets/${log.repairId}`).get();
      const ratingToken = secret.get("ratingToken") as string | undefined;
      if (ratingToken) msgs.push(textMessage(T.ratingText(`${base}/rate/${ratingToken}`)));
      return msgs;
    }
    case "test":
      return [textMessage(T.testNotificationText(log.roomLabel ?? "-"))];
  }
}

/** Claims, sends and records one notification. Safe to call repeatedly (retry/duplicate triggers). */
export async function processNotification(id: string): Promise<void> {
  const ref = col().doc(id);
  type Claimed = FirebaseFirestore.DocumentData & { attempts: number };
  const claimed = await db.runTransaction<Claimed | null>(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const st = s.get("status") as string;
    if (["sent", "mock_sent", "dead", "skipped"].includes(st)) return null;
    const upd = (s.get("updatedAt") as Timestamp | undefined)?.toMillis() ?? 0;
    if (st === "sending" && Date.now() - upd < 2 * 60_000) return null; // someone else is on it
    const attempts = (s.get("attempts") as number) + 1;
    tx.update(ref, { status: "sending", attempts, updatedAt: FieldValue.serverTimestamp() });
    return { ...s.data()!, attempts };
  });
  if (!claimed) return;

  const finish = (patch: Record<string, unknown>) => ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });

  try {
    let recipientId = claimed.recipientId as string;
    if (claimed.recipientType === "group") {
      const s = await getSystemSettings();
      recipientId = s.lineStaffGroupId;
    }
    const to = await resolveRecipient(claimed.recipientType, recipientId);
    if (!to.to) {
      await finish({ status: "skipped", lastError: to.reason ?? "ไม่มีผู้รับ" });
      return;
    }
    const mock = await isMock();
    const messages = await buildMessages(claimed, mock);
    const chunks = chunkMessages(messages);

    if (mock) {
      await finish({
        status: "mock_sent",
        lastError: null,
        sentAt: FieldValue.serverTimestamp(),
        mockSummary: `${messages.length} messages / ${chunks.length} requests (โหมดจำลอง ไม่ได้ส่งจริง)`,
      });
      logger.info("notification (mock) not sent to LINE", { id, type: claimed.type });
      return;
    }

    const s2 = await getSystemSettings();
    const token = s2.lineChannelAccessToken;
    const res = await deliverChunks(
      chunks,
      (claimed.sentChunks as number) ?? 0,
      (msgs, idx) => linePush(to.to!, msgs, token, retryKeyFor(`${id}:${idx}`)),
      async (next) => {
        await ref.update({ sentChunks: next });
      },
    );
    if (res.ok) {
      await finish({ status: "sent", lastError: null, sentAt: FieldValue.serverTimestamp(), nextRetryAt: null });
      return;
    }
    const exhausted = claimed.attempts >= LIMITS.notificationMaxAttempts;
    const retry = res.result.retryable && !exhausted;
    await finish({
      status: retry ? "failed" : "dead",
      lastError: res.result.error ?? "unknown",
      lastHttpStatus: res.result.status,
      nextRetryAt: retry ? Timestamp.fromMillis(Date.now() + backoffMinutes(claimed.attempts) * 60_000) : null,
    });
    logger.warn("notification send failed", { id, status: res.result.status, retry });
  } catch (e) {
    const exhausted = claimed.attempts >= LIMITS.notificationMaxAttempts;
    await finish({
      status: exhausted ? "dead" : "failed",
      lastError: (e as Error).message.slice(0, 500),
      nextRetryAt: exhausted ? null : Timestamp.fromMillis(Date.now() + backoffMinutes(claimed.attempts) * 60_000),
    });
    logger.error("notification processing error", { id, error: (e as Error).message });
  }
}

/** For the scheduled retry function. */
export async function retryDueNotifications(limit = 50): Promise<number> {
  const now = Timestamp.now();
  const due = await col().where("status", "==", "failed").where("nextRetryAt", "<=", now).limit(limit).get();
  const stale = await col()
    .where("status", "==", "sending")
    .where("updatedAt", "<=", Timestamp.fromMillis(Date.now() - 5 * 60_000))
    .limit(limit)
    .get();
  const ids = [...due.docs, ...stale.docs].map((d) => d.id);
  for (const id of ids) await processNotification(id);
  return ids.length;
}
