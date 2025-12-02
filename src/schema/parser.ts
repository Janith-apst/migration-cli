import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


export async function readBaseSchema(): Promise<string> {
    try {
        const templatePath = join(__dirname, '../../templates/base-schema.sql');
        const content = await readFile(templatePath, 'utf-8');
        return content;
    } catch (error) {
        throw new Error(
            `Failed to read base schema template: ${error instanceof Error ? error.message : String(error)}`
        );
    }
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

export async function generateSchemaSQL(schemaName: string): Promise<string> {
    const template = await readBaseSchema();
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
