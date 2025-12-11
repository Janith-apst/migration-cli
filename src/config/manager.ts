import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface DatabaseConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
    createdAt?: string;
    updatedAt?: string;
}

export interface ConfigFile {
    activeEnv?: string;
    templatePath?: string;
    [envName: string]: DatabaseConfig | string | undefined;
}

const CONFIG_DIR = path.join(os.homedir(), '.migration-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export async function ensureConfigDir(): Promise<void> {
    try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
    } catch (error) {
        throw new Error(`Failed to create config directory: ${error}`);
    }
}

export async function readConfig(): Promise<ConfigFile> {
    try {
        const content = await fs.readFile(CONFIG_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw new Error(`Failed to read config file: ${error.message}`);
    }
}

export async function getEnvConfig(envName: string): Promise<DatabaseConfig | null> {
    const config = await readConfig();
    const envConfig = config[envName];
    if (envConfig && typeof envConfig === 'object' && 'host' in envConfig) {
        return envConfig as DatabaseConfig;
    }

    return null;
}

export async function saveEnvConfig(
    envName: string,
    dbConfig: DatabaseConfig
): Promise<void> {
    await ensureConfigDir();
    const config = await readConfig();
    const now = new Date().toISOString();
    const isFirstEnv = Object.keys(config).filter(k => k !== 'activeEnv').length === 0;
    config[envName] = {
        ...dbConfig,
        createdAt: (config[envName] as DatabaseConfig)?.createdAt || now,
        updatedAt: now,
    };

    if (isFirstEnv && !config.activeEnv) {
        config.activeEnv = envName;
    }

    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        throw new Error(`Failed to write config file: ${error}`);
    }
}

export async function listEnvs(): Promise<string[]> {
    const config = await readConfig();
    return Object.keys(config).filter(k => k !== 'activeEnv' && k !== 'templatePath');
}

export async function getActiveEnv(): Promise<string | null> {
    const config = await readConfig();
    return (config.activeEnv as string | null) || null;
}

export async function setActiveEnv(envName: string): Promise<void> {
    const config = await readConfig();
    const envConfig = await getEnvConfig(envName);
    if (!envConfig) {
        throw new Error(`Environment '${envName}' not found in config`);
    }

    config.activeEnv = envName;

    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        throw new Error(`Failed to update config file: ${error}`);
    }
}

export async function deleteEnvConfig(envName: string): Promise<void> {
    const config = await readConfig();
    if (!config[envName]) {
        throw new Error(`Environment '${envName}' not found in config`);
    }

    delete config[envName];
    if (config.activeEnv === envName) {
        const remainingEnvs = Object.keys(config).filter(k => k !== 'activeEnv');
        config.activeEnv = remainingEnvs.length > 0 ? remainingEnvs[0] : undefined;
    }

    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        throw new Error(`Failed to update config file: ${error}`);
    }
}

export function getConfigFilePath(): string {
    return CONFIG_FILE;
}

export async function setTemplatePath(filePath: string): Promise<void> {
    await ensureConfigDir();
    try {
        await fs.access(filePath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Template file not accessible: ${filePath}`);
    }

    const config = await readConfig();
    config.templatePath = path.resolve(filePath);
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        throw new Error(`Failed to save template path: ${error}`);
    }
}

export async function getTemplatePath(): Promise<string | null> {
    const config = await readConfig();
    return config.templatePath || null;
}

export async function clearTemplatePath(): Promise<void> {
    const config = await readConfig();
    delete config.templatePath;

    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        throw new Error(`Failed to clear template path: ${error}`);
    }
}
