import { PoolClient } from 'pg';
import { getPool } from '../db/connection.js';

export interface SchemaPoolRecord {
    schema_id?: string;
    schema_name: string;
    status: 'AVAILABLE' | 'ALLOCATED' | 'DELETED';
    account_id?: string | null;
    allocated_at?: Date | null;
    created_at?: Date;
    updated_at?: Date | null;
}

export async function registerSchema(
    schemaName: string,
    client?: PoolClient
): Promise<string> {
    const query = `
    INSERT INTO common.schema_pool (schema_name, status, account_id, allocated_at)
    VALUES ($1, $2, $3, $4)
    RETURNING schema_id, schema_name, status, created_at
  `;

    const values = [schemaName, 'AVAILABLE', null, null];

    try {
        const result = client
            ? await client.query(query, values)
            : await (await getPool()).query(query, values);

        if (result.rowCount === 0) {
            throw new Error('Failed to insert record into schema_pool');
        }

        return result.rows[0].schema_id;
    } catch (error: any) {
        if (error.code === '23505') {
            throw new Error(`Schema '${schemaName}' is already registered in schema_pool`);
        }
        throw error;
    }
}

export async function listSchemas(statusFilter?: string): Promise<SchemaPoolRecord[]> {
    const pool = await getPool();

    let query = `
    SELECT 
      schema_id,
      schema_name,
      status,
      account_id,
      allocated_at,
      created_at,
      updated_at
    FROM common.schema_pool
  `;

    const values: string[] = [];

    if (statusFilter) {
        query += ' WHERE status = $1';
        values.push(statusFilter.toUpperCase());
    }

    query += ' ORDER BY created_at DESC';

    try {
        const result = await pool.query(query, values);
        return result.rows;
    } catch (error) {
        throw new Error(
            `Failed to list schemas: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export async function schemaExistsInPool(schemaName: string): Promise<boolean> {
    const pool = await getPool();

    const query = `
    SELECT 1 FROM common.schema_pool WHERE schema_name = $1
  `;

    try {
        const result = await pool.query(query, [schemaName]);
        return result.rowCount !== null && result.rowCount > 0;
    } catch (error) {
        throw new Error(
            `Failed to check schema existence: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export async function deleteSchemaFromPool(
    schemaName: string,
    hardDelete: boolean = false
): Promise<void> {
    const pool = await getPool();

    const query = hardDelete
        ? 'DELETE FROM common.schema_pool WHERE schema_name = $1'
        : `UPDATE common.schema_pool 
       SET status = 'DELETED', updated_at = CURRENT_TIMESTAMP 
       WHERE schema_name = $1`;

    try {
        const result = await pool.query(query, [schemaName]);
        if (result.rowCount === 0) {
            throw new Error(`Schema '${schemaName}' not found in schema_pool`);
        }
    } catch (error) {
        throw new Error(
            `Failed to delete schema from pool: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export async function getSchemaFromPool(schemaName: string): Promise<SchemaPoolRecord | null> {
    const pool = await getPool();

    const query = `
    SELECT 
      schema_id,
      schema_name,
      status,
      account_id,
      allocated_at,
      created_at,
      updated_at
    FROM common.schema_pool
    WHERE schema_name = $1
  `;

    try {
        const result = await pool.query(query, [schemaName]);
        return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
    } catch (error) {
        throw new Error(
            `Failed to get schema from pool: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
