CREATE TABLE IF NOT EXISTS "public"."front_profit_cost_period" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"source_row_no" integer NOT NULL,
	"period" varchar(7) NOT NULL,
	"sku_key" varchar(128) NOT NULL,
	"cost_kind" varchar(32) DEFAULT 'product_cost' NOT NULL,
	"effective_from" varchar(10) NOT NULL,
	"effective_to" varchar(10) NOT NULL,
	"unit_cost" numeric(24, 6) NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"row_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fp_cost_period_run_sku_kind_from" UNIQUE("run_id","sku_key","cost_kind","effective_from"),
	CONSTRAINT "fp_cost_source_row_no_check" CHECK ("public"."front_profit_cost_period"."source_row_no" >= 1),
	CONSTRAINT "fp_cost_period_check" CHECK ("public"."front_profit_cost_period"."period" ~ '^\d{4}-\d{2}$'),
	CONSTRAINT "fp_cost_effective_from_check" CHECK ("public"."front_profit_cost_period"."effective_from" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "fp_cost_effective_to_check" CHECK ("public"."front_profit_cost_period"."effective_to" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "fp_cost_effective_range_check" CHECK ("public"."front_profit_cost_period"."effective_to" >= "public"."front_profit_cost_period"."effective_from"),
	CONSTRAINT "fp_cost_kind_check" CHECK ("public"."front_profit_cost_period"."cost_kind" IN ('product_cost')),
	CONSTRAINT "fp_cost_currency_check" CHECK ("public"."front_profit_cost_period"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."front_profit_fee_fact" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"source_row_no" integer NOT NULL,
	"period" varchar(7) NOT NULL,
	"fee_kind" varchar(32) NOT NULL,
	"authority_source" varchar(32) NOT NULL,
	"authority_priority" integer NOT NULL,
	"fee_key" varchar(160) NOT NULL,
	"event_date" varchar(10) NOT NULL,
	"platform" varchar(64),
	"shop" varchar(128),
	"operator_key" varchar(128),
	"sku_key" varchar(128),
	"ad_account_key" varchar(128),
	"amount" numeric(24, 6) NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"row_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fp_fee_fact_run_fee_source_key" UNIQUE("run_id","fee_kind","authority_source","fee_key"),
	CONSTRAINT "fp_fee_source_row_no_check" CHECK ("public"."front_profit_fee_fact"."source_row_no" >= 1),
	CONSTRAINT "fp_fee_period_check" CHECK ("public"."front_profit_fee_fact"."period" ~ '^\d{4}-\d{2}$'),
	CONSTRAINT "fp_fee_event_date_check" CHECK ("public"."front_profit_fee_fact"."event_date" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "fp_fee_currency_check" CHECK ("public"."front_profit_fee_fact"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "fp_fee_kind_check" CHECK ("public"."front_profit_fee_fact"."fee_kind" IN ('platform_fee', 'tax_fee', 'finance_cost', 'freight', 'commission', 'promotion_fee')),
	CONSTRAINT "fp_fee_authority_source_check" CHECK ("public"."front_profit_fee_fact"."authority_source" IN ('settlement', 'platform_bill', 'rate_rule', 'manual_estimate')),
	CONSTRAINT "fp_fee_authority_priority_check" CHECK ("public"."front_profit_fee_fact"."authority_priority" BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."front_profit_operator_assignment" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"source_row_no" integer NOT NULL,
	"period" varchar(7) NOT NULL,
	"shop" varchar(128) NOT NULL,
	"authority_key_type" varchar(32) NOT NULL,
	"authority_key" varchar(160) NOT NULL,
	"operator" varchar(128) NOT NULL,
	"effective_from" varchar(10) NOT NULL,
	"effective_to" varchar(10) NOT NULL,
	"row_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fp_operator_assignment_run_key" UNIQUE("run_id","shop","authority_key_type","authority_key","effective_from"),
	CONSTRAINT "fp_operator_source_row_no_check" CHECK ("public"."front_profit_operator_assignment"."source_row_no" >= 1),
	CONSTRAINT "fp_operator_period_check" CHECK ("public"."front_profit_operator_assignment"."period" ~ '^\d{4}-\d{2}$'),
	CONSTRAINT "fp_operator_effective_from_check" CHECK ("public"."front_profit_operator_assignment"."effective_from" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "fp_operator_effective_to_check" CHECK ("public"."front_profit_operator_assignment"."effective_to" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "fp_operator_effective_range_check" CHECK ("public"."front_profit_operator_assignment"."effective_to" >= "public"."front_profit_operator_assignment"."effective_from"),
	CONSTRAINT "fp_operator_authority_key_type_check" CHECK ("public"."front_profit_operator_assignment"."authority_key_type" IN ('sku', 'ad_account', 'product_owner', 'order_owner', 'manual_mapping')),
	CONSTRAINT "fp_operator_authority_key_check" CHECK (length(trim("public"."front_profit_operator_assignment"."authority_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."front_profit_rebate_fact" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"source_row_no" integer NOT NULL,
	"period" varchar(7) NOT NULL,
	"rebate_key" varchar(160) NOT NULL,
	"rebate_event_date" varchar(10) NOT NULL,
	"platform" varchar(64),
	"shop" varchar(128),
	"operator_key" varchar(128),
	"sku_key" varchar(128),
	"order_key" varchar(160),
	"fill_order_amount" numeric(24, 6) NOT NULL,
	"fill_order_product_cost" numeric(24, 6) NOT NULL,
	"fill_order_quantity" numeric(24, 6) NOT NULL,
	"row_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fp_rebate_fact_run_rebate_key" UNIQUE("run_id","rebate_key"),
	CONSTRAINT "fp_rebate_source_row_no_check" CHECK ("public"."front_profit_rebate_fact"."source_row_no" >= 1),
	CONSTRAINT "fp_rebate_period_check" CHECK ("public"."front_profit_rebate_fact"."period" ~ '^\d{4}-\d{2}$'),
	CONSTRAINT "fp_rebate_event_date_check" CHECK ("public"."front_profit_rebate_fact"."rebate_event_date" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_cost_period" ADD CONSTRAINT "fp_cost_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_cost_period" ADD CONSTRAINT "fp_cost_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_fee_fact" ADD CONSTRAINT "fp_fee_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_fee_fact" ADD CONSTRAINT "fp_fee_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_operator_assignment" ADD CONSTRAINT "fp_operator_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_operator_assignment" ADD CONSTRAINT "fp_operator_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_rebate_fact" ADD CONSTRAINT "fp_rebate_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."front_profit_rebate_fact" ADD CONSTRAINT "fp_rebate_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_cost_period_run_period" ON "public"."front_profit_cost_period" USING btree ("run_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_cost_period_source_id" ON "public"."front_profit_cost_period" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_cost_period_sku_key" ON "public"."front_profit_cost_period" USING btree ("sku_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_fee_fact_run_period_kind" ON "public"."front_profit_fee_fact" USING btree ("run_id","period","fee_kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_fee_fact_source_id" ON "public"."front_profit_fee_fact" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_fee_fact_sku_key" ON "public"."front_profit_fee_fact" USING btree ("sku_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_operator_assignment_run_period" ON "public"."front_profit_operator_assignment" USING btree ("run_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_operator_assignment_source_id" ON "public"."front_profit_operator_assignment" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_rebate_fact_run_period" ON "public"."front_profit_rebate_fact" USING btree ("run_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_rebate_fact_source_id" ON "public"."front_profit_rebate_fact" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fp_rebate_fact_sku_key" ON "public"."front_profit_rebate_fact" USING btree ("sku_key");