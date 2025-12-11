DROP SCHEMA IF EXISTS {{SCHEMA_NAME}} CASCADE;
CREATE SCHEMA {{SCHEMA_NAME}} AUTHORIZATION admin_user;

-- ENUM Types
CREATE TYPE {{SCHEMA_NAME}}."flexibility_enum" AS ENUM (
	'rigid',
	'soft');

CREATE TYPE {{SCHEMA_NAME}}."ink_type_enum" AS ENUM (
	'Water soluble',
	'Non-water soluble',
	'UV ink or coating',
	'Other',
	'Unsure');

CREATE TYPE {{SCHEMA_NAME}}."item_type_enum" AS ENUM (
	'Bottle',
	'Cap',
	'Foil',
	'Tray');

CREATE TYPE {{SCHEMA_NAME}}."packaging_type" AS ENUM (
	'PP',
	'SP',
	'TP');

CREATE TYPE {{SCHEMA_NAME}}."size_unit_enum" AS ENUM (
	'mm',
	'cm',
	'm');

CREATE TYPE {{SCHEMA_NAME}}."thickness_unit_enum" AS ENUM (
	'μm',
	'mm');

CREATE TYPE {{SCHEMA_NAME}}."upload_type" AS ENUM (
	'manual',
	'bulk_upload',
	'ai',
	'import');

CREATE TYPE {{SCHEMA_NAME}}."volume_unit_enum" AS ENUM (
	'mL',
	'g');

CREATE TYPE {{SCHEMA_NAME}}."weight_unit_enum" AS ENUM (
	'mg',
	'g',
	'kg',
	'tonne',
	't');

-- Tables
CREATE TABLE {{SCHEMA_NAME}}.daily_material_aggregate (
	sold_at varchar(50) NOT NULL,
	material_id uuid NOT NULL,
	unit varchar(5) NULL,
	mass float8 NOT NULL,
	created_at timestamp NULL,
	updated_at timestamp NULL,
	CONSTRAINT daily_material_aggregate_pk PRIMARY KEY (sold_at, material_id)
);

ALTER TABLE {{SCHEMA_NAME}}.daily_material_aggregate OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.daily_material_aggregate TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.flyway_schema_history (
	installed_rank int4 NOT NULL,
	"version" varchar(50) NULL,
	description varchar(200) NOT NULL,
	"type" varchar(20) NOT NULL,
	script varchar(1000) NOT NULL,
	checksum int4 NULL,
	installed_by varchar(100) NOT NULL,
	installed_on timestamp DEFAULT now() NOT NULL,
	execution_time int4 NOT NULL,
	success bool NOT NULL,
	CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank)
);

CREATE INDEX flyway_schema_history_s_idx ON {{SCHEMA_NAME}}.flyway_schema_history USING btree (success);

ALTER TABLE {{SCHEMA_NAME}}.flyway_schema_history OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.flyway_schema_history TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.packaging_line (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	product_id uuid NOT NULL,
	"packaging_type" {{SCHEMA_NAME}}."packaging_type" NULL,
	quantity numeric DEFAULT 0 NULL,
	"version" varchar(10) DEFAULT 'v1'::character varying NULL,
	image jsonb NULL,
	calculated_values jsonb NULL,
	vendor_meta_data jsonb NULL,
	created_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	CONSTRAINT packaging_line_pkey PRIMARY KEY (id),
	CONSTRAINT packaging_line_product_packaging_unique UNIQUE (product_id, packaging_type)
);

ALTER TABLE {{SCHEMA_NAME}}.packaging_line OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.packaging_line TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.product_groups (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	parent_id uuid NULL,
	"name" varchar(255) NOT NULL,
	created_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	CONSTRAINT product_groups_pkey PRIMARY KEY (id)
);

ALTER TABLE {{SCHEMA_NAME}}.product_groups OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.product_groups TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.products (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	sku varchar(100) NULL,
	"name" varchar(255) NOT NULL,
	variant varchar(100) NULL,
	brand varchar(100) NULL,
	url varchar(255) NULL,
	description varchar(255) NULL,
	pack_volume numeric(10, 3) NULL,
	pack_volume_unit {{SCHEMA_NAME}}."volume_unit_enum" NULL,
	pack_weight_unit {{SCHEMA_NAME}}."weight_unit_enum" NULL,
	"upload_type" {{SCHEMA_NAME}}."upload_type" NULL,
	mfr_region varchar(50) NULL,
	eol_region varchar(50) NULL,
	calculated_values jsonb NULL,
	vendor_meta_data jsonb NULL,
	created_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	"comments" varchar NULL,
	prep_enabled BOOLEAN DEFAULT False,
	CONSTRAINT products_pkey PRIMARY KEY (id)
);

ALTER TABLE {{SCHEMA_NAME}}.products OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.products TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.attachments (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	product_id uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(100) NULL,
	link text NULL,
	created_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	CONSTRAINT attachments_pkey PRIMARY KEY (id),
	CONSTRAINT fk_attachments_product FOREIGN KEY (product_id) REFERENCES {{SCHEMA_NAME}}.products(id) ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE {{SCHEMA_NAME}}.attachments OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.attachments TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.folders (
	id uuid NOT NULL,
	owner_user_id varchar(255) NOT NULL,
	parent_folder_id uuid NULL,
	"name" varchar(255) NOT NULL,
	"path" text NOT NULL,
	"depth" int4 DEFAULT 0 NULL,
	starred bool DEFAULT false NULL,
	is_shared bool DEFAULT false NULL,
	tags _text NULL,
	created_at timestamp DEFAULT now() NULL,
	updated_at timestamp NULL,
	deleted_at timestamp NULL,
	CONSTRAINT folders_pkey PRIMARY KEY (id),
	CONSTRAINT folders_parent_folder_id_fkey FOREIGN KEY (parent_folder_id) REFERENCES {{SCHEMA_NAME}}.folders(id) ON DELETE CASCADE
);

CREATE INDEX idx_folders_deleted ON {{SCHEMA_NAME}}.folders USING btree (deleted_at);
CREATE INDEX idx_folders_owner ON {{SCHEMA_NAME}}.folders USING btree (owner_user_id);
CREATE INDEX idx_folders_parent ON {{SCHEMA_NAME}}.folders USING btree (parent_folder_id);
CREATE INDEX idx_folders_path ON {{SCHEMA_NAME}}.folders USING btree (path);

ALTER TABLE {{SCHEMA_NAME}}.folders OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.folders TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.product_group_members (
	product_id uuid NOT NULL,
	group_id uuid NOT NULL,
	created_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	CONSTRAINT pk_product_group_member PRIMARY KEY (product_id, group_id),
	CONSTRAINT fk_group_members_product FOREIGN KEY (product_id) REFERENCES {{SCHEMA_NAME}}.products(id) ON DELETE CASCADE,
	CONSTRAINT fk_product_group_member_product FOREIGN KEY (product_id) REFERENCES {{SCHEMA_NAME}}.products(id) ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT fk_product_group_member_product_group FOREIGN KEY (group_id) REFERENCES {{SCHEMA_NAME}}.product_groups(id) ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE {{SCHEMA_NAME}}.product_group_members OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.product_group_members TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.quantities (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	product_id uuid NOT NULL,
	quantity numeric(10, 2) DEFAULT 0 NULL,
	quantity_accuracy int4 NULL,
	metadata jsonb DEFAULT '{}'::jsonb NULL,
	created_at timestamptz DEFAULT now() NULL,
	updated_at timestamptz DEFAULT now() NULL,
	CONSTRAINT quantities_pkey PRIMARY KEY (id),
	CONSTRAINT uk_quantities_product_id UNIQUE (product_id),
	CONSTRAINT fk_product_quantity_product FOREIGN KEY (product_id) REFERENCES {{SCHEMA_NAME}}.products(id) ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE {{SCHEMA_NAME}}.quantities OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.quantities TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.files (
	id uuid NOT NULL,
	owner_user_id varchar(255) NOT NULL,
	folder_id uuid NULL,
	original_name varchar(500) NOT NULL,
	mime_type varchar(255) NOT NULL,
	size_bytes int8 NULL,
	bucket varchar(255) NOT NULL,
	s3_key text NOT NULL,
	file_hash varchar(255) NULL,
	status varchar(20) DEFAULT 'UPLOADED'::character varying NOT NULL,
	starred bool DEFAULT false NULL,
	pinned bool DEFAULT false NULL,
	tags _text NULL,
	is_shared bool DEFAULT false NULL,
	version_id uuid NULL,
	will_expire_at timestamp NULL,
	created_at timestamp DEFAULT now() NULL,
	updated_at timestamp NULL,
	last_accessed_at timestamp NULL,
	deleted_at timestamp NULL,
	CONSTRAINT files_pkey PRIMARY KEY (id),
	CONSTRAINT files_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES {{SCHEMA_NAME}}.folders(id)
);

CREATE INDEX idx_files_created_at ON {{SCHEMA_NAME}}.files USING btree (created_at DESC);
CREATE INDEX idx_files_deleted ON {{SCHEMA_NAME}}.files USING btree (deleted_at);
CREATE INDEX idx_files_folder ON {{SCHEMA_NAME}}.files USING btree (folder_id);
CREATE INDEX idx_files_owner ON {{SCHEMA_NAME}}.files USING btree (owner_user_id);
CREATE INDEX idx_files_starred ON {{SCHEMA_NAME}}.files USING btree (starred) WHERE (starred = true);

ALTER TABLE {{SCHEMA_NAME}}.files OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.files TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.file_activities (
	id uuid NOT NULL,
	file_id uuid NULL,
	user_id varchar(255) NOT NULL,
	event_type varchar(40) NOT NULL,
	event_time timestamp DEFAULT now() NULL,
	details jsonb NULL,
	context text NULL,
	CONSTRAINT file_activities_pkey PRIMARY KEY (id),
	CONSTRAINT file_activities_file_id_fkey FOREIGN KEY (file_id) REFERENCES {{SCHEMA_NAME}}.files(id) ON DELETE CASCADE
);

CREATE INDEX idx_file_activities_event_type ON {{SCHEMA_NAME}}.file_activities USING btree (event_type);
CREATE INDEX idx_file_activities_file ON {{SCHEMA_NAME}}.file_activities USING btree (file_id);
CREATE INDEX idx_file_activities_time ON {{SCHEMA_NAME}}.file_activities USING btree (event_time DESC);
CREATE INDEX idx_file_activities_user ON {{SCHEMA_NAME}}.file_activities USING btree (user_id);

ALTER TABLE {{SCHEMA_NAME}}.file_activities OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.file_activities TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.component_material (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	component_id uuid NOT NULL,
	material_id uuid NOT NULL,
	material_accuracy numeric(5, 3) NULL,
	mass numeric(10, 3) NULL,
	mass_unit {{SCHEMA_NAME}}."weight_unit_enum" NULL,
	mass_accuracy numeric(5, 3) NULL,
	certification _text NULL,
	recycled_content jsonb NULL,
	vendor_meta_data jsonb NULL,
	prep_data jsonb NULL,
	prep_errors JSONB NULL,
	apco_material_id uuid NULL,
	created_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	CONSTRAINT component_material_pkey PRIMARY KEY (id)
);

ALTER TABLE {{SCHEMA_NAME}}.component_material OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.component_material TO admin_user;

CREATE TABLE {{SCHEMA_NAME}}.components (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	code varchar(20) NULL,
	packaging_id uuid NOT NULL,
	supplier_id uuid NULL,
	is_composite bool DEFAULT false NULL,
	"name" text NULL,
	items int4 NULL,
	calculated_values jsonb NULL,
	mass_per_item numeric(10, 3) NULL,
	mass_unit {{SCHEMA_NAME}}."weight_unit_enum" NULL,
	mass_accuracy numeric(5, 3) NULL,
	is_recycled bool DEFAULT false NULL,
	is_reusable bool DEFAULT false NULL,
	prep_data jsonb NULL,
	vendor_meta_data jsonb NULL,
	prep_errors JSONB NULL,
	created_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	mfr_region varchar(50) NULL,
	mass_unit_1 varchar(50) NULL,
	CONSTRAINT components_pkey PRIMARY KEY (id)
);

ALTER TABLE {{SCHEMA_NAME}}.components OWNER TO admin_user;
GRANT ALL ON TABLE {{SCHEMA_NAME}}.components TO admin_user;

-- Foreign Key Constraints
ALTER TABLE {{SCHEMA_NAME}}.component_material ADD CONSTRAINT fk_component_material_component FOREIGN KEY (component_id) REFERENCES {{SCHEMA_NAME}}.components(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE {{SCHEMA_NAME}}.components ADD CONSTRAINT fk_component_product FOREIGN KEY (packaging_id) REFERENCES {{SCHEMA_NAME}}.packaging_line(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE {{SCHEMA_NAME}}.components ADD CONSTRAINT fk_component_supplier FOREIGN KEY (supplier_id) REFERENCES common.suppliers(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- Grant schema permissions
GRANT ALL ON SCHEMA {{SCHEMA_NAME}} TO admin_user;
