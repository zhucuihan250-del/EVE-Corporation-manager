import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

export const announcementsTable = pgTable("announcements", {
  id: serial("id").primaryKey(),
  fc: text("fc").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  rallyPoint: text("rally_point").notNull(),
  rallyLevel: text("rally_level").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Announcement = typeof announcementsTable.$inferSelect;
