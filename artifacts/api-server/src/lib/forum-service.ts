import type { db } from "@workspace/db";
import { corporationsTable, forumAttachmentsTable, forumPostsTable, forumRepliesTable } from "@workspace/db/schema";
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { FORUM_LIMITS, ForumError, forumAttachmentId, forumId, forumModerator, forumObject, forumPage, forumStorageQuota, forumText, forumUpload, forumVersion, type ForumActor } from "./forum-rules";

type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Post = typeof forumPostsTable.$inferSelect;
type Reply = typeof forumRepliesTable.$inferSelect;
const attachmentColumns = { id: forumAttachmentsTable.id, fileName: forumAttachmentsTable.fileName, mimeType: forumAttachmentsTable.mimeType, size: forumAttachmentsTable.size, postId: forumAttachmentsTable.postId };
const attachmentView = (row: { id: string; fileName: string; mimeType: string; size: number }) => ({ id: row.id, fileName: row.fileName, mimeType: row.mimeType, size: row.size, url: `/api/forum/attachments/${row.id}`, downloadUrl: `/api/forum/attachments/${row.id}/download` });
const postWhere = (actor: ForumActor, id?: number) => and(eq(forumPostsTable.corporationId, actor.corporationId), isNull(forumPostsTable.deletedAt), id === undefined ? undefined : eq(forumPostsTable.id, forumId(id)));
const replyWhere = (actor: ForumActor, id?: number) => and(eq(forumRepliesTable.corporationId, actor.corporationId), isNull(forumRepliesTable.deletedAt), id === undefined ? undefined : eq(forumRepliesTable.id, forumId(id)));
const attachmentWhere = (actor: ForumActor, id?: string) => and(eq(forumAttachmentsTable.corporationId, actor.corporationId), isNull(forumAttachmentsTable.deletedAt), id === undefined ? undefined : eq(forumAttachmentsTable.id, forumAttachmentId(id)));
const missing = () => new ForumError(404, "FORUM_NOT_FOUND", "找不到该内容，可能已被移除。");
const forbidden = () => new ForumError(403, "FORUM_FORBIDDEN", "你没有权限执行该操作。");
const locked = () => new ForumError(409, "FORUM_POST_LOCKED", "此帖已锁定，无法编辑或回复。");
function own(actor: ForumActor, authorId: number | null) { if (authorId !== actor.userId) throw forbidden(); }
function replyView(actor: ForumActor, row: Reply, parent: Post) {
  return { id: row.id, body: row.body, author: { id: row.authorUserId, name: row.authorName }, createdAt: row.createdAt, updatedAt: row.updatedAt, version: row.version, canEdit: !parent.locked && row.authorUserId === actor.userId, canDelete: row.authorUserId === actor.userId || forumModerator(actor) };
}

export function createForumService({ database }: { database: Database }) {
  /** One FK-compatible corporation lock makes quota checks atomic across API
   * instances; no corporation row data is changed by this lock. Every write
   * takes it before touching posts or attachments to avoid lock-order cycles. */
  const write = async <T>(actor: ForumActor, callback: (tx: Transaction) => Promise<T>): Promise<T> => database.transaction(async tx => {
    const [corporation] = await tx.select({ id: corporationsTable.id }).from(corporationsTable).where(eq(corporationsTable.id, actor.corporationId)).for("no key update");
    if (!corporation) throw forbidden();
    return callback(tx);
  });
  async function findPost(connection: Database | Transaction, actor: ForumActor, id: number) {
    const [post] = await connection.select().from(forumPostsTable).where(postWhere(actor, id));
    if (!post) throw missing();
    return post;
  }
  async function postViews(connection: Database | Transaction, actor: ForumActor, rows: Post[]) {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id);
    const attachments = await connection.select(attachmentColumns).from(forumAttachmentsTable).where(and(attachmentWhere(actor), inArray(forumAttachmentsTable.postId, ids))).orderBy(asc(forumAttachmentsTable.createdAt), asc(forumAttachmentsTable.id));
    const counts = await connection.select({ postId: forumRepliesTable.postId, count: sql<number>`count(*)::integer` }).from(forumRepliesTable).where(and(replyWhere(actor), inArray(forumRepliesTable.postId, ids))).groupBy(forumRepliesTable.postId);
    return rows.map(row => ({ id: row.id, title: row.title, body: row.body, author: { id: row.authorUserId, name: row.authorName }, createdAt: row.createdAt, updatedAt: row.updatedAt, pinned: row.pinned, locked: row.locked, version: row.version, replyCount: counts.find(count => count.postId === row.id)?.count ?? 0, attachments: attachments.filter(file => file.postId === row.id).map(attachmentView), canEdit: !row.locked && row.authorUserId === actor.userId, canDelete: row.authorUserId === actor.userId || forumModerator(actor) }));
  }
  async function listPosts(actor: ForumActor, options: { query?: unknown; page?: unknown } = {}) {
    const page = forumPage(options.page), pageSize = 20;
    if (options.query !== undefined && (typeof options.query !== "string" || options.query.length > 100 || /[\u0000-\u001f\u007f]/u.test(options.query))) throw new ForumError(400, "FORUM_INVALID_SEARCH", "搜索词最多 100 字。");
    const query = typeof options.query === "string" ? options.query.trim() : "", term = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const where = and(postWhere(actor), query ? or(ilike(forumPostsTable.title, term), ilike(forumPostsTable.body, term), ilike(forumPostsTable.authorName, term)) : undefined);
    const [count] = await database.select({ total: sql<number>`count(*)::integer` }).from(forumPostsTable).where(where);
    const rows = await database.select().from(forumPostsTable).where(where).orderBy(desc(forumPostsTable.pinned), desc(forumPostsTable.createdAt), desc(forumPostsTable.id)).limit(pageSize).offset((page - 1) * pageSize);
    return { posts: await postViews(database, actor, rows), page, pageSize, total: count?.total ?? 0, canModerate: forumModerator(actor), limits: FORUM_LIMITS };
  }
  async function getPost(actor: ForumActor, id: number, options: { replyPage?: unknown } = {}) {
    const post = await findPost(database, actor, id), replyPage = forumPage(options.replyPage), replyPageSize = 50;
    const where = and(replyWhere(actor), eq(forumRepliesTable.postId, post.id));
    const [count] = await database.select({ total: sql<number>`count(*)::integer` }).from(forumRepliesTable).where(where);
    const replies = await database.select().from(forumRepliesTable).where(where).orderBy(asc(forumRepliesTable.createdAt), asc(forumRepliesTable.id)).limit(replyPageSize).offset((replyPage - 1) * replyPageSize);
    return { post: (await postViews(database, actor, [post]))[0]!, replies: replies.map(row => replyView(actor, row, post)), replyPage, replyPageSize, replyTotal: count?.total ?? 0, canModerate: forumModerator(actor) };
  }
  async function createPost(actor: ForumActor, value: unknown) {
    const body = forumObject(value), title = forumText(body.title, "title"), text = forumText(body.body, "body", true);
    const attachmentIds = body.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > FORUM_LIMITS.attachmentsMax) throw new ForumError(400, "FORUM_ATTACHMENT_LIMIT", "每篇帖子最多 6 个附件。");
    const ids = attachmentIds.map(forumAttachmentId);
    if (new Set(ids).size !== ids.length) throw new ForumError(400, "FORUM_INVALID_ATTACHMENT", "不能重复添加同一附件。");
    if (!text && !ids.length) throw new ForumError(400, "FORUM_EMPTY_POST", "请填写正文或添加附件。");
    return write(actor, async tx => {
      if (ids.length) {
        const files = await tx.select({ id: forumAttachmentsTable.id }).from(forumAttachmentsTable).where(and(attachmentWhere(actor), inArray(forumAttachmentsTable.id, ids), isNull(forumAttachmentsTable.postId), eq(forumAttachmentsTable.ownerUserId, actor.userId), sql`${forumAttachmentsTable.createdAt} > now() - interval '24 hours'`));
        if (files.length !== ids.length) throw new ForumError(404, "FORUM_ATTACHMENT_NOT_FOUND", "附件已过期、已发布或不属于你，请重新上传。");
      }
      const [post] = await tx.insert(forumPostsTable).values({ corporationId: actor.corporationId, authorUserId: actor.userId, authorName: actor.userName.slice(0, 200), title, body: text }).returning();
      if (ids.length) await tx.update(forumAttachmentsTable).set({ postId: post!.id }).where(and(attachmentWhere(actor), inArray(forumAttachmentsTable.id, ids), eq(forumAttachmentsTable.ownerUserId, actor.userId), isNull(forumAttachmentsTable.postId)));
      return { post: (await postViews(tx, actor, [post!]))[0]! };
    });
  }
  async function updatePost(actor: ForumActor, id: number, value: unknown) {
    const body = forumObject(value), title = forumText(body.title, "title"), text = forumText(body.body, "body", true);
    return write(actor, async tx => {
      const current = await findPost(tx, actor, id); own(actor, current.authorUserId); if (current.locked) throw locked(); forumVersion(body.version, current.version);
      if (!text) {
        const [file] = await tx.select({ id: forumAttachmentsTable.id }).from(forumAttachmentsTable).where(and(attachmentWhere(actor), eq(forumAttachmentsTable.postId, current.id))).limit(1);
        if (!file) throw new ForumError(400, "FORUM_EMPTY_POST", "请保留正文或附件。");
      }
      const [post] = await tx.update(forumPostsTable).set({ title, body: text, updatedAt: new Date(), version: current.version + 1 }).where(postWhere(actor, id)).returning();
      return { post: (await postViews(tx, actor, [post!]))[0]! };
    });
  }
  async function deletePost(actor: ForumActor, id: number) {
    return write(actor, async tx => {
      const post = await findPost(tx, actor, id); if (post.authorUserId !== actor.userId && !forumModerator(actor)) throw forbidden();
      const now = new Date();
      await tx.update(forumPostsTable).set({ deletedAt: now, updatedAt: now, version: post.version + 1 }).where(postWhere(actor, id));
      // Deleted attachments retain metadata tombstones, never accessible bytes.
      await tx.update(forumAttachmentsTable).set({ deletedAt: now, dataBase64: null }).where(and(attachmentWhere(actor), eq(forumAttachmentsTable.postId, post.id)));
      return { deleted: true };
    });
  }
  async function moderatePost(actor: ForumActor, id: number, value: unknown) {
    if (!forumModerator(actor)) throw forbidden();
    const body = forumObject(value), pinned = Object.hasOwn(body, "pinned"), isLocked = Object.hasOwn(body, "locked");
    if ((!pinned && !isLocked) || (pinned && typeof body.pinned !== "boolean") || (isLocked && typeof body.locked !== "boolean")) throw new ForumError(400, "FORUM_INVALID_MODERATION", "请选择置顶或锁帖操作。");
    return write(actor, async tx => {
      const current = await findPost(tx, actor, id); forumVersion(body.version, current.version);
      const [post] = await tx.update(forumPostsTable).set({ ...(pinned ? { pinned: body.pinned as boolean } : {}), ...(isLocked ? { locked: body.locked as boolean } : {}), updatedAt: new Date(), version: current.version + 1 }).where(postWhere(actor, id)).returning();
      return { post: (await postViews(tx, actor, [post!]))[0]! };
    });
  }
  async function createReply(actor: ForumActor, id: number, value: unknown) {
    const body = forumText(forumObject(value).body, "body");
    return write(actor, async tx => {
      const post = await findPost(tx, actor, id); if (post.locked) throw locked();
      const [reply] = await tx.insert(forumRepliesTable).values({ corporationId: actor.corporationId, postId: post.id, authorUserId: actor.userId, authorName: actor.userName.slice(0, 200), body }).returning();
      return { reply: replyView(actor, reply!, post) };
    });
  }
  async function updateReply(actor: ForumActor, id: number, value: unknown) {
    const input = forumObject(value), body = forumText(input.body, "body");
    return write(actor, async tx => {
      const [current] = await tx.select().from(forumRepliesTable).where(replyWhere(actor, id)); if (!current) throw missing();
      const post = await findPost(tx, actor, current.postId); own(actor, current.authorUserId); if (post.locked) throw locked(); forumVersion(input.version, current.version);
      const [reply] = await tx.update(forumRepliesTable).set({ body, updatedAt: new Date(), version: current.version + 1 }).where(replyWhere(actor, id)).returning();
      return { reply: replyView(actor, reply!, post) };
    });
  }
  async function deleteReply(actor: ForumActor, id: number) {
    return write(actor, async tx => {
      const [reply] = await tx.select().from(forumRepliesTable).where(replyWhere(actor, id)); if (!reply) throw missing();
      await findPost(tx, actor, reply.postId); if (reply.authorUserId !== actor.userId && !forumModerator(actor)) throw forbidden();
      await tx.update(forumRepliesTable).set({ deletedAt: new Date(), updatedAt: new Date(), version: reply.version + 1 }).where(replyWhere(actor, id));
      return { deleted: true };
    });
  }
  async function uploadAttachment(actor: ForumActor, bytes: unknown, contentType: unknown, encodedName: unknown) {
    const file = forumUpload(bytes, contentType, encodedName);
    return write(actor, async tx => {
      // Only expired unpublished blobs are reclaimed, never published posts.
      await tx.update(forumAttachmentsTable).set({ deletedAt: new Date(), dataBase64: null }).where(and(attachmentWhere(actor), isNull(forumAttachmentsTable.postId), lt(forumAttachmentsTable.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))));
      const [usage] = await tx.select({ corporation: sql<number>`coalesce(sum(${forumAttachmentsTable.size}), 0)::bigint`, user: sql<number>`coalesce(sum(CASE WHEN ${forumAttachmentsTable.ownerUserId} = ${actor.userId} THEN ${forumAttachmentsTable.size} ELSE 0 END), 0)::bigint`, draft: sql<number>`coalesce(sum(CASE WHEN ${forumAttachmentsTable.ownerUserId} = ${actor.userId} AND ${forumAttachmentsTable.postId} IS NULL THEN ${forumAttachmentsTable.size} ELSE 0 END), 0)::bigint`, corporationCount: sql<number>`count(*)::integer`, userCount: sql<number>`count(*) FILTER (WHERE ${forumAttachmentsTable.ownerUserId} = ${actor.userId})::integer`, draftCount: sql<number>`count(*) FILTER (WHERE ${forumAttachmentsTable.ownerUserId} = ${actor.userId} AND ${forumAttachmentsTable.postId} IS NULL)::integer` }).from(forumAttachmentsTable).where(attachmentWhere(actor));
      forumStorageQuota({ corporation: Number(usage?.corporation ?? 0), user: Number(usage?.user ?? 0), draft: Number(usage?.draft ?? 0), corporationCount: Number(usage?.corporationCount ?? 0), userCount: Number(usage?.userCount ?? 0), draftCount: Number(usage?.draftCount ?? 0) }, file.size);
      const [row] = await tx.insert(forumAttachmentsTable).values({ id: randomUUID(), corporationId: actor.corporationId, ownerUserId: actor.userId, fileName: file.fileName, mimeType: file.mimeType, size: file.size, dataBase64: file.bytes.toString("base64") }).returning(attachmentColumns);
      return { attachment: attachmentView(row!) };
    });
  }
  async function getAttachment(actor: ForumActor, id: string) {
    const [row] = await database.select().from(forumAttachmentsTable).where(attachmentWhere(actor, id));
    if (!row) throw missing();
    if (row.postId !== null) await findPost(database, actor, row.postId);
    else if (row.ownerUserId !== actor.userId || Date.now() - row.createdAt.getTime() >= 24 * 60 * 60 * 1000) throw missing();
    if (!row.dataBase64) throw missing();
    return { fileName: row.fileName, mimeType: row.mimeType, bytes: Buffer.from(row.dataBase64, "base64") };
  }
  async function deleteDraftAttachment(actor: ForumActor, id: string) {
    return write(actor, async tx => {
      const [row] = await tx.select({ id: forumAttachmentsTable.id }).from(forumAttachmentsTable).where(and(attachmentWhere(actor, id), isNull(forumAttachmentsTable.postId), eq(forumAttachmentsTable.ownerUserId, actor.userId)));
      if (!row) throw missing();
      await tx.update(forumAttachmentsTable).set({ deletedAt: new Date(), dataBase64: null }).where(attachmentWhere(actor, id));
      return { deleted: true };
    });
  }
  return { listPosts, getPost, createPost, updatePost, deletePost, moderatePost, createReply, updateReply, deleteReply, uploadAttachment, getAttachment, deleteDraftAttachment };
}
