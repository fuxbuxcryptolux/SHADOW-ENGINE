import { pgTable, text, serial, real, timestamp } from "drizzle-orm/pg-core";

export const activityTable = pgTable("activity", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(), // 'claimed' | 'dismissed'
  opportunityTitle: text("opportunity_title").notNull(),
  opportunityType: text("opportunity_type").notNull(),
  actualValue: real("actual_value"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export type Activity = typeof activityTable.$inferSelect;
