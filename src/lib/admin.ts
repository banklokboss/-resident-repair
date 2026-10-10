import * as admin from "firebase-admin";
import type { Request, Response, NextFunction } from "express";

import * as fs from "fs";
import * as path from "path";

let app;
const keyPath = path.resolve(__dirname, "../../service-account.json");
if (fs.existsSync(keyPath)) {
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  app = admin.initializeApp(); // relies on GOOGLE_APPLICATION_CREDENTIALS or emulator
}

export const db = admin.firestore();
export const adminAuth = admin.auth();
export const storage = admin.storage();

export interface AuthUser {
  uid: string;
  role: "admin" | "technician" | "resident";
  residentId?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export const requireAuth = (allowedRoles?: string[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const token = authHeader.split("Bearer ")[1];
      const decoded = await adminAuth.verifyIdToken(token);
      
      const user: AuthUser = {
        uid: decoded.uid,
        role: (decoded.role as AuthUser["role"]) || "technician",
        residentId: decoded.residentId as string | undefined,
      };

      if (allowedRoles && !allowedRoles.includes(user.role)) {
        res.status(403).json({ error: "Permission denied" });
        return;
      }

      req.user = user;
      next();
    } catch (e) {
      console.error("Auth error", e);
      res.status(401).json({ error: "Unauthorized" });
    }
  };
};

export async function assertActive(user: AuthUser) {
  if (user.role === "resident") {
    if (!user.residentId) throw new Error("resident-id-missing");
    const doc = await db.doc(`residents/${user.residentId}`).get();
    if (!doc.exists || doc.get("active") !== true) throw new Error("account-inactive");
  } else {
    const doc = await db.doc(`users/${user.uid}`).get();
    if (!doc.exists || doc.get("active") !== true) throw new Error("account-inactive");
  }
}
