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

### 4. Schema Management

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

The migration CLI integrates with AWS DynamoDB to create auxiliary data tables alongside your PostgreSQL schemas. When you create a schema, you can optionally create a corresponding DynamoDB table with the naming format: `${environment}-prep-data-${accountCode}`.

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
3. If AWS is configured, a DynamoDB table is created with format: `${environment}-prep-data-${accountCode}`
   - Example: `dev-prep-data-ps97wn2h`
   - Partition key: `product_id` (String)
   - Attributes available: `prep_project` (for JSON data), `created_at` (timestamp)

### DynamoDB Tables

List all tables in the configured region:

```bash
phantm dynamodb:list-tables
```

### Setup Guide

For detailed instructions on setting up AWS IAM users and configuring DynamoDB integration, see [AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md).

## Configuration Files

- Config location: `~/.phantm/config.json`
- Stores: database credentials, AWS credentials, active environment, and SQL template path
