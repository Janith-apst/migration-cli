import { Pool, PoolConfig } from 'pg';
import { getEnvConfig, getActiveEnv } from '../config/manager.js';

export interface DatabaseConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
}

export async function getDatabaseConfig(): Promise<DatabaseConfig> {
    let envName = process.env.MIGRATION_ENV;
    if (!envName) {
        const activeEnv = await getActiveEnv();
        envName = activeEnv || 'default';
    }

    const configFromFile = await getEnvConfig(envName);
    if (configFromFile) {
        return configFromFile;
    }

    throw new Error(
        `Configuration not found for environment '${envName}'.\n\n` +
        `Set up using config file:\n` +
        `  pnpm cli configure ${envName}\n`
    );
}

export function createPool(config?: DatabaseConfig): Pool {
    if (!config) {
        throw new Error('Database configuration is required. Please run "pnpm cli configure" first.');
    }

    const dbConfig = config;
    const poolConfig: PoolConfig = {
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        user: dbConfig.user,
        password: dbConfig.password,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

    if (dbConfig.ssl) {
        poolConfig.ssl = { rejectUnauthorized: false };
    }
    return new Pool(poolConfig);
}

let pool: Pool | null = null;
let dbConfig: DatabaseConfig | null = null;
export async function getPool(): Promise<Pool> {
    if (!pool) {
        if (!dbConfig) {
            dbConfig = await getDatabaseConfig();
        }
        pool = createPool(dbConfig);
    }
    return pool;
}

export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

export async function testConnection(): Promise<boolean> {
    const testPool = await getPool();
    try {
        const client = await testPool.connect();
        await client.query('SELECT 1');
        client.release();
        return true;
    } catch (error) {
        throw new Error(
            `Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export async function verifyCommonSchema(): Promise<void> {
    const pool = await getPool();
    try {
        const schemaResult = await pool.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'common'`
        );

        if (schemaResult.rowCount === 0) {
            throw new Error('Common schema does not exist in the database');
        }

        const tableResult = await pool.query(
            `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'common' AND table_name = 'schema_pool'`
        );

        if (tableResult.rowCount === 0) {
            throw new Error('Table common.schema_pool does not exist');
        }
    } catch (error) {
        throw new Error(
            `Failed to verify common schema: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
