import sharp from "sharp";
import { IMAGE_STANDARD } from "../config";

export type SourceFormat = "jpeg" | "png" | "webp" | "heic" | "avif";

export class ImageError extends Error {
  constructor(
    public readonly code: "unsupported_type" | "corrupt" | "decode_failed" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "ImageError";
  }
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const GENERIC_HEIF_BRANDS = new Set(["mif1", "msf1", "heif"]);

/** Detects the real file type from magic bytes. File name and MIME type are never trusted. */
export function detectFormat(buf: Buffer): SourceFormat | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const major = buf.toString("ascii", 8, 12);
    const boxSize = Math.min(buf.readUInt32BE(0) || 32, 256, buf.length);
    const compat: string[] = [];
    for (let i = 16; i + 4 <= boxSize; i += 4) compat.push(buf.toString("ascii", i, i + 4));
    const all = [major, ...compat];
    if (AVIF_BRANDS.has(major)) return "avif";
    if (HEIC_BRANDS.has(major)) return "heic";
    if (GENERIC_HEIF_BRANDS.has(major)) {
      if (all.some((b) => AVIF_BRANDS.has(b))) return "avif";
      if (all.some((b) => HEIC_BRANDS.has(b)) || major === "heif" || major === "mif1" || major === "msf1") return "heic";
    }
  }
  return null;
}

export interface ProcessedImage {
  jpeg: Buffer;
  preview: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
  sourceFormat: SourceFormat;
}

async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  try {
    // heic-convert is CommonJS; loaded lazily so tests/cold start of other functions stay light.
    const convert = (await import("heic-convert")).default as unknown as (o: {
      buffer: Buffer;
      format: "JPEG";
      quality: number;
    }) => Promise<ArrayBuffer>;
    const out = await convert({ buffer: buf, format: "JPEG", quality: 0.95 });
    return Buffer.from(out);
  } catch (e) {
    throw new ImageError(
      "decode_failed",
      `ไม่สามารถแปลงไฟล์ HEIC/HEIF ได้ (${(e as Error).message}) กรุณาถ่ายหรือส่งเป็น JPEG อีกครั้ง`,
    );
  }
}

/**
 * Standard pipeline for every picture in the system:
 * detect real type -> decode -> fix EXIF orientation -> flatten transparency on white ->
 * fit inside 1920px (never enlarge, never crop) -> JPEG q88 without metadata.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const format = detectFormat(input);
  if (!format) {
    throw new ImageError("unsupported_type", "ชนิดไฟล์ไม่รองรับ (รองรับ JPEG, PNG, WebP, HEIC/HEIF, AVIF)");
  }
  let source = input;
  if (format === "heic") source = await heicToJpeg(input);

  try {
    const jpeg = await sharp(source, { failOn: "error" })
      .rotate() // applies EXIF orientation, then drops the tag
      .flatten({ background: "#ffffff" })
      .resize({
        width: IMAGE_STANDARD.maxLongEdge,
        height: IMAGE_STANDARD.maxLongEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: IMAGE_STANDARD.quality, mozjpeg: true })
      .toBuffer(); // no withMetadata(): EXIF/GPS are stripped

    const meta = await sharp(jpeg).metadata();

    // LINE preview image must be JPEG/PNG, <= 1024px and <= 1MB.
    let q: number = IMAGE_STANDARD.previewQuality;
    let preview = await makePreview(jpeg, q);
    while (preview.length > 1_000_000 && q > 40) {
      q -= 10;
      preview = await makePreview(jpeg, q);
    }

    return {
      jpeg,
      preview,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      sizeBytes: jpeg.length,
      sourceFormat: format,
    };
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError(
      format === "avif" ? "decode_failed" : "corrupt",
      `ไม่สามารถอ่านไฟล์รูปภาพ ${format.toUpperCase()} ได้: ${(e as Error).message}`,
    );
  }
}

function makePreview(jpeg: Buffer, quality: number): Promise<Buffer> {
  return sharp(jpeg)
    .resize({
      width: IMAGE_STANDARD.previewLongEdge,
      height: IMAGE_STANDARD.previewLongEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}
