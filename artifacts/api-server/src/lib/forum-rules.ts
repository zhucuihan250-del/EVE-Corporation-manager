import { TextDecoder } from "node:util";

export const FORUM_LIMITS = Object.freeze({ titleMax: 150, bodyMax: 20_000, fileBytesMax: 5 * 1024 * 1024, attachmentsMax: 6, draftBytesMax: 30 * 1024 * 1024, userBytesMax: 100 * 1024 * 1024, corporationBytesMax: 1024 * 1024 * 1024, draftAttachmentsMax: 24, userAttachmentsMax: 1000, corporationAttachmentsMax: 20_000, draftLifetimeHours: 24 });
export type ForumActor = { corporationId: number; userId: number; userName: string; role: string };
export class ForumError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function forumId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw new ForumError(400, "FORUM_INVALID_ID", "内容编号无效。");
  return id;
}
export function forumAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ForumError(400, "FORUM_INVALID_ATTACHMENT", "附件编号无效。");
  return value.toLowerCase();
}
export function forumObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) throw new ForumError(400, "FORUM_INVALID_INPUT", "请提交有效的内容。");
  return value as Record<string, unknown>;
}
export function forumText(value: unknown, field: "title" | "body", allowEmpty = false): string {
  const max = field === "title" ? FORUM_LIMITS.titleMax : FORUM_LIMITS.bodyMax;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (!allowEmpty && !value.trim()) || (field === "title" && /[\r\n\t]/u.test(value))) throw new ForumError(400, "FORUM_INVALID_TEXT", field === "title" ? "标题须为 1–150 字。" : "正文须为 1–20000 字，不能包含控制字符。");
  return value.trim();
}
export function forumVersion(value: unknown, current: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ForumError(400, "FORUM_INVALID_VERSION", "内容版本无效。");
  if (value !== current) throw new ForumError(409, "FORUM_VERSION_CONFLICT", "内容已经更新，请刷新后再编辑。");
}
export const forumModerator = (actor: ForumActor) => ["admin", "controller"].includes(actor.role);
export function forumStorageQuota(usage: { corporation: number; user: number; draft: number; corporationCount: number; userCount: number; draftCount: number }, size: number): void {
  if (usage.draft + size > FORUM_LIMITS.draftBytesMax || usage.user + size > FORUM_LIMITS.userBytesMax || usage.draftCount >= FORUM_LIMITS.draftAttachmentsMax || usage.userCount >= FORUM_LIMITS.userAttachmentsMax) throw new ForumError(409, "FORUM_USER_STORAGE_LIMIT", "附件存储额度已满，请发布或移除未使用的附件，或删除不再需要的帖子。");
  if (usage.corporation + size > FORUM_LIMITS.corporationBytesMax || usage.corporationCount >= FORUM_LIMITS.corporationAttachmentsMax) throw new ForumError(409, "FORUM_CORPORATION_STORAGE_LIMIT", "军团附件存储额度已满，请联系管理员清理不再需要的帖子。");
}
export function forumPage(value: unknown): number {
  if (value === undefined) return 1;
  const page = forumId(value);
  if (page > 10_000) throw new ForumError(400, "FORUM_INVALID_PAGE", "页码无效。");
  return page;
}

/** Claimed MIME and extension are never trusted. Text/PDF are always forced
 * downloads; format checks are not a substitute for scanning downloaded files. */
export function forumUpload(bytes: unknown, contentType: unknown, encodedName: unknown) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > FORUM_LIMITS.fileBytesMax) throw new ForumError(bytes && Buffer.isBuffer(bytes) && bytes.length > FORUM_LIMITS.fileBytesMax ? 413 : 400, "FORUM_INVALID_FILE", "每个附件须为非空文件且不超过 5 MiB。");
  const mimeType = typeof contentType === "string" ? contentType.split(";")[0]!.trim().toLowerCase() : "";
  let name: string;
  try { name = typeof encodedName === "string" ? decodeURIComponent(encodedName) : ""; } catch { throw new ForumError(400, "FORUM_INVALID_FILENAME", "附件名称无效。"); }
  name = name.normalize("NFC").trim();
  if (!name || name.length > 180 || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u.test(name) || name === "." || name === "..") throw new ForumError(400, "FORUM_INVALID_FILENAME", "附件名称须为 1–180 字且不能含路径或控制字符。");
  let valid = false;
  if (mimeType === "image/png") {
    valid = bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(8) === 13;
    if (valid) {
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20); valid = width > 0 && height > 0 && width * height <= 40_000_000;
      let position = 8, ended = false;
      while (valid && position + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(position), type = bytes.toString("ascii", position + 4, position + 8);
        if (length > bytes.length - position - 12) { valid = false; break; }
        position += length + 12;
        if (type === "IEND") { ended = length === 0 && position === bytes.length; break; }
      }
      valid = valid && ended;
    }
  } else if (mimeType === "image/jpeg") {
    valid = bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    let position = 2, dimensions = false;
    while (valid && position + 4 <= bytes.length) {
      if (bytes[position++] !== 0xff) break;
      while (bytes[position] === 0xff) position++;
      if (position + 3 > bytes.length) { valid = false; break; }
      const marker = bytes[position++]; if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker && marker >= 0xd0 && marker <= 0xd7) continue;
      const length = bytes.readUInt16BE(position); if (length < 2 || position + length > bytes.length) { valid = false; break; }
      if (marker && [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) {
        const height = bytes.readUInt16BE(position + 3), width = bytes.readUInt16BE(position + 5); dimensions = width > 0 && height > 0 && width * height <= 40_000_000;
      }
      position += length;
    }
    valid = valid && dimensions;
  } else if (mimeType === "image/gif") {
    valid = bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) && bytes[bytes.length - 1] === 0x3b && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.readUInt16LE(6) * bytes.readUInt16LE(8) <= 40_000_000;
  } else if (mimeType === "image/webp") {
    valid = bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length;
    let position = 12, dimensions = false;
    while (valid && position + 8 <= bytes.length) {
      const tag = bytes.toString("ascii", position, position + 4), length = bytes.readUInt32LE(position + 4), offset = position + 8;
      if (length > bytes.length - offset) { valid = false; break; }
      let width = 0, height = 0;
      if (tag === "VP8X" && length === 10 && (bytes[offset]! & 0xc1) === 0 && bytes.subarray(offset + 1, offset + 4).every(value => value === 0)) { width = bytes.readUIntLE(offset + 4, 3) + 1; height = bytes.readUIntLE(offset + 7, 3) + 1; }
      else if (tag === "VP8L" && length >= 5 && bytes[offset] === 0x2f && (bytes[offset + 4]! & 0xe0) === 0) { const bits = bytes.readUInt32LE(offset + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      else if (tag === "VP8 " && length >= 10 && (bytes[offset]! & 1) === 0 && bytes.subarray(offset + 3, offset + 6).equals(Buffer.from([0x9d,0x01,0x2a]))) { width = bytes.readUInt16LE(offset + 6) & 0x3fff; height = bytes.readUInt16LE(offset + 8) & 0x3fff; }
      if (["VP8X", "VP8L", "VP8 "].includes(tag)) { if (!width || !height || width * height > 40_000_000) { valid = false; break; } dimensions = true; }
      position = offset + length + (length % 2);
    }
    valid = valid && dimensions && position === bytes.length;
  } else if (mimeType === "application/pdf") {
    const source = bytes.toString("latin1");
    const decodedNames = source.replace(/#([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    valid = /^%PDF-(?:1\.[0-9]|2\.0)/u.test(source) && /%%EOF\s*$/u.test(source) && !/\/(?:JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA)\b/iu.test(decodedNames);
  } else if (mimeType === "text/plain") {
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      valid = !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source) && !/<\s*(?:!doctype\s+html|html|script|svg|iframe|object|embed)\b/iu.test(source);
    } catch { valid = false; }
  } else throw new ForumError(415, "FORUM_UNSUPPORTED_FILE", "仅支持 PNG、JPEG、GIF、WebP 图片及 PDF、TXT 附件。");
  if (!valid) throw new ForumError(400, "FORUM_INVALID_FILE_CONTENT", "附件内容与所选类型不符、已损坏或含不支持的活动内容。");
  const extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf", "text/plain": ".txt" }[mimeType]!;
  const base = name.replace(/\.[^.]*$/u, "").trim() || "附件";
  const fileName = `${base.slice(0, 180 - extension.length).replace(/[\ud800-\udbff]$/u, "")}${extension}`;
  return { bytes, fileName, mimeType, size: bytes.length };
}
