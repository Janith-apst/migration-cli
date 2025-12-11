## Installation

Requirements: Node.js >= 18.

Release assets should be published to GitHub Releases as:

- macOS/Linux: `migration-cli-<os>-<arch>.tar.gz` (os: `macos|linux`, arch: `x64|arm64`)
- Windows: `migration-cli-windows-<arch>.zip` (arch: `x64|arm64`)

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
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.ps1 -OutFile $env:TEMP/migration-cli-install.ps1; & $env:TEMP/migration-cli-install.ps1 -System"  # run in an admin shell
```

Uninstall:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Janith-apst/migration-cli/main/scripts/install.ps1 -OutFile $env:TEMP/migration-cli-install.ps1; & $env:TEMP/migration-cli-install.ps1 -Uninstall"
```

## Usage

After installation, configure your database environment and SQL template before creating schemas.

### 1. Environment Management

#### Configure Database Connection

Add a new database environment:

```bash
migration-cli configure <env-name>
```

Example:
```bash
migration-cli configure production
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
migration-cli list-env
```

#### Activate Environment

Switch between configured environments:

```bash
migration-cli activate-env
```

#### Delete Environment

Remove a configured environment:

```bash
migration-cli delete-env
```

#### Test Database Connection

Verify your database connection and setup:

```bash
migration-cli test-connection
```

### 2. SQL Template Configuration

Before creating schemas, you need to configure a SQL template file.

#### Set SQL Template

Configure a SQL template file for schema creation:

```bash
migration-cli use <path-to-sql-file>
```

Example:
```bash
migration-cli use ./schemas/base-schema.sql
```

The command will:
- Validate the file path
- Analyze the SQL structure
- Show a preview of types, tables, and indexes
- Save the path to your config

#### View Template Info

Show current template configuration and details:

```bash
migration-cli ddl info
```

#### Remove Template Configuration

Remove the configured template:

```bash
migration-cli unuse
```
#### Validate Template

Validate the configured SQL template structure:

```bash
migration-cli validate
```

### 3. Schema Creation

#### Create Single Schema

Create a new schema with an auto-generated name:

```bash
migration-cli create
```

Create with a custom name (must start with "account_"):

```bash
migration-cli create --name account_mycustom
```

Force recreate if schema already exists:

```bash
migration-cli create --force
```

Skip confirmation prompt:

```bash
migration-cli create --yes
```

Combine options:

```bash
migration-cli create --name account_prod --force --yes
```

#### Create Multiple Schemas

Create multiple schemas at once:

```bash
migration-cli create-bulk <count>
```

Example:
```bash
migration-cli create-bulk 10
```

Skip confirmation:
```bash
migration-cli create-bulk 5 --yes
```

### 4. Schema Management

#### List All Schemas

List all schemas in the pool:

```bash
migration-cli list
```

Filter by status:

```bash
migration-cli list --status AVAILABLE
migration-cli list --status ALLOCATED
migration-cli list --status DELETED
```

#### Get Schema Information

Get detailed information about a specific schema:

```bash
migration-cli info <schema-name>
```

Example:
```bash
migration-cli info account_abc12345
```

## Quick Start Example

```bash
# 1. Configure database
migration-cli configure production

# 2. Test connection
migration-cli test-connection

# 3. Set up SQL template
migration-cli use ./my-schema.sql

# 4. Validate template
migration-cli validate

# 5. Create a schema
migration-cli create

# 6. List all schemas
migration-cli list
```

## Configuration Files

- Config location: `~/.migration-cli/config.json`
- Stores: database credentials, active environment, and SQL template path