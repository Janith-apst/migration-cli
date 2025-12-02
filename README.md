## Usage

### Create a New Schema

Create a new schema with an auto-generated name:

```bash
pnpm dev create
```

Create multiple schemas at once:

```bash
pnpm dev create-bulk <number_of_schemas>
```

Create with custom name:

```bash
pnpm dev create --name account_mycustom
```

Force recreate if exists:

```bash
pnpm dev create --force
```

Skip confirmation prompt:

```bash
pnpm dev create --yes
```

### List All Schemas

List all schemas in the pool:

```bash
pnpm dev list
```

Filter by status:

```bash
pnpm dev list --status AVAILABLE
pnpm dev list --status ALLOCATED
pnpm dev list --status DELETED
```

### Get Schema Information

Get detailed information about a specific schema:

```bash
pnpm dev info account_abc12345
```

### Validate Template

Validate the base schema SQL template:

```bash
pnpm dev validate
```