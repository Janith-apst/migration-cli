import { nanoid } from 'nanoid';
import { getPool } from '../db/connection.js';
import { generateSchemaSQL, validateSQL } from './parser.js';
import { registerSchema, schemaExistsInPool, deleteSchemaFromPool } from '../pool/registry.js';
import { logger } from '../utils/logger.js';

export interface CreateSchemaOptions {
    force?: boolean;
    customName?: string;
}

export interface CreateSchemaResult {
    schemaName: string;
    schemaId: string;
    success: boolean;
    error?: string;
}


export function generateSchemaName(customName?: string): string {
    if (customName) {
        if (!/^account_[a-z0-9_]+$/.test(customName)) {
            throw new Error(
                'Custom schema name must start with "account_" and contain only lowercase letters, numbers, and underscores'
            );
        }
        return customName;
    }
    const uniqueId = nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '');
    return `account_${uniqueId}`;
}

export async function schemaExistsInDatabase(schemaName: string): Promise<boolean> {
    const pool = await getPool();

    const query = `
    SELECT schema_name 
    FROM information_schema.schemata 
    WHERE schema_name = $1
  `;

    try {
        const result = await pool.query(query, [schemaName]);
        return result.rowCount !== null && result.rowCount > 0;
    } catch (error) {
        throw new Error(
            `Failed to check schema existence in database: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export async function dropSchema(schemaName: string): Promise<void> {
    const pool = await getPool();

    const query = `DROP SCHEMA IF EXISTS ${schemaName} CASCADE`;

    try {
        await pool.query(query);
    } catch (error) {
        throw new Error(
            `Failed to drop schema: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export async function createSchema(options: CreateSchemaOptions = {}): Promise<CreateSchemaResult> {
    const pool = await getPool();
    const client = await pool.connect();

    let schemaName: string | null = null;
    let schemaId: string | null = null;

    try {
        schemaName = generateSchemaName(options.customName);
        logger.info(`Preparing to create schema: ${schemaName}`);

        const existsInDb = await schemaExistsInDatabase(schemaName);
        const existsInPool = await schemaExistsInPool(schemaName);

        if (existsInDb || existsInPool) {
            if (!options.force) {
                throw new Error(
                    `Schema '${schemaName}' already exists. Use --force flag to recreate it.`
                );
            }

            logger.warn(`Schema '${schemaName}' exists. Recreating due to --force flag...`);
            await client.query('BEGIN');

            try {
                if (existsInDb) {
                    logger.startSpinner('Dropping existing schema from database...');
                    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
                    logger.succeedSpinner('Existing schema dropped from database');
                }

                if (existsInPool) {
                    logger.startSpinner('Removing existing schema from pool...');
                    await deleteSchemaFromPool(schemaName, true);
                    logger.succeedSpinner('Existing schema removed from pool');
                }

                await client.query('COMMIT');
            } catch (cleanupError) {
                await client.query('ROLLBACK');
                throw cleanupError;
            }
        }

        logger.startSpinner('Generating SQL from template...');
        const sql = await generateSchemaSQL(schemaName);
        validateSQL(sql);
        logger.succeedSpinner('SQL generated and validated');
        await client.query('BEGIN');

        try {
            logger.startSpinner('Creating schema and all database objects...');
            await client.query(sql);
            logger.succeedSpinner('Schema and database objects created successfully');

            const verifyResult = await client.query(
                'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
                [schemaName]
            );

            if (verifyResult.rowCount === 0) {
                throw new Error('Schema creation verification failed');
            }

            logger.startSpinner('Registering schema in pool...');
            schemaId = await registerSchema(schemaName, client);
            logger.succeedSpinner(`Schema registered with ID: ${schemaId}`);
            await client.query('COMMIT');
            logger.success(`Schema '${schemaName}' created successfully!`);

            return {
                schemaName,
                schemaId,
                success: true,
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to create schema: ${errorMessage}`);

        return {
            schemaName: schemaName || 'unknown',
            schemaId: schemaId || 'unknown',
            success: false,
            error: errorMessage,
        };
    } finally {
        client.release();
    }
}

export async function validateSchemaStructure(schemaName: string): Promise<boolean> {
    const pool = await getPool();

    const expectedTables = [
        'daily_material_aggregate',
        'flyway_schema_history',
        'packaging_line',
        'product_groups',
        'products',
        'attachments',
        'folders',
        'product_group_members',
        'quantities',
        'files',
        'file_activities',
        'component_material',
        'components',
    ];

    try {
        const query = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    `;

        const result = await pool.query(query, [schemaName]);
        const actualTables = result.rows.map((row) => row.table_name);

        const missingTables = expectedTables.filter(
            (table) => !actualTables.includes(table)
        );

        if (missingTables.length > 0) {
            logger.warn(`Missing tables in schema '${schemaName}': ${missingTables.join(', ')}`);
            return false;
        }

        return true;
    } catch (error) {
        throw new Error(
            `Failed to validate schema structure: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
