#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { access, constants, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { testConnection, verifyCommonSchema, closePool, getDatabaseConfig, getPool } from './db/connection.js';
import { createSchema, validateSchemaStructure, deleteSchemaComplete, deleteSchemaAndMark } from './schema/creator.js';
import { listSchemas, getSchemaFromPool, ensureSeededFilesColumn, getSeededFiles, resetSeededFiles } from './pool/registry.js';
import { logger } from './utils/logger.js';
import { readBaseSchema, validateSQL, readSchemaFromPath, analyzeSchemaTemplate, generateSchemaSQL } from './schema/parser.js';
import { saveEnvConfig, getEnvConfig, listEnvs, getConfigFilePath, getActiveEnv, setActiveEnv, deleteEnvConfig, setEnvTemplatePath, getEnvTemplatePath, clearEnvTemplatePath, setEnvSeedPath, getEnvSeedPath, clearEnvSeedPath } from './config/manager.js';
import type { DatabaseConfig } from './config/manager.js';
import { seedSchema, seedMultipleSchemas, discoverSeedFiles, getPendingSeedFiles } from './seed/executor.js';
import type { SeedResult } from './seed/executor.js';
import {
    type DataValidationRules,
    discoverAccountImportPlans,
    findUnknownOrderedTables,
    importCsvIntoTable,
    type ImportMode,
    parseTableOrder,
    suggestTableOrderByForeignKeys,
    truncateTableForImport,
} from './import/executor.js';
import { DynamoDBClient, CreateTableCommand, ListTablesCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

async function promptEnvSelection(message = 'Select environment:'): Promise<string> {
    const envs = await listEnvs();
    if (envs.length === 0) {
        throw new Error('No environments configured. Run phantm configure <env-name> first.');
    }
    const activeEnv = await getActiveEnv();
    const { selectedEnv } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selectedEnv',
            message,
            choices: envs,
            default: activeEnv || undefined,
        } as any,
    ]);
    return selectedEnv;
}

type AwsReadyConfig = DatabaseConfig & {
    region: string;
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
};

function getAwsConfig(config: DatabaseConfig | null | undefined): AwsReadyConfig | null {
    if (config?.region && config.awsAccessKeyId && config.awsSecretAccessKey) {
        return config as AwsReadyConfig;
    }
    return null;
}

async function createDynamoTableForSchema(envName: string, schemaName: string, config: AwsReadyConfig): Promise<void> {
    const accountCode = schemaName.replace('account_', '').replace(/_/g, '');
    const tableName = `${envName}-prep-data-${accountCode}`;

    logger.log('');
    logger.log(chalk.bold('DynamoDB Table:'));
    logger.log(`  Table Name: ${chalk.cyan(tableName)}`);
    logger.log(`  Region:     ${chalk.cyan(config.region)}`);
    logger.log('');

    try {
        logger.startSpinner('Creating DynamoDB table...');
        const dynamoDB = new DynamoDBClient({
            region: config.region,
            credentials: {
                accessKeyId: config.awsAccessKeyId,
                secretAccessKey: config.awsSecretAccessKey,
            },
        });

        await dynamoDB.send(new CreateTableCommand({
            TableName: tableName,
            KeySchema: [
                { AttributeName: 'product_id', KeyType: 'HASH' },
            ],
            AttributeDefinitions: [
                { AttributeName: 'product_id', AttributeType: 'S' },
            ],
            ProvisionedThroughput: {
                ReadCapacityUnits: 5,
                WriteCapacityUnits: 5,
            },
        }));

        logger.succeedSpinner('DynamoDB table created successfully');
        logger.log('');
        logger.success(`✅ DynamoDB table '${chalk.cyan(tableName)}' created!`);
    } catch (dynamoError) {
        logger.failSpinner();
        logger.error(`DynamoDB table creation failed for '${tableName}': ${dynamoError instanceof Error ? dynamoError.message : String(dynamoError)}`);
        logger.warn('Schema was created successfully, but DynamoDB table creation failed.');
    }
}

async function deleteDynamoTableForSchema(envName: string, schemaName: string, config: AwsReadyConfig): Promise<void> {
    const accountCode = schemaName.replace('account_', '').replace(/_/g, '');
    const tableName = `${envName}-prep-data-${accountCode}`;

    try {
        logger.startSpinner(`Deleting DynamoDB table '${tableName}'...`);
        const dynamoDB = new DynamoDBClient({
            region: config.region,
            credentials: {
                accessKeyId: config.awsAccessKeyId,
                secretAccessKey: config.awsSecretAccessKey,
            },
        });

        await dynamoDB.send(new DeleteTableCommand({ TableName: tableName }));
        logger.succeedSpinner(`DynamoDB table '${tableName}' deleted`);
    } catch (dynamoError: any) {
        if (dynamoError?.name === 'ResourceNotFoundException') {
            logger.succeedSpinner(`DynamoDB table '${tableName}' does not exist (skipped)`);
        } else {
            logger.failSpinner();
            logger.warn(`Failed to delete DynamoDB table '${tableName}': ${dynamoError instanceof Error ? dynamoError.message : String(dynamoError)}`);
        }
    }
}

const program = new Command();

program
    .name('phantm')
    .description('PostgreSQL schema CLI tool')
    .version(version, '-v, --version');

program
    .command('configure <env-name>')
    .description('Configure database credentials for an environment')
    .action(async (envName) => {
        try {
            logger.header(`⚙️  Configure Database - ${envName}`);

            const existingConfig = await getEnvConfig(envName);
            if (existingConfig) {
                logger.log('');
                logger.warn(`Environment '${envName}' already exists. Current configuration:`);
                logger.log(`  Host:     ${chalk.cyan(existingConfig.host)}`);
                logger.log(`  Port:     ${chalk.cyan(existingConfig.port)}`);
                logger.log(`  Database: ${chalk.cyan(existingConfig.database)}`);
                logger.log(`  User:     ${chalk.cyan(existingConfig.user)}`);
                logger.log(`  SSL:      ${chalk.cyan(existingConfig.ssl ? 'Enabled' : 'Disabled')}`);
                logger.log('');

                const answer = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'overwrite',
                        message: 'Overwrite existing configuration?',
                        default: false,
                    },
                ]);

                if (!answer.overwrite) {
                    logger.info('Operation cancelled');
                    process.exit(0);
                }
            }

            logger.log('');
            logger.log('Enter database connection details:');
            logger.log('');

            const config = await inquirer.prompt<{
                host: string;
                port: number;
                database: string;
                user: string;
                password: string;
                ssl: boolean;
            }>(
                [
                    {
                        type: 'input',
                        name: 'host',
                        message: 'Database host:',
                        default: existingConfig?.host || 'localhost',
                        validate: (input: string) => input.trim() ? true : 'Host cannot be empty',
                    },
                    {
                        type: 'input',
                        name: 'port',
                        message: 'Database port:',
                        default: existingConfig?.port || 5432,
                        validate: (input: string) => {
                            const port = parseInt(input);
                            return !isNaN(port) && port > 0 && port < 65536 ? true : 'Port must be a valid number between 1 and 65535';
                        },
                        filter: (input: string) => parseInt(input),
                    },
                    {
                        type: 'input',
                        name: 'database',
                        message: 'Database name:',
                        default: existingConfig?.database || 'postgres',
                        validate: (input: string) => input.trim() ? true : 'Database name cannot be empty',
                    },
                    {
                        type: 'input',
                        name: 'user',
                        message: 'Database user:',
                        default: existingConfig?.user || 'postgres',
                        validate: (input: string) => input.trim() ? true : 'User cannot be empty',
                    },
                    {
                        type: 'password',
                        name: 'password',
                        message: 'Database password:',
                        default: existingConfig?.password || '',
                        mask: '*',
                    },
                    {
                        type: 'confirm',
                        name: 'ssl',
                        message: 'Enable SSL connection?',
                        default: existingConfig?.ssl || false,
                    },
                ] as any
            );

            logger.log('');
            logger.startSpinner('Saving configuration...');

            await saveEnvConfig(envName, {
                host: config.host,
                port: config.port,
                database: config.database,
                user: config.user,
                password: config.password,
                ssl: config.ssl,
            });

            logger.succeedSpinner('Configuration saved');
            logger.log('');
            logger.success('✅ Database configuration saved successfully!');
            logger.log('');
            logger.log(chalk.bold('Configuration Details:'));
            logger.log(`  Environment: ${chalk.cyan(envName)}`);
            logger.log(`  Host:        ${chalk.cyan(config.host)}`);
            logger.log(`  Port:        ${chalk.cyan(config.port)}`);
            logger.log(`  Database:    ${chalk.cyan(config.database)}`);
            logger.log(`  User:        ${chalk.cyan(config.user)}`);
            logger.log(`  SSL:         ${chalk.cyan(config.ssl ? 'Enabled' : 'Disabled')}`);
            logger.log('');

            const awsAnswer = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'configureAWS',
                    message: 'Do you want to configure AWS credentials for DynamoDB? (optional)',
                    default: false,
                },
            ]);

            if (awsAnswer.configureAWS) {
                logger.log('');
                logger.log(chalk.bold('AWS Configuration:'));
                logger.log('');

                const awsConfig = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'accessKeyId',
                        message: 'AWS Access Key ID:',
                        validate: (input: string) => input.trim() ? true : 'Access Key ID cannot be empty',
                    },
                    {
                        type: 'password',
                        name: 'secretAccessKey',
                        message: 'AWS Secret Access Key:',
                        validate: (input: string) => input.trim() ? true : 'Secret Access Key cannot be empty',
                        mask: '*',
                    },
                    {
                        type: 'input',
                        name: 'region',
                        message: 'AWS Region:',
                        default: 'us-east-1',
                        validate: (input: string) => input.trim() ? true : 'Region cannot be empty',
                    },
                ]);

                const currentConfig = await getEnvConfig(envName);
                if (currentConfig) {
                    await saveEnvConfig(envName, {
                        ...currentConfig,
                        region: awsConfig.region,
                        awsAccessKeyId: awsConfig.accessKeyId,
                        awsSecretAccessKey: awsConfig.secretAccessKey,
                    });
                }

                logger.log('');
                logger.success('✅ AWS credentials configured successfully!');
                logger.log(`  Region: ${chalk.cyan(awsConfig.region)}`);
                logger.log('');
            }

            // logger.log(chalk.dim(`Config file: ${getConfigFilePath()}`)
            // );
        } catch (error) {
            logger.failSpinner();
            logger.error(`Configuration failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

const envCommand = program
    .command('env')
    .description('Manage database environments');

envCommand
    .command('list')
    .description('List all configured environments')
    .action(async () => {
        try {
            logger.header('📋 Configured Environments');
            const envs = await listEnvs();
            const activeEnv = await getActiveEnv();

            if (envs.length === 0) {
                logger.info('No environments configured yet');
                logger.log('');
                logger.log('Create one with:');
                logger.log('  phantm configure <env-name>');
                return;
            }

            logger.log('');
            logger.log(chalk.bold('Environments:'));
            envs.forEach((env, index) => {
                const isActive = env === activeEnv;
                const icon = isActive ? chalk.green('●') : chalk.gray('○');
                logger.log(`  ${icon} ${env}${isActive ? chalk.green(' (active)') : ''}`);
            });

            logger.log('');
            // logger.log(chalk.dim(`Config file: ${getConfigFilePath()}`));
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

envCommand
    .command('activate')
    .description('Set the active environment')
    .action(async () => {
        try {
            logger.header('🔧 Activate Environment');
            const envs = await listEnvs();

            if (envs.length === 0) {
                logger.error('No environments configured');
                logger.log('');
                logger.log('Create an environment first:');
                logger.log('  phantm configure <env-name>');
                process.exit(1);
            }

            const activeEnv = await getActiveEnv();
            const { selectedEnv } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedEnv',
                    message: 'Select active environment:',
                    choices: envs.map(env => ({
                        name: `${env}${env === activeEnv ? ' (currently active)' : ''}`,
                        value: env,
                    })),
                    default: activeEnv || undefined,
                } as any,
            ]);

            logger.log('');
            logger.startSpinner(`Setting active environment to '${selectedEnv}'...`);
            await setActiveEnv(selectedEnv);
            logger.succeedSpinner('Active environment updated');

            logger.log('');
            logger.success(`✅ Active environment is now: ${chalk.cyan(selectedEnv)}`);
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

envCommand
    .command('delete')
    .description('Delete a configured environment')
    .action(async () => {
        try {
            logger.header('🗑️  Delete Environment');
            const envs = await listEnvs();

            if (envs.length === 0) {
                logger.error('No environments configured');
                logger.log('');
                logger.log('Create an environment first:');
                logger.log('  phantm configure <env-name>');
                process.exit(1);
            }

            const { selectedEnv } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedEnv',
                    message: 'Select environment to delete:',
                    choices: envs,
                } as any,
            ]);

            const envConfig = await getEnvConfig(selectedEnv);
            const activeEnv = await getActiveEnv();

            logger.log('');
            logger.log(chalk.bold('Environment Details:'));
            logger.log(`  Name:     ${chalk.cyan(selectedEnv)}`);
            logger.log(`  Host:     ${chalk.cyan(envConfig?.host || 'N/A')}`);
            logger.log(`  Database: ${chalk.cyan(envConfig?.database || 'N/A')}`);
            logger.log(`  User:     ${chalk.cyan(envConfig?.user || 'N/A')}`);

            if (selectedEnv === activeEnv) {
                logger.log('');
                logger.warn(`⚠️  This is the currently active environment!`);
            }

            logger.log('');
            const { confirm } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: `Delete environment '${selectedEnv}'?`,
                    default: false,
                } as any,
            ]);

            if (!confirm) {
                logger.info('Deletion cancelled');
                process.exit(0);
            }

            logger.log('');
            logger.startSpinner('Deleting environment...');
            await deleteEnvConfig(selectedEnv);
            logger.succeedSpinner('Environment deleted');

            logger.log('');
            logger.success(`✅ Environment '${selectedEnv}' has been deleted`);

            const newActiveEnv = await getActiveEnv();
            if (newActiveEnv && newActiveEnv !== selectedEnv) {
                logger.log('');
                logger.log(`Active environment is now: ${chalk.cyan(newActiveEnv)}`);
            } else if (!newActiveEnv) {
                logger.log('');
                logger.warn('No active environment set. Configure a new one:');
                logger.log('  pnpm cli configure <env-name>');
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('create [count]')
    .description('Create one or more schemas from the base template')
    .option('-f, --force', 'Force recreate if schema already exists (single mode only)')
    .option('-n, --name <name>', 'Custom schema name (must start with "account_", single mode only)')
    .option('-s, --suffix <suffix>', 'Suffix to append to autogenerated schema name')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--seed', 'Run seed files after schema creation')
    .action(async (count, options) => {
        try {
            const schemaCount = count ? parseInt(count, 10) : 1;

            if (isNaN(schemaCount) || schemaCount < 1) {
                logger.error('Count must be a positive integer');
                process.exit(1);
            }

            if (schemaCount > 100) {
                logger.error('Maximum 100 schemas can be created at once');
                process.exit(1);
            }

            if (schemaCount === 1) {
                const envName = (await getActiveEnv()) || (await promptEnvSelection('Select environment for schema creation:'));
                const templatePath = await getEnvTemplatePath(envName);
                if (!templatePath) {
                    logger.log('');
                    logger.warn(`No template configured for environment '${envName}'.`);
                    logger.log(`Run ${chalk.cyan('phantm use <path-to-sql-file>')} to configure one.`);
                    process.exit(1);
                }

                logger.header('🚀 Schema Creation');
                logger.startSpinner('Testing database connection...');
                await testConnection();
                logger.succeedSpinner('Database connection successful');

                logger.startSpinner('Verifying common schema...');
                await verifyCommonSchema();
                logger.succeedSpinner('Common schema verified');

                const envConfig = await getEnvConfig(envName);
                const awsConfig = getAwsConfig(envConfig);
                if (!awsConfig) {
                    logger.log('');
                    logger.info('AWS credentials not configured for this environment; DynamoDB table creation will be skipped.');
                }

                if (!options.yes) {
                    const answer = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'proceed',
                            message: options.force
                                ? 'This will recreate the schema if it exists. Continue?'
                                : 'Create a new schema?',
                            default: true,
                        },
                    ]);

                    if (!answer.proceed) {
                        logger.info('Operation cancelled');
                        process.exit(0);
                    }
                }

                logger.divider();
                const result = await createSchema({
                    envName,
                    force: options.force,
                    customName: options.name,
                    suffix: options.suffix,
                });

                if (result.success) {
                    logger.divider();
                    logger.success('✅ Schema creation completed successfully!');
                    logger.log('');
                    logger.log(chalk.bold('Schema Details:'));
                    logger.log(`  Name: ${chalk.cyan(result.schemaName)}`);
                    logger.log(`  ID:   ${chalk.cyan(result.schemaId)}`);
                    logger.log('');

                    logger.startSpinner('Validating schema structure...');
                    const isValid = await validateSchemaStructure(result.schemaName);
                    if (isValid) {
                        logger.succeedSpinner('Schema structure validated successfully');
                    } else {
                        logger.warnSpinner('Schema structure validation found issues');
                    }

                    if (awsConfig) {
                        await createDynamoTableForSchema(envName, result.schemaName, awsConfig);
                    } else {
                        logger.log('');
                        logger.info('AWS credentials not configured for this environment; skipping DynamoDB table creation.');
                    }

                    // Auto-seed if --seed flag is set
                    if (options.seed) {
                        const seedPath = await getEnvSeedPath(envName);
                        if (!seedPath) {
                            logger.log('');
                            logger.warn('--seed flag used but no seed folder configured.');
                            logger.log(`Run ${chalk.cyan('phantm use <sql-file> --seed <seed-folder-path>')} to configure one.`);
                        } else {
                            logger.log('');
                            logger.header('🌱 Auto-Seeding');
                            await ensureSeededFilesColumn();
                            logger.startSpinner(`Seeding ${result.schemaName}...`);
                            const seedResult = await seedSchema(result.schemaName, envName);
                            if (seedResult.success) {
                                logger.succeedSpinner(`Seeded ${result.schemaName}: ${seedResult.applied.length} file(s) applied`);
                                seedResult.applied.forEach(f => logger.log(`    ${chalk.green('+')} ${f}`));
                            } else {
                                logger.failSpinner(`Seeding failed for ${result.schemaName}`);
                                if (seedResult.failed) {
                                    logger.error(`  Failed on: ${seedResult.failed.file}`);
                                    logger.error(`  ${seedResult.failed.error}`);
                                }
                            }
                        }
                    }
                } else {
                    logger.error(`Schema creation failed: ${result.error}`);
                    process.exit(1);
                }
            } else {
                const envName = (await getActiveEnv()) || (await promptEnvSelection('Select environment for schema creation:'));
                const templatePath = await getEnvTemplatePath(envName);
                if (!templatePath) {
                    logger.log('');
                    logger.warn(`No template configured for environment '${envName}'.`);
                    logger.log(`Run ${chalk.cyan('phantm use <path-to-sql-file>')} to configure one.`);
                    process.exit(1);
                }

                logger.header(`🚀 Bulk Schema Creation (${schemaCount} schemas)`);

                logger.startSpinner('Testing database connection...');
                await testConnection();
                logger.succeedSpinner('Database connection successful');

                logger.startSpinner('Verifying common schema...');
                await verifyCommonSchema();
                logger.succeedSpinner('Common schema verified');

                const envConfig = await getEnvConfig(envName);
                const awsConfig = getAwsConfig(envConfig);
                if (!awsConfig) {
                    logger.log('');
                    logger.info('AWS credentials not configured for this environment; DynamoDB table creation will be skipped.');
                }

                if (!options.yes) {
                    const answer = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'proceed',
                            message: `Create ${schemaCount} new schema${schemaCount > 1 ? 's' : ''}?`,
                            default: true,
                        },
                    ]);

                    if (!answer.proceed) {
                        logger.info('Operation cancelled');
                        process.exit(0);
                    }
                }

                // Pre-check seed path for bulk mode
                let seedPathForBulk: string | null = null;
                if (options.seed) {
                    seedPathForBulk = await getEnvSeedPath(envName);
                    if (!seedPathForBulk) {
                        logger.warn('--seed flag used but no seed folder configured.');
                        logger.log(`Run ${chalk.cyan('phantm use <sql-file> --seed <seed-folder-path>')} to configure one.`);
                    } else {
                        await ensureSeededFilesColumn();
                        logger.info(`Auto-seeding enabled from: ${chalk.cyan(seedPathForBulk)}`);
                    }
                }

                logger.log('');
                logger.divider();

                const results = {
                    successful: [] as string[],
                    failed: [] as { name: string; error: string }[],
                };

                for (let i = 1; i <= schemaCount; i++) {
                    logger.log(`\n${chalk.bold(`[${i}/${schemaCount}]`)} Creating schema...`);

                    const result = await createSchema({
                        envName,
                        force: false,
                        suffix: options.suffix,
                    });

                    if (result.success) {
                        results.successful.push(result.schemaName);
                        logger.success(`✓ ${chalk.cyan(result.schemaName)} created (ID: ${result.schemaId})`);
                        if (awsConfig) {
                            await createDynamoTableForSchema(envName, result.schemaName, awsConfig);
                        }

                        // Auto-seed if --seed flag is set
                        if (options.seed && seedPathForBulk) {
                            logger.startSpinner(`  Seeding ${result.schemaName}...`);
                            try {
                                const seedResult = await seedSchema(result.schemaName, envName);
                                if (seedResult.success) {
                                    logger.succeedSpinner(`  Seeded ${result.schemaName}: ${seedResult.applied.length} file(s) applied`);
                                } else {
                                    logger.failSpinner(`  Seeding failed for ${result.schemaName}`);
                                    if (seedResult.failed) {
                                        logger.error(`    Failed on: ${seedResult.failed.file} - ${seedResult.failed.error}`);
                                    }
                                }
                            } catch (seedError) {
                                logger.failSpinner(`  Seeding error for ${result.schemaName}`);
                                logger.error(`    ${seedError instanceof Error ? seedError.message : String(seedError)}`);
                            }
                        }
                    } else {
                        results.failed.push({
                            name: result.schemaName,
                            error: result.error || 'Unknown error',
                        });
                        logger.error(`✗ Failed: ${result.error}`);
                    }
                }

                logger.log('');
                logger.divider();
                logger.header('📊 Bulk Creation Summary');

                logger.success(`✅ Successfully created: ${chalk.bold(results.successful.length)} schema${results.successful.length !== 1 ? 's' : ''}`);

                if (results.successful.length > 0) {
                    logger.log('');
                    logger.log(chalk.bold('Created schemas:'));
                    results.successful.forEach((name, index) => {
                        logger.log(`  ${index + 1}. ${chalk.cyan(name)}`);
                    });
                }

                if (results.failed.length > 0) {
                    logger.log('');
                    logger.error(`❌ Failed: ${chalk.bold(results.failed.length)} schema${results.failed.length !== 1 ? 's' : ''}`);
                    logger.log('');
                    logger.log(chalk.bold('Failed schemas:'));
                    results.failed.forEach((item, index) => {
                        logger.log(`  ${index + 1}. ${chalk.red(item.name)}: ${item.error}`);
                    });
                }

                logger.log('');
                logger.divider();

                if (results.failed.length > 0) {
                    process.exit(1);
                }
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });

program
    .command('list')
    .description('List all schemas in the pool')
    .option('-s, --status <status>', 'Filter by status (AVAILABLE, ALLOCATED, DELETED)')
    .action(async (options) => {
        try {
            logger.header('📋 Schema Pool');

            logger.startSpinner('Connecting to database...');
            await testConnection();
            logger.succeedSpinner('Connected');

            logger.startSpinner('Fetching schemas...');
            const schemas = await listSchemas(options.status);
            logger.succeedSpinner(`Found ${schemas.length} schema(s)`);

            // Try to ensure seeded_files column exists for display
            let hasSeededColumn = false;
            try {
                await ensureSeededFilesColumn();
                hasSeededColumn = true;
            } catch {
                // Column may not exist yet, that's okay
            }

            if (schemas.length === 0) {
                logger.info('No schemas found in the pool');
                return;
            }

            logger.log('');
            logger.divider();

            for (let index = 0; index < schemas.length; index++) {
                const schema = schemas[index];
                logger.log(`${chalk.bold(`${index + 1}.`)} ${chalk.cyan(schema.schema_name)}`);
                logger.log(`   ID:         ${schema.schema_id}`);
                logger.log(`   Status:     ${getStatusColor(schema.status)}${schema.status}${chalk.reset()}`);
                logger.log(`   Account ID: ${schema.account_id || chalk.gray('N/A')}`);
                logger.log(`   Created:    ${schema.created_at ? new Date(schema.created_at).toLocaleString() : 'N/A'}`);

                if (schema.allocated_at) {
                    logger.log(`   Allocated:  ${new Date(schema.allocated_at).toLocaleString()}`);
                }

                if (hasSeededColumn) {
                    try {
                        const seededFiles = await getSeededFiles(schema.schema_name);
                        logger.log(`   Seeded:     ${chalk.cyan(seededFiles.length)} file(s)`);
                    } catch {
                        // Ignore errors for display
                    }
                }

                if (index < schemas.length - 1) {
                    logger.log('');
                }
            }

            logger.divider();
            logger.log(`${chalk.bold('Total:')} ${schemas.length} schema(s)`);
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });

program
    .command('delete [schema-name]')
    .description('Delete a schema and remove it from the schema pool')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--all-available', 'Delete all schemas with AVAILABLE status')
    .action(async (schemaName, options) => {
        try {
            logger.header('🗑️  Delete Schema');

            const envName = await getActiveEnv();
            if (!envName) {
                logger.error('No active environment. Run phantm switch first.');
                process.exit(1);
            }
            const envConfig = await getEnvConfig(envName);
            const awsConfig = getAwsConfig(envConfig);

            if (options.allAvailable) {
                // --- Bulk delete all AVAILABLE schemas ---
                logger.startSpinner('Testing database connection...');
                await testConnection();
                logger.succeedSpinner('Database connection successful');

                logger.startSpinner('Verifying common schema...');
                await verifyCommonSchema();
                logger.succeedSpinner('Common schema verified');

                logger.startSpinner('Fetching AVAILABLE schemas...');
                const availableSchemas = await listSchemas('AVAILABLE');
                logger.succeedSpinner(`Found ${availableSchemas.length} AVAILABLE schema(s)`);

                if (availableSchemas.length === 0) {
                    logger.info('No AVAILABLE schemas to delete.');
                    process.exit(0);
                }

                logger.log('');
                logger.log(chalk.bold('Schemas to delete:'));
                for (const s of availableSchemas) {
                    logger.log(`  • ${chalk.cyan(s.schema_name)}`);
                }
                logger.log('');

                if (!options.yes) {
                    logger.warn('⚠️  This action will:');
                    logger.log('  • Drop each schema and all its objects from the database');
                    logger.log('  • Mark each schema as DELETED in the schema_pool table');
                    logger.log('  • Delete the associated DynamoDB table for each schema');
                    logger.log('  • This action cannot be undone!');
                    logger.log('');

                    const answer = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'proceed',
                            message: `Delete all ${availableSchemas.length} AVAILABLE schema(s)?`,
                            default: false,
                        },
                    ]);

                    if (!answer.proceed) {
                        logger.info('Deletion cancelled');
                        process.exit(0);
                    }
                }

                let successCount = 0;
                let failCount = 0;

                for (const schema of availableSchemas) {
                    logger.log('');
                    logger.divider();
                    logger.log(chalk.bold(`Deleting: ${chalk.cyan(schema.schema_name)}`));
                    try {
                        await deleteSchemaAndMark(schema.schema_name);
                        if (awsConfig) {
                            await deleteDynamoTableForSchema(envName, schema.schema_name, awsConfig);
                        }
                        successCount++;
                    } catch (err) {
                        logger.error(`Failed to delete '${schema.schema_name}': ${err instanceof Error ? err.message : String(err)}`);
                        failCount++;
                    }
                }

                logger.log('');
                logger.divider();
                logger.log('');
                logger.success(`✅ Deleted: ${successCount}, Failed: ${failCount}`);
            } else {
                // --- Single schema delete ---
                if (!schemaName) {
                    logger.error('Please provide a schema name or use --all-available');
                    process.exit(1);
                }

                if (!/^account_[a-z0-9_]+$/.test(schemaName)) {
                    logger.error('Schema name must start with "account_" and contain only lowercase letters, numbers, and underscores');
                    process.exit(1);
                }

                logger.startSpinner('Testing database connection...');
                await testConnection();
                logger.succeedSpinner('Database connection successful');

                logger.startSpinner('Verifying common schema...');
                await verifyCommonSchema();
                logger.succeedSpinner('Common schema verified');

                logger.startSpinner('Checking schema existence...');
                const schemaInfo = await getSchemaFromPool(schemaName);
                logger.succeedSpinner('Schema check complete');

                if (!schemaInfo) {
                    logger.log('');
                    logger.warn(`Schema '${schemaName}' not found in schema pool`);

                    const pool = await (await import('./db/connection.js')).getPool();
                    const dbCheck = await pool.query(
                        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
                        [schemaName]
                    );

                    if (dbCheck.rowCount === 0) {
                        logger.error(`Schema '${schemaName}' does not exist in database or pool`);
                        process.exit(1);
                    }

                    logger.warn(`Schema exists in database but not in pool. Will attempt to delete from database.`);
                }

                if (schemaInfo) {
                    logger.log('');
                    logger.log(chalk.bold('Schema Details:'));
                    logger.log(`  Name:       ${chalk.cyan(schemaInfo.schema_name)}`);
                    logger.log(`  ID:         ${chalk.cyan(schemaInfo.schema_id || 'N/A')}`);
                    logger.log(`  Status:     ${getStatusColor(schemaInfo.status)}${schemaInfo.status}${chalk.reset()}`);
                    logger.log(`  Account ID: ${schemaInfo.account_id || chalk.gray('N/A')}`);
                    logger.log(`  Created:    ${schemaInfo.created_at ? new Date(schemaInfo.created_at).toLocaleString() : 'N/A'}`);
                    logger.log('');
                }

                if (!options.yes) {
                    logger.log('');
                    logger.warn('⚠️  This action will:');
                    logger.log('  • Drop the schema and all its objects from the database');
                    logger.log('  • Mark the schema as DELETED in the schema_pool table');
                    logger.log('  • Delete the associated DynamoDB table');
                    logger.log('  • This action cannot be undone!');
                    logger.log('');

                    const answer = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'proceed',
                            message: `Delete schema '${schemaName}'?`,
                            default: false,
                        },
                    ]);

                    if (!answer.proceed) {
                        logger.info('Deletion cancelled');
                        process.exit(0);
                    }
                }

                logger.log('');
                logger.divider();
                await deleteSchemaAndMark(schemaName);
                if (awsConfig) {
                    await deleteDynamoTableForSchema(envName, schemaName, awsConfig);
                }
                logger.divider();
                logger.log('');
                logger.success(`✅ Schema '${chalk.cyan(schemaName)}' has been successfully deleted`);
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });

program
    .command('validate')
    .description('Validate the configured SQL template')
    .action(async () => {
        try {
            logger.header('🔍 Template Validation');

            const envName = await promptEnvSelection('Select environment to validate template for:');
            const templatePath = await getEnvTemplatePath(envName);

            if (!templatePath) {
                logger.log('');
                logger.warn(`No template configured for environment '${envName}'.`);
                logger.log('');
                logger.log(`Run ${chalk.cyan('phantm use <path-to-sql-file>')} to configure a template.`);
                process.exit(1);
            }

            logger.log('');
            logger.log(chalk.bold('Template:'));
            logger.log(`  ${chalk.cyan(templatePath)}`);
            logger.log('');

            logger.startSpinner('Reading template...');
            const template = await readBaseSchema(envName);
            logger.succeedSpinner('Template loaded');

            logger.startSpinner('Validating SQL structure...');
            validateSQL(template);
            logger.succeedSpinner('SQL structure is valid');

            logger.startSpinner('Analyzing template...');
            const analysis = analyzeSchemaTemplate(template);
            logger.succeedSpinner('Analysis complete');

            logger.log('');
            logger.success('✅ Template is valid!');
            logger.log('');
            logger.divider();
            logger.log(chalk.bold('Template Statistics:'));
            logger.log(`  ${chalk.bold('Types:')}         ${chalk.cyan(analysis.typeCount)}`);
            logger.log(`  ${chalk.bold('Tables:')}        ${chalk.cyan(analysis.tableCount)}`);
            logger.log(`  ${chalk.bold('Indexes:')}       ${chalk.cyan(analysis.indexCount)}`);
            logger.log(`  ${chalk.bold('Foreign Keys:')}  ${chalk.cyan(analysis.foreignKeyCount)}`);
            logger.divider();
        } catch (error) {
            logger.failSpinner();
            logger.error(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

const infoCommand = program
    .command('info')
    .description('Show information');

infoCommand
    .command('schema <schema-name>')
    .description('Get detailed information about a schema')
    .action(async (schemaName) => {
        try {
            logger.header(`📊 Schema Information: ${schemaName}`);

            logger.startSpinner('Connecting to database...');
            await testConnection();
            logger.succeedSpinner('Connected');

            logger.startSpinner('Fetching schema details...');
            const schema = await getSchemaFromPool(schemaName);

            if (!schema) {
                logger.failSpinner(`Schema '${schemaName}' not found in pool`);
                process.exit(1);
            }

            logger.succeedSpinner('Schema found');

            logger.log('');
            logger.divider();
            logger.log(chalk.bold('Schema Details:'));
            logger.log(`  Name:       ${chalk.cyan(schema.schema_name)}`);
            logger.log(`  ID:         ${schema.schema_id}`);
            logger.log(`  Status:     ${getStatusColor(schema.status)}${schema.status}${chalk.reset()}`);
            logger.log(`  Account ID: ${schema.account_id || chalk.gray('N/A')}`);
            logger.log(`  Created:    ${schema.created_at ? new Date(schema.created_at).toLocaleString() : 'N/A'}`);

            if (schema.allocated_at) {
                logger.log(`  Allocated:  ${new Date(schema.allocated_at).toLocaleString()}`);
            }

            if (schema.updated_at) {
                logger.log(`  Updated:    ${new Date(schema.updated_at).toLocaleString()}`);
            }

            logger.log('');
            logger.startSpinner('Validating schema structure...');
            const isValid = await validateSchemaStructure(schemaName);
            if (isValid) {
                logger.succeedSpinner('Schema structure is valid');
            } else {
                logger.warnSpinner('Schema structure has issues');
            }

            logger.divider();
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });

infoCommand
    .command('ddl')
    .description('Show schema creation DDL from template (env-specific)')
    .action(async () => {
        try {
            const envName = await promptEnvSelection();

            const templatePath = await getEnvTemplatePath(envName);

            if (!templatePath) {
                logger.warn(`No template set for environment '${envName}'. Run 'phantm use <path>' to set one.`);
                return;
            }

            logger.header('📜 Schema Creation DDL');
            logger.info(`Environment: ${envName}`);
            logger.info(`Template: ${templatePath}`);

            const schemaSQL = await generateSchemaSQL('migration_pool_schema', envName);

            logger.divider();
            logger.log(schemaSQL);
            logger.divider();
        } catch (error) {
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

infoCommand
    .command('seed [schema-name]')
    .description('Show seed configuration and status for a schema')
    .action(async (schemaName) => {
        try {
            const envName = (await getActiveEnv()) || (await promptEnvSelection('Select environment:'));

            logger.header(`🌱 Seed Information (${envName})`);

            const seedPath = await getEnvSeedPath(envName);
            logger.log('');
            logger.log(chalk.bold('Seed Configuration:'));
            logger.log(`  Environment: ${chalk.cyan(envName)}`);
            logger.log(`  Seed folder: ${seedPath ? chalk.cyan(seedPath) : chalk.gray('Not configured')}`);

            if (!seedPath) {
                logger.log('');
                logger.warn('No seed folder configured.');
                logger.log(`Run ${chalk.cyan('phantm use <sql-file> --seed <seed-folder-path>')} to configure one.`);
                process.exit(0);
            }

            // Discover seed files
            let seedFiles: string[] = [];
            try {
                seedFiles = await discoverSeedFiles(seedPath);
            } catch (error) {
                logger.log('');
                logger.error(`Cannot read seed folder: ${error instanceof Error ? error.message : String(error)}`);
                process.exit(1);
            }

            logger.log(`  Seed files:  ${chalk.cyan(seedFiles.length)}`);
            logger.log('');

            if (seedFiles.length > 0) {
                logger.log(chalk.bold('Available seed files:'));
                seedFiles.forEach((f, i) => {
                    logger.log(`  ${chalk.gray(`${i + 1}.`)} ${f}`);
                });
            }

            if (schemaName) {
                logger.startSpinner('Connecting to database...');
                await testConnection();
                logger.succeedSpinner('Connected');

                await verifyCommonSchema();
                await ensureSeededFilesColumn();

                const schema = await getSchemaFromPool(schemaName);
                if (!schema) {
                    logger.log('');
                    logger.error(`Schema '${schemaName}' not found in schema_pool`);
                    process.exit(1);
                }

                const seeded = await getSeededFiles(schemaName);
                const pending = getPendingSeedFiles(seedFiles, seeded);

                logger.log('');
                logger.divider();
                logger.log(chalk.bold(`Seed status for ${chalk.cyan(schemaName)}:`));
                logger.log(`  Applied: ${chalk.green(seeded.length)}`);
                logger.log(`  Pending: ${chalk.yellow(pending.length)}`);
                logger.log('');

                if (seeded.length > 0) {
                    logger.log(chalk.bold('Applied:'));
                    seeded.forEach(s => {
                        logger.log(`  ${chalk.green('✓')} ${s.file} ${chalk.gray(`(${s.applied_at})`)}`);
                    });
                }

                if (pending.length > 0) {
                    logger.log(chalk.bold('Pending:'));
                    pending.forEach(f => {
                        logger.log(`  ${chalk.yellow('○')} ${f}`);
                    });
                }

                logger.divider();
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });

envCommand
    .command('check')
    .description('Test database connection and verify setup')
    .action(async () => {
        try {
            logger.header('🔌 Database Connection Test');

            logger.startSpinner('Testing database connection...');
            await testConnection();
            logger.succeedSpinner('Database connection successful');

            logger.startSpinner('Verifying common schema exists...');
            await verifyCommonSchema();
            logger.succeedSpinner('Common schema and schema_pool table verified');

            logger.log('');
            logger.success('✅ All checks passed! Database is ready.');
            logger.log('');
            logger.log(chalk.bold('Connection Details:'));
            const config = await getDatabaseConfig();
            logger.log(`  Host:     ${chalk.cyan(config.host)}`);
            logger.log(`  Port:     ${chalk.cyan(config.port)}`);
            logger.log(`  Database: ${chalk.cyan(config.database)}`);
            logger.log(`  User:     ${chalk.cyan(config.user)}`);
            logger.log(`  SSL:      ${chalk.cyan(config.ssl ? 'Enabled' : 'Disabled')}`);
        } catch (error) {
            logger.failSpinner();
            logger.error(`Connection test failed: ${error instanceof Error ? error.message : String(error)}`);
            logger.log('');
            logger.warn('Please check your .env file and database settings.');
            process.exit(1);
        } finally {
            await closePool();
        }
    });

program
    .command('use <sql-file-path>')
    .description('Configure a SQL template file to use for schema creation')
    .option('-s, --seed <seed-folder-path>', 'Path to seed files folder')
    .action(async (sqlFilePath, options) => {
        try {
            logger.header('📄 Configure SQL Template');
            const resolvedPath = resolve(sqlFilePath);
            logger.startSpinner('Validating file path...');
            try {
                await access(resolvedPath, constants.R_OK);
            } catch (error) {
                logger.failSpinner();
                logger.error(`Cannot access file: ${resolvedPath}`);
                logger.error('Please check the file path and permissions');
                process.exit(1);
            }
            logger.succeedSpinner('File path is valid');
            logger.startSpinner('Reading template file...');
            let template: string;
            try {
                template = await readSchemaFromPath(resolvedPath);
            } catch (error) {
                logger.failSpinner();
                logger.error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
                process.exit(1);
            }
            logger.succeedSpinner('Template loaded');
            logger.startSpinner('Validating SQL structure...');
            try {
                validateSQL(template);
            } catch (error) {
                logger.failSpinner();
                logger.error(`Invalid SQL template: ${error instanceof Error ? error.message : String(error)}`);
                process.exit(1);
            }
            logger.succeedSpinner('SQL structure is valid');
            logger.startSpinner('Analyzing template...');
            const analysis = analyzeSchemaTemplate(template);
            logger.succeedSpinner('Analysis complete');

            logger.log('');
            logger.divider();
            logger.log(chalk.bold('📊 Schema Template Preview:'));
            logger.log('');
            logger.log(`  ${chalk.bold('Authorization:')} ${analysis.authorization ? chalk.cyan(analysis.authorization) : chalk.gray('Not specified')}`);
            logger.log(`  ${chalk.bold('Types:')}         ${chalk.cyan(analysis.typeCount)}`);
            logger.log(`  ${chalk.bold('Tables:')}        ${chalk.cyan(analysis.tableCount)}`);
            logger.log(`  ${chalk.bold('Indexes:')}       ${chalk.cyan(analysis.indexCount)}`);
            logger.log(`  ${chalk.bold('Foreign Keys:')}  ${chalk.cyan(analysis.foreignKeyCount)}`);
            logger.log('');

            if (analysis.tableNames.length > 0) {
                logger.log(chalk.bold('Tables Found:'));
                const displayTables = analysis.tableNames.slice(0, 8);
                displayTables.forEach(table => {
                    logger.log(`  ${chalk.gray('•')} ${table}`);
                });
                if (analysis.tableNames.length > 8) {
                    logger.log(`  ${chalk.gray(`... and ${analysis.tableNames.length - 8} more`)}`);
                }
                logger.log('');
            }

            logger.log(chalk.bold('File Path:'));
            logger.log(`  ${chalk.cyan(resolvedPath)}`);
            logger.divider();
            logger.log('');

            const envName = await promptEnvSelection('Select environment to associate this template with:');

            const answer = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: `Save this template for environment '${envName}'?`,
                    default: true,
                },
            ]);

            if (!answer.confirm) {
                logger.info('Operation cancelled');
                process.exit(0);
            }

            logger.startSpinner('Saving template configuration...');
            await setEnvTemplatePath(envName, resolvedPath);
            logger.succeedSpinner('Template configuration saved');

            // Handle --seed option
            if (options.seed) {
                const resolvedSeedPath = resolve(options.seed);
                logger.startSpinner('Validating seed folder path...');
                try {
                    const seedStat = await stat(resolvedSeedPath);
                    if (!seedStat.isDirectory()) {
                        logger.failSpinner();
                        logger.error(`Seed path is not a directory: ${resolvedSeedPath}`);
                        process.exit(1);
                    }
                } catch (error) {
                    logger.failSpinner();
                    logger.error(`Cannot access seed folder: ${resolvedSeedPath}`);
                    logger.error('Please check the folder path and permissions');
                    process.exit(1);
                }
                logger.succeedSpinner('Seed folder path is valid');

                logger.startSpinner('Saving seed folder configuration...');
                await setEnvSeedPath(envName, resolvedSeedPath);
                logger.succeedSpinner('Seed folder configuration saved');

                logger.log('');
                logger.success(`✅ Seed folder configured: ${chalk.cyan(resolvedSeedPath)}`);
            }

            logger.log('');
            logger.success(`✅ Template configured for environment '${envName}'`);
            logger.log('');
            logger.log(`You can now use ${chalk.cyan('phantm create <schema-name>')} to create schemas.`);
            logger.log(`Config saved to: ${chalk.gray(getConfigFilePath())}`);
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

infoCommand
    .command('template')
    .description('Show SQL template configuration for an environment')
    .action(async () => {
        try {
            const envName = await promptEnvSelection('Select environment to view template for:');
            logger.header(`📄 Template Configuration (${envName})`);
            const templatePath = await getEnvTemplatePath(envName);
            if (!templatePath) {
                logger.log('');
                logger.warn(`No template configured for environment '${envName}'.`);
                logger.log('');
                logger.log(`Run ${chalk.cyan('phantm use <path-to-sql-file>')} to configure a template.`);
                process.exit(0);
            }

            logger.log('');
            logger.log(chalk.bold('Current Template:'));
            logger.log(`  ${chalk.cyan(templatePath)}`);
            logger.log('');
            logger.startSpinner('Checking file accessibility...');
            try {
                await access(templatePath, constants.R_OK);
                logger.succeedSpinner('File is accessible');

                logger.startSpinner('Analyzing template...');
                const template = await readSchemaFromPath(templatePath);
                const analysis = analyzeSchemaTemplate(template);
                logger.succeedSpinner('Analysis complete');

                logger.log('');
                logger.divider();
                logger.log(chalk.bold('Template Details:'));
                logger.log('');
                logger.log(`  ${chalk.bold('Authorization:')} ${analysis.authorization ? chalk.cyan(analysis.authorization) : chalk.gray('Not specified')}`);
                logger.log(`  ${chalk.bold('Types:')}         ${chalk.cyan(analysis.typeCount)}`);
                logger.log(`  ${chalk.bold('Tables:')}        ${chalk.cyan(analysis.tableCount)}`);
                logger.log(`  ${chalk.bold('Indexes:')}       ${chalk.cyan(analysis.indexCount)}`);
                logger.log(`  ${chalk.bold('Foreign Keys:')}  ${chalk.cyan(analysis.foreignKeyCount)}`);
                logger.divider();
            } catch (error) {
                logger.failSpinner();
                logger.warn('File is not accessible or has been moved');
                logger.log('');
                logger.log(`Run ${chalk.cyan('phantm use <path-to-sql-file>')} to update the template path.`);
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('template clear')
    .description('Clear the configured SQL template for an environment')
    .action(async () => {
        try {
            const envName = await promptEnvSelection('Select environment to clear template for:');
            logger.header(`🗑️  Clear Template Configuration (${envName})`);
            const templatePath = await getEnvTemplatePath(envName);
            if (!templatePath) {
                logger.log('');
                logger.info(`No template is configured for environment '${envName}'.`);
                process.exit(0);
            }

            logger.log('');
            logger.log(chalk.bold('Current Template:'));
            logger.log(`  ${chalk.cyan(templatePath)}`);
            logger.log('');

            const answer = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: 'Clear this template configuration?',
                    default: false,
                },
            ]);

            if (!answer.confirm) {
                logger.info('Operation cancelled');
                process.exit(0);
            }

            logger.startSpinner('Clearing template configuration...');
            await clearEnvTemplatePath(envName);
            logger.succeedSpinner('Template configuration cleared');

            logger.log('');
            logger.success('✅ Template configuration removed');
            logger.log('');
            logger.log(`Run ${chalk.cyan('phantm use <path-to-sql-file>')} to configure a new template.`);
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('unuse')
    .description('Remove the configured SQL template for an environment')
    .action(async () => {
        try {
            const envName = await promptEnvSelection('Select environment to remove template for:');
            logger.header(`🗑️  Remove SQL Template (${envName})`);
            const templatePath = await getEnvTemplatePath(envName);
            if (!templatePath) {
                logger.log('');
                logger.info(`No template is configured for environment '${envName}'.`);
                process.exit(0);
            }

            logger.log('');
            logger.log(chalk.bold('Current Template:'));
            logger.log(`  ${chalk.cyan(templatePath)}`);
            logger.log('');

            const answer = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: `Remove the template for environment '${envName}'?`,
                    default: false,
                },
            ]);

            if (!answer.confirm) {
                logger.info('Operation cancelled');
                process.exit(0);
            }

            logger.startSpinner('Removing template configuration...');
            await clearEnvTemplatePath(envName);
            logger.succeedSpinner('Template configuration removed');

            logger.log('');
            logger.success('✅ Template configuration removed');
            logger.log('');
            logger.log(`Run ${chalk.cyan('phantm use <path-to-sql-file>')} to configure a new template.`);
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('dynamodb:list-tables')
    .description('List DynamoDB tables')
    .action(async () => {
        try {
            logger.header('📋 DynamoDB Tables');

            const envName = await getActiveEnv();
            if (!envName) {
                logger.error('No active environment set. Use "phantm env:use <name>" first.');
                process.exit(1);
            }

            const config = await getEnvConfig(envName);
            if (!config) {
                logger.error(`Environment '${envName}' not found`);
                process.exit(1);
            }

            if (!config.region) {
                logger.error('AWS region not configured. Please configure AWS credentials first.');
                process.exit(1);
            }

            logger.log('');
            logger.log(chalk.bold('Configuration:'));
            logger.log(`  Environment: ${chalk.cyan(envName)}`);
            logger.log(`  Region:      ${chalk.cyan(config.region)}`);
            logger.log('');

            logger.startSpinner('Fetching tables...');
            const dynamoDB = new DynamoDBClient({
                region: config.region,
                credentials: {
                    accessKeyId: config.awsAccessKeyId!,
                    secretAccessKey: config.awsSecretAccessKey!,
                },
            });
            const tables = await dynamoDB.send(new ListTablesCommand({}));
            logger.succeedSpinner(`Found ${tables.TableNames?.length} table(s)`);

            if (tables.TableNames && tables.TableNames.length > 0) {
                logger.log('');
                tables.TableNames.forEach((tableName, index) => {
                    logger.log(`  ${index + 1}. ${chalk.cyan(tableName)}`);
                });
            } else {
                logger.info('No tables found');
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('import <import-data-folder-path>')
    .description('Import CSV files into schema tables from folder structure')
    .option('--order <tables>', 'Comma-separated table names in import order')
    .option('--auto-order-from <schema-name>', 'Auto-generate table order from FK relations in the given schema')
    .option('--mode <mode>', 'Import mode: append | truncate | upsert', 'append')
    .option('-r, --rollback-and-contiue', 'Rollback failed account and continue importing next accounts')
    .option('--dry-run', 'Validate CSV and table mappings without writing data')
    .option('--precheck-db-casts', 'Validate by executing DB casts/inserts inside transaction and rolling back')
    .option('--report <file-path>', 'Write JSON import report to a file')
    .option('--from-account <schema-name>', 'Start processing from this account folder (inclusive)')
    .option('--only-account <schema-name>', 'Process only this account folder')
    .option('--resume-failed-from-report <file-path>', 'Resume only failed accounts from a previous report')
    .option('--strict-columns', 'Validate that CSV columns exactly match table insertable columns')
    .option('--validate-not-null', 'Validate NOT NULL required columns are present and non-empty')
    .option('--strict-types', 'Validate common PostgreSQL types before import')
    .option('--null-string <value>', 'Treat this exact CSV value as NULL (e.g. NULL)')
    .option('--empty-as-null', 'Convert empty CSV values ("") to NULL for all column types')
    .option('--json-empty-as-null', 'Convert empty CSV values ("") to NULL for json/jsonb columns')
    .option('--enum-empty-as-null', 'Convert empty CSV values ("") to NULL for enum columns')
    .option('--numeric-empty-as-null', 'Convert empty CSV values ("") to NULL for numeric columns')
    .option('--trim-values', 'Trim whitespace around CSV values before validation/import')
    .option('--auto-sanitize', 'Sanitize problematic control characters and JSON unicode escapes before import')
    .option('-y, --yes', 'Skip account confirmation prompts')
    .action(async (importDataFolderPath, options) => {
        try {
            logger.header('📥 Data Import');

            const envName = (await getActiveEnv()) || (await promptEnvSelection('Select environment for import:'));
            const resolvedImportPath = resolve(importDataFolderPath);
            const manualOrder = options.order ? parseTableOrder(String(options.order)) : null;
            const autoOrderFrom = options.autoOrderFrom ? String(options.autoOrderFrom) : null;
            const rawMode = String(options.mode ?? 'append').toLowerCase();
            const rollbackAndContiue = options.rollbackAndContiue === true;
            const dryRun = options.dryRun === true;
            const precheckDbCasts = options.precheckDbCasts === true;
            const validationOnlyMode = dryRun || precheckDbCasts;
            const skipConfirmation = options.yes === true;
            const reportPath = options.report ? resolve(options.report) : null;
            const fromAccount = options.fromAccount ? String(options.fromAccount) : null;
            const onlyAccount = options.onlyAccount ? String(options.onlyAccount) : null;
            const resumeFailedFromReport = options.resumeFailedFromReport
                ? resolve(String(options.resumeFailedFromReport))
                : null;
            const validationRules: DataValidationRules = {
                strictColumns: options.strictColumns === true,
                validateNotNull: options.validateNotNull === true,
                strictTypes: options.strictTypes === true,
                nullString: options.nullString !== undefined ? String(options.nullString) : undefined,
                emptyAsNull: options.emptyAsNull === true,
                jsonEmptyAsNull: options.jsonEmptyAsNull === true,
                enumEmptyAsNull: options.enumEmptyAsNull === true,
                numericEmptyAsNull: options.numericEmptyAsNull === true,
                trimValues: options.trimValues === true,
                autoSanitize: options.autoSanitize === true,
            };
            const hasRuleOptions =
                validationRules.strictColumns === true ||
                validationRules.validateNotNull === true ||
                validationRules.strictTypes === true ||
                validationRules.nullString !== undefined ||
                validationRules.emptyAsNull === true ||
                validationRules.jsonEmptyAsNull === true ||
                validationRules.enumEmptyAsNull === true ||
                validationRules.numericEmptyAsNull === true ||
                validationRules.trimValues === true ||
                validationRules.autoSanitize === true;
            const allowedModes: ImportMode[] = ['append', 'truncate', 'upsert'];

            if (!allowedModes.includes(rawMode as ImportMode)) {
                throw new Error(`Invalid --mode '${rawMode}'. Allowed values: append, truncate, upsert`);
            }
            const importMode = rawMode as ImportMode;

            if (fromAccount && onlyAccount) {
                throw new Error('Use either --from-account or --only-account, not both');
            }
            if (dryRun && precheckDbCasts) {
                throw new Error('Use either --dry-run or --precheck-db-casts, not both');
            }

            if (!manualOrder && !autoOrderFrom) {
                throw new Error('Provide either --order <tables> or --auto-order-from <schema-name>');
            }
            if (manualOrder && autoOrderFrom) {
                throw new Error('Use either --order or --auto-order-from, not both');
            }
            if (resumeFailedFromReport && (fromAccount || onlyAccount)) {
                throw new Error('Use --resume-failed-from-report by itself, not with --from-account/--only-account');
            }

            let importPathStats;
            try {
                importPathStats = await stat(resolvedImportPath);
            } catch (error) {
                throw new Error(
                    `Import folder '${resolvedImportPath}' does not exist: ${error instanceof Error ? error.message : String(error)}`
                );
            }

            if (!importPathStats.isDirectory()) {
                throw new Error(`Import path must be a directory: ${resolvedImportPath}`);
            }

            logger.startSpinner('Testing database connection...');
            await testConnection();
            logger.succeedSpinner('Database connection successful');

            const discoveredPlans = await discoverAccountImportPlans(resolvedImportPath, []);
            if (discoveredPlans.length === 0) {
                logger.log('');
                logger.warn('No account folders with CSV files were found.');
                logger.log(`Expected structure: ${chalk.cyan('<import-root>/<schema-name>/<table>.csv')}`);
                process.exit(1);
            }

            let plans = discoveredPlans;
            if (onlyAccount) {
                plans = plans.filter(plan => plan.schemaName === onlyAccount);
                if (plans.length === 0) {
                    throw new Error(`Account '${onlyAccount}' was not found in '${resolvedImportPath}'`);
                }
            } else if (fromAccount) {
                const startIndex = plans.findIndex(plan => plan.schemaName === fromAccount);
                if (startIndex < 0) {
                    throw new Error(`Account '${fromAccount}' was not found in '${resolvedImportPath}'`);
                }
                plans = plans.slice(startIndex);
            }

            if (resumeFailedFromReport) {
                let resumeData: any;
                try {
                    resumeData = JSON.parse(await readFile(resumeFailedFromReport, 'utf-8'));
                } catch (error) {
                    throw new Error(
                        `Failed to read resume report '${resumeFailedFromReport}': ${error instanceof Error ? error.message : String(error)}`
                    );
                }
                const failedAccounts: string[] = Array.isArray(resumeData?.accounts)
                    ? resumeData.accounts
                        .filter((account: any) => account?.status === 'failed' && typeof account?.schemaName === 'string')
                        .map((account: any) => account.schemaName as string)
                    : [];
                if (failedAccounts.length === 0) {
                    throw new Error(`No failed accounts found in report '${resumeFailedFromReport}'`);
                }
                const failedSet = new Set(failedAccounts);
                plans = plans.filter(plan => failedSet.has(plan.schemaName));
                if (plans.length === 0) {
                    throw new Error('None of the failed report accounts exist in the current import folder');
                }
            }

            let tableOrder: string[] = [];
            if (manualOrder) {
                const unknownOrderTables = findUnknownOrderedTables(manualOrder, plans);
                if (unknownOrderTables.length > 0) {
                    logger.log('');
                    logger.warn(
                        `These table(s) from --order are not found as CSV files in current scope and will be ignored: ${unknownOrderTables.join(', ')}`
                    );
                }
                tableOrder = manualOrder;
            } else if (autoOrderFrom) {
                const availableTables = Array.from(
                    new Set(plans.flatMap(plan => plan.tables.map(table => table.tableName)))
                ).sort((a, b) => a.localeCompare(b));
                const suggestion = await suggestTableOrderByForeignKeys(autoOrderFrom, availableTables);
                tableOrder = suggestion.orderedTables;

                logger.log('');
                logger.log(chalk.bold('Auto FK Order Suggestion:'));
                logger.log(`  Schema: ${chalk.cyan(autoOrderFrom)}`);
                logger.log(`  Tables: ${chalk.cyan(availableTables.join(', '))}`);
                logger.log(`  Suggested order: ${chalk.cyan(tableOrder.join(' -> '))}`);
                if (suggestion.cyclicTables.length > 0) {
                    logger.warn(
                        `Detected FK cycles or unresolved dependencies for: ${suggestion.cyclicTables.join(', ')}`
                    );
                }

                if (!skipConfirmation) {
                    const autoOrderConfirm = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'approve',
                            message: `Apply this auto-generated FK order for import?`,
                            default: false,
                        },
                    ]);
                    if (!autoOrderConfirm.approve) {
                        logger.info('Operation cancelled');
                        process.exit(0);
                    }
                }
            }

            if (tableOrder.length === 0) {
                throw new Error('Resolved table order is empty');
            }

            plans = plans.map(plan => ({
                ...plan,
                orderedTables: tableOrder
                    .map(tableName => plan.tables.find(table => table.tableName === tableName))
                    .filter(Boolean) as typeof plan.tables,
            }));

            logger.log(`  Environment: ${chalk.cyan(envName)}`);
            logger.log(`  Import path: ${chalk.cyan(resolvedImportPath)}`);
            logger.log(`  Order:       ${chalk.cyan(tableOrder.join(', '))}`);
            logger.log(`  Mode:        ${chalk.cyan(importMode)}`);
            logger.log(`  Dry run:     ${chalk.cyan(dryRun ? 'yes' : 'no')}`);
            logger.log(`  Precheck:    ${chalk.cyan(precheckDbCasts ? 'db-cast check with rollback' : 'no')}`);
            logger.log(`  Confirm:     ${chalk.cyan(skipConfirmation ? 'skipped (--yes)' : 'account-wise prompt')}`);
            logger.log(`  On failure:  ${rollbackAndContiue ? chalk.cyan('rollback account and continue') : chalk.cyan('rollback account and stop')}`);
            if (fromAccount) logger.log(`  From:        ${chalk.cyan(fromAccount)}`);
            if (onlyAccount) logger.log(`  Only:        ${chalk.cyan(onlyAccount)}`);
            if (resumeFailedFromReport) logger.log(`  Resume:      ${chalk.cyan(resumeFailedFromReport)}`);
            if (reportPath) logger.log(`  Report:      ${chalk.cyan(reportPath)}`);
            if (hasRuleOptions) {
                logger.log(`  Rules:       ${chalk.cyan([
                    validationRules.strictColumns ? 'strict-columns' : '',
                    validationRules.validateNotNull ? 'validate-not-null' : '',
                    validationRules.strictTypes ? 'strict-types' : '',
                    validationRules.nullString !== undefined ? `null-string=${validationRules.nullString}` : '',
                    validationRules.emptyAsNull ? 'empty-as-null' : '',
                    validationRules.jsonEmptyAsNull ? 'json-empty-as-null' : '',
                    validationRules.enumEmptyAsNull ? 'enum-empty-as-null' : '',
                    validationRules.numericEmptyAsNull ? 'numeric-empty-as-null' : '',
                    validationRules.trimValues ? 'trim-values' : '',
                    validationRules.autoSanitize ? 'auto-sanitize' : '',
                ].filter(Boolean).join(', '))}`);
            }
            logger.log('');

            if (!skipConfirmation && (fromAccount || onlyAccount || resumeFailedFromReport)) {
                logger.log(chalk.bold('Resume Scope:'));
                logger.log(`  Accounts in scope: ${chalk.cyan(plans.length)}`);
                logger.log(`  ${plans.map(plan => plan.schemaName).join(', ')}`);
                const resumeConfirm = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'approve',
                        message: `Proceed with this account scope?`,
                        default: false,
                    },
                ]);
                if (!resumeConfirm.approve) {
                    logger.info('Operation cancelled');
                    process.exit(0);
                }
            }

            if (!skipConfirmation && precheckDbCasts) {
                logger.log(chalk.bold('Precheck Plan:'));
                logger.log('  The tool will attempt inserts against database types and constraints,');
                logger.log('  then rollback each account transaction (no persisted writes).');
                const precheckConfirm = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'approve',
                        message: `Proceed with DB cast precheck mode?`,
                        default: false,
                    },
                ]);
                if (!precheckConfirm.approve) {
                    logger.info('Operation cancelled');
                    process.exit(0);
                }
            }

            if (!skipConfirmation && hasRuleOptions) {
                logger.log(chalk.bold('Validation/Coercion Rules:'));
                logger.log(`  strict-columns:   ${chalk.cyan(validationRules.strictColumns ? 'enabled' : 'disabled')}`);
                logger.log(`  validate-not-null:${chalk.cyan(validationRules.validateNotNull ? 'enabled' : 'disabled')}`);
                logger.log(`  strict-types:     ${chalk.cyan(validationRules.strictTypes ? 'enabled' : 'disabled')}`);
                logger.log(`  null-string:      ${chalk.cyan(validationRules.nullString ?? '(none)')}`);
                logger.log(`  empty-as-null:    ${chalk.cyan(validationRules.emptyAsNull ? 'enabled' : 'disabled')}`);
                logger.log(`  json-empty-as-null:${chalk.cyan(validationRules.jsonEmptyAsNull ? 'enabled' : 'disabled')}`);
                logger.log(`  enum-empty-as-null:${chalk.cyan(validationRules.enumEmptyAsNull ? 'enabled' : 'disabled')}`);
                logger.log(`  numeric-empty-as-null:${chalk.cyan(validationRules.numericEmptyAsNull ? 'enabled' : 'disabled')}`);
                logger.log(`  trim-values:      ${chalk.cyan(validationRules.trimValues ? 'enabled' : 'disabled')}`);
                logger.log(`  auto-sanitize:    ${chalk.cyan(validationRules.autoSanitize ? 'enabled' : 'disabled')}`);
                const rulesConfirm = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'approve',
                        message: `Proceed with these validation/coercion rules?`,
                        default: false,
                    },
                ]);
                if (!rulesConfirm.approve) {
                    logger.info('Operation cancelled');
                    process.exit(0);
                }
            }

            const totalTables = plans.reduce((sum, plan) => sum + plan.tables.length, 0);
            logger.info(`Found ${plans.length} account folder(s) and ${totalTables} CSV file(s) in scope.`);

            let importedAccounts = 0;
            let validatedAccounts = 0;
            let skippedAccounts = 0;
            let failedAccounts = 0;
            let totalRowsProcessed = 0;
            let stoppedAfterFailure = false;
            const runStartedAt = new Date();

            const report: {
                generatedAt: string;
                startedAt: string;
                finishedAt: string;
                options: {
                    environment: string;
                    importPath: string;
                    order: string[];
                    orderSource: 'manual' | 'auto-fk';
                    autoOrderFrom: string | null;
                    mode: ImportMode;
                    dryRun: boolean;
                    precheckDbCasts: boolean;
                    rollbackAndContiue: boolean;
                    skipConfirmation: boolean;
                    fromAccount: string | null;
                    onlyAccount: string | null;
                    resumeFailedFromReport: string | null;
                    validation: DataValidationRules;
                };
                summary: {
                    accountsPlanned: number;
                    accountsImported: number;
                    accountsValidated: number;
                    accountsSkipped: number;
                    accountsFailed: number;
                    rowsProcessed: number;
                    stoppedEarly: boolean;
                };
                accounts: Array<{
                    schemaName: string;
                    status: 'imported' | 'validated' | 'skipped' | 'failed';
                    reason?: string;
                    rows: number;
                    startedAt: string;
                    finishedAt: string;
                    tables: Array<{
                        tableName: string;
                        fileName: string;
                        status: 'planned' | 'validated' | 'imported' | 'failed' | 'skipped';
                        rows: number;
                        error?: string;
                        durationMs: number;
                    }>;
                }>;
            } = {
                generatedAt: new Date().toISOString(),
                startedAt: runStartedAt.toISOString(),
                finishedAt: '',
                options: {
                    environment: envName,
                    importPath: resolvedImportPath,
                    order: tableOrder,
                    orderSource: manualOrder ? 'manual' : 'auto-fk',
                    autoOrderFrom,
                    mode: importMode,
                    dryRun,
                    precheckDbCasts,
                    rollbackAndContiue,
                    skipConfirmation,
                    fromAccount,
                    onlyAccount,
                    resumeFailedFromReport,
                    validation: validationRules,
                },
                summary: {
                    accountsPlanned: plans.length,
                    accountsImported: 0,
                    accountsValidated: 0,
                    accountsSkipped: 0,
                    accountsFailed: 0,
                    rowsProcessed: 0,
                    stoppedEarly: false,
                },
                accounts: [],
            };

            for (const plan of plans) {
                logger.log('');
                logger.divider();
                logger.log(chalk.bold(`Account: ${plan.schemaName}`));
                logger.log(`  Folder: ${chalk.cyan(plan.folderPath)}`);
                logger.log(`  CSV tables: ${chalk.cyan(plan.tables.length)}`);
                logger.log(`  Selected:   ${chalk.cyan(plan.orderedTables.length)}`);
                logger.log(`  Order:  ${chalk.cyan(plan.orderedTables.map(table => table.tableName).join(' -> '))}`);
                logger.log('');

                const accountStartedAt = new Date();
                const accountReport = {
                    schemaName: plan.schemaName,
                    status: 'skipped' as 'imported' | 'validated' | 'skipped' | 'failed',
                    reason: '',
                    rows: 0,
                    startedAt: accountStartedAt.toISOString(),
                    finishedAt: accountStartedAt.toISOString(),
                    tables: plan.orderedTables.map(table => ({
                        tableName: table.tableName,
                        fileName: table.fileName,
                        status: 'planned' as 'planned' | 'validated' | 'imported' | 'failed' | 'skipped',
                        rows: 0,
                        error: '',
                        durationMs: 0,
                    })),
                };
                report.accounts.push(accountReport);

                const missingOrderedCsv = tableOrder.filter(
                    orderedTable => !plan.tables.some(table => table.tableName === orderedTable)
                );
                if (missingOrderedCsv.length > 0) {
                    logger.warn(
                        `Ignoring missing ordered table CSV(s) for '${plan.schemaName}': ${missingOrderedCsv.join(', ')}`
                    );
                }

                if (plan.orderedTables.length === 0) {
                    logger.warn(`No tables selected for import in '${plan.schemaName}'.`);
                    accountReport.status = 'skipped';
                    accountReport.reason = 'No matching tables found between order and CSV files';
                    accountReport.finishedAt = new Date().toISOString();
                    skippedAccounts++;
                    continue;
                }

                logger.log(chalk.bold('Table preview:'));

                for (const [index, table] of plan.orderedTables.entries()) {
                    logger.log(`  ${index + 1}. ${chalk.cyan(table.tableName)} (${table.fileName})`);
                    logger.log(`     Size: ${formatBytes(table.sizeBytes)} | Columns: ${table.preview.headers.length}`);
                    logger.log(`     Header: ${chalk.gray(table.preview.headers.join(', '))}`);
                    logger.log(`     Peek:   ${chalk.gray(formatPreviewRow(table.preview.headers, table.preview.firstRow))}`);
                }

                if (!skipConfirmation) {
                    logger.log('');
                    const confirmation = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'proceed',
                            message: dryRun
                                ? `Validate account/schema '${plan.schemaName}'?`
                                : precheckDbCasts
                                    ? `Precheck DB casts for account/schema '${plan.schemaName}'?`
                                    : `Import data for account/schema '${plan.schemaName}'?`,
                            default: false,
                        },
                    ]);

                    if (!confirmation.proceed) {
                        skippedAccounts++;
                        accountReport.status = 'skipped';
                        accountReport.reason = 'User skipped account';
                        accountReport.tables = accountReport.tables.map(table => ({
                            ...table,
                            status: 'skipped',
                        }));
                        accountReport.finishedAt = new Date().toISOString();
                        logger.warn(`Skipped '${plan.schemaName}'`);
                        continue;
                    }
                }

                const pool = await getPool();
                const client = await pool.connect();
                let accountRows = 0;
                let failedTableName: string | null = null;
                let accountFailed = false;

                try {
                    if (!dryRun) {
                        await client.query('BEGIN');
                    }

                    if (!dryRun && importMode === 'truncate') {
                        for (const table of [...plan.orderedTables].reverse()) {
                            logger.startSpinner(`Truncating ${plan.schemaName}.${table.tableName}...`);
                            try {
                                await truncateTableForImport(plan.schemaName, table.tableName, client);
                                logger.succeedSpinner(`Truncated ${plan.schemaName}.${table.tableName}`);
                            } catch (error) {
                                failedTableName = table.tableName;
                                logger.failSpinner(`Failed truncating ${plan.schemaName}.${table.tableName}`);
                                throw error;
                            }
                        }
                    }

                    for (const table of plan.orderedTables) {
                        const tableReport = accountReport.tables.find(t => t.tableName === table.tableName);
                        const tableStartedAt = Date.now();
                        logger.startSpinner(`Importing ${plan.schemaName}.${table.tableName}...`);
                        try {
                            const tableMode: ImportMode = importMode === 'upsert' ? 'upsert' : 'append';
                            const result = await importCsvIntoTable(
                                plan.schemaName,
                                table.tableName,
                                table.filePath,
                                {
                                    client,
                                    mode: tableMode,
                                    dryRun,
                                    validation: validationRules,
                                    diagnoseRowErrors: true,
                                }
                            );
                            accountRows += result.rowsInserted;
                            if (tableReport) {
                                tableReport.rows = result.rowsInserted;
                                tableReport.durationMs = Date.now() - tableStartedAt;
                                tableReport.status = validationOnlyMode ? 'validated' : 'imported';
                            }
                            if (validationOnlyMode) {
                                logger.succeedSpinner(
                                    `${precheckDbCasts ? 'Prechecked' : 'Validated'} ${result.rowsInserted} row(s) for ${plan.schemaName}.${table.tableName}`
                                );
                            } else {
                                logger.succeedSpinner(
                                    `Imported ${result.rowsInserted} row(s) into ${plan.schemaName}.${table.tableName}`
                                );
                            }
                        } catch (error) {
                            failedTableName = table.tableName;
                            logger.failSpinner(`Failed importing ${plan.schemaName}.${table.tableName}`);
                            if (tableReport) {
                                tableReport.durationMs = Date.now() - tableStartedAt;
                                tableReport.status = 'failed';
                                tableReport.error = error instanceof Error ? error.message : String(error);
                            }
                            throw error;
                        }
                    }

                    if (precheckDbCasts) {
                        await client.query('ROLLBACK');
                        validatedAccounts++;
                        logger.success(`Precheck passed for '${plan.schemaName}' (${accountRows} row(s) checked, rolled back)`);
                        accountReport.status = 'validated';
                    } else if (!dryRun) {
                        await client.query('COMMIT');
                        importedAccounts++;
                        logger.success(`Completed '${plan.schemaName}' (${accountRows} row(s) inserted)`);
                        accountReport.status = 'imported';
                    } else {
                        validatedAccounts++;
                        logger.success(`Validated '${plan.schemaName}' (${accountRows} row(s) checked)`);
                        accountReport.status = 'validated';
                    }
                    accountReport.rows = accountRows;
                    totalRowsProcessed += accountRows;
                } catch (error) {
                    accountFailed = true;
                    if (!dryRun) {
                        await client.query('ROLLBACK');
                        logger.warn(
                            precheckDbCasts
                                ? `Rolled back precheck transaction for '${plan.schemaName}'.`
                                : `Rolled back all imported data for '${plan.schemaName}'.`
                        );
                    }
                    if (failedTableName) {
                        logger.error(
                            `Import failed at table '${failedTableName}': ${error instanceof Error ? error.message : String(error)}`
                        );
                    } else {
                        logger.error(error instanceof Error ? error.message : String(error));
                    }
                    accountReport.status = 'failed';
                    accountReport.reason = failedTableName
                        ? `Failed at table '${failedTableName}'`
                        : 'Import failed';
                    failedAccounts++;
                    if (!rollbackAndContiue) {
                        stoppedAfterFailure = true;
                    }
                } finally {
                    accountReport.finishedAt = new Date().toISOString();
                    client.release();
                }

                if (accountFailed && stoppedAfterFailure) {
                    logger.warn('Stopping import due to account failure. Use --rollback-and-contiue to continue with next accounts.');
                    break;
                }
            }

            report.finishedAt = new Date().toISOString();
            report.summary.accountsImported = importedAccounts;
            report.summary.accountsValidated = validatedAccounts;
            report.summary.accountsSkipped = skippedAccounts;
            report.summary.accountsFailed = failedAccounts;
            report.summary.rowsProcessed = totalRowsProcessed;
            report.summary.stoppedEarly = stoppedAfterFailure;

            if (reportPath) {
                await mkdir(dirname(reportPath), { recursive: true });
                await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
            }

            logger.log('');
            logger.divider();
            logger.header('📊 Import Summary');
            logger.log(`  Accounts imported:  ${chalk.cyan(importedAccounts)}`);
            logger.log(`  Accounts validated: ${chalk.cyan(validatedAccounts)}`);
            logger.log(`  Accounts skipped:  ${chalk.cyan(skippedAccounts)}`);
            logger.log(`  Accounts failed:   ${chalk.cyan(failedAccounts)}`);
            logger.log(`  Total rows:        ${chalk.cyan(totalRowsProcessed)}`);
            if (stoppedAfterFailure) {
                logger.log(`  Stopped early:     ${chalk.cyan('yes')}`);
            }
            if (reportPath) {
                logger.log(`  Report file:       ${chalk.cyan(reportPath)}`);
            }

            if (failedAccounts > 0) {
                process.exit(1);
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });


function getStatusColor(status: string): string {
    switch (status) {
        case 'AVAILABLE':
            return chalk.green('');
        case 'ALLOCATED':
            return chalk.yellow('');
        case 'DELETED':
            return chalk.red('');
        default:
            return chalk.reset('');
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPreviewRow(headers: string[], firstRow: string[] | null): string {
    if (!firstRow) {
        return chalk.gray('(no data rows)');
    }

    return headers
        .map((header, index) => {
            const value = firstRow[index] ?? '';
            const clipped = value.length > 30 ? `${value.slice(0, 30)}...` : value;
            return `${header}=${clipped}`;
        })
        .join(' | ');
}

function printSeedResult(result: SeedResult): void {
    if (result.success) {
        if (result.applied.length > 0) {
            logger.success(`${chalk.cyan(result.schemaName)}: Applied ${result.applied.length} seed file(s)`);
            result.applied.forEach(f => logger.log(`    ${chalk.green('+')} ${f}`));
        } else {
            logger.info(`${chalk.cyan(result.schemaName)}: Already up to date (${result.skipped.length} file(s) already applied)`);
        }
    } else {
        logger.error(`${chalk.cyan(result.schemaName)}: Failed`);
        if (result.applied.length > 0) {
            logger.log(`    Applied ${result.applied.length} file(s) before failure:`);
            result.applied.forEach(f => logger.log(`      ${chalk.green('+')} ${f}`));
        }
        if (result.failed) {
            logger.log(`    ${chalk.red('✗')} Failed on: ${result.failed.file}`);
            logger.log(`      ${chalk.red(result.failed.error)}`);
        }
    }
}

program
    .command('seed [schema-name]')
    .description('Run seed SQL files against a schema')
    .option('--all-available', 'Seed all schemas with status AVAILABLE')
    .option('--all', 'Seed all schemas with status AVAILABLE or ALLOCATED')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (schemaName, options) => {
        try {
            const isAllAvailable = options.allAvailable === true;
            const isAll = options.all === true;

            if (!schemaName && !isAllAvailable && !isAll) {
                logger.error('Please provide a schema name, or use --all-available or --all flag');
                logger.log('');
                logger.log('Usage:');
                logger.log(`  ${chalk.cyan('phantm seed <schema-name>')}          Seed a specific schema`);
                logger.log(`  ${chalk.cyan('phantm seed --all-available')}        Seed all AVAILABLE schemas`);
                logger.log(`  ${chalk.cyan('phantm seed --all')}                  Seed all AVAILABLE + ALLOCATED schemas`);
                process.exit(1);
            }

            logger.header('🌱 Schema Seeding');

            // Resolve environment
            const envName = (await getActiveEnv()) || (await promptEnvSelection('Select environment for seeding:'));

            // Check seed path
            const seedPath = await getEnvSeedPath(envName);
            if (!seedPath) {
                logger.log('');
                logger.warn(`No seed folder configured for environment '${envName}'.`);
                logger.log(`Run ${chalk.cyan('phantm use <sql-file> --seed <seed-folder-path>')} to configure one.`);
                process.exit(1);
            }

            logger.log(`  Environment: ${chalk.cyan(envName)}`);
            logger.log(`  Seed folder: ${chalk.cyan(seedPath)}`);
            logger.log('');

            logger.startSpinner('Testing database connection...');
            await testConnection();
            logger.succeedSpinner('Database connection successful');

            logger.startSpinner('Verifying common schema...');
            await verifyCommonSchema();
            logger.succeedSpinner('Common schema verified');

            logger.startSpinner('Ensuring seed tracking column exists...');
            await ensureSeededFilesColumn();
            logger.succeedSpinner('Seed tracking ready');

            // Discover seed files for preview
            const allSeedFiles = await discoverSeedFiles(seedPath);
            if (allSeedFiles.length === 0) {
                logger.log('');
                logger.warn('No seed files found in the seed folder.');
                logger.log(`Expected files matching pattern: ${chalk.cyan('<number>_<name>.sql')}`);
                logger.log(`  e.g. ${chalk.gray('1_base_data.sql, 2_lookup_tables.sql')}`);
                process.exit(0);
            }

            logger.info(`Found ${chalk.bold(allSeedFiles.length)} seed file(s) in folder`);

            if (isAllAvailable || isAll) {
                // Multi-schema mode
                const statusFilter = isAll
                    ? ['AVAILABLE', 'ALLOCATED']
                    : ['AVAILABLE'];

                const allSchemas = await listSchemas();
                const targetSchemas = allSchemas.filter(s => statusFilter.includes(s.status));

                if (targetSchemas.length === 0) {
                    logger.log('');
                    logger.warn(`No schemas found with status: ${statusFilter.join(', ')}`);
                    process.exit(0);
                }

                logger.log('');
                logger.log(chalk.bold('Target schemas:'));
                for (const s of targetSchemas) {
                    const seeded = await getSeededFiles(s.schema_name);
                    const pending = getPendingSeedFiles(allSeedFiles, seeded);
                    logger.log(`  ${chalk.cyan(s.schema_name)} - ${pending.length} pending, ${seeded.length} already applied`);
                }

                if (!options.yes) {
                    logger.log('');
                    const answer = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'proceed',
                            message: `Seed ${targetSchemas.length} schema(s)?`,
                            default: true,
                        },
                    ]);

                    if (!answer.proceed) {
                        logger.info('Operation cancelled');
                        process.exit(0);
                    }
                }

                logger.log('');
                logger.divider();

                const results = await seedMultipleSchemas(envName, statusFilter);

                logger.log('');
                logger.divider();
                logger.header('📊 Seeding Summary');

                let totalApplied = 0;
                let totalFailed = 0;

                for (const result of results) {
                    printSeedResult(result);
                    totalApplied += result.applied.length;
                    if (!result.success) totalFailed++;
                }

                logger.log('');
                logger.divider();
                logger.log(`${chalk.bold('Total:')} ${results.length} schema(s), ${totalApplied} file(s) applied, ${totalFailed} failure(s)`);

                if (totalFailed > 0) {
                    process.exit(1);
                }
            } else {
                // Single schema mode
                const schema = await getSchemaFromPool(schemaName);
                if (!schema) {
                    logger.error(`Schema '${schemaName}' not found in schema_pool`);
                    process.exit(1);
                }

                const seeded = await getSeededFiles(schemaName);
                const pending = getPendingSeedFiles(allSeedFiles, seeded);

                logger.log('');
                logger.log(chalk.bold('Seed Status:'));
                logger.log(`  Schema:          ${chalk.cyan(schemaName)}`);
                logger.log(`  Total files:     ${chalk.cyan(allSeedFiles.length)}`);
                logger.log(`  Already applied: ${chalk.cyan(seeded.length)}`);
                logger.log(`  Pending:         ${chalk.cyan(pending.length)}`);

                if (pending.length === 0) {
                    logger.log('');
                    logger.success('All seed files have already been applied.');
                    process.exit(0);
                }

                logger.log('');
                logger.log(chalk.bold('Pending files:'));
                pending.forEach(f => logger.log(`  ${chalk.yellow('○')} ${f}`));

                if (!options.yes) {
                    logger.log('');
                    const answer = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'proceed',
                            message: `Apply ${pending.length} seed file(s) to '${schemaName}'?`,
                            default: true,
                        },
                    ]);

                    if (!answer.proceed) {
                        logger.info('Operation cancelled');
                        process.exit(0);
                    }
                }

                logger.log('');
                logger.divider();

                logger.startSpinner('Applying seed files...');

                // Use the seedSchema orchestrator for the actual work
                const result = await seedSchema(schemaName, envName);
                if (result.success) {
                    logger.succeedSpinner(`Applied ${result.applied.length} seed file(s)`);
                } else {
                    logger.failSpinner('Seeding failed');
                }

                logger.log('');
                logger.divider();
                printSeedResult(result);

                if (!result.success) {
                    process.exit(1);
                }
            }
        } catch (error) {
            logger.failSpinner();
            logger.error(`Seeding failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });

program
    .command('seed:reset <schema-name>')
    .description('Reset seed tracking for a schema (marks all seeds as unapplied)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (schemaName, options) => {
        try {
            logger.header('🔄 Reset Seed Tracking');

            logger.startSpinner('Testing database connection...');
            await testConnection();
            logger.succeedSpinner('Database connection successful');

            logger.startSpinner('Verifying common schema...');
            await verifyCommonSchema();
            logger.succeedSpinner('Common schema verified');

            await ensureSeededFilesColumn();

            const schema = await getSchemaFromPool(schemaName);
            if (!schema) {
                logger.error(`Schema '${schemaName}' not found in schema_pool`);
                process.exit(1);
            }

            const seeded = await getSeededFiles(schemaName);
            logger.log('');
            logger.log(chalk.bold('Current seed status:'));
            logger.log(`  Schema:        ${chalk.cyan(schemaName)}`);
            logger.log(`  Applied seeds: ${chalk.cyan(seeded.length)}`);

            if (seeded.length === 0) {
                logger.log('');
                logger.info('No seeds have been applied to this schema.');
                process.exit(0);
            }

            seeded.forEach(s => {
                logger.log(`    ${chalk.green('✓')} ${s.file} (${s.applied_at})`);
            });

            if (!options.yes) {
                logger.log('');
                const answer = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'proceed',
                        message: `Reset seed tracking for '${schemaName}'? This will NOT undo the seed data.`,
                        default: false,
                    },
                ]);

                if (!answer.proceed) {
                    logger.info('Operation cancelled');
                    process.exit(0);
                }
            }

            logger.startSpinner('Resetting seed tracking...');
            await resetSeededFiles(schemaName);
            logger.succeedSpinner('Seed tracking reset');

            logger.log('');
            logger.success(`✅ Seed tracking cleared for '${chalk.cyan(schemaName)}'`);
            logger.log('');
            logger.warn('Note: The seeded data still exists in the schema. Only the tracking was reset.');
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        } finally {
            await closePool();
        }
    });

program.parseAsync(process.argv);
