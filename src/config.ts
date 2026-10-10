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
