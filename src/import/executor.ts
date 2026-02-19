import type { Dirent } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import type { PoolClient } from 'pg';
import { getPool } from '../db/connection.js';

const CSV_EXTENSION_PATTERN = /\.csv$/i;

export interface CsvPreview {
    headers: string[];
    firstRow: string[] | null;
}

export interface TableImportPlan {
    tableName: string;
    fileName: string;
    filePath: string;
    sizeBytes: number;
    preview: CsvPreview;
}

export interface AccountImportPlan {
    schemaName: string;
    folderName: string;
    folderPath: string;
    tables: TableImportPlan[];
    orderedTables: TableImportPlan[];
}

export interface TableImportResult {
    schemaName: string;
    tableName: string;
    rowsInserted: number;
}

export type ImportMode = 'append' | 'truncate' | 'upsert';

export interface ImportCsvOptions {
    client?: PoolClient;
    dryRun?: boolean;
    mode?: ImportMode;
    validation?: DataValidationRules;
    diagnoseRowErrors?: boolean;
}

export interface DataValidationRules {
    strictColumns?: boolean;
    validateNotNull?: boolean;
    strictTypes?: boolean;
    nullString?: string;
    emptyAsNull?: boolean;
    jsonEmptyAsNull?: boolean;
    enumEmptyAsNull?: boolean;
    numericEmptyAsNull?: boolean;
    trimValues?: boolean;
    autoSanitize?: boolean;
}

export interface SchemaCsvTableMatch {
    schemaTables: string[];
    csvTables: string[];
    missingInCsv: string[];
    extraInCsv: string[];
}

export interface ForeignKeyOrderSuggestion {
    orderedTables: string[];
    cyclicTables: string[];
    relationships: Array<{ parentTable: string; childTable: string }>;
}

interface TableColumnMeta {
    columnName: string;
    isNullable: boolean;
    hasDefault: boolean;
    isGenerated: boolean;
    isIdentity: boolean;
    dataType: string;
    udtName: string;
    udtSchema: string;
    isEnum: boolean;
    enumValues: Set<string> | null;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function isValidValueForType(value: string, dataType: string, udtName: string): boolean {
    const normalizedDataType = dataType.toLowerCase();
    const normalizedUdt = udtName.toLowerCase();

    if (
        normalizedDataType.includes('character') ||
        normalizedDataType === 'text' ||
        normalizedDataType === 'citext'
    ) {
        return true;
    }

    if (
        normalizedUdt === 'int2' ||
        normalizedUdt === 'int4' ||
        normalizedUdt === 'int8' ||
        normalizedDataType === 'smallint' ||
        normalizedDataType === 'integer' ||
        normalizedDataType === 'bigint'
    ) {
        return /^-?\d+$/.test(value);
    }

    if (
        normalizedUdt === 'numeric' ||
        normalizedUdt === 'float4' ||
        normalizedUdt === 'float8' ||
        normalizedDataType === 'numeric' ||
        normalizedDataType === 'real' ||
        normalizedDataType === 'double precision' ||
        normalizedDataType === 'decimal'
    ) {
        return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value);
    }

    if (normalizedDataType === 'boolean' || normalizedUdt === 'bool') {
        return /^(true|false|t|f|1|0|yes|no)$/i.test(value);
    }

    if (normalizedDataType === 'date' || normalizedDataType.includes('timestamp')) {
        return !Number.isNaN(Date.parse(value));
    }

    if (normalizedDataType.includes('time')) {
        return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?$/.test(value);
    }

    if (normalizedDataType === 'uuid' || normalizedUdt === 'uuid') {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    if (normalizedDataType === 'json' || normalizedDataType === 'jsonb') {
        try {
            JSON.parse(value);
            return true;
        } catch {
            return false;
        }
    }

    // Unknown types are passed through to PostgreSQL.
    return true;
}

function isNumericType(dataType: string, udtName: string): boolean {
    const normalizedDataType = dataType.toLowerCase();
    const normalizedUdt = udtName.toLowerCase();
    return (
        normalizedUdt === 'int2' ||
        normalizedUdt === 'int4' ||
        normalizedUdt === 'int8' ||
        normalizedUdt === 'numeric' ||
        normalizedUdt === 'float4' ||
        normalizedUdt === 'float8' ||
        normalizedDataType === 'smallint' ||
        normalizedDataType === 'integer' ||
        normalizedDataType === 'bigint' ||
        normalizedDataType === 'numeric' ||
        normalizedDataType === 'real' ||
        normalizedDataType === 'double precision' ||
        normalizedDataType === 'decimal'
    );
}

function isJsonType(dataType: string): boolean {
    const normalizedDataType = dataType.toLowerCase();
    return normalizedDataType === 'json' || normalizedDataType === 'jsonb';
}

function sanitizeControlChars(value: string): string {
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ');
}

function sanitizeValueByType(value: string, columnMeta: TableColumnMeta): string {
    let sanitized = sanitizeControlChars(value);

    if (columnMeta.isEnum) {
        return sanitized;
    }

    if (!isJsonType(columnMeta.dataType)) {
        return sanitized;
    }

    // Clean common problematic escaped controls inside JSON payloads.
    // Example: \u0096 (often an invalid dash-like control in source systems).
    sanitized = sanitized.replace(/\\u0096/gi, '-');
    sanitized = sanitized.replace(/\\u00(?:0[0-8bcef]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/gi, ' ');

    try {
        const parsed = JSON.parse(sanitized);
        return JSON.stringify(parsed);
    } catch {
        return sanitized;
    }
}

function findLikelyFailedColumn(
    rowErrorMessage: string,
    rowValues: Array<string | null>,
    headers: string[],
    columnMetaByName: Map<string, TableColumnMeta>
): string | null {
    const message = rowErrorMessage.toLowerCase();

    for (let idx = 0; idx < headers.length; idx++) {
        const columnName = headers[idx];
        const value = rowValues[idx];
        const columnMeta = columnMetaByName.get(columnName);
        if (!columnMeta || value === null) {
            continue;
        }

        if (message.includes('for type json') && isJsonType(columnMeta.dataType)) {
            return columnName;
        }
        if (message.includes('for enum') && columnMeta.isEnum) {
            return columnName;
        }
        if (
            (message.includes('for type numeric') ||
                message.includes('for type integer') ||
                message.includes('for type bigint') ||
                message.includes('for type real') ||
                message.includes('for type double precision')) &&
            isNumericType(columnMeta.dataType, columnMeta.udtName)
        ) {
            return columnName;
        }
        if (message.includes('for type uuid') && columnMeta.udtName.toLowerCase() === 'uuid') {
            return columnName;
        }
        if (
            message.includes('for type boolean') &&
            (columnMeta.udtName.toLowerCase() === 'bool' || columnMeta.dataType.toLowerCase() === 'boolean')
        ) {
            return columnName;
        }
    }

    return null;
}

export function parseTableOrder(orderOption: string): string[] {
    const order = orderOption
        .split(',')
        .map(value => value.trim())
        .filter(value => value.length > 0)
        .map(value => value.replace(CSV_EXTENSION_PATTERN, ''));

    if (order.length === 0) {
        throw new Error('Order cannot be empty. Example: --order table1,table2,table3');
    }

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const table of order) {
        if (seen.has(table)) {
            duplicates.add(table);
            continue;
        }
        seen.add(table);
    }

    if (duplicates.size > 0) {
        throw new Error(`Duplicate table names found in --order: ${Array.from(duplicates).join(', ')}`);
    }

    return order;
}

function parseCsvRecords(csvContent: string): string[][] {
    const text = csvContent.charCodeAt(0) === 0xfeff ? csvContent.slice(1) : csvContent;
    const records: string[][] = [];

    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    const pushRow = () => {
        const isBlank = row.length === 1 && row[0].trim() === '';
        if (!isBlank) {
            records.push(row);
        }
        row = [];
    };

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            // Enter quoted mode only when quote starts the field.
            // Quotes appearing later in an unquoted field (e.g. raw JSON) are literal content.
            if (field.length === 0) {
                inQuotes = true;
                continue;
            }
            field += char;
            continue;
        }

        if (char === ',') {
            row.push(field);
            field = '';
            continue;
        }

        if (char === '\n') {
            row.push(field);
            field = '';
            pushRow();
            continue;
        }

        if (char === '\r') {
            if (text[i + 1] === '\n') {
                i++;
            }
            row.push(field);
            field = '';
            pushRow();
            continue;
        }

        field += char;
    }

    if (inQuotes) {
        throw new Error('CSV has an unclosed quote');
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        const isBlank = row.length === 1 && row[0].trim() === '';
        if (!isBlank) {
            records.push(row);
        }
    }

    return records;
}

async function loadCsvPreview(filePath: string): Promise<CsvPreview> {
    const content = await readFile(filePath, 'utf-8');
    const records = parseCsvRecords(content);

    if (records.length === 0) {
        throw new Error(`CSV '${filePath}' is empty`);
    }

    const headers = records[0].map(column => column.trim());
    if (headers.some(column => column.length === 0)) {
        throw new Error(`CSV '${filePath}' contains an empty column name in the header`);
    }

    return {
        headers,
        firstRow: records.length > 1 ? records[1] : null,
    };
}

function applyOrderToTables(tables: TableImportPlan[], order: string[]): TableImportPlan[] {
    const tableMap = new Map<string, TableImportPlan>();
    for (const table of tables) {
        tableMap.set(table.tableName, table);
    }

    const ordered: TableImportPlan[] = [];

    for (const orderedTableName of order) {
        const matched = tableMap.get(orderedTableName);
        if (matched) {
            ordered.push(matched);
        }
    }

    return ordered;
}

export function findUnknownOrderedTables(order: string[], plans: AccountImportPlan[]): string[] {
    if (order.length === 0) {
        return [];
    }

    const knownTables = new Set<string>();
    for (const plan of plans) {
        for (const table of plan.tables) {
            knownTables.add(table.tableName);
        }
    }

    return order.filter(tableName => !knownTables.has(tableName));
}

export async function discoverAccountImportPlans(
    importRootPath: string,
    order: string[]
): Promise<AccountImportPlan[]> {
    let rootEntries: Dirent[];
    try {
        rootEntries = await readdir(importRootPath, { withFileTypes: true, encoding: 'utf-8' });
    } catch (error) {
        throw new Error(
            `Failed to read import folder '${importRootPath}': ${error instanceof Error ? error.message : String(error)}`
        );
    }

    const accountFolders = rootEntries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));

    const plans: AccountImportPlan[] = [];

    for (const folderName of accountFolders) {
        const folderPath = path.join(importRootPath, folderName);
        const entries = await readdir(folderPath, { withFileTypes: true, encoding: 'utf-8' });

        const csvFiles = entries
            .filter(entry => entry.isFile() && CSV_EXTENSION_PATTERN.test(entry.name))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));

        if (csvFiles.length === 0) {
            continue;
        }

        const tables: TableImportPlan[] = [];
        for (const csvFileName of csvFiles) {
            const filePath = path.join(folderPath, csvFileName);
            const tableName = csvFileName.replace(CSV_EXTENSION_PATTERN, '');
            const fileInfo = await stat(filePath);
            const preview = await loadCsvPreview(filePath);

            tables.push({
                tableName,
                fileName: csvFileName,
                filePath,
                sizeBytes: fileInfo.size,
                preview,
            });
        }

        plans.push({
            schemaName: folderName,
            folderName,
            folderPath,
            tables,
            orderedTables: applyOrderToTables(tables, order),
        });
    }

    return plans;
}

export async function importCsvIntoTable(
    schemaName: string,
    tableName: string,
    csvFilePath: string,
    options: ImportCsvOptions = {}
): Promise<TableImportResult> {
    const mode = options.mode ?? 'append';
    const dryRun = options.dryRun === true;
    const validation = options.validation ?? {};
    const diagnoseRowErrors = options.diagnoseRowErrors !== false;

    const csvContent = await readFile(csvFilePath, 'utf-8');
    const records = parseCsvRecords(csvContent);

    if (records.length === 0) {
        throw new Error(`CSV '${csvFilePath}' is empty`);
    }

    const headers = records[0].map(column => column.trim());
    if (headers.length === 0 || headers.some(column => column.length === 0)) {
        throw new Error(`CSV '${csvFilePath}' has an invalid header row`);
    }

    const dataRows = records.slice(1);
    for (let index = 0; index < dataRows.length; index++) {
        const row = dataRows[index];
        if (row.length !== headers.length) {
            throw new Error(
                `CSV '${csvFilePath}' has a column mismatch on row ${index + 2}: expected ${headers.length}, got ${row.length}`
            );
        }
    }

    const runImportWithClient = async (dbClient: PoolClient): Promise<number> => {
        const tableCheck = await dbClient.query(
            `SELECT 1
             FROM information_schema.tables
             WHERE table_schema = $1 AND table_name = $2`,
            [schemaName, tableName]
        );

        if (tableCheck.rowCount === 0) {
            throw new Error(`Table '${schemaName}.${tableName}' does not exist`);
        }

        const columnRows = await dbClient.query(
            `SELECT
                column_name,
                is_nullable,
                column_default,
                is_generated,
                is_identity,
                data_type,
                udt_name,
                udt_schema
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2`,
            [schemaName, tableName]
        );
        const enumTypeKeys = Array.from(
            new Set(
                columnRows.rows
                    .filter(row => (row.data_type as string).toLowerCase() === 'user-defined')
                    .map(row => `${row.udt_schema as string}.${row.udt_name as string}`)
            )
        );
        const enumValuesByType = new Map<string, Set<string>>();
        if (enumTypeKeys.length > 0) {
            const enumRows = await dbClient.query(
                `SELECT
                    n.nspname AS schema_name,
                    t.typname AS type_name,
                    e.enumlabel AS enum_label
                 FROM pg_type t
                 JOIN pg_namespace n ON n.oid = t.typnamespace
                 JOIN pg_enum e ON e.enumtypid = t.oid
                 WHERE (n.nspname || '.' || t.typname) = ANY($1::text[])`,
                [enumTypeKeys]
            );

            for (const row of enumRows.rows) {
                const key = `${row.schema_name as string}.${row.type_name as string}`;
                if (!enumValuesByType.has(key)) {
                    enumValuesByType.set(key, new Set<string>());
                }
                enumValuesByType.get(key)!.add(row.enum_label as string);
            }
        }

        const tableColumns: TableColumnMeta[] = columnRows.rows.map(row => {
            const enumKey = `${row.udt_schema as string}.${row.udt_name as string}`;
            const enumValues = enumValuesByType.get(enumKey) ?? null;
            return {
            columnName: row.column_name as string,
            isNullable: (row.is_nullable as string) === 'YES',
            hasDefault: row.column_default !== null,
            isGenerated: (row.is_generated as string) !== 'NEVER',
            isIdentity: (row.is_identity as string) === 'YES',
            dataType: row.data_type as string,
            udtName: row.udt_name as string,
            udtSchema: row.udt_schema as string,
            isEnum: enumValues !== null,
            enumValues,
        };
        });
        const dbColumns = new Set(tableColumns.map(column => column.columnName));
        const unknownColumns = headers.filter(column => !dbColumns.has(column));
        if (unknownColumns.length > 0) {
            throw new Error(
                `CSV contains column(s) not found in '${schemaName}.${tableName}': ${unknownColumns.join(', ')}`
            );
        }

        const insertableColumns = tableColumns
            .filter(column => !column.isGenerated)
            .map(column => column.columnName);

        if (validation.strictColumns === true) {
            const csvSet = new Set(headers);
            const insertableSet = new Set(insertableColumns);
            const missingInCsv = insertableColumns.filter(column => !csvSet.has(column));
            const extraInCsv = headers.filter(column => !insertableSet.has(column));

            if (missingInCsv.length > 0 || extraInCsv.length > 0) {
                throw new Error(
                    `Strict column validation failed for '${schemaName}.${tableName}'. ` +
                    `Missing: [${missingInCsv.join(', ')}], Extra: [${extraInCsv.join(', ')}]`
                );
            }
        }

        const requiredColumns = tableColumns
            .filter(column => !column.isNullable && !column.hasDefault && !column.isIdentity && !column.isGenerated)
            .map(column => column.columnName);
        if (validation.validateNotNull === true) {
            const missingRequiredColumns = requiredColumns.filter(column => !headers.includes(column));
            if (missingRequiredColumns.length > 0) {
                throw new Error(
                    `NOT NULL validation failed for '${schemaName}.${tableName}'. Missing required column(s): ${missingRequiredColumns.join(', ')}`
                );
            }
        }

        const columnMetaByName = new Map<string, TableColumnMeta>();
        for (const column of tableColumns) {
            columnMetaByName.set(column.columnName, column);
        }

        const normalizedRows: Array<Array<string | null>> = dataRows.map((row, rowIndex) => {
            return row.map((rawValue, colIndex) => {
                const columnName = headers[colIndex];
                const columnMeta = columnMetaByName.get(columnName);
                const nullString = validation.nullString;
                const maybeTrimmedValue = validation.trimValues === true ? rawValue.trim() : rawValue;
                let normalizedValue: string | null =
                    nullString !== undefined && maybeTrimmedValue === nullString
                        ? null
                        : maybeTrimmedValue;

                if (validation.autoSanitize === true && normalizedValue !== null && columnMeta) {
                    normalizedValue = sanitizeValueByType(normalizedValue, columnMeta);
                }

                if (normalizedValue === '' && columnMeta) {
                    const numericLike = isNumericType(columnMeta.dataType, columnMeta.udtName);
                    const jsonLike = isJsonType(columnMeta.dataType);
                    const enumLike = columnMeta.isEnum;

                    if (validation.numericEmptyAsNull === true && numericLike) {
                        normalizedValue = null;
                    }
                    if (validation.jsonEmptyAsNull === true && jsonLike) {
                        normalizedValue = null;
                    }
                    if (validation.enumEmptyAsNull === true && enumLike) {
                        normalizedValue = null;
                    }
                    if (validation.emptyAsNull === true) {
                        normalizedValue = null;
                    }
                }

                if (validation.validateNotNull === true && requiredColumns.includes(columnName)) {
                    if (normalizedValue === null || normalizedValue.trim() === '') {
                        throw new Error(
                            `NOT NULL validation failed for '${schemaName}.${tableName}', row ${rowIndex + 2}, column '${columnName}'`
                        );
                    }
                }

                if (
                    validation.strictTypes === true &&
                    normalizedValue !== null &&
                    normalizedValue.trim() !== '' &&
                    columnMeta &&
                    (
                        (columnMeta.isEnum && columnMeta.enumValues
                            ? !columnMeta.enumValues.has(normalizedValue)
                            : false) ||
                        !isValidValueForType(normalizedValue, columnMeta.dataType, columnMeta.udtName)
                    )
                ) {
                    throw new Error(
                        `Type validation failed for '${schemaName}.${tableName}', row ${rowIndex + 2}, column '${columnName}' (value '${normalizedValue}')`
                    );
                }

                return normalizedValue;
            });
        });

        let onConflictSql = '';
        if (mode === 'upsert') {
            const pkColumnsResult = await dbClient.query(
                `SELECT kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                  AND tc.table_name = kcu.table_name
                 WHERE tc.table_schema = $1
                   AND tc.table_name = $2
                   AND tc.constraint_type = 'PRIMARY KEY'
                 ORDER BY kcu.ordinal_position`,
                [schemaName, tableName]
            );

            const pkColumns = pkColumnsResult.rows.map(row => row.column_name as string);
            if (pkColumns.length === 0) {
                throw new Error(
                    `Mode 'upsert' requires a primary key on '${schemaName}.${tableName}', but no primary key was found`
                );
            }

            const missingPkColumns = pkColumns.filter(pkCol => !headers.includes(pkCol));
            if (missingPkColumns.length > 0) {
                throw new Error(
                    `CSV is missing primary key column(s) required for upsert on '${schemaName}.${tableName}': ${missingPkColumns.join(', ')}`
                );
            }

            const pkSet = new Set(pkColumns);
            const updatableColumns = headers.filter(column => !pkSet.has(column));
            const conflictTarget = pkColumns.map(column => quoteIdentifier(column)).join(', ');

            if (updatableColumns.length === 0) {
                onConflictSql = ` ON CONFLICT (${conflictTarget}) DO NOTHING`;
            } else {
                const updateSet = updatableColumns
                    .map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
                    .join(', ');
                onConflictSql = ` ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet}`;
            }
        }

        if (dryRun) {
            return dataRows.length;
        }

        const columnSql = headers.map(column => quoteIdentifier(column)).join(', ');
        const BATCH_SIZE = 200;
        let inserted = 0;

        for (let i = 0; i < normalizedRows.length; i += BATCH_SIZE) {
            const batch = normalizedRows.slice(i, i + BATCH_SIZE);
            if (batch.length === 0) {
                continue;
            }

            const values: string[] = [];
            const params: unknown[] = [];
            let paramIndex = 1;

            for (const row of batch) {
                const placeholders = row.map(() => `$${paramIndex++}`);
                values.push(`(${placeholders.join(', ')})`);
                params.push(...row);
            }

            const batchInsertSql =
                `INSERT INTO ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} (${columnSql})
                 VALUES ${values.join(', ')}${onConflictSql}`;
            const batchSavepoint = `phantm_batch_${i}`;
            await dbClient.query(`SAVEPOINT ${batchSavepoint}`);
            try {
                await dbClient.query(batchInsertSql, params);
                await dbClient.query(`RELEASE SAVEPOINT ${batchSavepoint}`);
            } catch (batchError) {
                await dbClient.query(`ROLLBACK TO SAVEPOINT ${batchSavepoint}`);
                await dbClient.query(`RELEASE SAVEPOINT ${batchSavepoint}`);

                if (!diagnoseRowErrors) {
                    throw batchError;
                }

                // Re-run one-by-one to find exact CSV row for better troubleshooting.
                for (let j = 0; j < batch.length; j++) {
                    const singleRow = batch[j];
                    const placeholders = singleRow.map((_, idx) => `$${idx + 1}`).join(', ');
                    const singleInsertSql =
                        `INSERT INTO ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} (${columnSql})
                         VALUES (${placeholders})${onConflictSql}`;
                    const rowSavepoint = `phantm_row_${i}_${j}`;
                    await dbClient.query(`SAVEPOINT ${rowSavepoint}`);
                    try {
                        await dbClient.query(singleInsertSql, singleRow);
                        await dbClient.query(`RELEASE SAVEPOINT ${rowSavepoint}`);
                    } catch (rowError) {
                        await dbClient.query(`ROLLBACK TO SAVEPOINT ${rowSavepoint}`);
                        await dbClient.query(`RELEASE SAVEPOINT ${rowSavepoint}`);
                        const csvRowNumber = i + j + 2;
                        const rowMessage = rowError instanceof Error ? rowError.message : String(rowError);
                        const likelyColumn = findLikelyFailedColumn(
                            rowMessage,
                            singleRow,
                            headers,
                            columnMetaByName
                        );
                        const location = likelyColumn
                            ? `row ${csvRowNumber}, column '${likelyColumn}'`
                            : `row ${csvRowNumber}`;
                        throw new Error(`Invalid value at ${location}: ${rowMessage}`);
                    }
                }
            }

            inserted += batch.length;
        }

        return inserted;
    };

    if (options.client) {
        try {
            const inserted = await runImportWithClient(options.client);
            return {
                schemaName,
                tableName,
                rowsInserted: inserted,
            };
        } catch (error) {
            throw new Error(
                `Failed to import CSV '${path.basename(csvFilePath)}' into '${schemaName}.${tableName}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    const pool = await getPool();
    const ownClient = await pool.connect();

    try {
        if (!dryRun) {
            await ownClient.query('BEGIN');
        }
        const inserted = await runImportWithClient(ownClient);
        if (!dryRun) {
            await ownClient.query('COMMIT');
        }

        return {
            schemaName,
            tableName,
            rowsInserted: inserted,
        };
    } catch (error) {
        if (!dryRun) {
            await ownClient.query('ROLLBACK');
        }
        throw new Error(
            `Failed to import CSV '${path.basename(csvFilePath)}' into '${schemaName}.${tableName}': ${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        ownClient.release();
    }
}

export async function truncateTableForImport(
    schemaName: string,
    tableName: string,
    client: PoolClient
): Promise<void> {
    const tableCheck = await client.query(
        `SELECT 1
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, tableName]
    );

    if (tableCheck.rowCount === 0) {
        throw new Error(`Table '${schemaName}.${tableName}' does not exist`);
    }

    await client.query(
        `TRUNCATE TABLE ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} RESTART IDENTITY`
    );
}

export async function getSchemaCsvTableMatch(
    schemaName: string,
    csvTableNames: string[]
): Promise<SchemaCsvTableMatch> {
    const pool = await getPool();
    const result = await pool.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_type = 'BASE TABLE'
           AND table_name <> 'flyway_schema_history'`,
        [schemaName]
    );

    const schemaTables = result.rows
        .map(row => row.table_name as string)
        .sort((a, b) => a.localeCompare(b));
    const csvTables = [...csvTableNames].sort((a, b) => a.localeCompare(b));

    const schemaSet = new Set(schemaTables);
    const csvSet = new Set(csvTables);

    const missingInCsv = schemaTables.filter(table => !csvSet.has(table));
    const extraInCsv = csvTables.filter(table => !schemaSet.has(table));

    return {
        schemaTables,
        csvTables,
        missingInCsv,
        extraInCsv,
    };
}

export async function suggestTableOrderByForeignKeys(
    schemaName: string,
    tableNames: string[]
): Promise<ForeignKeyOrderSuggestion> {
    const uniqueTables = Array.from(new Set(tableNames)).sort((a, b) => a.localeCompare(b));
    if (uniqueTables.length === 0) {
        return {
            orderedTables: [],
            cyclicTables: [],
            relationships: [],
        };
    }

    const tableSet = new Set(uniqueTables);
    const pool = await getPool();
    const fkRows = await pool.query(
        `SELECT
            kcu.table_name AS child_table,
            ccu.table_name AS parent_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1`,
        [schemaName]
    );

    const relationships: Array<{ parentTable: string; childTable: string }> = [];
    const outgoing = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    for (const table of uniqueTables) {
        outgoing.set(table, new Set());
        inDegree.set(table, 0);
    }

    for (const row of fkRows.rows) {
        const childTable = row.child_table as string;
        const parentTable = row.parent_table as string;
        if (!tableSet.has(childTable) || !tableSet.has(parentTable)) {
            continue;
        }
        if (childTable === parentTable) {
            continue;
        }

        const children = outgoing.get(parentTable);
        if (!children || children.has(childTable)) {
            continue;
        }

        children.add(childTable);
        inDegree.set(childTable, (inDegree.get(childTable) ?? 0) + 1);
        relationships.push({ parentTable, childTable });
    }

    const ready = uniqueTables
        .filter(table => (inDegree.get(table) ?? 0) === 0)
        .sort((a, b) => a.localeCompare(b));
    const orderedTables: string[] = [];

    while (ready.length > 0) {
        const current = ready.shift()!;
        orderedTables.push(current);

        const children = Array.from(outgoing.get(current) ?? []);
        for (const child of children) {
            const nextDegree = (inDegree.get(child) ?? 0) - 1;
            inDegree.set(child, nextDegree);
            if (nextDegree === 0) {
                ready.push(child);
                ready.sort((a, b) => a.localeCompare(b));
            }
        }
    }

    const cyclicTables = uniqueTables
        .filter(table => !orderedTables.includes(table))
        .sort((a, b) => a.localeCompare(b));
    const finalOrder = [...orderedTables, ...cyclicTables];

    return {
        orderedTables: finalOrder,
        cyclicTables,
        relationships,
    };
}
