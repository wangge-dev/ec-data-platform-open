CREATE TABLE IF NOT EXISTS "public"."front_profit_publish_row" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publish_version_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"period" varchar(7) NOT NULL,
	"record_id" varchar(128) NOT NULL,
	"aggregation_key" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"platform" varchar(64) NOT NULL,
	"business_mode" varchar(32) NOT NULL,
	"group_name" varchar(128),
	"shop" varchar(128) NOT NULL,
	"shop_normalized" varchar(128),
	"operator" varchar(128) NOT NULL,
	"quantity" numeric(24, 6),
	"gmv" numeric(24, 6),
	"fill_order_amount" numeric(24, 6),
	"fill_order_product_cost" numeric(24, 6),
	"fill_order_quantity" numeric(24, 6),
	"product_cost" numeric(24, 6),
	"shipment_value" numeric(24, 6),
	"platform_fee" numeric(24, 6),
	"tax_fee" numeric(24, 6),
	"finance_cost" numeric(24, 6),
	"freight" numeric(24, 6),
	"commission" numeric(24, 6),
	"promotion_fee" numeric(24, 6),
	"source_file" varchar(256),
	"source_batch" varchar(128),
	"note" text,
	"real_revenue" numeric(24, 6),
	"front_profit" numeric(24, 6),
	"paid_ratio" numeric(24, 8),
	"row_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "front_profit_publish_row_version_record_id_key" UNIQUE("publish_version_id","record_id"),
	CONSTRAINT "front_profit_publish_row_version_aggregation_key" UNIQUE("publish_version_id","aggregation_key"),
	CONSTRAINT "front_profit_publish_row_status_check" CHECK ("public"."front_profit_publish_row"."status" IN ('draft', 'published', 'superseded', 'rolled_back'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."publish_version_source" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publish_version_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"source_run_id" bigint,
	"input_batch_id" varchar(128),
	"role" varchar(32) DEFAULT 'input' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "publish_version_source_version_source_role_key" UNIQUE("publish_version_id","source_id","role"),
	CONSTRAINT "publish_version_source_role_check" CHECK ("public"."publish_version_source"."role" IN ('input', 'manual_baseline', 'adjustment'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_publish_row" ADD CONSTRAINT "fp_publish_row_version_fk" FOREIGN KEY ("publish_version_id") REFERENCES "public"."publish_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."publish_version_source" ADD CONSTRAINT "publish_version_source_publish_version_id_publish_version_id_fk" FOREIGN KEY ("publish_version_id") REFERENCES "public"."publish_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."publish_version_source" ADD CONSTRAINT "publish_version_source_source_run_id_job_run_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_front_profit_publish_row_published_period_key" ON "public"."front_profit_publish_row" USING btree ("period","aggregation_key") WHERE "public"."front_profit_publish_row"."status" = 'published';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_front_profit_publish_row_version_id" ON "public"."front_profit_publish_row" USING btree ("publish_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_front_profit_publish_row_source_id" ON "public"."front_profit_publish_row" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_front_profit_publish_row_period_status" ON "public"."front_profit_publish_row" USING btree ("period","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_publish_version_source_version_id" ON "public"."publish_version_source" USING btree ("publish_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_publish_version_source_source_id" ON "public"."publish_version_source" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_publish_version_source_run_id" ON "public"."publish_version_source" USING btree ("source_run_id");
