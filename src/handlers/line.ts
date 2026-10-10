import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Request, Response } from "express";
import { SECRETS } from "../config";
import { getSystemSettings } from "../lib/settings";
import { adminAuth, assertActive, db } from "../lib/admin";
import type { AuthenticatedRequest } from "../lib/admin";
import { sha256 } from "../lib/crypto";
import { type LineMessage, lineReply, textMessage, verifyLineSignature } from "../lib/lineClient";
import { bindWithCode, issueBindingCode, issueResidentLink, setLineStatusByUser, unbindOwner, type OwnerType } from "../lib/lineBinding";
import * as T from "../lib/messages";
import { enqueue, isMock, processNotification } from "../lib/notifications";

interface LineEvent {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { type: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type: string; text?: string };
  deliveryContext?: { isRedelivery?: boolean };
}

async function reply(token: string | undefined, messages: LineMessage[]) {
  if (!token) return;
  if (await isMock()) {
    console.info("[mock] LINE reply not sent", { count: messages.length });
    return;
  }
  const s = await getSystemSettings();
  const r = await lineReply(token, messages, s.lineChannelAccessToken);
  if (!r.ok) console.warn("LINE reply failed", { status: r.status });
}

async function handleEvent(ev: LineEvent) {
  const userId = ev.source?.userId;
  switch (ev.type) {
    case "follow":
      if (userId) await setLineStatusByUser(userId, "linked");
      return reply(ev.replyToken, [textMessage(T.welcomeText)]);
    case "unfollow":
      if (userId) await setLineStatusByUser(userId, "blocked");
      return;
    case "message": {
      if (ev.message?.type !== "text" || !ev.message.text) return;
      const text = ev.message.text.trim();
      if (ev.source?.type !== "user") {
        if (/^!?groupid$/i.test(text) && ev.source?.groupId) {
          return reply(ev.replyToken, [textMessage(`Group ID: ${ev.source.groupId}\n(นำไปตั้งค่า LINE_STAFF_GROUP_ID)`)]);
        }
        return;
      }
      if (!userId) return;

      const bind = text.match(/^(?:ลงทะเบียน|ผูกบัญชี|register|bind)\s*[:：]?\s*([A-Za-z0-9-]{8,9})$/i);
      if (bind) {
        const r = await bindWithCode(userId, bind[1]);
        if (!r.ok) return reply(ev.replyToken, [textMessage((r as any).reason === "locked" ? T.bindLockedText : (r as any).reason === "taken" ? "บัญชี LINE นี้ผูกกับผู้ใช้อื่นอยู่แล้ว กรุณาติดต่อนิติบุคคล" : T.bindFailText)]);
        const msgs = [textMessage(T.bindSuccessText((r as any).ownerType === "resident" ? (r as any).roomLabel : "เจ้าหน้าที่"))];
        if ((r as any).ownerType === "resident") {
          const res = await db.doc(`residents/${(r as any).ownerId}`).get();
          msgs.push(textMessage(T.personalLinkText(await issueResidentLink((r as any).ownerId, res.get("roomId")))));
        }
        return reply(ev.replyToken, msgs);
      }

      const link = await db.doc(`lineLinks/${userId}`).get();
      if (/^(ลิงก์|ลิงค์|แจ้งซ่อม|เมนู|link|menu)$/i.test(text)) {
        if (!link.exists || link.get("ownerType") !== "resident") return reply(ev.replyToken, [textMessage(T.notBoundText)]);
        const res = await db.doc(`residents/${link.get("ownerId")}`).get();
        if (!res.exists || res.get("active") !== true) return reply(ev.replyToken, [textMessage(T.notBoundText)]);
        return reply(ev.replyToken, [textMessage(T.personalLinkText(await issueResidentLink(res.id, res.get("roomId"))))]);
      }
      if (/^(ยกเลิกผูก|ยกเลิกการผูกบัญชี|unlink)$/i.test(text)) {
        if (!link.exists) return reply(ev.replyToken, [textMessage(T.notBoundText)]);
        await unbindOwner(link.get("ownerType"), link.get("ownerId"));
        return reply(ev.replyToken, [textMessage(T.unbindText)]);
      }
      return reply(ev.replyToken, [textMessage(link.exists ? "พิมพ์ \"แจ้งซ่อม\" เพื่อรับลิงก์ส่วนตัวสำหรับแจ้งซ่อม" : T.welcomeText)]);
    }
  }
}

export const lineWebhook = async (req: Request, res: Response): Promise<void> => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  const sig = req.get("x-line-signature");
  const s = await getSystemSettings();
  if (!verifyLineSignature((req as any).rawBody, sig, s.lineChannelSecret)) {
    console.warn("LINE webhook rejected: bad signature");
    res.status(401).send("Invalid signature");
    return;
  }
  const events = ((req.body as { events?: LineEvent[] })?.events ?? []) as LineEvent[];
  try {
    for (const ev of events) {
      if (ev.webhookEventId) {
        try {
          await db.doc(`lineEvents/${ev.webhookEventId}`).create({ type: ev.type, at: FieldValue.serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + 7 * 86_400_000) });
        } catch (e) {
          if ((e as { code?: number }).code === 6) continue;
          throw e;
        }
      }
      try {
        await handleEvent(ev);
      } catch (e) {
        if (ev.webhookEventId) await db.doc(`lineEvents/${ev.webhookEventId}`).delete().catch(() => undefined);
        throw e;
      }
    }
    res.status(200).send("OK");
  } catch (e: any) {
    console.error("webhook processing failed", { error: e.message });
    res.status(500).send("error");
  }
};

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

export const exchangeResidentLink = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = req.body.data || req.body;
    const token = String(data?.token ?? "");
    if (token.length < 20 || token.length > 200) return sendError(res, 400, "ลิงก์ไม่ถูกต้อง");
    const snap = await db.doc(`residentAccessTokens/${sha256(token)}`).get();
    if (!snap.exists || snap.get("revokedAt") || (snap.get("expiresAt") as Timestamp).toMillis() < Date.now()) {
      return sendError(res, 403, "ลิงก์หมดอายุหรือถูกยกเลิก กรุณาพิมพ์ \"แจ้งซ่อม\" ใน LINE OA เพื่อรับลิงก์ใหม่");
    }
    const residentId = snap.get("residentId") as string;
    const resident = await db.doc(`residents/${residentId}`).get();
    if (!resident.exists || resident.get("active") !== true || resident.get("lineLinked") !== true) {
      return sendError(res, 403, "บัญชีลูกบ้านไม่พร้อมใช้งาน");
    }
    const roomId = resident.get("roomId") as string;
    const customToken = await adminAuth.createCustomToken(`res_${residentId}`, { role: "resident", residentId, roomId });
    res.json({ data: { customToken } });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

export const generateBindingCode = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await assertActive(req.user!);
    const data = req.body.data || req.body;
    const caller = req.user!;
    if (!["admin", "technician"].includes(caller.role)) return sendError(res, 403, "ไม่มีสิทธิ์");
    
    const ownerType = data?.ownerType as OwnerType;
    const ownerId = String(data?.ownerId ?? "");
    if (!["resident", "staff"].includes(ownerType) || !ownerId) return sendError(res, 400, "ข้อมูลไม่ถูกต้อง");
    if (ownerType === "resident" && caller.role !== "admin") return sendError(res, 403, "เฉพาะผู้ดูแลระบบ");
    if (ownerType === "staff" && caller.role !== "admin" && ownerId !== caller.uid) return sendError(res, 403, "ออกรหัสได้เฉพาะบัญชีของตนเอง");
    
    const exists = await db.doc(ownerType === "resident" ? `residents/${ownerId}` : `users/${ownerId}`).get();
    if (!exists.exists) return sendError(res, 404, "ไม่พบข้อมูล");
    
    const result = await issueBindingCode(ownerType, ownerId, caller.uid);
    res.json({ data: result });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

export const unbindLine = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await assertActive(req.user!);
    const caller = req.user!;
    const data = req.body.data || req.body;
    const ownerType = (data?.ownerType ?? (caller.role === "resident" ? "resident" : "staff")) as OwnerType;
    let ownerId = String(data?.ownerId ?? "");
    if (caller.role === "resident") {
      ownerId = caller.residentId!;
      if (ownerType !== "resident") return sendError(res, 403, "ไม่มีสิทธิ์");
    } else if (caller.role === "technician") {
      ownerId = caller.uid;
      if (ownerType !== "staff") return sendError(res, 403, "ไม่มีสิทธิ์");
    }
    if (!ownerId) return sendError(res, 400, "ข้อมูลไม่ถูกต้อง");
    
    await unbindOwner(ownerType, ownerId);
    res.json({ data: { ok: true } });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

export const sendTestNotification = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const caller = req.user!;
    await assertActive(caller);
    const data = req.body.data || req.body;
    let recipientType: "resident" | "staff" = caller.role === "resident" ? "resident" : "staff";
    let recipientId = caller.role === "resident" ? caller.residentId! : caller.uid;
    if (caller.role === "admin" && data?.residentId) {
      recipientType = "resident";
      recipientId = String(data.residentId);
    }
    let roomLabel = "-";
    if (recipientType === "resident") {
      const r = await db.doc(`residents/${recipientId}`).get();
      roomLabel = ((await db.doc(`rooms/${r.get("roomId")}`).get()).get("label") as string) ?? "-";
    }
    const bucket = Math.floor(Date.now() / 30_000);
    const key = `test_${recipientType}_${recipientId}_${bucket}`;
    const created = await enqueue({ dedupeKey: key, type: "test", recipientType, recipientId, roomLabel });
    if (!created) return sendError(res, 429, "ทดสอบได้ทุก 30 วินาที กรุณารอสักครู่");
    
    const id = key.replace(/[^A-Za-z0-9_-]/g, "_");
    await processNotification(id);
    const log = await db.doc(`notificationLogs/${id}`).get();
    res.json({ data: { status: log.get("status") as string, error: (log.get("lastError") as string | null) ?? null, mock: await isMock() }});
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
