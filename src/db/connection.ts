import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export interface DatabaseConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
}

export function getDatabaseConfig(): DatabaseConfig {
    const requiredVars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
    const missing = requiredVars.filter(varName => !process.env[varName]);

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}\n` +
            'Please create a .env file based on .env.example'
        );
    }

    return {
        host: process.env.DB_HOST!,
        port: parseInt(process.env.DB_PORT!, 10),
        database: process.env.DB_NAME!,
        user: process.env.DB_USER!,
        password: process.env.DB_PASSWORD!,
        ssl: process.env.DB_SSL === 'true',
    };
}

export function createPool(config?: DatabaseConfig): Pool {
    const dbConfig = config || getDatabaseConfig();

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

export function getPool(): Pool {
    if (!pool) {
        pool = createPool();
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
    const testPool = getPool();
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
    const pool = getPool();

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
