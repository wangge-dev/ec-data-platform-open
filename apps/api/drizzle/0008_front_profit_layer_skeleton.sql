CREATE TABLE IF NOT EXISTS "public"."front_profit_l1_source_row" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"source_row_no" integer NOT NULL,
	"period" varchar(7) NOT NULL,
	"source_family" varchar(32) NOT NULL,
	"source_record_key" varchar(160) NOT NULL,
	"event_date" varchar(10) NOT NULL,
	"platform" varchar(64),
	"shop" varchar(128),
	"operator_key" varchar(128),
	"sku_key" varchar(128),
	"amount_kind" varchar(64) NOT NULL,
	"amount_value" numeric(24, 6),
	"quantity" numeric(24, 6),
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"row_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fp_l1_source_row_run_record_kind_key" UNIQUE("run_id","source_family","source_record_key","amount_kind"),
	CONSTRAINT "fp_l1_source_row_no_check" CHECK ("public"."front_profit_l1_source_row"."source_row_no" >= 1),
	CONSTRAINT "fp_l1_period_check" CHECK ("public"."front_profit_l1_source_row"."period" ~ '^\d{4}-\d{2}$'),
	CONSTRAINT "fp_l1_event_date_check" CHECK ("public"."front_profit_l1_source_row"."event_date" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "fp_l1_currency_check" CHECK ("public"."front_profit_l1_source_row"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."front_profit_l3_calc_detail" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"detail_key" varchar(160) NOT NULL,
	"l1_source_row_id" bigint,
	"source_id" bigint,
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
	"calculation_role" varchar(64) NOT NULL,
	"mapping_version_id" bigint,
	"rule_version" varchar(64) NOT NULL,
	"job_version" varchar(64) NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"gmv" numeric(24, 6) NOT NULL,
	"fill_order_amount" numeric(24, 6) NOT NULL,
	"fill_order_product_cost" numeric(24, 6) NOT NULL,
	"fill_order_quantity" numeric(24, 6) NOT NULL,
	"product_cost" numeric(24, 6) NOT NULL,
	"shipment_value" numeric(24, 6) NOT NULL,
	"platform_fee" numeric(24, 6) NOT NULL,
	"tax_fee" numeric(24, 6) NOT NULL,
	"finance_cost" numeric(24, 6) NOT NULL,
	"freight" numeric(24, 6) NOT NULL,
	"commission" numeric(24, 6) NOT NULL,
	"promotion_fee" numeric(24, 6) NOT NULL,
	"lineage_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fp_l3_calc_detail_run_detail_key" UNIQUE("run_id","detail_key"),
	CONSTRAINT "fp_l3_period_check" CHECK ("public"."front_profit_l3_calc_detail"."period" ~ '^\d{4}-\d{2}$'),
	CONSTRAINT "fp_l3_date_check" CHECK ("public"."front_profit_l3_calc_detail"."date" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."front_profit_l4_agg_row" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"publish_version_id" bigint,
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
	"quantity" numeric(24, 6) NOT NULL,
	"gmv" numeric(24, 6) NOT NULL,
	"fill_order_amount" numeric(24, 6) NOT NULL,
	"fill_order_product_cost" numeric(24, 6) NOT NULL,
	"fill_order_quantity" numeric(24, 6) NOT NULL,
	"product_cost" numeric(24, 6) NOT NULL,
	"shipment_value" numeric(24, 6) NOT NULL,
	"platform_fee" numeric(24, 6) NOT NULL,
	"tax_fee" numeric(24, 6) NOT NULL,
	"finance_cost" numeric(24, 6) NOT NULL,
	"freight" numeric(24, 6) NOT NULL,
	"commission" numeric(24, 6) NOT NULL,
	"promotion_fee" numeric(24, 6) NOT NULL,
	"source_file" varchar(256),
	"source_batch" varchar(128),
	"note" text,
	"real_revenue" numeric(24, 6) NOT NULL,
	"front_profit" numeric(24, 6) NOT NULL,
	"paid_ratio" numeric(24, 8) NOT NULL,
	"data_status" varchar(128),
	"row_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fp_l4_agg_row_run_record_key" UNIQUE("run_id","record_id"),
	CONSTRAINT "fp_l4_agg_row_run_aggregation_key" UNIQUE("run_id","aggregation_key"),
	CONSTRAINT "fp_l4_period_check" CHECK ("public"."front_profit_l4_agg_row"."period" ~ '^\d{4}-\d{2}$'),
	CONSTRAINT "fp_l4_date_check" CHECK ("public"."front_profit_l4_agg_row"."date" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_l1_source_row" ADD CONSTRAINT "fp_l1_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_l1_source_row" ADD CONSTRAINT "fp_l1_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_l3_calc_detail" ADD CONSTRAINT "fp_l3_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_l3_calc_detail" ADD CONSTRAINT "fp_l3_l1_row_fk" FOREIGN KEY ("l1_source_row_id") REFERENCES "public"."front_profit_l1_source_row"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_l3_calc_detail" ADD CONSTRAINT "fp_l3_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_l4_agg_row" ADD CONSTRAINT "fp_l4_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_l4_agg_row" ADD CONSTRAINT "fp_l4_publish_version_fk" FOREIGN KEY ("publish_version_id") REFERENCES "public"."publish_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l1_source_row_run_period" ON "public"."front_profit_l1_source_row" USING btree ("run_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l1_source_row_source_id" ON "public"."front_profit_l1_source_row" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l1_source_row_period_family" ON "public"."front_profit_l1_source_row" USING btree ("period","source_family");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l3_calc_detail_run_aggregation" ON "public"."front_profit_l3_calc_detail" USING btree ("run_id","aggregation_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l3_calc_detail_run_record" ON "public"."front_profit_l3_calc_detail" USING btree ("run_id","record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l3_calc_detail_l1_row" ON "public"."front_profit_l3_calc_detail" USING btree ("l1_source_row_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l3_calc_detail_source_id" ON "public"."front_profit_l3_calc_detail" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l4_agg_row_run_period" ON "public"."front_profit_l4_agg_row" USING btree ("run_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_l4_agg_row_publish_version" ON "public"."front_profit_l4_agg_row" USING btree ("publish_version_id");