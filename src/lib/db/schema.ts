import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

import type {
  Point,
  ProviderReceipt,
  Regions,
  RunInputSnapshot,
  VersionSourceMetadata,
} from "../contracts/domain";

export const ASSET_KINDS = [
  "original",
  "canonical",
  "reference",
  "selection_mask",
  "allowed_mask",
  "blend_mask",
  "raw",
  "final",
] as const;

export const VERSION_ORIGINS = ["upload", "sample", "generate", "edit"] as const;
export const RUN_KINDS = ["generate", "segment", "edit"] as const;
export const EXECUTION_MODES = ["live", "mock", "fixture"] as const;
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "needs_review"] as const;
export const USAGE_OUTCOMES = ["pending", "completed", "rejected", "unknown"] as const;
export const COST_PROVENANCES = ["provider", "calculated", "estimated", "unavailable"] as const;

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  rootVersionId: text("root_version_id"),
  activeVersionId: text("active_version_id"),
  budgetLimitUsdMicros: integer("budget_limit_usd_micros").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ASSET_KINDS }).notNull(),
    relativePath: text("relative_path").notNull(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("assets_project_created_idx").on(table.projectId, table.createdAt, table.id),
    uniqueIndex("assets_project_path_unique").on(table.projectId, table.relativePath),
  ],
);

export const versions = sqliteTable(
  "versions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentVersionId: text("parent_version_id").references((): AnySQLiteColumn => versions.id),
    imageAssetId: text("image_asset_id")
      .notNull()
      .references(() => assets.id),
    origin: text("origin", { enum: VERSION_ORIGINS }).notNull(),
    originalAssetId: text("original_asset_id").references(() => assets.id),
    sourceMetadataJson: text("source_metadata_json", { mode: "json" }).$type<VersionSourceMetadata | null>(),
    originatingRunId: text("originating_run_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("versions_project_created_idx").on(table.projectId, table.createdAt, table.id),
    uniqueIndex("versions_one_root_per_project")
      .on(table.projectId)
      .where(sql`${table.parentVersionId} is null`),
    uniqueIndex("versions_origin_run_unique")
      .on(table.originatingRunId)
      .where(sql`${table.originatingRunId} is not null`),
  ],
);

export const selections = sqliteTable(
  "selections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceVersionId: text("source_version_id")
      .notNull()
      .references(() => versions.id),
    originatingRunId: text("originating_run_id").notNull(),
    positivePointsJson: text("positive_points_json", { mode: "json" }).$type<Point[]>().notNull(),
    negativePointsJson: text("negative_points_json", { mode: "json" }).$type<Point[]>().notNull(),
    binaryMaskAssetId: text("binary_mask_asset_id")
      .notNull()
      .references(() => assets.id),
    regionsJson: text("regions_json", { mode: "json" }).$type<Regions>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("selections_project_source_created_idx").on(
      table.projectId,
      table.sourceVersionId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("selections_origin_run_unique")
      .on(table.originatingRunId)
      .where(sql`${table.originatingRunId} is not null`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RUN_KINDS }).notNull(),
    executionMode: text("execution_mode", { enum: EXECUTION_MODES }).notNull(),
    comparisonGroupId: text("comparison_group_id"),
    retryOfRunId: text("retry_of_run_id")
      .references((): AnySQLiteColumn => runs.id)
      .unique(),
    parentVersionId: text("parent_version_id").references(() => versions.id),
    inputSelectionId: text("input_selection_id").references(() => selections.id),
    model: text("model").notNull(),
    inputSnapshotJson: text("input_snapshot_json", { mode: "json" })
      .$type<RunInputSnapshot>()
      .notNull(),
    commonInputHash: text("common_input_hash"),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    stage: text("stage").notNull(),
    reservedUsdMicros: integer("reserved_usd_micros").notNull(),
    budgetChargeUsdMicros: integer("budget_charge_usd_micros").notNull(),
    rawAssetId: text("raw_asset_id").references(() => assets.id),
    normalizedRawAssetId: text("normalized_raw_asset_id").references(() => assets.id),
    outputSelectionId: text("output_selection_id"),
    outputVersionId: text("output_version_id"),
    providerReceiptJson: text("provider_receipt_json", { mode: "json" }).$type<ProviderReceipt | null>(),
    metricsJson: text("metrics_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    evaluationJson: text("evaluation_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    providerStartedAt: integer("provider_started_at"),
    providerFinishedAt: integer("provider_finished_at"),
    finishedAt: integer("finished_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("runs_status_created_idx").on(table.status, table.createdAt, table.id),
    index("runs_project_created_idx").on(table.projectId, table.createdAt, table.id),
    index("runs_comparison_model_created_idx").on(
      table.comparisonGroupId,
      table.model,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("runs_one_active_generation_per_project")
      .on(table.projectId)
      .where(sql`${table.kind} = 'generate' and ${table.status} in ('queued', 'running')`),
  ],
);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .unique()
      .references(() => runs.id),
    operation: text("operation", { enum: RUN_KINDS }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    executionMode: text("execution_mode", { enum: EXECUTION_MODES }).notNull(),
    outcome: text("outcome", { enum: USAGE_OUTCOMES }).notNull(),
    amountUsdMicros: integer("amount_usd_micros"),
    costProvenance: text("cost_provenance", { enum: COST_PROVENANCES }).notNull(),
    pricingVersion: text("pricing_version").notNull(),
    pricingSourceSnapshotJson: text("pricing_source_snapshot_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    usageJson: text("usage_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    providerRequestId: text("provider_request_id"),
    elapsedMs: integer("elapsed_ms"),
    createdAt: integer("created_at").notNull(),
    settledAt: integer("settled_at"),
  },
  (table) => [index("usage_events_project_created_idx").on(table.projectId, table.createdAt, table.id)],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseJson: text("response_json", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idempotency_project_key_unique").on(table.projectId, table.key)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type VersionRow = typeof versions.$inferSelect;
export type SelectionRow = typeof selections.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
