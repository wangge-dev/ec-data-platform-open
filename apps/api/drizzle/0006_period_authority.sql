CREATE TABLE IF NOT EXISTS "public"."period_authority" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"module_code" varchar(64) NOT NULL,
	"scope_key" varchar(128) NOT NULL,
	"authority" varchar(16) DEFAULT 'manual' NOT NULL,
	"close_day" integer DEFAULT 5 NOT NULL,
	"reopened_by" bigint,
	"reopened_at" timestamp,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "period_authority_module_scope_key" UNIQUE("module_code","scope_key"),
	CONSTRAINT "period_authority_authority_check" CHECK ("public"."period_authority"."authority" IN ('manual', 'auto')),
	CONSTRAINT "period_authority_close_day_check" CHECK ("public"."period_authority"."close_day" BETWEEN 1 AND 28)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."period_authority_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"module_code" varchar(64) NOT NULL,
	"scope_key" varchar(128) NOT NULL,
	"action" varchar(32) NOT NULL,
	"from_authority" varchar(16),
	"to_authority" varchar(16),
	"actor_id" bigint,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "period_authority_event_action_check" CHECK ("public"."period_authority_event"."action" IN ('initialized', 'set_authority', 'reopen_period')),
	CONSTRAINT "period_authority_event_from_authority_check" CHECK ("public"."period_authority_event"."from_authority" IS NULL OR "public"."period_authority_event"."from_authority" IN ('manual', 'auto')),
	CONSTRAINT "period_authority_event_to_authority_check" CHECK ("public"."period_authority_event"."to_authority" IS NULL OR "public"."period_authority_event"."to_authority" IN ('manual', 'auto'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."period_authority" ADD CONSTRAINT "period_authority_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."period_authority" ADD CONSTRAINT "period_authority_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."period_authority" ADD CONSTRAINT "period_authority_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public"."period_authority_event" ADD CONSTRAINT "period_authority_event_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_period_authority_module_authority" ON "public"."period_authority" USING btree ("module_code","authority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_period_authority_event_module_scope_created" ON "public"."period_authority_event" USING btree ("module_code","scope_key","created_at");