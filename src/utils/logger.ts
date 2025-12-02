import chalk from 'chalk';
import ora, { Ora } from 'ora';

export class Logger {
    private spinner: Ora | null = null;

    /**
     * Print success message
     */
    success(message: string): void {
        console.log(chalk.green('✓'), message);
    }

    /**
     * Print error message
     */
    error(message: string): void {
        console.log(chalk.red('✗'), message);
    }

    /**
     * Print warning message
     */
    warn(message: string): void {
        console.log(chalk.yellow('⚠'), message);
    }

    /**
     * Print info message
     */
    info(message: string): void {
        console.log(chalk.blue('ℹ'), message);
    }

    /**
     * Print plain message
     */
    log(message: string): void {
        console.log(message);
    }

    /**
     * Start a spinner
     */
    startSpinner(text: string): void {
        this.spinner = ora(text).start();
    }

    /**
     * Update spinner text
     */
    updateSpinner(text: string): void {
        if (this.spinner) {
            this.spinner.text = text;
        }
    }

    /**
     * Stop spinner with success
     */
    succeedSpinner(text?: string): void {
        if (this.spinner) {
            this.spinner.succeed(text);
            this.spinner = null;
        }
    }

    /**
     * Stop spinner with failure
     */
    failSpinner(text?: string): void {
        if (this.spinner) {
            this.spinner.fail(text);
            this.spinner = null;
        }
    }

    /**
     * Stop spinner with warning
     */
    warnSpinner(text?: string): void {
        if (this.spinner) {
            this.spinner.warn(text);
            this.spinner = null;
        }
    }

    /**
     * Stop spinner with info
     */
    infoSpinner(text?: string): void {
        if (this.spinner) {
            this.spinner.info(text);
            this.spinner = null;
        }
    }

    /**
     * Print a divider
     */
    divider(): void {
        console.log(chalk.gray('─'.repeat(50)));
    }

    /**
     * Print a header
     */
    header(text: string): void {
        console.log();
        console.log(chalk.bold.cyan(text));
        this.divider();
    }
}

export const logger = new Logger();
