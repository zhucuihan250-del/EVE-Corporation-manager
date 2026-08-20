import type { PoolClient } from "pg";

export const papMarketMigration = {
  id: "0021_pap_market",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "users"
        ALTER COLUMN "total_pap" TYPE double precision USING "total_pap"::double precision,
        ALTER COLUMN "redeemable_pap" TYPE double precision USING "redeemable_pap"::double precision,
        ADD COLUMN "locked_pap" double precision NOT NULL DEFAULT 0,
        ADD CONSTRAINT "users_locked_pap_nonnegative" CHECK ("locked_pap" >= 0),
        ADD CONSTRAINT "users_locked_pap_within_balance" CHECK ("locked_pap" <= "redeemable_pap");

      ALTER TABLE "pap_records"
        ALTER COLUMN "amount" TYPE double precision USING "amount"::double precision;

      CREATE TABLE "pap_market_orders" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "owner_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "owner_name" text NOT NULL,
        "type" text NOT NULL CHECK ("type" IN ('buy', 'sell')),
        "original_amount" double precision NOT NULL CHECK ("original_amount" > 0),
        "remaining_amount" double precision NOT NULL CHECK ("remaining_amount" >= 0),
        "matched_amount" double precision NOT NULL DEFAULT 0 CHECK ("matched_amount" >= 0),
        "locked_pap_amount" double precision NOT NULL DEFAULT 0 CHECK ("locked_pap_amount" >= 0),
        "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'partially_filled', 'filled', 'cancelled', 'expired')),
        "client_request_id" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "cancelled_at" timestamptz,
        "expires_at" timestamptz,
        CONSTRAINT "pap_market_orders_amounts_valid" CHECK (ABS(("remaining_amount" + "matched_amount") - "original_amount") < 0.000001),
        CONSTRAINT "pap_market_orders_lock_valid" CHECK ("locked_pap_amount" <= "remaining_amount")
      );
      CREATE UNIQUE INDEX "pap_market_orders_corporation_id_unique" ON "pap_market_orders" ("corporation_id", "id");
      CREATE UNIQUE INDEX "pap_market_orders_request_unique" ON "pap_market_orders" ("corporation_id", "owner_id", "client_request_id");
      CREATE INDEX "pap_market_orders_book_idx" ON "pap_market_orders" ("corporation_id", "type", "status", "created_at");
      CREATE INDEX "pap_market_orders_owner_idx" ON "pap_market_orders" ("corporation_id", "owner_id", "created_at");

      CREATE TABLE "pap_market_transactions" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "order_id" integer NOT NULL REFERENCES "pap_market_orders"("id") ON DELETE RESTRICT,
        "order_type" text NOT NULL CHECK ("order_type" IN ('buy', 'sell')),
        "buyer_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "buyer_name" text NOT NULL,
        "seller_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "seller_name" text NOT NULL,
        "pap_amount" double precision NOT NULL CHECK ("pap_amount" > 0),
        "isk_value" bigint NOT NULL CHECK ("isk_value" > 0),
        "status" text NOT NULL DEFAULT 'pending_admin' CHECK ("status" IN ('pending_admin', 'completed', 'rejected', 'disputed', 'cancelled')),
        "request_id" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "reviewed_at" timestamptz,
        "reviewed_by" integer REFERENCES "users"("id") ON DELETE RESTRICT,
        "admin_note" text,
        CONSTRAINT "pap_market_transactions_parties_different" CHECK ("buyer_id" <> "seller_id"),
        CONSTRAINT "pap_market_transactions_corporation_order_fk"
          FOREIGN KEY ("corporation_id", "order_id")
          REFERENCES "pap_market_orders"("corporation_id", "id") ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX "pap_market_transactions_corporation_id_unique" ON "pap_market_transactions" ("corporation_id", "id");
      CREATE UNIQUE INDEX "pap_market_transactions_request_unique" ON "pap_market_transactions" ("corporation_id", "request_id");
      CREATE INDEX "pap_market_transactions_status_idx" ON "pap_market_transactions" ("corporation_id", "status", "created_at");
      CREATE INDEX "pap_market_transactions_buyer_idx" ON "pap_market_transactions" ("corporation_id", "buyer_id", "created_at");
      CREATE INDEX "pap_market_transactions_seller_idx" ON "pap_market_transactions" ("corporation_id", "seller_id", "created_at");

      CREATE TABLE "pap_ledger" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "user_name" text NOT NULL,
        "amount" double precision NOT NULL DEFAULT 0,
        "locked_delta" double precision NOT NULL DEFAULT 0,
        "type" text NOT NULL CHECK ("type" IN ('opening_balance', 'pap_earned', 'redemption', 'admin_adjustment', 'activity_deduction', 'account_merge', 'market_order_lock', 'market_order_unlock', 'market_transaction_lock', 'market_transaction_unlock', 'market_buy', 'market_sell', 'reversal')),
        "order_id" integer REFERENCES "pap_market_orders"("id") ON DELETE RESTRICT,
        "transaction_id" integer REFERENCES "pap_market_transactions"("id") ON DELETE RESTRICT,
        "balance_after" double precision NOT NULL CHECK ("balance_after" >= 0),
        "locked_after" double precision NOT NULL CHECK ("locked_after" >= 0),
        "available_after" double precision NOT NULL CHECK ("available_after" >= 0),
        "admin_id" integer REFERENCES "users"("id") ON DELETE RESTRICT,
        "reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pap_ledger_lock_within_balance" CHECK ("locked_after" <= "balance_after"),
        CONSTRAINT "pap_ledger_corporation_order_fk"
          FOREIGN KEY ("corporation_id", "order_id")
          REFERENCES "pap_market_orders"("corporation_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "pap_ledger_corporation_transaction_fk"
          FOREIGN KEY ("corporation_id", "transaction_id")
          REFERENCES "pap_market_transactions"("corporation_id", "id") ON DELETE RESTRICT
      );
      CREATE INDEX "pap_ledger_corporation_user_idx" ON "pap_ledger" ("corporation_id", "user_id", "created_at");
      CREATE INDEX "pap_ledger_corporation_transaction_idx" ON "pap_ledger" ("corporation_id", "transaction_id");

      CREATE TABLE "pap_market_admin_logs" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "admin_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "action" text NOT NULL CHECK ("action" IN ('approve', 'reject', 'dispute')),
        "transaction_id" integer NOT NULL REFERENCES "pap_market_transactions"("id") ON DELETE RESTRICT,
        "order_id" integer NOT NULL REFERENCES "pap_market_orders"("id") ON DELETE RESTRICT,
        "before_state" jsonb NOT NULL,
        "after_state" jsonb NOT NULL,
        "note" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pap_market_admin_logs_corporation_transaction_fk"
          FOREIGN KEY ("corporation_id", "transaction_id")
          REFERENCES "pap_market_transactions"("corporation_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "pap_market_admin_logs_corporation_order_fk"
          FOREIGN KEY ("corporation_id", "order_id")
          REFERENCES "pap_market_orders"("corporation_id", "id") ON DELETE RESTRICT
      );
      CREATE INDEX "pap_market_admin_logs_corporation_idx" ON "pap_market_admin_logs" ("corporation_id", "created_at");

      INSERT INTO "pap_ledger" (
        "corporation_id", "user_id", "user_name", "amount", "locked_delta", "type",
        "balance_after", "locked_after", "available_after", "reason"
      )
      SELECT
        u."corporation_id", u."id", COALESCE(NULLIF(u."eve_character_name", ''), 'User ' || u."id"), u."redeemable_pap", 0, 'opening_balance',
        u."redeemable_pap", 0, u."redeemable_pap", 'PAP Market opening balance'
      FROM "users" u
      WHERE u."corporation_id" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "corporation_memberships" cm
          WHERE cm."corporation_id" = u."corporation_id" AND cm."user_id" = u."id"
        );
    `);
  },
};
