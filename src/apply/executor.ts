import { readFile } from 'fs/promises';
import type { PoolClient } from 'pg';
import { getPool } from '../db/connection.js';
import { replaceSchemaName } from '../schema/parser.js';

export interface ApplyResult {
    schemaName: string;
    status: string;
    executed: boolean;
    skipped: boolean;
    success: boolean;
    error?: string;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

export async function readApplySqlFile(filePath: string): Promise<string> {
    let sql: string;

    try {
        sql = await readFile(filePath, 'utf-8');
    } catch (error) {
        throw new Error(
            `Failed to read SQL file '${filePath}': ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (sql.trim().length === 0) {
        throw new Error(`SQL file '${filePath}' is empty`);
    }

    return sql;
}

export function prepareApplySql(sql: string, schemaName: string): string {
    return sql.includes('{{SCHEMA_NAME}}')
        ? replaceSchemaName(sql, schemaName)
        : sql;
}

export async function applySqlToSchema(
    schemaName: string,
    sql: string,
    client?: PoolClient
): Promise<void> {
    const pool = client ? null : await getPool();
    const dbClient = client ?? await pool!.connect();

    try {
        await dbClient.query('BEGIN');
        try {
            await dbClient.query(`SET LOCAL search_path TO ${quoteIdentifier(schemaName)}, public`);
            await dbClient.query(sql);
            await dbClient.query('COMMIT');
        } catch (error) {
            await dbClient.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        throw new Error(
            `Failed to apply SQL to schema '${schemaName}': ${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        if (!client) {
            dbClient.release();
        }
    }
}
