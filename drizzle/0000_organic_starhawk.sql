CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assets_project_created_idx` ON `assets` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_project_path_unique` ON `assets` (`project_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`operation` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_project_key_unique` ON `idempotency_keys` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`root_version_id` text,
	`active_version_id` text,
	`budget_limit_usd_micros` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`execution_mode` text NOT NULL,
	`comparison_group_id` text,
	`retry_of_run_id` text,
	`parent_version_id` text,
	`input_selection_id` text,
	`model` text NOT NULL,
	`input_snapshot_json` text NOT NULL,
	`common_input_hash` text,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`reserved_usd_micros` integer NOT NULL,
	`budget_charge_usd_micros` integer NOT NULL,
	`raw_asset_id` text,
	`normalized_raw_asset_id` text,
	`output_selection_id` text,
	`output_version_id` text,
	`provider_receipt_json` text,
	`metrics_json` text,
	`evaluation_json` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`provider_started_at` integer,
	`provider_finished_at` integer,
	`finished_at` integer,
	`error_code` text,
	`error_message` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`retry_of_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`input_selection_id`) REFERENCES `selections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`normalized_raw_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_retry_of_run_id_unique` ON `runs` (`retry_of_run_id`);--> statement-breakpoint
CREATE INDEX `runs_status_created_idx` ON `runs` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `runs_project_created_idx` ON `runs` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `runs_comparison_model_created_idx` ON `runs` (`comparison_group_id`,`model`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `selections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_version_id` text NOT NULL,
	`originating_run_id` text NOT NULL,
	`positive_points_json` text NOT NULL,
	`negative_points_json` text NOT NULL,
	`binary_mask_asset_id` text NOT NULL,
	`regions_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`binary_mask_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `selections_project_source_created_idx` ON `selections` (`project_id`,`source_version_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `selections_origin_run_unique` ON `selections` (`originating_run_id`) WHERE "selections"."originating_run_id" is not null;--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`operation` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`execution_mode` text NOT NULL,
	`outcome` text NOT NULL,
	`amount_usd_micros` integer,
	`cost_provenance` text NOT NULL,
	`pricing_version` text NOT NULL,
	`pricing_source_snapshot_json` text NOT NULL,
	`usage_json` text,
	`provider_request_id` text,
	`elapsed_ms` integer,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_run_id_unique` ON `usage_events` (`run_id`);--> statement-breakpoint
CREATE INDEX `usage_events_project_created_idx` ON `usage_events` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_version_id` text,
	`image_asset_id` text NOT NULL,
	`origin` text NOT NULL,
	`original_asset_id` text,
	`source_metadata_json` text,
	`originating_run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `versions_project_created_idx` ON `versions` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `versions_one_root_per_project` ON `versions` (`project_id`) WHERE "versions"."parent_version_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `versions_origin_run_unique` ON `versions` (`originating_run_id`) WHERE "versions"."originating_run_id" is not null;