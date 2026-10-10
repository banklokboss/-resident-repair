import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { LIMITS } from "../config";
import { getSystemSettings } from "./settings";
import { adminAuth, db } from "./admin";
import { generateRegistrationCode, normalizeCode, randomToken, sha256 } from "./crypto";

export type OwnerType = "resident" | "staff";

export const MAX_BIND_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60_000;

/** Admin (or staff for themselves) issues a one-time registration code. Only its hash is stored. */
export async function issueBindingCode(ownerType: OwnerType, ownerId: string, createdBy: string) {
  const old = await db.collection("lineBindingTokens").where("ownerId", "==", ownerId).where("usedAt", "==", null).get();
  const code = generateRegistrationCode();
  const expiresAt = Timestamp.fromMillis(Date.now() + LIMITS.bindingCodeMinutes * 60_000);
  const batch = db.batch();
  old.docs.forEach((d) => batch.delete(d.ref));
  batch.set(db.doc(`lineBindingTokens/${sha256(code)}`), { ownerType, ownerId, createdBy, expiresAt, usedAt: null, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return { code, expiresAt: expiresAt.toMillis() };
}

export type BindResult =
  | { ok: true; ownerType: OwnerType; ownerId: string; roomLabel: string }
  | { ok: false; reason: "locked" | "invalid" | "taken" };

/** Binds the LINE userId (taken from the verified webhook event) to the owner of a valid code. */
export async function bindWithCode(lineUserId: string, rawCode: string): Promise<BindResult> {
  const attemptsRef = db.doc(`lineAttempts/${lineUserId}`);
  const att = await attemptsRef.get();
  const now = Date.now();
  const winStart = (att.get("windowStart") as Timestamp | undefined)?.toMillis() ?? 0;
  const inWindow = now - winStart < ATTEMPT_WINDOW_MS;
  const count = inWindow ? ((att.get("count") as number) ?? 0) : 0;
  if (count >= MAX_BIND_ATTEMPTS) return { ok: false, reason: "locked" };

  const tokenRef = db.doc(`lineBindingTokens/${sha256(normalizeCode(rawCode))}`);

  const result = await db.runTransaction<BindResult>(async (tx) => {
    const t = await tx.get(tokenRef);
    const link = await tx.get(db.doc(`lineLinks/${lineUserId}`));
    if (!t.exists || t.get("usedAt") || (t.get("expiresAt") as Timestamp).toMillis() < now) return { ok: false, reason: "invalid" };
    const ownerType = t.get("ownerType") as OwnerType;
    const ownerId = t.get("ownerId") as string;
    if (link.exists && link.get("status") !== "replaced" && (link.get("ownerId") !== ownerId || link.get("ownerType") !== ownerType)) {
      return { ok: false, reason: "taken" };
    }
    const publicRef = db.doc(ownerType === "resident" ? `residents/${ownerId}` : `users/${ownerId}`);
    const privateRef = db.doc(ownerType === "resident" ? `residentPrivate/${ownerId}` : `staffPrivate/${ownerId}`);
    const [pub, priv] = await Promise.all([tx.get(publicRef), tx.get(privateRef)]);
    if (!pub.exists || pub.get("active") !== true) return { ok: false, reason: "invalid" };

    let roomLabel = "";
    if (ownerType === "resident") {
      const room = await tx.get(db.doc(`rooms/${pub.get("roomId")}`));
      roomLabel = (room.get("label") as string) ?? "";
    }

    // Account change: drop the previously linked LINE account of this owner.
    const oldId = priv.get("lineUserId") as string | undefined;
    if (oldId && oldId !== lineUserId) tx.delete(db.doc(`lineLinks/${oldId}`));
    tx.update(tokenRef, { usedAt: FieldValue.serverTimestamp(), usedByLineHash: sha256(lineUserId) });
    tx.set(db.doc(`lineLinks/${lineUserId}`), { ownerType, ownerId, status: "linked", boundAt: FieldValue.serverTimestamp() });
    tx.set(privateRef, { lineUserId, lineStatus: "linked", boundAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.update(publicRef, { lineLinked: true, lineStatus: "linked", lineBoundAt: FieldValue.serverTimestamp() });
    return { ok: true, ownerType, ownerId, roomLabel };
  });

  if (result.ok) {
    await attemptsRef.delete().catch(() => undefined);
  } else if ((result as any).reason === "invalid") {
    await attemptsRef.set({ count: count + 1, windowStart: inWindow ? att.get("windowStart") : Timestamp.now() });
  }
  return result;
}

/** Removes the binding in both directions and invalidates resident web links. */
export async function unbindOwner(ownerType: OwnerType, ownerId: string): Promise<void> {
  const privateRef = db.doc(ownerType === "resident" ? `residentPrivate/${ownerId}` : `staffPrivate/${ownerId}`);
  const publicRef = db.doc(ownerType === "resident" ? `residents/${ownerId}` : `users/${ownerId}`);
  const priv = await privateRef.get();
  const lineUserId = priv.get("lineUserId") as string | undefined;
  const batch = db.batch();
  if (lineUserId) batch.delete(db.doc(`lineLinks/${lineUserId}`));
  batch.set(privateRef, { lineUserId: FieldValue.delete(), lineStatus: "unlinked", unboundAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.set(publicRef, { lineLinked: false, lineStatus: "unlinked" }, { merge: true });
  await batch.commit();
  if (ownerType === "resident") {
    const toks = await db.collection("residentAccessTokens").where("residentId", "==", ownerId).where("revokedAt", "==", null).get();
    const b2 = db.batch();
    toks.docs.forEach((d) => b2.update(d.ref, { revokedAt: FieldValue.serverTimestamp() }));
    await b2.commit();
    await adminAuth.revokeRefreshTokens(`res_${ownerId}`).catch(() => undefined);
  }
}

/** Marks the owner of a LINE user as blocked/active (unfollow/follow events). */
export async function setLineStatusByUser(lineUserId: string, status: "blocked" | "linked"): Promise<void> {
  const link = await db.doc(`lineLinks/${lineUserId}`).get();
  if (!link.exists) return;
  const ownerType = link.get("ownerType") as OwnerType;
  const ownerId = link.get("ownerId") as string;
  await Promise.all([
    link.ref.update({ status }),
    db.doc(ownerType === "resident" ? `residentPrivate/${ownerId}` : `staffPrivate/${ownerId}`).set({ lineStatus: status }, { merge: true }),
    db.doc(ownerType === "resident" ? `residents/${ownerId}` : `users/${ownerId}`).set({ lineStatus: status }, { merge: true }),
  ]);
}

/** Creates a personal, revocable web link that is only ever delivered to the resident's own LINE chat. */
export async function issueResidentLink(residentId: string, roomId: string): Promise<string> {
  const token = randomToken(32);
  await db.doc(`residentAccessTokens/${sha256(token)}`).set({
    residentId,
    roomId,
    expiresAt: Timestamp.fromMillis(Date.now() + LIMITS.residentLinkDays * 86_400_000),
    revokedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  const s = await getSystemSettings();
  return `${s.appBaseUrl.replace(/\/$/, "")}/r/${token}`;
}
