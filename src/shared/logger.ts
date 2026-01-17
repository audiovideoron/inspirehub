/**
 * Centralized logging utility for inspirehub apps
 *
 * Logs are sent to both:
 * 1. Browser console (for development debugging)
 * 2. Shell logging service (for Bug Spray reports)
 *
 * Usage:
 *   import { createLogger } from '../../shared/logger';
 *   const log = createLogger('equipment');
 *
 *   log.info('Loading equipment...');
 *   log.debug('API response:', data);
 *   log.warn('Slow response time');
 *   log.error('Failed to load', error);
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

interface ShellLogAPI {
    add: (params: {
        source: string;
        level: LogLevel;
        message: string;
        data?: any;
        timestamp?: string;
    }) => Promise<void>;
}

interface WindowAPI {
    shellLog?: ShellLogAPI;
}

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

// Default to 'info' in production, 'debug' in development
const currentLevel: LogLevel = (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development')
    ? 'debug'
    : 'info';

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatTimestamp(): string {
    return new Date().toISOString();
}

function formatTimeForConsole(): string {
    return new Date().toISOString().slice(11, 23); // HH:mm:ss.sss
}

/**
 * Format args into a message string and optional data object
 */
function formatArgs(args: any[]): { message: string; data?: any } {
    if (args.length === 0) {
        return { message: '' };
    }

    // First arg is the message
    const message = String(args[0]);

    // If there are additional args, include them as data
    if (args.length > 1) {
        const data = args.length === 2 ? args[1] : args.slice(1);
        return { message, data };
    }

    return { message };
}

/**
 * Send log to shell logging service (non-blocking, fire-and-forget)
 */
function sendToShellLog(module: string, level: LogLevel, args: any[]): void {
    try {
        const api = (window as any).api as WindowAPI | undefined;
        if (api?.shellLog?.add) {
            const { message, data } = formatArgs(args);
            api.shellLog.add({
                source: module,
                level,
                message,
                data,
                timestamp: formatTimestamp()
            }).catch(() => {
                // Silently ignore errors - don't create infinite loop
            });
        }
    } catch {
        // Silently ignore - API may not be available yet
    }
}

/**
 * Create a logger instance for a specific module/app
 * @param module - Module name (e.g., 'shell', 'equipment', 'price-list')
 */
export function createLogger(module: string): Logger {
    const prefix = `[${module}]`;

    return {
        debug: (...args: any[]) => {
            if (shouldLog('debug')) {
                console.debug(`${formatTimeForConsole()} ${prefix} DEBUG:`, ...args);
                sendToShellLog(module, 'debug', args);
            }
        },
        info: (...args: any[]) => {
            if (shouldLog('info')) {
                console.info(`${formatTimeForConsole()} ${prefix} INFO:`, ...args);
                sendToShellLog(module, 'info', args);
            }
        },
        warn: (...args: any[]) => {
            if (shouldLog('warn')) {
                console.warn(`${formatTimeForConsole()} ${prefix} WARN:`, ...args);
                sendToShellLog(module, 'warn', args);
            }
        },
        error: (...args: any[]) => {
            if (shouldLog('error')) {
                console.error(`${formatTimeForConsole()} ${prefix} ERROR:`, ...args);
                sendToShellLog(module, 'error', args);
            }
        }
    };
}

// Pre-configured loggers for common modules
export const shellLog = createLogger('shell');
export const equipmentLog = createLogger('equipment');
export const priceListLog = createLogger('price-list');
