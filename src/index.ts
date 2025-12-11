#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { testConnection, verifyCommonSchema, closePool, getDatabaseConfig } from './db/connection.js';
import { createSchema, validateSchemaStructure } from './schema/creator.js';
import { listSchemas, getSchemaFromPool } from './pool/registry.js';
import { logger } from './utils/logger.js';
import { readBaseSchema, validateSQL } from './schema/parser.js';
import { saveEnvConfig, getEnvConfig, listEnvs, getConfigFilePath, getActiveEnv, setActiveEnv, deleteEnvConfig } from './config/manager.js';

const program = new Command();

program
    .name('migration-cli')
    .description('PostgreSQL schema migration CLI tool')
    .version('1.0.0');

program
    .command('configure <env-name>')
    .description('Configure database credentials for an environment')
    .action(async (envName) => {
        try {
            logger.header(`⚙️  Configure Database - ${envName}`);

            // Check if environment already exists
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
            logger.log(chalk.dim(`Config file: ${getConfigFilePath()}`)
            );
        } catch (error) {
            logger.failSpinner();
            logger.error(`Configuration failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('activate-env')
    .description('Set the active environment')
    .action(async () => {
        try {
            logger.header('🔧 Activate Environment');
            const envs = await listEnvs();

            if (envs.length === 0) {
                logger.error('No environments configured');
                logger.log('');
                logger.log('Create an environment first:');
                logger.log('  pnpm cli configure <env-name>');
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

program
    .command('list-env')
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
                logger.log('  pnpm cli configure <env-name>');
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
            logger.log(chalk.dim(`Config file: ${getConfigFilePath()}`));
        } catch (error) {
            logger.failSpinner();
            logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('delete-env')
    .description('Delete a configured environment')
    .action(async () => {
        try {
            logger.header('🗑️  Delete Environment');
            const envs = await listEnvs();

            if (envs.length === 0) {
                logger.error('No environments configured');
                logger.log('');
                logger.log('Create an environment first:');
                logger.log('  pnpm cli configure <env-name>');
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

            // Check if we deleted the active environment
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
    .command('create')
    .description('Create a new schema from the base template')
    .option('-f, --force', 'Force recreate if schema already exists')
    .option('-n, --name <name>', 'Custom schema name (must start with "account_")')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
        try {
            logger.header('🚀 Schema Creation');
            logger.startSpinner('Testing database connection...');
            await testConnection();
            logger.succeedSpinner('Database connection successful');

            logger.startSpinner('Verifying common schema...');
            await verifyCommonSchema();
            logger.succeedSpinner('Common schema verified');

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
                force: options.force,
                customName: options.name,
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
            } else {
                logger.error(`Schema creation failed: ${result.error}`);
                process.exit(1);
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
    .command('create-bulk <count>')
    .description('Create multiple schemas at once')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (count, options) => {
        try {
            const schemaCount = parseInt(count, 10);

            if (isNaN(schemaCount) || schemaCount < 1) {
                logger.error('Count must be a positive integer');
                process.exit(1);
            }

            if (schemaCount > 100) {
                logger.error('Maximum 100 schemas can be created at once');
                process.exit(1);
            }

            logger.header(`🚀 Bulk Schema Creation (${schemaCount} schemas)`);

            logger.startSpinner('Testing database connection...');
            await testConnection();
            logger.succeedSpinner('Database connection successful');

            logger.startSpinner('Verifying common schema...');
            await verifyCommonSchema();
            logger.succeedSpinner('Common schema verified');

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

            logger.log('');
            logger.divider();

            const results = {
                successful: [] as string[],
                failed: [] as { name: string; error: string }[],
            };

            for (let i = 1; i <= schemaCount; i++) {
                logger.log(`\n${chalk.bold(`[${i}/${schemaCount}]`)} Creating schema...`);

                const result = await createSchema({
                    force: false,
                });

                if (result.success) {
                    results.successful.push(result.schemaName);
                    logger.success(`✓ ${chalk.cyan(result.schemaName)} created (ID: ${result.schemaId})`);
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

            if (schemas.length === 0) {
                logger.info('No schemas found in the pool');
                return;
            }

            logger.log('');
            logger.divider();

            schemas.forEach((schema, index) => {
                logger.log(`${chalk.bold(`${index + 1}.`)} ${chalk.cyan(schema.schema_name)}`);
                logger.log(`   ID:         ${schema.schema_id}`);
                logger.log(`   Status:     ${getStatusColor(schema.status)}${schema.status}${chalk.reset()}`);
                logger.log(`   Account ID: ${schema.account_id || chalk.gray('N/A')}`);
                logger.log(`   Created:    ${schema.created_at ? new Date(schema.created_at).toLocaleString() : 'N/A'}`);

                if (schema.allocated_at) {
                    logger.log(`   Allocated:  ${new Date(schema.allocated_at).toLocaleString()}`);
                }

                if (index < schemas.length - 1) {
                    logger.log('');
                }
            });

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
    .command('validate')
    .description('Validate the base schema SQL template')
    .action(async () => {
        try {
            logger.header('🔍 Template Validation');

            logger.startSpinner('Reading base schema template...');
            const template = await readBaseSchema();
            logger.succeedSpinner('Template loaded');

            logger.startSpinner('Validating SQL structure...');
            validateSQL(template);
            logger.succeedSpinner('SQL structure is valid');

            const typeCount = (template.match(/CREATE TYPE/g) || []).length;
            const tableCount = (template.match(/CREATE TABLE/g) || []).length;
            const indexCount = (template.match(/CREATE INDEX/g) || []).length;

            logger.log('');
            logger.success('✅ Base schema template is valid!');
            logger.log('');
            logger.log(chalk.bold('Template Statistics:'));
            logger.log(`  Types:   ${chalk.cyan(typeCount)}`);
            logger.log(`  Tables:  ${chalk.cyan(tableCount)}`);
            logger.log(`  Indexes: ${chalk.cyan(indexCount)}`);
        } catch (error) {
            logger.failSpinner();
            logger.error(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    });

program
    .command('info <schema-name>')
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

program
    .command('test-connection')
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


function getStatusColor(status: string): string {
    switch (status) {
        case 'AVAILABLE':
            return chalk.green('');
        case 'ALLOCATED':
            return chalk.yellow('');
        case 'DELETED':
            return chalk.red('');
        default:
            return chalk.gray('');
    }
}

process.on('unhandledRejection', (error) => {
    logger.error(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
    closePool().finally(() => process.exit(1));
});

process.on('SIGINT', () => {
    logger.log('');
    logger.warn('Operation interrupted by user');
    closePool().finally(() => process.exit(0));
});

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}
