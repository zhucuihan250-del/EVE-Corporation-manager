import type { PoolClient } from "pg";

export const courierModuleMigration = {
  id: "0014_courier_module",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "corporations"
        ADD COLUMN "courier_enabled" boolean NOT NULL DEFAULT false;
      UPDATE "corporations" SET "courier_enabled" = true WHERE "is_primary" = true;

      CREATE TABLE "courier_agents" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "name" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "courier_agents_corporation_user_unique"
        ON "courier_agents" ("corporation_id", "user_id");
      CREATE UNIQUE INDEX "courier_agents_corporation_id_unique"
        ON "courier_agents" ("corporation_id", "id");

      CREATE TABLE "courier_routes" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "courier_agent_id" integer NOT NULL REFERENCES "courier_agents"("id") ON DELETE RESTRICT,
        "origin" text NOT NULL,
        "destination" text NOT NULL,
        "pricing_method" text NOT NULL CHECK ("pricing_method" IN ('fixed', 'volume', 'collateral', 'volume_collateral')),
        "base_fee" double precision NOT NULL DEFAULT 0,
        "price_per_m3" double precision NOT NULL DEFAULT 0,
        "collateral_rate" double precision NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "courier_routes_corporation_active_idx"
        ON "courier_routes" ("corporation_id", "is_active");
      CREATE INDEX "courier_routes_corporation_agent_idx"
        ON "courier_routes" ("corporation_id", "courier_agent_id");
      CREATE UNIQUE INDEX "courier_routes_corporation_id_unique"
        ON "courier_routes" ("corporation_id", "id");
      ALTER TABLE "courier_routes" ADD CONSTRAINT "courier_routes_corporation_agent_fk"
        FOREIGN KEY ("corporation_id", "courier_agent_id")
        REFERENCES "courier_agents"("corporation_id", "id") ON DELETE RESTRICT;

      CREATE TABLE "courier_orders" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "route_id" integer NOT NULL REFERENCES "courier_routes"("id") ON DELETE RESTRICT,
        "courier_agent_id" integer NOT NULL REFERENCES "courier_agents"("id") ON DELETE RESTRICT,
        "submitted_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "submitter_name" text NOT NULL,
        "courier_name" text NOT NULL,
        "origin" text NOT NULL,
        "destination" text NOT NULL,
        "pricing_method" text NOT NULL CHECK ("pricing_method" IN ('fixed', 'volume', 'collateral', 'volume_collateral')),
        "base_fee" double precision NOT NULL,
        "price_per_m3" double precision NOT NULL,
        "collateral_rate" double precision NOT NULL,
        "volume_m3" double precision NOT NULL,
        "collateral" double precision NOT NULL,
        "calculated_fee" double precision NOT NULL,
        "note" text,
        "internal_notes" text,
        "status" text NOT NULL DEFAULT 'submitted' CHECK ("status" IN ('submitted', 'accepted', 'in_transit', 'completed', 'rejected', 'cancelled')),
        "accepted_at" timestamptz,
        "completed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "courier_orders_corporation_submitter_idx"
        ON "courier_orders" ("corporation_id", "submitted_by");
      CREATE INDEX "courier_orders_corporation_agent_idx"
        ON "courier_orders" ("corporation_id", "courier_agent_id");
      CREATE INDEX "courier_orders_corporation_status_idx"
        ON "courier_orders" ("corporation_id", "status");
      ALTER TABLE "courier_orders" ADD CONSTRAINT "courier_orders_corporation_route_fk"
        FOREIGN KEY ("corporation_id", "route_id")
        REFERENCES "courier_routes"("corporation_id", "id") ON DELETE RESTRICT;
      ALTER TABLE "courier_orders" ADD CONSTRAINT "courier_orders_corporation_agent_fk"
        FOREIGN KEY ("corporation_id", "courier_agent_id")
        REFERENCES "courier_agents"("corporation_id", "id") ON DELETE RESTRICT;
    `);
  },
};
