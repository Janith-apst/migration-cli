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

## Usage (after install)

### Create a New Schema

Create a new schema with an auto-generated name:

```bash
migration-cli create
```

Create multiple schemas at once:

```bash
migration-cli create-bulk <number_of_schemas>
```

Create with custom name:

```bash
migration-cli create --name account_mycustom
```

Force recreate if exists:

```bash
migration-cli create --force
```

Skip confirmation prompt:

```bash
migration-cli create --yes
```

### List All Schemas

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

### Get Schema Information

Get detailed information about a specific schema:

```bash
migration-cli info account_abc12345
```

### Validate Template

Validate the base schema SQL template:

```bash
migration-cli validate
```