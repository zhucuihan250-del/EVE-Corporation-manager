import { apiUrl } from "@/lib/api";

export type ForumAuthor = { id: number | null; name: string };
export type ForumAttachment = { id: string; fileName: string; mimeType: string; size: number; url: string; downloadUrl: string };
export type ForumPost = {
  id: number; title: string; body: string; author: ForumAuthor; createdAt: string; updatedAt: string;
  pinned: boolean; locked: boolean; replyCount: number; attachments: ForumAttachment[];
  canEdit: boolean; canDelete: boolean; version: number;
};
export type ForumReply = {
  id: number; body: string; author: ForumAuthor; createdAt: string; updatedAt: string;
  canEdit: boolean; canDelete: boolean; version: number;
};
export type ForumLimits = { titleMax: number; bodyMax: number; fileBytesMax: number; attachmentsMax: number };
export type ForumList = { posts: ForumPost[]; page: number; pageSize: number; total: number; canModerate: boolean; limits: ForumLimits };
export type ForumDetail = { post: ForumPost; replies: ForumReply[]; canModerate: boolean; replyPage: number; replyPageSize: number; replyTotal: number };
export const forumLimits: ForumLimits = { titleMax: 150, bodyMax: 20000, fileBytesMax: 5242880, attachmentsMax: 6 };
export const forumKeys = { all: ["forum"] as const, list: (query: string, page: number) => ["forum", "list", query, page] as const, detail: (id: number, page: number) => ["forum", "detail", id, page] as const };
export const forumAcceptedTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"] as const;

export class ForumError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = "ForumError"; }
}
function responseError(status: number, data: unknown): ForumError {
  const item = object(data);
  const raw = item?.error ?? item?.message;
  const code = typeof item?.code === "string" && /^FORUM_[A-Z0-9_]{1,80}$/.test(item.code) ? item.code : undefined;
  return new ForumError(typeof raw === "string" && code && raw.length <= 1000 && !/<\/?[a-z!][^>]*>|bearer\s|access_token|refresh_token/i.test(raw)
    ? raw : `请求失败（HTTP ${status}），请刷新核对后重试。 / Request failed. Refresh to check the result before retrying.`, status, code);
}
const unexpected = () => new ForumError("服务器返回异常，请刷新核对。 / Unexpected response. Refresh to check the result.", 502);
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(new Date(value).getTime());
const author = (value: unknown) => { const item = object(value); return Boolean(item && (item.id === null || id(item.id)) && text(item.name, 500)); };
export function forumAttachmentUrl(attachment: ForumAttachment, download = false): string {
  const expected = `/api/forum/attachments/${encodeURIComponent(attachment.id)}${download ? "/download" : ""}`;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(attachment.id) || (download ? attachment.downloadUrl : attachment.url) !== expected) throw unexpected();
  return apiUrl(expected);
}
const validAttachment = (value: unknown): value is ForumAttachment => {
  const item = object(value);
  if (!item || !text(item.id, 80) || !text(item.fileName, 255) || !forumAcceptedTypes.includes(item.mimeType as typeof forumAcceptedTypes[number]) || !id(item.size) || Number(item.size) > forumLimits.fileBytesMax) return false;
  try { forumAttachmentUrl(item as ForumAttachment); forumAttachmentUrl(item as ForumAttachment, true); return true; } catch { return false; }
};
const validReply = (value: unknown): value is ForumReply => { const item = object(value); return Boolean(item && id(item.id) && text(item.body, forumLimits.bodyMax) && author(item.author) && timestamp(item.createdAt) && timestamp(item.updatedAt) && typeof item.canEdit === "boolean" && typeof item.canDelete === "boolean" && id(item.version)); };
const validPost = (value: unknown): value is ForumPost => {
  const item = object(value);
  return Boolean(item && text(item.title, forumLimits.titleMax) && typeof item.pinned === "boolean" && typeof item.locked === "boolean" && count(item.replyCount) && Array.isArray(item.attachments) && item.attachments.length <= forumLimits.attachmentsMax && item.attachments.every(validAttachment) && validReply(value));
};
async function request(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  let response: Response;
  try { response = await fetch(apiUrl(path), { method: options.method ?? "GET", credentials: "include", headers: options.body === undefined ? undefined : { "Content-Type": "application/json" }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal }); }
  catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; throw new ForumError("连接失败，请刷新核对后重试。 / Connection failed. Refresh to check the result before retrying.", 0); }
  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw responseError(response.status, data);
  if (response.status !== 204 && !object(data)) throw unexpected();
  return data;
}
export async function listForumPosts(query: string, page: number, signal?: AbortSignal): Promise<ForumList> {
  const params = new URLSearchParams({ query, page: String(page) });
  const data = object(await request(`/api/forum/posts?${params}`, { signal }));
  const limits = object(data?.limits);
  if (!data || !Array.isArray(data.posts) || data.posts.length > 100 || !data.posts.every(validPost) || !id(data.page) || !id(data.pageSize) || !count(data.total) || typeof data.canModerate !== "boolean" || !limits || !id(limits.titleMax) || !id(limits.bodyMax) || !id(limits.fileBytesMax) || !id(limits.attachmentsMax)) throw unexpected();
  return data as ForumList;
}
export async function getForumPost(postId: number, page: number, signal?: AbortSignal): Promise<ForumDetail> {
  const data = object(await request(`/api/forum/posts/${postId}?replyPage=${page}`, { signal }));
  if (!data || !validPost(data.post) || !Array.isArray(data.replies) || data.replies.length > 100 || !data.replies.every(validReply) || typeof data.canModerate !== "boolean" || !id(data.replyPage) || !id(data.replyPageSize) || !count(data.replyTotal)) throw unexpected();
  return data as ForumDetail;
}
async function postResponse(path: string, method: string, body: unknown): Promise<ForumPost> { const data = object(await request(path, { method, body })); if (!validPost(data?.post)) throw unexpected(); return data.post; }
async function replyResponse(path: string, method: string, body: unknown): Promise<ForumReply> { const data = object(await request(path, { method, body })); if (!validReply(data?.reply)) throw unexpected(); return data.reply; }
export const createForumPost = (body: { title: string; body: string; attachmentIds: string[] }) => postResponse("/api/forum/posts", "POST", body);
export const editForumPost = (postId: number, body: { title: string; body: string; version: number }) => postResponse(`/api/forum/posts/${postId}`, "PATCH", body);
export const deleteForumPost = (postId: number) => request(`/api/forum/posts/${postId}`, { method: "DELETE" });
export const moderateForumPost = (postId: number, body: { pinned?: boolean; locked?: boolean; version: number }) => postResponse(`/api/forum/posts/${postId}/moderation`, "PATCH", body);
export const createForumReply = (postId: number, body: string) => replyResponse(`/api/forum/posts/${postId}/replies`, "POST", { body });
export const editForumReply = (replyId: number, body: string, version: number) => replyResponse(`/api/forum/replies/${replyId}`, "PATCH", { body, version });
export const deleteForumReply = (replyId: number) => request(`/api/forum/replies/${replyId}`, { method: "DELETE" });
export async function deleteForumDraftAttachment(attachmentId: string): Promise<unknown> {
  try { return await request(`/api/forum/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" }); }
  catch (error) { if (error instanceof ForumError && error.status === 404) return null; throw error; }
}
export function uploadForumAttachment(file: File, onProgress: (percent: number) => void): Promise<ForumAttachment> {
  if (!forumAcceptedTypes.includes(file.type as typeof forumAcceptedTypes[number]) || file.size < 1 || file.size > forumLimits.fileBytesMax) return Promise.reject(new ForumError("请选择不超过 5 MiB 的图片、PDF 或 TXT 文件。 / Choose an image, PDF or TXT file up to 5 MiB.", 400));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/api/forum/attachments")); xhr.withCredentials = true;
    xhr.timeout = 120000;
    xhr.setRequestHeader("Content-Type", file.type); xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      let data: unknown; try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status < 200 || xhr.status >= 300) { reject(responseError(xhr.status, data)); return; }
      const attachment = object(data)?.attachment;
      if (!validAttachment(attachment)) { reject(unexpected()); return; }
      onProgress(100); resolve(attachment);
    };
    xhr.onerror = xhr.ontimeout = () => reject(new ForumError("上传失败，请核对网络后重试。 / Upload failed. Check your connection and retry.", 0));
    xhr.send(file);
  });
}
