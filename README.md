## Installation

Requirements: Node.js >= 18.

Release assets should be published to GitHub Releases as:

- macOS/Linux: `phantm-<os>-<arch>.tar.gz` (os: `macos|linux`, arch: `x64|arm64`)
- Windows: `phantm-windows-<arch>.zip` (arch: `x64|arm64`)

### macOS / Linux (per-user, default)

```bash
curl -fsSL https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.sh | bash
```

System-wide install (e.g., /usr/local or /opt/homebrew):

```bash
curl -fsSL https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.sh | sudo bash -s -- --system
```

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.sh | bash -s -- --uninstall
```

### Windows (PowerShell)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.ps1 | iex"
```

System-wide install (requires elevated PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.ps1 -OutFile $env:TEMP/phantm-install.ps1; & $env:TEMP/phantm-install.ps1 -System"  # run in an admin shell
```

Uninstall:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.ps1 -OutFile $env:TEMP/phantm-install.ps1; & $env:TEMP/phantm-install.ps1 -Uninstall"
```

## Usage

After installation, configure your database environment and SQL template before creating schemas.

### 1. Environment Management

#### Configure Database Connection

Add a new database environment:

```bash
phantm configure <env-name>
```

Example:
```bash
phantm configure production
```

You'll be prompted to enter:
- Database host
- Database port
- Database name
- Database user
- Database password
- SSL enabled (yes/no)

#### List All Environments

View all configured environments:

```bash
phantm env list
```

#### Activate Environment

Switch between configured environments:

```bash
phantm env activate
```

#### Delete Environment

Remove a configured environment:

```bash
phantm env delete
```

#### Test Database Connection

Verify your database connection and setup:

```bash
phantm env check
```

### 2. SQL Template Configuration

Before creating schemas, you need to configure a SQL template file.

#### Set SQL Template

Configure a SQL template file for schema creation:

```bash
phantm use <path-to-sql-file>
```

Example:
```bash
phantm use ./schemas/base-schema.sql
```

The command will prompt you to pick an environment, validate the file, preview the schema, and save the path for that environment only.

#### View Template Info

Show current template configuration, schema info, and DDL for a chosen environment:

```bash
phantm info schema <schema-name>
phantm info template
phantm info ddl
```

#### Remove Template Configuration

Remove the configured template for a chosen environment:
```bash
phantm unuse
```

#### Validate Template

Validate the configured SQL template structure for a chosen environment:
```bash
phantm validate
```
You will be prompted to select the environment whose template should be validated.

#### Create Single Schema
Show current template configuration and details for a chosen environment:
Create a new schema with an auto-generated name:

```bash
phantm create
```

Create multiple schemas at once by specifying a count:

```bash
phantm create <count>
```

Example:
```bash
phantm create 10
```

Create with a custom name (single schema only, must start with "account_"):

```bash
phantm create --name account_mycustom
```

Force recreate if schema already exists (single schema only):

```bash
phantm create --force
```

Skip confirmation prompt:

```bash
phantm create --yes
```

Combine options (single schema only):

```bash
phantm create --name account_prod --force --yes
```

### 3. Seeding Schemas (NEW)

You can associate a folder of SQL seed files with each environment. Seed files are applied in order after schema creation, and you can re-run seeding at any time.

#### Configure Seed Folder

Set the seed folder when configuring your template:

```bash
phantm use <path-to-sql-file> --seed <seed-folder-path>
```

Example:
```bash
phantm use ./schemas/base-schema.sql --seed ./seeds
```

#### Seed File Naming

Seed files must be named with a numeric prefix for ordering:

```
seeds/
  1_roles.sql
  2_default_users.sql
  3_lookup_data.sql
```

You can use `{{SCHEMA_NAME}}` in your SQL to reference the target schema.

#### Run Seeding

Seed a single schema:
```bash
phantm seed <schema-name>
```

Seed all AVAILABLE schemas:
```bash
phantm seed --all-available
```

Seed all AVAILABLE and ALLOCATED schemas:
```bash
phantm seed --all
```

Skip confirmation prompt:
```bash
phantm seed <schema-name> -y
```

Show seed status/configuration:
```bash
phantm info seed [schema-name]
```

Reset seed tracking (for development):
```bash
phantm seed:reset <schema-name>
```

#### Auto-seed on Create (NEW)

You can automatically run seeding after schema creation by adding the `--seed` flag:

```bash
phantm create --seed
phantm create 5 --seed
phantm create --name account_demo --seed
```

Each schema will be seeded immediately after creation. In bulk mode, seeding failures for one schema do not block the rest.

### 4. Apply Arbitrary SQL Across Schemas

You can run a SQL file against every schema in `common.schema_pool` with status `AVAILABLE` or `ALLOCATED`.

The command supports SQL that uses `{{SCHEMA_NAME}}`, and it also sets `search_path` to the target schema so unqualified SQL can work too.

Run a SQL file with per-schema confirmation:

```bash
phantm apply --sql ./ack.sql
```

Skip the per-schema confirmation prompts:

```bash
phantm apply --sql ./ack.sql --yes
```

Behavior:
- Prompts for an environment if no active environment is set
- Verifies database connectivity and `common.schema_pool`
- Shows each target schema's name and status before execution
- Runs the SQL in a transaction per schema
- On failure, rolls back that schema and asks whether to continue
- Prints an apply summary with applied, skipped, and failed counts

### 5. CSV Data Import (NEW)

Import CSV data into existing schemas using this folder structure:

```text
<import-root>/
  account_xxxxxxxx/
    table_a.csv
    table_b.csv
  account_yyyyyyyy/
    table_a.csv
    table_b.csv
```

- Folder name is treated as schema name.
- CSV filename (without `.csv`) is treated as table name.
- CSV header row is treated as the column list.

Run import (provide either `--order` or `--auto-order-from`):

```bash
phantm import <import-data-folder-path> --order <table1,table2,...>
```

Example:

```bash
phantm import ./data --order suppliers,products,components,component_material
```

Auto-generate FK-safe table order from an existing schema:

```bash
phantm import ./data --auto-order-from account_fgwzgd0u
```

Choose import mode:

```bash
phantm import ./data --order suppliers,products,components --mode append
phantm import ./data --order suppliers,products,components --mode truncate
phantm import ./data --order suppliers,products,components --mode upsert
```

Run validation only (no writes):

```bash
phantm import ./data --order suppliers,products,components --dry-run
```

Run DB cast precheck (no writes, executes inserts then rolls back):

```bash
phantm import ./data --order suppliers,products,components --precheck-db-casts
```

Continue to next account when one account fails:

```bash
phantm import ./data --order suppliers,products,components,component_material --rollback-and-contiue
```

Filter accounts or resume from a specific account:

```bash
phantm import ./data --order suppliers,products --only-account account_fgwzgd0u
phantm import ./data --order suppliers,products --from-account account_gntg0wt
```

Skip account-wise confirmations:

```bash
phantm import ./data --order suppliers,products --yes
```

Write a JSON report:

```bash
phantm import ./data --order suppliers,products --report ./artifacts/import-report.json
```

Resume only failed accounts from a previous report:

```bash
phantm import ./data --order suppliers,products --resume-failed-from-report ./artifacts/import-report.json
```

Enable strict validation rules:

```bash
phantm import ./data --order suppliers,products --strict-columns --validate-not-null --strict-types --null-string NULL
```

Enable coercion rules for common empty-value mismatches:

```bash
phantm import ./data --order suppliers,products --empty-as-null --numeric-empty-as-null --json-empty-as-null --enum-empty-as-null --trim-values
```

Coerce integer-like decimals for integer columns:

```bash
phantm import ./data --order suppliers,products,components --coerce-integer-decimals
```

Enable automatic sanitization for problematic control chars/JSON escapes:

```bash
phantm import ./data --order suppliers,products --auto-sanitize
```

Set FK-safe table order:

```bash
phantm import ./data --order suppliers,products,components,component_material
```

During import, the CLI shows account-wise metadata + table preview (headers and first row), and asks for yes/y approval before importing each account (unless `--yes` is used).

For the new advanced features, the CLI also shows what it is going to do and asks for approval before proceeding:
- Resume scope confirmation (`--from-account`, `--only-account`, `--resume-failed-from-report`)
- Validation/coercion rule confirmation (`--strict-columns`, `--validate-not-null`, `--strict-types`, `--null-string`, `--empty-as-null`, `--json-empty-as-null`, `--enum-empty-as-null`, `--numeric-empty-as-null`, `--trim-values`, `--auto-sanitize`, `--coerce-integer-decimals`)
- FK order confirmation (`--auto-order-from`)
- DB cast precheck confirmation (`--precheck-db-casts`)

Each account import runs in a single transaction:
- If any table fails for that account, all imported tables for that account are rolled back.
- By default, import stops at the first failed account after rollback.
- With `--rollback-and-contiue` (or `-r`), failed accounts are rolled back and skipped, and import continues with remaining accounts.

Mode behavior:
- `append`: inserts rows as-is.
- `truncate`: truncates selected tables first (in reverse order), then inserts.
- `upsert`: inserts or updates by primary key (requires PK columns in CSV).
- `--precheck-db-casts`: attempts real DB inserts/casts in a transaction and always rolls back on success (useful to catch JSON/enum/numeric mismatch before real import).

Table selection behavior:
- With `--order`, only listed tables are imported. CSV files for tables not listed are ignored.
- Missing CSV files for tables listed in `--order` are ignored for that account.
- With `--auto-order-from`, all CSV tables in scope are ordered automatically and imported.
- If a selected table does not exist in the target schema, that table import fails (and account rollback behavior applies).
- `--strict-columns` fails when CSV columns and table insertable columns differ.
- `--validate-not-null` fails when required NOT NULL columns are missing/empty.
- `--strict-types` validates common PostgreSQL types before import.
- `--empty-as-null` converts empty strings to NULL for all column types.
- `--json-empty-as-null` converts empty strings to NULL for JSON/JSONB columns.
- `--enum-empty-as-null` converts empty strings to NULL for enum columns.
- `--numeric-empty-as-null` converts empty strings to NULL for numeric columns.
- `--trim-values` trims surrounding whitespace before validation/import.
- `--auto-sanitize` sanitizes problematic control characters and common JSON control unicode escapes (e.g. `\u0096`) before validation/import.
- `--coerce-integer-decimals` converts integer-like decimals (e.g. `1.0`, `5.000`) into integers for integer columns.

### 5. Schema Management

#### List All Schemas

List all schemas in the pool:

```bash
phantm list
```

Filter by status:

```bash
phantm list --status AVAILABLE
phantm list --status ALLOCATED
phantm list --status DELETED
```

#### Get Schema Information

Get detailed information about a specific schema:

```bash
phantm info schema <schema-name>
```

Example:
```bash
phantm info account_abc12345
```

#### Delete Schemas

Delete a single schema (drops from DB, marks as DELETED in pool, deletes DynamoDB table):

```bash
phantm delete <schema-name>
```

Delete all AVAILABLE schemas at once:

```bash
phantm delete --all-available
```

Skip confirmation prompts:

```bash
phantm delete <schema-name> -y
phantm delete --all-available -y
```

> **Note:** The delete command performs a soft-delete — schemas are marked as `DELETED` in the `schema_pool` table rather than being removed entirely. If AWS credentials are configured, the associated DynamoDB table is also deleted.

### 6. Iterative Full Cleanup (NEW)

`cleanup` is an iterative, per-schema destructive flow designed for full account cleanup.

For each `account_*` schema found in the database, it will:
- Load related records from `common.schema_pool`, `common.accounts`, and `common.users`
- Show key details (including names/emails and timestamps formatted in `+05:30` timezone)
- Discover matching DynamoDB tables by account code (`prep-data` and `event_data` patterns)
- Resolve Cognito users by `sub` (mapped from `common.users.subject_id`)
- Ask for confirmation before cleanup of that schema

If confirmed, it will:
- Drop the schema
- Delete related rows from `common.users`, `common.accounts`, and `common.schema_pool`
- Delete discovered DynamoDB tables
- Delete discovered Cognito users

If declined, it skips that schema and continues to the next one.

Run interactive iterative cleanup:

```bash
phantm cleanup
```

Cleanup all discovered schemas without per-schema prompt:

```bash
phantm cleanup --yes
```

Start iteration from a specific schema (inclusive):

```bash
phantm cleanup --from account_fgwzgd0u
```

Process only one schema:

```bash
phantm cleanup --only account_fgwzgd0u
```

Skip specific schemas during cleanup:

```bash
phantm cleanup --except account_keep1 account_keep2
phantm cleanup --except account_keep1,account_keep2
```

Dry-run full discovery (no deletes), auto-iterate all schemas, and write CSV report:

```bash
phantm cleanup --dry-run
```

Dry-run with custom CSV output path:

```bash
phantm cleanup --dry-run --csv ./artifacts/cleanup-report.csv
```

> **Cognito requirement:** set `cognitoUserPoolId` in environment config (or `AWS_COGNITO_USER_POOL_ID`) to enable Cognito discovery/deletion. You can also store `cognitoAppClientId` during `phantm configure` for future Cognito workflows.

## Quick Start Example

```bash
# 1. Configure database
phantm configure production

# 2. Test connection
phantm env check

# 3. Set up SQL template
phantm use ./my-schema.sql

# 4. Validate template
phantm validate

# 5. Create a schema
phantm create

# 6. List all schemas
phantm list
```

## AWS DynamoDB Integration

The migration CLI integrates with AWS DynamoDB to create auxiliary data tables alongside your PostgreSQL schemas. When you create a schema, it can create these DynamoDB tables:

- `prep-data`: `${environment}-prep-data-${accountCode}`
- `event_data`: `${environment}-event_data_${accountCode}`

### Configure AWS Credentials

When configuring an environment, you'll be prompted to optionally add AWS credentials:

```bash
phantm configure <env-name>
```

After entering database details, you'll be asked:
- Do you want to configure AWS credentials? (yes/no)
- If yes:
  - AWS Access Key ID
  - AWS Secret Access Key
  - AWS Region (default: us-east-1)

### Integrated Schema + DynamoDB Creation

When creating a schema, if AWS is configured, a DynamoDB table is automatically created for the schema:

```bash
phantm create
```

The workflow:
1. Schema is created (e.g., `account_ps97wn2h`)
2. Record is inserted into `schema_pool` table
3. If AWS is configured, two DynamoDB tables are created in on-demand mode:
   - `${environment}-prep-data-${accountCode}`
     - Example: `dev-prep-data-ps97wn2h`
     - Partition key: `product_id` (String)
   - `${environment}-event_data_${accountCode}`
     - Example: `dev-event_data_ps97wn2h`
     - Partition key: `source_id` (String)
     - Sort key: `entity` (String)

### DynamoDB Tables

List all tables in the configured region:

```bash
phantm dynamodb:list-tables
```

Preview missing managed tables for every `account_*` schema in the active environment:

```bash
phantm dynamodb:ensure-tables
```

Create any missing managed tables in on-demand mode:

```bash
phantm dynamodb:ensure-tables --apply
```

Skip the confirmation prompt when creating:

```bash
phantm dynamodb:ensure-tables --apply -y
```

`dynamodb:ensure-tables`:

- Scans all PostgreSQL schemas matching `account_*`
- Derives the exact expected table names for each schema
- Checks whether these tables exist:
  - `${environment}-prep-data-${accountCode}`
  - `${environment}-event_data_${accountCode}`
- Runs in dry-run mode by default and only creates missing tables when `--apply` is used
- Creates missing tables with `PAY_PER_REQUEST` billing

Preview orphaned managed DynamoDB tables that no longer have a matching `account_*` schema:

```bash
phantm dynamodb:cleanup-unused
```

Delete the orphaned tables:

```bash
phantm dynamodb:cleanup-unused --delete
```

Skip the confirmation prompt when deleting:

```bash
phantm dynamodb:cleanup-unused --delete -y
```

`dynamodb:cleanup-unused`:

- Runs in dry-run mode by default and only deletes when `--delete` is used
- Scans PostgreSQL schemas matching `account_*` directly from the database
- Preserves the full schema suffix when deriving account code
- Example: `account_abcdef_mecca` maps to account code `abcdef_mecca`
- Only considers exact managed table shapes for the selected environment:
  - `${environment}-prep-data-${accountCode}`
  - `${environment}-event_data_${accountCode}`
  - legacy `${environment}-event_data-${accountCode}`
- Deletes orphaned tables one by one and continues even if one deletion fails

Preview managed tables that would be converted to on-demand billing for the active environment:

```bash
phantm dynamodb:convert-on-demand
```

Apply the conversion:

```bash
phantm dynamodb:convert-on-demand --apply
```

Skip the confirmation prompt when applying:

```bash
phantm dynamodb:convert-on-demand --apply -y
```

`dynamodb:convert-on-demand` only targets tables for the selected environment whose names start with:

- `${environment}-prep-data-`
- `${environment}-event_data_`

By default it runs in dry-run mode, shows each table's current billing mode, and reports what would be converted.

### Setup Guide

For detailed instructions on setting up AWS IAM users and configuring DynamoDB integration, see [AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md).

## Configuration Files

- Config location: `~/.phantm/config.json`
- Stores: database credentials, AWS credentials, active environment, and SQL template path
