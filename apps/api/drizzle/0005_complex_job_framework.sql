CREATE TABLE IF NOT EXISTS "public"."dq_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"severity" varchar(16) NOT NULL,
	"code" varchar(64) NOT NULL,
	"source_id" bigint,
	"row_no" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_by" bigint,
	"resolved_at" timestamp,
	"resolution_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dq_event_severity_check" CHECK ("public"."dq_event"."severity" IN ('block', 'warn', 'allow'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."job_run" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"module_code" varchar(64) NOT NULL,
	"scope_key" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"input_batch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_checkpoint_step" varchar(64),
	"started_at" timestamp,
	"heartbeat_at" timestamp,
	"finished_at" timestamp,
	"triggered_by" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_run_status_check" CHECK ("public"."job_run"."status" IN ('queued', 'running', 'recon_pending', 'gated', 'published', 'failed', 'rolled_back'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."job_step" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"step_key" varchar(64) NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"rows_in" integer,
	"rows_out" integer,
	"error_code" varchar(64),
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_step_run_id_step_key_attempt_key" UNIQUE("run_id","step_key","attempt"),
	CONSTRAINT "job_step_status_check" CHECK ("public"."job_step"."status" IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "job_step_attempt_check" CHECK ("public"."job_step"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."publish_version" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"module_code" varchar(64) NOT NULL,
	"scope_key" varchar(128) NOT NULL,
	"version_no" integer NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"published_by" bigint,
	"published_at" timestamp,
	"superseded_by" bigint,
	"source_run_id" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "publish_version_module_scope_version_key" UNIQUE("module_code","scope_key","version_no"),
	CONSTRAINT "publish_version_status_check" CHECK ("public"."publish_version"."status" IN ('draft', 'validated', 'published', 'superseded', 'rolled_back')),
	CONSTRAINT "publish_version_version_no_check" CHECK ("public"."publish_version"."version_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."recon_result" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"layer" varchar(64) NOT NULL,
	"metric" varchar(128) NOT NULL,
	"expected" numeric(24, 6),
	"actual" numeric(24, 6),
	"tolerance" numeric(24, 6),
	"passed" boolean DEFAULT false NOT NULL,
	"evidence_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recon_result_run_id_layer_metric_key" UNIQUE("run_id","layer","metric")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."dq_event" ADD CONSTRAINT "dq_event_run_id_job_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."dq_event" ADD CONSTRAINT "dq_event_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."dq_event" ADD CONSTRAINT "dq_event_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."job_run" ADD CONSTRAINT "job_run_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."job_step" ADD CONSTRAINT "job_step_run_id_job_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."publish_version" ADD CONSTRAINT "publish_version_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."publish_version" ADD CONSTRAINT "publish_version_source_run_id_job_run_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."recon_result" ADD CONSTRAINT "recon_result_run_id_job_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dq_event_run_severity" ON "public"."dq_event" USING btree ("run_id","severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dq_event_code" ON "public"."dq_event" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dq_event_unresolved" ON "public"."dq_event" USING btree ("run_id") WHERE "public"."dq_event"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_run_status_started_at" ON "public"."job_run" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_run_module_scope" ON "public"."job_run" USING btree ("module_code","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_publish_version_published_scope" ON "public"."publish_version" USING btree ("module_code","scope_key") WHERE "public"."publish_version"."status" = 'published';