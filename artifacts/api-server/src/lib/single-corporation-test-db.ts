/** Test-only esbuild replacement for @workspace/db; never uses DATABASE_URL. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

export * from "../../../../lib/db/src/schema/index";
export const pg = new PGlite();
export const db = drizzle(pg);
