import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export const forumPostsTable = pgTable("forum_posts", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  authorUserId: integer("author_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  authorName: text("author_name").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  pinned: boolean("pinned").notNull().default(false),
  locked: boolean("locked").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, table => [
  uniqueIndex("forum_posts_corp_id_unique").on(table.corporationId, table.id),
  index("forum_posts_listing_idx").on(table.corporationId, table.pinned, table.createdAt, table.id),
  check("forum_posts_text_valid", sql`length(${table.title}) BETWEEN 1 AND 150 AND length(${table.body}) <= 20000 AND length(${table.authorName}) BETWEEN 1 AND 200`),
  check("forum_posts_version_valid", sql`${table.version} >= 1`),
]);

export const forumRepliesTable = pgTable("forum_replies", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  postId: integer("post_id").notNull(),
  authorUserId: integer("author_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, table => [
  foreignKey({ name: "forum_replies_post_fk", columns: [table.corporationId, table.postId], foreignColumns: [forumPostsTable.corporationId, forumPostsTable.id] }).onDelete("restrict"),
  index("forum_replies_post_idx").on(table.corporationId, table.postId, table.id),
  check("forum_replies_text_valid", sql`length(${table.body}) BETWEEN 1 AND 20000 AND length(${table.authorName}) BETWEEN 1 AND 200`),
  check("forum_replies_version_valid", sql`${table.version} >= 1`),
]);

/** Binary content is encoded once, kept in PostgreSQL rather than ephemeral
 * deployment disks, and never included in API metadata responses. */
export const forumAttachmentsTable = pgTable("forum_attachments", {
  id: uuid("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  ownerUserId: integer("owner_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  postId: integer("post_id"),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  dataBase64: text("data_base64"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, table => [
  foreignKey({ name: "forum_attachments_post_fk", columns: [table.corporationId, table.postId], foreignColumns: [forumPostsTable.corporationId, forumPostsTable.id] }).onDelete("restrict"),
  index("forum_attachments_owner_idx").on(table.corporationId, table.ownerUserId, table.createdAt),
  index("forum_attachments_post_idx").on(table.corporationId, table.postId),
  check("forum_attachments_values_valid", sql`${table.size} BETWEEN 1 AND 5242880 AND length(${table.fileName}) BETWEEN 1 AND 180 AND ${table.mimeType} IN ('image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain') AND ((${table.deletedAt} IS NULL AND ${table.dataBase64} IS NOT NULL AND length(${table.dataBase64}) = 4 * ((${table.size} + 2) / 3)) OR (${table.deletedAt} IS NOT NULL AND ${table.dataBase64} IS NULL))`),
]);
