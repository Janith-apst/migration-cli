import { readFile } from 'fs/promises';
import { getEnvTemplatePath } from '../config/manager.js';

export interface SchemaAnalysis {
    authorization: string | null;
    typeCount: number;
    tableCount: number;
    indexCount: number;
    tableNames: string[];
    foreignKeyCount: number;
}

export async function readSchemaFromPath(filePath: string): Promise<string> {
    try {
        const content = await readFile(filePath, 'utf-8');
        return content;
    } catch (error) {
        throw new Error(
            `Failed to read schema template from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export async function readBaseSchema(envName: string): Promise<string> {
    const configuredPath = await getEnvTemplatePath(envName);
    if (configuredPath) {
        return readSchemaFromPath(configuredPath);
    }

    throw new Error(
        `No template configured for environment '${envName}'. Please run: phantm use <path-to-sql-file>`
    );
}

export function analyzeSchemaTemplate(sql: string): SchemaAnalysis {
    const authMatch = sql.match(/AUTHORIZATION\s+(\w+)/i);
    const authorization = authMatch ? authMatch[1] : null;
    const typeCount = (sql.match(/CREATE TYPE/gi) || []).length;
    const tableCount = (sql.match(/CREATE TABLE/gi) || []).length;
    const indexCount = (sql.match(/CREATE INDEX/gi) || []).length;
    const foreignKeyCount = (sql.match(/FOREIGN KEY/gi) || []).length;

    const tableMatches = sql.matchAll(/CREATE TABLE\s+(?:\{\{SCHEMA_NAME\}\}\.|[\w]+\.)?(\w+)/gi);
    const tableNames: string[] = [];
    for (const match of tableMatches) {
        if (match[1]) {
            tableNames.push(match[1]);
        }
    }

    return {
        authorization,
        typeCount,
        tableCount,
        indexCount,
        tableNames,
        foreignKeyCount
    };
}


export function replaceSchemaName(template: string, schemaName: string): string {
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
        throw new Error(
            `Invalid schema name: ${schemaName}. Must start with lowercase letter or underscore, ` +
            'and contain only lowercase letters, numbers, and underscores.'
        );
    }

    const result = template.replace(/\{\{SCHEMA_NAME\}\}/g, schemaName);

    if (result.includes('{{SCHEMA_NAME}}')) {
        throw new Error('Failed to replace all schema name placeholders');
    }

    return result;
}

export async function generateSchemaSQL(schemaName: string, envName: string): Promise<string> {
    const template = await readBaseSchema(envName);
    return replaceSchemaName(template, schemaName);
}

export function validateSQL(sql: string): void {
    if (!sql || sql.trim().length === 0) {
        throw new Error('SQL content is empty');
    }

    const requiredKeywords = ['CREATE SCHEMA', 'CREATE TYPE', 'CREATE TABLE'];
    const missingKeywords = requiredKeywords.filter(keyword => !sql.includes(keyword));

    if (missingKeywords.length > 0) {
        throw new Error(`SQL template is missing required keywords: ${missingKeywords.join(', ')}`);
    }
}
