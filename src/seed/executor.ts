import { readdir } from 'fs/promises';
import { readFile } from 'fs/promises';
import path from 'path';
import { getPool } from '../db/connection.js';
import { getEnvSeedPath } from '../config/manager.js';
import { replaceSchemaName } from '../schema/parser.js';
import {
    getSeededFiles,
    updateSeededFiles,
    ensureSeededFilesColumn,
    getSchemaFromPool,
    listSchemas,
} from '../pool/registry.js';
import type { SeededFileRecord } from '../pool/registry.js';
import { logger } from '../utils/logger.js';

const SEED_FILE_PATTERN = /^(\d+)_.+\.sql$/;

export interface SeedResult {
    schemaName: string;
    applied: string[];
    skipped: string[];
    failed?: { file: string; error: string };
    success: boolean;
}

/**
 * Discover and sort seed SQL files from a directory.
 * Files must match the pattern: <number>_<name>.sql (e.g. 1_users.sql, 2_products.sql)
 * Sorted numerically by prefix.
 */
export async function discoverSeedFiles(seedFolderPath: string): Promise<string[]> {
    let entries: string[];
    try {
        entries = await readdir(seedFolderPath);
    } catch (error) {
        throw new Error(
            `Failed to read seed directory '${seedFolderPath}': ${error instanceof Error ? error.message : String(error)}`
        );
    }

    const sqlFiles: { order: number; filename: string }[] = [];
    const skipped: string[] = [];

    for (const entry of entries) {
        const match = entry.match(SEED_FILE_PATTERN);
        if (match) {
            sqlFiles.push({ order: parseInt(match[1], 10), filename: entry });
        } else if (entry.endsWith('.sql')) {
            skipped.push(entry);
        }
    }

    if (skipped.length > 0) {
        logger.warn(
            `Skipping ${skipped.length} SQL file(s) that don't match naming pattern (<number>_<name>.sql):`
        );
        skipped.forEach(f => logger.log(`  - ${f}`));
    }

    // Sort numerically by the prefix number
    sqlFiles.sort((a, b) => a.order - b.order);

    return sqlFiles.map(f => f.filename);
}

/**
 * Determine which seed files still need to be applied.
 */
export function getPendingSeedFiles(
    allFiles: string[],
    alreadySeeded: SeededFileRecord[]
): string[] {
    const seededSet = new Set(alreadySeeded.map(s => s.file));
    return allFiles.filter(f => !seededSet.has(f));
}

/**
 * Read and execute a single seed SQL file against a schema.
 * Runs inside a transaction for atomicity.
 */
export async function executeSeedFile(
    schemaName: string,
    seedFolderPath: string,
    filename: string
): Promise<void> {
    const filePath = path.join(seedFolderPath, filename);
    const pool = await getPool();
    const client = await pool.connect();

    try {
        let sql = await readFile(filePath, 'utf-8');

        if (sql.trim().length === 0) {
            throw new Error(`Seed file '${filename}' is empty`);
        }

        // Replace {{SCHEMA_NAME}} placeholders
        if (sql.includes('{{SCHEMA_NAME}}')) {
            sql = replaceSchemaName(sql, schemaName);
        }

        await client.query('BEGIN');
        try {
            // Set search_path to the target schema for convenience
            await client.query(`SET search_path TO ${schemaName}, public`);
            await client.query(sql);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        throw new Error(
            `Failed to execute seed file '${filename}' on schema '${schemaName}': ${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        client.release();
    }
}

/**
 * Seed a single schema: discover files, determine pending, execute in order.
 * Progress is saved after each successful file so partial runs are resumable.
 */
export async function seedSchema(
    schemaName: string,
    envName: string
): Promise<SeedResult> {
    const seedPath = await getEnvSeedPath(envName);
    if (!seedPath) {
        throw new Error(
            `No seed path configured for environment '${envName}'.\n` +
            `Run: phantm use <sql-file> --seed <seed-folder-path>`
        );
    }

    // Verify schema exists in pool
    const schema = await getSchemaFromPool(schemaName);
    if (!schema) {
        throw new Error(`Schema '${schemaName}' not found in schema_pool`);
    }

    // Discover all seed files
    const allFiles = await discoverSeedFiles(seedPath);
    if (allFiles.length === 0) {
        return {
            schemaName,
            applied: [],
            skipped: [],
            success: true,
        };
    }

    // Get already-seeded files
    const alreadySeeded = await getSeededFiles(schemaName);

    // Determine pending
    const pending = getPendingSeedFiles(allFiles, alreadySeeded);
    const skipped = allFiles.filter(f => !pending.includes(f));

    if (pending.length === 0) {
        return {
            schemaName,
            applied: [],
            skipped,
            success: true,
        };
    }

    const applied: string[] = [];
    let currentSeeded = [...alreadySeeded];

    for (const filename of pending) {
        try {
            await executeSeedFile(schemaName, seedPath, filename);

            // Record this file as seeded immediately (for resume-on-failure)
            const record: SeededFileRecord = {
                file: filename,
                applied_at: new Date().toISOString(),
            };
            currentSeeded.push(record);
            await updateSeededFiles(schemaName, currentSeeded);

            applied.push(filename);
        } catch (error) {
            // Return partial progress on failure
            return {
                schemaName,
                applied,
                skipped,
                failed: {
                    file: filename,
                    error: error instanceof Error ? error.message : String(error),
                },
                success: false,
            };
        }
    }

    return {
        schemaName,
        applied,
        skipped,
        success: true,
    };
}

/**
 * Seed multiple schemas at once.
 * Used by --all-available and --all flags.
 */
export async function seedMultipleSchemas(
    envName: string,
    statusFilter: string[]
): Promise<SeedResult[]> {
    // Ensure the column exists before querying it
    await ensureSeededFilesColumn();

    const allSchemas = await listSchemas();
    const targetSchemas = allSchemas.filter(s =>
        statusFilter.includes(s.status)
    );

    if (targetSchemas.length === 0) {
        return [];
    }

    const results: SeedResult[] = [];

    for (const schema of targetSchemas) {
        try {
            const result = await seedSchema(schema.schema_name, envName);
            results.push(result);
        } catch (error) {
            results.push({
                schemaName: schema.schema_name,
                applied: [],
                skipped: [],
                failed: {
                    file: 'N/A',
                    error: error instanceof Error ? error.message : String(error),
                },
                success: false,
            });
        }
    }

    return results;
}
