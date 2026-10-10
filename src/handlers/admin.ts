import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Request, Response } from "express";
import { adminAuth, assertActive, db } from "../lib/admin";
import type { AuthenticatedRequest } from "../lib/admin";
import { sha256 } from "../lib/crypto";
import { bangkokToDate, createStaffInput, submitRatingInput } from "../lib/validation";
import { parseInput } from "../lib/validation"; // assuming it exists or needs to be exported

// Helper to mimic HttpsError behavior
function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

export const createStaff = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await assertActive(req.user!);
    const input = parseInput(createStaffInput, req.body.data || req.body);
    let user;
    try {
      user = await adminAuth.createUser({ email: input.email, password: input.password, displayName: input.displayName });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "auth/email-already-exists") return sendError(res, 409, "อีเมลนี้ถูกใช้งานแล้ว");
      return sendError(res, 500, "สร้างบัญชีไม่สำเร็จ");
    }
    await adminAuth.setCustomUserClaims(user.uid, { role: input.role });
    await db.doc(`users/${user.uid}`).set({
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      active: true,
      lineLinked: false,
      lineStatus: "unlinked",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user!.uid,
    });
    res.json({ data: { uid: user.uid } });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

export const updateStaff = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await assertActive(req.user!);
    const callerUid = req.user!.uid;
    const data = req.body.data || req.body;
    const uid = String(data?.uid ?? "");
    if (!uid) return sendError(res, 400, "ไม่พบผู้ใช้");

    const patch: Record<string, unknown> = {};
    if (typeof data.active === "boolean") {
      if (uid === callerUid && !data.active) return sendError(res, 400, "ไม่สามารถปิดบัญชีของตนเองได้");
      patch.active = data.active;
    }
    if (data.role !== undefined) {
      if (!["admin", "technician"].includes(data.role)) return sendError(res, 400, "สิทธิ์ไม่ถูกต้อง");
      if (uid === callerUid && data.role !== "admin") return sendError(res, 400, "ไม่สามารถลดสิทธิ์ตนเองได้");
      patch.role = data.role;
    }
    if (typeof data.displayName === "string" && data.displayName.trim()) {
      patch.displayName = data.displayName.trim().slice(0, 100);
    }
    if (Object.keys(patch).length === 0) return sendError(res, 400, "ไม่มีข้อมูลที่จะแก้ไข");

    if ("active" in patch) await adminAuth.updateUser(uid, { disabled: !patch.active });
    if ("role" in patch) await adminAuth.setCustomUserClaims(uid, { role: patch.role });
    if ("displayName" in patch) await adminAuth.updateUser(uid, { displayName: patch.displayName as string });
    if ("active" in patch || "role" in patch) await adminAuth.revokeRefreshTokens(uid);
    await db.doc(`users/${uid}`).update(patch);
    res.json({ data: { ok: true } });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

async function lookup(token: string) {
  const ref = db.doc(`ratingTokens/${sha256(token)}`);
  const snap = await ref.get();
  return { ref, snap };
}

export const getRatingInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = req.body.data || req.body;
    const token = String(data?.token ?? "");
    if (token.length < 20) return sendError(res, 400, "ลิงก์ไม่ถูกต้อง");
    const { snap } = await lookup(token);
    if (!snap.exists) return sendError(res, 404, "ไม่พบลิงก์ประเมิน");
    const repair = await db.doc(`repairs/${snap.get("repairId")}`).get();
    res.json({ data: {
      repairNo: repair.get("repairNo"),
      roomLabel: repair.get("roomLabel"),
      technicianName: repair.get("assignedTechnicianName") ?? null,
      completedAt: (repair.get("completedAt") as Timestamp | null)?.toMillis() ?? null,
      expired: (snap.get("expiresAt") as Timestamp).toMillis() < Date.now(),
      alreadyRated: !!snap.get("usedAt"),
      completed: repair.get("status") === "completed",
    }});
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

export const submitRating = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = req.body.data || req.body;
    const input = parseInput(submitRatingInput, data);
    const { ref } = await lookup(input.token);
    await db.runTransaction(async (tx) => {
      const t = await tx.get(ref);
      if (!t.exists) throw new Error("ไม่พบลิงก์ประเมิน");
      if (t.get("usedAt")) throw new Error("ใบงานนี้ได้รับการประเมินแล้ว");
      if ((t.get("expiresAt") as Timestamp).toMillis() < Date.now()) throw new Error("ลิงก์ประเมินหมดอายุแล้ว");
      const repairId = t.get("repairId") as string;
      const repairRef = db.doc(`repairs/${repairId}`);
      const ratingRef = db.doc(`ratings/${repairId}`);
      const [repair, existing] = await Promise.all([tx.get(repairRef), tx.get(ratingRef)]);
      if (repair.get("status") !== "completed") throw new Error("ใบงานยังไม่ปิดงาน");
      if (existing.exists) throw new Error("ใบงานนี้ได้รับการประเมินแล้ว");
      tx.create(ratingRef, {
        repairId,
        repairNo: repair.get("repairNo"),
        roomId: repair.get("roomId"),
        technicianId: t.get("technicianId"),
        technicianName: repair.get("assignedTechnicianName") ?? null,
        score: input.score,
        comment: input.comment?.trim() || null,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(ref, { usedAt: FieldValue.serverTimestamp() });
    });
    res.json({ data: { ok: true } });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

export const getDashboardStats = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await assertActive(req.user!);
    const data = req.body.data || req.body;
    const from = String(data?.from ?? "");
    const to = String(data?.to ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return sendError(res, 400, "ช่วงวันที่ไม่ถูกต้อง");
    const fromTs = Timestamp.fromDate(bangkokToDate(from));
    const toTs = Timestamp.fromDate(new Date(bangkokToDate(to).getTime() + 86_400_000));
    const repairs = db.collection("repairs");

    const countOf = async (q: FirebaseFirestore.Query) => (await q.count().get()).data().count;
    const [total, nw, scheduled, inProgress, completed, cancelled, overdue] = await Promise.all([
      countOf(repairs),
      countOf(repairs.where("status", "==", "new")),
      countOf(repairs.where("status", "==", "scheduled")),
      countOf(repairs.where("status", "==", "in_progress")),
      countOf(repairs.where("status", "==", "completed")),
      countOf(repairs.where("status", "==", "cancelled")),
      countOf(repairs.where("status", "in", ["new", "scheduled", "in_progress"]).where("dueAt", "<", Timestamp.now())),
    ]);

    const [createdSnap, doneSnap, ratingsSnap] = await Promise.all([
      repairs.where("createdAt", ">=", fromTs).where("createdAt", "<", toTs).limit(3000).get(),
      repairs.where("completedAt", ">=", fromTs).where("completedAt", "<", toTs).limit(3000).get(),
      db.collection("ratings").where("createdAt", ">=", fromTs).where("createdAt", "<", toTs).limit(3000).get(),
    ]);

    const day = (t: Timestamp) => new Date(t.toMillis() + 7 * 3600_000).toISOString().slice(0, 10);
    const daily: Record<string, { created: number; completed: number }> = {};
    const monthly: Record<string, { created: number; completed: number }> = {};
    const bump = (k: string, f: "created" | "completed", m: typeof daily) => ((m[k] ??= { created: 0, completed: 0 })[f]++);
    createdSnap.docs.forEach((d) => {
      const k = day(d.get("createdAt"));
      bump(k, "created", daily);
      bump(k.slice(0, 7), "created", monthly);
    });
    const techs: Record<string, { name: string; completed: number; totalHours: number; ratingSum: number; ratings: number }> = {};
    doneSnap.docs.forEach((d) => {
      const k = day(d.get("completedAt"));
      bump(k, "completed", daily);
      bump(k.slice(0, 7), "completed", monthly);
      const id = (d.get("assignedTechnicianId") ?? d.get("completedBy")) as string;
      const t = (techs[id] ??= { name: d.get("assignedTechnicianName") ?? d.get("completedByName") ?? id, completed: 0, totalHours: 0, ratingSum: 0, ratings: 0 });
      t.completed++;
      t.totalHours += (d.get("completedAt") as Timestamp).toMillis() / 3600_000 - (d.get("createdAt") as Timestamp).toMillis() / 3600_000;
    });
    let sum = 0;
    ratingsSnap.docs.forEach((d) => {
      sum += d.get("score") as number;
      const id = d.get("technicianId") as string;
      if (techs[id]) {
        techs[id].ratingSum += d.get("score");
        techs[id].ratings++;
      }
    });

    res.json({ data: {
      counts: { total, new: nw, scheduled, in_progress: inProgress, completed, cancelled, overdue, accepted: scheduled + inProgress + completed },
      daily: Object.entries(daily).sort().map(([date, v]) => ({ date, ...v })),
      monthly: Object.entries(monthly).sort().map(([month, v]) => ({ month, ...v })),
      ratings: { count: ratingsSnap.size, average: ratingsSnap.size ? sum / ratingsSnap.size : null },
      technicians: Object.entries(techs).map(([id, t]) => ({
        id,
        name: t.name,
        completed: t.completed,
        avgHours: t.completed ? t.totalHours / t.completed : null,
        ratings: t.ratings,
        avgRating: t.ratings ? t.ratingSum / t.ratings : null,
      })),
      truncated: createdSnap.size >= 3000 || doneSnap.size >= 3000,
    }});
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
