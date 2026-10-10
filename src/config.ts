import * as dotenv from "dotenv";
dotenv.config();

export const REGION = "asia-southeast1";

// Limits
export const LIMITS = {
  bindingCodeMinutes: 24 * 60,
  residentLinkDays: 30,
  maxActiveRepairsPerRoom: 5,
  maxImagesPerRepair: 10,
  notificationMaxAttempts: 5,
  signedUrlHoursLine: 168,
  signedUrlHoursStaff: 72,
  signedUrlHoursApp: 72,
  maxOriginalBytes: 25 * 1024 * 1024,
};

export const IMAGE_STANDARD = {
  maxLongEdge: 1920,
  quality: 88,
  previewLongEdge: 1024,
  previewQuality: 70,
};

function getEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined) {
    console.warn(`Environment variable ${key} is not set.`);
    return "";
  }
  return v;
}

export const SECRETS = {
  LINE_CHANNEL_ACCESS_TOKEN: getEnv("LINE_CHANNEL_ACCESS_TOKEN"),
  LINE_CHANNEL_SECRET: getEnv("LINE_CHANNEL_SECRET"),
};

export const APP_BASE_URL = getEnv("APP_BASE_URL");
export const LINE_CHANNEL_ACCESS_TOKEN = getEnv("LINE_CHANNEL_ACCESS_TOKEN");
export const LINE_CHANNEL_SECRET = getEnv("LINE_CHANNEL_SECRET");
export const LINE_STAFF_GROUP_ID = getEnv("LINE_STAFF_GROUP_ID");
export const LINE_MOCK_MODE = process.env.LINE_MOCK_MODE === "true";
