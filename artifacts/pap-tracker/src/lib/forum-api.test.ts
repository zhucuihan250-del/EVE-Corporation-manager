import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createForumPost, deleteForumDraftAttachment, deleteForumPost, editForumPost, editForumReply, forumAttachmentUrl, forumKeys, forumLimits, getForumPost, listForumPosts, uploadForumAttachment, ForumError } from "./forum-api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const author = { id: 1, name: "试飞员 <script>" };
const reply = { id: 2, body: "<img onerror=alert(1)>", author, createdAt: "2026-10-09T01:00:00Z", updatedAt: "2026-10-09T01:00:00Z", canEdit: true, canDelete: true, version: 1 };
const attachment = { id: "e551d81a-1f7c-4c05-9792-747e761f0123", fileName: "图片.png", mimeType: "image/png", size: 83, url: "/api/forum/attachments/e551d81a-1f7c-4c05-9792-747e761f0123", downloadUrl: "/api/forum/attachments/e551d81a-1f7c-4c05-9792-747e761f0123/download" };
const post = { ...reply, id: 1, title: "测试帖子", pinned: false, locked: false, replyCount: 1, attachments: [attachment] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
test("forum list encodes Chinese search and page, sends authenticated requests and preserves text", async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://example.invalid"); assert.equal(url.pathname, "/api/forum/posts"); assert.equal(url.searchParams.get("query"), "战斗 & 分享"); assert.equal(url.searchParams.get("page"), "2"); assert.equal(init?.credentials, "include");
    return response({ posts: [post], page: 2, pageSize: 20, total: 21, canModerate: false, limits: forumLimits });
  };
  const data = await listForumPosts("战斗 & 分享", 2); assert.equal(data.posts[0].body, reply.body); assert.equal(data.posts[0].author.name, author.name);
});
test("detail uses reply pagination and includes optimistic edit versions", async () => {
  globalThis.fetch = async (input) => { assert.equal(String(input), "/api/forum/posts/1?replyPage=3"); return response({ post, replies: [reply], canModerate: true, replyPage: 3, replyPageSize: 50, replyTotal: 101 }); };
  const data = await getForumPost(1, 3); assert.equal(data.replyTotal, 101); assert.equal(data.replies[0].version, 1);
});
test("create and edit JSON contracts keep owner identity on server and send stale-write version", async () => {
  const seen: unknown[] = [];
  globalThis.fetch = async (input, init) => { seen.push({ path: String(input), method: init?.method, body: JSON.parse(String(init?.body)), credentials: init?.credentials }); return response(String(input).includes("/replies/") ? { reply } : { post }); };
  await createForumPost({ title: "标题", body: "正文", attachmentIds: [attachment.id] }); await editForumPost(1, { title: "标题", body: "正文", version: 4 }); await editForumReply(2, "回复", 7);
  assert.deepEqual(seen, [
    { path: "/api/forum/posts", method: "POST", credentials: "include", body: { title: "标题", body: "正文", attachmentIds: [attachment.id] } },
    { path: "/api/forum/posts/1", method: "PATCH", credentials: "include", body: { title: "标题", body: "正文", version: 4 } },
    { path: "/api/forum/replies/2", method: "PATCH", credentials: "include", body: { body: "回复", version: 7 } },
  ]);
});
test("deletes handle 204 without attempting to parse JSON", async () => { globalThis.fetch = async (_, init) => { assert.equal(init?.method, "DELETE"); return new Response(null, { status: 204 }); }; await deleteForumPost(1); });
test("expired draft attachment cleanup treats 404 as gone without swallowing auth failures", async () => { globalThis.fetch = async () => response({ code: "FORUM_NOT_FOUND", error: "已过期" }, 404); assert.equal(await deleteForumDraftAttachment(attachment.id), null); for (const status of [401, 403]) { globalThis.fetch = async () => response({ error: "Forbidden" }, status); await assert.rejects(deleteForumDraftAttachment(attachment.id), (error: unknown) => error instanceof ForumError && error.status === status); } });
test("HTML proxy errors cannot appear as raw user-facing responses", async () => { globalThis.fetch = async () => new Response("<html>server token leaked</html>", { status: 502 }); await assert.rejects(listForumPosts("", 1), (error: unknown) => error instanceof ForumError && error.status === 502 && !error.message.includes("<html>") && !error.message.includes("leaked")); });
test("coded 409 errors remain useful for recovering an unsaved draft", async () => { globalThis.fetch = async () => response({ code: "FORUM_STALE_VERSION", error: "帖子已更新，请刷新后核对。" }, 409); await assert.rejects(editForumPost(1, { title: "新", body: "未保存内容", version: 1 }), (error: unknown) => error instanceof ForumError && error.status === 409 && error.code === "FORUM_STALE_VERSION" && error.message.includes("已更新")); });
test("coded HTML and credential-looking errors still use a safe generic message", async () => { for (const error of ["<script>alert(1)</script>", "access_token=secret", "bearer secret"]) { globalThis.fetch = async () => response({ code: "FORUM_FAILURE", error }, 400); await assert.rejects(listForumPosts("", 1), (cause: unknown) => cause instanceof ForumError && !cause.message.includes(error)); } });
test("success responses with malformed posts or excessive attachment counts are rejected", async () => { for (const malformed of [{ ...post, version: undefined }, { ...post, version: 0 }, { ...post, attachments: Array(7).fill(attachment) }, { ...post, attachments: [{ ...attachment, url: "javascript:alert(1)" }] }, { ...post, attachments: [{ ...attachment, mimeType: "image/svg+xml" }] }, { ...post, attachments: [{ ...attachment, size: 0 }] }]) { globalThis.fetch = async () => response({ posts: [malformed], page: 1, pageSize: 20, total: 1, canModerate: false, limits: forumLimits }); await assert.rejects(listForumPosts("", 1), ForumError); } });
test("authenticated attachment URLs reject foreign origins and executable URL schemes", () => { assert.equal(forumAttachmentUrl(attachment), attachment.url); assert.equal(forumAttachmentUrl(attachment, true), attachment.downloadUrl); for (const url of ["https://evil.invalid/test.png", "javascript:alert(1)", "//evil.invalid/test.png"]) assert.throws(() => forumAttachmentUrl({ ...attachment, url }), ForumError); assert.throws(() => forumAttachmentUrl({ ...attachment, id: "not-a-uuid" }), ForumError); });
test("list and reply page cache identities remain separate", () => { assert.notDeepEqual(forumKeys.list("", 1), forumKeys.list("", 2)); assert.notDeepEqual(forumKeys.list("test", 1), forumKeys.list("", 1)); assert.notDeepEqual(forumKeys.detail(1, 1), forumKeys.detail(1, 2)); assert.notDeepEqual(forumKeys.detail(1, 1), forumKeys.detail(2, 1)); });
test("upload rejects unsupported types, empty files and oversized files before opening a connection", async () => { for (const file of [new File(["script"], "x.html", { type: "text/html" }), new File([], "empty.txt", { type: "text/plain" }), new File([new Uint8Array(forumLimits.fileBytesMax + 1)], "large.txt", { type: "text/plain" })]) await assert.rejects(uploadForumAttachment(file, () => {}), ForumError); });
test("network and malformed successful responses produce bounded errors", async () => { globalThis.fetch = async () => { throw new Error("secret internal network details"); }; await assert.rejects(listForumPosts("", 1), (error: unknown) => error instanceof ForumError && error.status === 0 && !error.message.includes("internal")); globalThis.fetch = async () => new Response("ok"); await assert.rejects(listForumPosts("", 1), ForumError); });
