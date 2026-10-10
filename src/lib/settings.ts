import { APP_BASE_URL, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LINE_MOCK_MODE, LINE_STAFF_GROUP_ID } from "../config";
import { db } from "./admin";

export interface SystemSettings {
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  lineMockMode: boolean;
  lineStaffGroupId: string;
  appBaseUrl: string;
}

let cachedSettings: SystemSettings | null = null;
let lastFetch = 0;

export async function getSystemSettings(): Promise<SystemSettings> {
  const now = Date.now();
  // Cache for 1 minute
  if (cachedSettings && now - lastFetch < 60000) return cachedSettings;

  const doc = await db.doc("settings/system").get();
  const data = doc.data() || {};
  
  cachedSettings = {
    lineChannelAccessToken: data.lineChannelAccessToken || (LINE_CHANNEL_ACCESS_TOKEN.value() ?? ""),
    lineChannelSecret: data.lineChannelSecret || (LINE_CHANNEL_SECRET.value() ?? ""),
    lineMockMode: data.lineMockMode ?? (LINE_MOCK_MODE.value() === "true"),
    lineStaffGroupId: data.lineStaffGroupId || LINE_STAFF_GROUP_ID.value(),
    appBaseUrl: data.appBaseUrl || APP_BASE_URL.value(),
  };
  lastFetch = now;
  return cachedSettings;
}
