import { createHmac } from "node:crypto";
import { createHash } from "node:crypto";
import { safeEqual } from "./crypto";

/** LINE Messaging API limits (verified against official docs):
 *  - max 5 message objects per push/reply request
 *  - image: originalContentUrl/previewImageUrl must be HTTPS, <= 2000 chars, JPEG or PNG,
 *    original <= 10MB (<=4096px), preview <= 1MB (<=1024px)
 *  - text: max 5000 characters */
export const LINE_MAX_MESSAGES_PER_REQUEST = 5;
export const LINE_MAX_URL_LENGTH = 2000;
export const LINE_MAX_TEXT = 5000;

export type LineMessage =
  | { type: "text"; text: string }
  | { type: "image"; originalContentUrl: string; previewImageUrl: string };

/** Validates X-Line-Signature against the raw request body. */
export function verifyLineSignature(rawBody: Buffer | string, signature: string | undefined, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  return safeEqual(expected, signature);
}

export function chunkMessages<T>(messages: T[], size = LINE_MAX_MESSAGES_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < messages.length; i += size) out.push(messages.slice(i, i + size));
  return out;
}

export function imageMessage(originalUrl: string, previewUrl: string): LineMessage {
  for (const u of [originalUrl, previewUrl]) {
    if (!u.startsWith("https://")) throw new Error("LINE image URL must use HTTPS");
    if (u.length > LINE_MAX_URL_LENGTH) throw new Error("LINE image URL exceeds 2000 characters");
  }
  return { type: "image", originalContentUrl: originalUrl, previewImageUrl: previewUrl };
}

export function textMessage(text: string): LineMessage {
  return { type: "text", text: text.length > LINE_MAX_TEXT ? text.slice(0, LINE_MAX_TEXT - 1) + "…" : text };
}

/** Deterministic UUID-shaped key so retries of the same logical request reuse X-Line-Retry-Key. */
export function retryKeyFor(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface LineSendResult {
  ok: boolean;
  status: number;
  /** transient failure worth retrying */
  retryable: boolean;
  error?: string;
}

const API = "https://api.line.me/v2/bot/message";

async function call(path: "push" | "reply", body: unknown, token: string, retryKey?: string): Promise<LineSendResult> {
  try {
    const res = await fetch(`${API}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, status: res.status, retryable: false };
    // 409: a request with this retry key was already accepted => treat as delivered-once.
    if (res.status === 409) return { ok: true, status: 409, retryable: false };
    const text = (await res.text()).slice(0, 500);
    return {
      ok: false,
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      error: `HTTP ${res.status}: ${text}`,
    };
  } catch (e) {
    return { ok: false, status: 0, retryable: true, error: `network: ${(e as Error).message}` };
  }
}

export const linePush = (to: string, messages: LineMessage[], token: string, retryKey: string) =>
  call("push", { to, messages }, token, retryKey);

export const lineReply = (replyToken: string, messages: LineMessage[], token: string) =>
  call("reply", { replyToken, messages }, token);
