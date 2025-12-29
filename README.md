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

The command will:
- Validate the file path
- Analyze the SQL structure
- Show a preview of types, tables, and indexes
- Save the path to your config

#### View Template Info

Show current template configuration and details:

```bash
phantm ddl info
```

#### Remove Template Configuration

Remove the configured template:

```bash
phantm unuse
```
#### Validate Template

Validate the configured SQL template structure:

```bash
phantm validate
```

### 3. Schema Creation

#### Create Single Schema

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
phantm info <schema-name>
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

## Configuration Files

- Config location: `~/.phantm/config.json`
- Stores: database credentials, active environment, and SQL template path