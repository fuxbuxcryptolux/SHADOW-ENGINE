import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appSettingsTable = pgTable("app_settings", {
  key:       text("key").primaryKey(),
  value:     text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AppSetting = typeof appSettingsTable.$inferSelect;
