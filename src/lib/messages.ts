/** Thai LINE message templates. Pure functions => unit-testable. */

const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** "2026-03-05" -> "5 มี.ค. 2569" */
export function thaiDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

export const timeRange = (date: string, start: string, end: string) => `${thaiDate(date)} เวลา ${start}-${end} น.`;

export interface RepairView {
  repairNo: string;
  roomLabel: string;
  description: string;
  category?: string | null;
  preferredDate: string;
  preferredStartTime: string;
  preferredEndTime: string;
  scheduledDate?: string | null;
  scheduledStartTime?: string | null;
  scheduledEndTime?: string | null;
  technicianName?: string | null;
  note?: string | null;
}

export function newRepairText(r: RepairView): string {
  return [
    "🔔 มีงานแจ้งซ่อมใหม่",
    "",
    `เลขที่ใบงาน: ${r.repairNo}`,
    `ห้อง: ${r.roomLabel}`,
    ...(r.category ? [`ประเภท: ${r.category}`] : []),
    `อาการ: ${r.description}`,
    `วันที่สะดวก: ${timeRange(r.preferredDate, r.preferredStartTime, r.preferredEndTime)}`,
  ].join("\n");
}

export function repairCreatedForResidentText(r: RepairView): string {
  return [
    "รับเรื่องแจ้งซ่อมเรียบร้อยแล้วครับ",
    "",
    `เลขที่ใบงาน: ${r.repairNo}`,
    `ห้อง: ${r.roomLabel}`,
    "เจ้าหน้าที่จะแจ้งวันนัดหมายให้ทราบอีกครั้งครับ",
  ].join("\n");
}

export function scheduledText(r: RepairView): string {
  return [
    "ช่างรับงานและนัดหมายเรียบร้อยแล้วครับ",
    "",
    `เลขที่ใบงาน: ${r.repairNo}`,
    `ห้อง: ${r.roomLabel}`,
    ...(r.technicianName ? [`ช่างผู้รับผิดชอบ: ${r.technicianName}`] : []),
    `วันเวลานัดหมาย: ${timeRange(r.scheduledDate!, r.scheduledStartTime!, r.scheduledEndTime!)}`,
    ...(r.note ? [`หมายเหตุ: ${r.note}`] : []),
  ].join("\n");
}

/** The "งานเสร็จ" message. The detail line is omitted entirely when there is no extra detail. */
export function completedText(r: RepairView): string {
  const lines = ["งานเสร็จเรียบร้อยแล้วครับ", "", `เลขที่ใบงาน: ${r.repairNo}`, `ห้อง: ${r.roomLabel}`];
  if (r.note && r.note.trim()) {
    lines.push("", `รายละเอียดเพิ่มเติม: ${r.note.trim()}`);
  }
  return lines.join("\n");
}

export const photosHeaderText = "รูปภาพงานซ่อม:";

export function ratingText(url: string): string {
  return `หากสะดวก รบกวนประเมินการทำงานของช่างได้ที่ลิงก์ด้านล่างครับ\n${url}`;
}

export const welcomeText =
  "สวัสดีครับ 🙏\nหากต้องการผูกบัญชี LINE กับห้องของท่าน กรุณาพิมพ์\n\"ลงทะเบียน XXXX-XXXX\"\nโดยใช้รหัสลงทะเบียนที่นิติบุคคลออกให้";

export const bindSuccessText = (room: string) =>
  `ผูกบัญชี LINE กับห้อง ${room} สำเร็จแล้ว ✅\nท่านจะได้รับการแจ้งเตือนสถานะงานซ่อมผ่านแชทนี้`;

export const bindFailText = "รหัสลงทะเบียนไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว\nกรุณาติดต่อนิติบุคคลเพื่อขอรหัสใหม่";
export const bindLockedText = "พยายามผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่";
export const notBoundText = "ยังไม่ได้ผูกบัญชี LINE กับห้อง\nพิมพ์ \"ลงทะเบียน XXXX-XXXX\" พร้อมรหัสจากนิติบุคคล";

export const personalLinkText = (url: string) =>
  `ลิงก์ส่วนตัวสำหรับแจ้งซ่อมและดูสถานะ (ห้ามส่งต่อให้ผู้อื่น)\n${url}`;

export const testNotificationText = (room: string) =>
  `ทดสอบการแจ้งเตือนจากระบบแจ้งซ่อม (ห้อง ${room}) ✅\nหากท่านเห็นข้อความนี้ แสดงว่าผูกบัญชีสำเร็จ`;

export const unbindText = "ยกเลิกการผูกบัญชี LINE เรียบร้อยแล้ว";
