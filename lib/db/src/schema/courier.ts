import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export const courierAgentsTable = pgTable("courier_agents", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id")
    .notNull()
    .references(() => corporationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("courier_agents_corporation_user_unique").on(table.corporationId, table.userId),
  uniqueIndex("courier_agents_corporation_id_unique").on(table.corporationId, table.id),
]);

export const courierRoutesTable = pgTable("courier_routes", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id")
    .notNull()
    .references(() => corporationsTable.id, { onDelete: "cascade" }),
  courierAgentId: integer("courier_agent_id")
    .notNull()
    .references(() => courierAgentsTable.id, { onDelete: "restrict" }),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  pricingMethod: text("pricing_method", {
    enum: ["fixed", "volume", "collateral", "volume_collateral"],
  }).notNull(),
  baseFee: doublePrecision("base_fee").notNull().default(0),
  pricePerM3: doublePrecision("price_per_m3").notNull().default(0),
  collateralRate: doublePrecision("collateral_rate").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  index("courier_routes_corporation_active_idx").on(table.corporationId, table.isActive),
  index("courier_routes_corporation_agent_idx").on(table.corporationId, table.courierAgentId),
  uniqueIndex("courier_routes_corporation_id_unique").on(table.corporationId, table.id),
  foreignKey({
    columns: [table.corporationId, table.courierAgentId],
    foreignColumns: [courierAgentsTable.corporationId, courierAgentsTable.id],
    name: "courier_routes_corporation_agent_fk",
  }).onDelete("restrict"),
]);

export const courierOrdersTable = pgTable("courier_orders", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id")
    .notNull()
    .references(() => corporationsTable.id, { onDelete: "cascade" }),
  routeId: integer("route_id")
    .notNull()
    .references(() => courierRoutesTable.id, { onDelete: "restrict" }),
  courierAgentId: integer("courier_agent_id")
    .notNull()
    .references(() => courierAgentsTable.id, { onDelete: "restrict" }),
  submittedBy: integer("submitted_by").references(() => usersTable.id, { onDelete: "set null" }),
  submitterName: text("submitter_name").notNull(),
  courierName: text("courier_name").notNull(),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  pricingMethod: text("pricing_method", {
    enum: ["fixed", "volume", "collateral", "volume_collateral"],
  }).notNull(),
  baseFee: doublePrecision("base_fee").notNull(),
  pricePerM3: doublePrecision("price_per_m3").notNull(),
  collateralRate: doublePrecision("collateral_rate").notNull(),
  volumeM3: doublePrecision("volume_m3").notNull(),
  collateral: doublePrecision("collateral").notNull(),
  calculatedFee: doublePrecision("calculated_fee").notNull(),
  note: text("note"),
  internalNotes: text("internal_notes"),
  status: text("status", {
    enum: ["submitted", "accepted", "in_transit", "completed", "rejected", "cancelled"],
  }).notNull().default("submitted"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  index("courier_orders_corporation_submitter_idx").on(table.corporationId, table.submittedBy),
  index("courier_orders_corporation_agent_idx").on(table.corporationId, table.courierAgentId),
  index("courier_orders_corporation_status_idx").on(table.corporationId, table.status),
  foreignKey({
    columns: [table.corporationId, table.routeId],
    foreignColumns: [courierRoutesTable.corporationId, courierRoutesTable.id],
    name: "courier_orders_corporation_route_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.corporationId, table.courierAgentId],
    foreignColumns: [courierAgentsTable.corporationId, courierAgentsTable.id],
    name: "courier_orders_corporation_agent_fk",
  }).onDelete("restrict"),
]);

export type CourierAgent = typeof courierAgentsTable.$inferSelect;
export type CourierRoute = typeof courierRoutesTable.$inferSelect;
export type CourierOrder = typeof courierOrdersTable.$inferSelect;
