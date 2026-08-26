-- `create schema if not exists` matters: the kernel creates `mod_inventory` before running these, so
-- the bare form fails on boot. Every table and index is guarded the same way, so an interrupted
-- first boot can be retried rather than needing the schema dropped by hand.
--
-- `btree_gist` is what lets an exclusion constraint mix `uuid with =` and `tstzrange with &&`, which
-- is how `0001_rls.sql` makes two open custody periods for one asset impossible. Without it that
-- constraint fails with "data type uuid has no default operator class for access method gist" —
-- during the module's own migration, so the *service does not start*. Core creates four extensions
-- and this is not one of them; HR declares its own for the same reason.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "mod_inventory";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."asset_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"changes" jsonb,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"custodian_user_id" uuid,
	"custody_since" timestamp with time zone,
	"serial_number" text,
	"location" text,
	"purchased_on" date,
	"purchased_from" text,
	"price_minor" integer,
	"currency" char(3),
	"warranty_until" date,
	"photo_file_id" uuid,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"repair_id" uuid,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime_type" text,
	"size" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."counters" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "counters_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."custody_periods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"note" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."field_defs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"category_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"options" jsonb,
	"default_value" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"searchable" boolean DEFAULT false NOT NULL,
	"show_in_list" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_inventory"."repairs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"detail" text,
	"vendor" text,
	"cost_minor" integer,
	"currency" char(3),
	"sent_on" date NOT NULL,
	"returned_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_asset_history_asset_idx" ON "mod_inventory"."asset_history" USING btree ("workspace_id","asset_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_assets_ws_code_uq" ON "mod_inventory"."assets" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_assets_ws_created_idx" ON "mod_inventory"."assets" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_assets_ws_status_idx" ON "mod_inventory"."assets" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_assets_ws_category_idx" ON "mod_inventory"."assets" USING btree ("workspace_id","category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_assets_ws_custodian_idx" ON "mod_inventory"."assets" USING btree ("workspace_id","custodian_user_id") WHERE custodian_user_id is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_assets_ws_warranty_idx" ON "mod_inventory"."assets" USING btree ("workspace_id","warranty_until") WHERE warranty_until is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_attachments_asset_file_uq" ON "mod_inventory"."attachments" USING btree ("asset_id","file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_attachments_ws_asset_idx" ON "mod_inventory"."attachments" USING btree ("workspace_id","asset_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_categories_ws_name_uq" ON "mod_inventory"."categories" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_categories_ws_idx" ON "mod_inventory"."categories" USING btree ("workspace_id","order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_custody_ws_asset_idx" ON "mod_inventory"."custody_periods" USING btree ("workspace_id","asset_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_field_defs_ws_key_uq" ON "mod_inventory"."field_defs" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_field_defs_ws_idx" ON "mod_inventory"."field_defs" USING btree ("workspace_id","order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_repairs_ws_asset_idx" ON "mod_inventory"."repairs" USING btree ("workspace_id","asset_id","sent_on");