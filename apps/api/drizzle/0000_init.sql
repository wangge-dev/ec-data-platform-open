CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" bigint,
	"status" varchar(16) DEFAULT 'running',
	"inputs" jsonb,
	"outputs" jsonb,
	"cost_cny" numeric(10, 4),
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"prompt_template" text NOT NULL,
	"model" varchar(32) DEFAULT 'deepseek-v4-flash',
	"config" jsonb,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "agents_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"module_code" varchar(64) NOT NULL,
	"rule_key" varchar(64) NOT NULL,
	"rule_label" varchar(256) NOT NULL,
	"severity" varchar(16) DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"triggered_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "charts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dataset_id" bigint,
	"name" varchar(128) NOT NULL,
	"chart_type" varchar(32) NOT NULL,
	"config" jsonb NOT NULL,
	"module_code" varchar(64),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dashboards" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_sources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"type" varchar(32) NOT NULL,
	"platform" varchar(32),
	"config" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'active',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "datasets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"source_id" bigint,
	"query_type" varchar(16) NOT NULL,
	"query_text" text,
	"fields" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_templates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" varchar(64) NOT NULL,
	"file_pattern" varchar(256) NOT NULL,
	"pattern_flags" varchar(8) DEFAULT 'i',
	"join_col" varchar(64) NOT NULL,
	"dict_key" varchar(8) DEFAULT 'id' NOT NULL,
	"amount_col" varchar(64) NOT NULL,
	"qty_col" varchar(64),
	"pay_time_col" varchar(64),
	"order_time_col" varchar(64),
	"main_order_col" varchar(64),
	"row_key_col" varchar(64),
	"enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "platform_templates_platform_unique" UNIQUE("platform")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unified_sales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" varchar(32) NOT NULL,
	"row_key" varchar(160) NOT NULL,
	"main_order_no" varchar(64),
	"product_id" varchar(128),
	"qty" numeric(14, 2),
	"amount" numeric(14, 2),
	"pay_time" timestamp,
	"order_month" varchar(8),
	"shop" varchar(128),
	"brand" varchar(64),
	"operator" varchar(64),
	"product_name" varchar(256),
	"category" varchar(128),
	"matched" boolean DEFAULT false,
	"source_file" varchar(256),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unified_shopee_sales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" varchar(32) NOT NULL,
	"row_key" varchar(160) NOT NULL,
	"main_order_no" varchar(64),
	"product_id" varchar(128),
	"qty" numeric(14, 2),
	"amount" numeric(14, 2),
	"pay_time" timestamp,
	"order_month" varchar(8),
	"shop" varchar(128),
	"brand" varchar(64),
	"operator" varchar(64),
	"product_name" varchar(256),
	"category" varchar(128),
	"matched" boolean DEFAULT false,
	"source_file" varchar(256),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" varchar(128) NOT NULL,
	"display_name" varchar(64),
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "charts" ADD CONSTRAINT "charts_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "datasets" ADD CONSTRAINT "datasets_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_unified_platform_rowkey" ON "unified_sales" USING btree ("platform","row_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_unified_shopee_platform_rowkey" ON "unified_shopee_sales" USING btree ("platform","row_key");