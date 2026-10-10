import { z } from "zod";

export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(`ข้อมูลไม่ถูกต้อง: ${(e as any).errors.map((err: any) => err.message).join(", ")}`);
    }
    throw e;
  }
}

export const REPAIR_STATUSES = ["new", "scheduled", "in_progress", "completed", "cancelled"] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "รูปแบบวันที่ไม่ถูกต้อง");
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "รูปแบบเวลาไม่ถูกต้อง");

/** Asia/Bangkok has no DST and is a fixed UTC+7. */
export function bangkokToDate(date: string, time = "00:00"): Date {
  return new Date(`${date}T${time}:00+07:00`);
}

export function todayBangkok(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function timeRangeValid(start: string, end: string): boolean {
  return start < end; // HH:mm strings compare lexicographically
}

const upload = z.object({
  uploadId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  fileName: z.string().max(200).optional(),
});

const window = z
  .object({ date: dateStr, startTime: timeStr, endTime: timeStr })
  .refine((v) => timeRangeValid(v.startTime, v.endTime), { message: "เวลาสิ้นสุดต้องหลังเวลาเริ่มต้น" });

export const createRepairInput = z.object({
  requestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  roomId: z.string().min(1).max(64),
  category: z.string().max(80).optional(),
  description: z.string().trim().min(5, "กรุณาระบุอาการอย่างน้อย 5 ตัวอักษร").max(2000),
  preferred: window,
  uploads: z.array(upload).max(10).default([]),
});

export const acceptRepairInput = z.object({
  repairId: z.string().min(1),
  schedule: window,
  note: z.string().trim().max(500).optional(),
});

export const completeRepairInput = z.object({
  repairId: z.string().min(1),
  requestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  note: z.string().trim().max(1000).optional(),
  uploads: z.array(upload).max(10).default([]),
});

export const submitRatingInput = z.object({
  token: z.string().min(20).max(200),
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});

export const createStaffInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  displayName: z.string().trim().min(1).max(100),
  role: z.enum(["admin", "technician"]),
});
