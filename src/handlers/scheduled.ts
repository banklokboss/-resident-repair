import type { Request, Response } from "express";
import { retryDueNotifications } from "../lib/notifications";

export const retryNotificationsApi = async (req: Request, res: Response): Promise<void> => {
  // In a real environment, you'd protect this with a secret token header
  // so only a trusted cron-job can trigger it.
  try {
    await retryDueNotifications();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};
