import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as defiSchema from "./schema/defi.js";
import * as walletSchema from "./schema/wallets.js";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL env var is required");

const client = postgres(connectionString, { max: 10 });
export const db = drizzle(client, { schema: { ...defiSchema, ...walletSchema } });

export * from "./schema/defi.js";
export * from "./schema/wallets.js";
