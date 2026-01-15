/**
 * Centralized logging utility for inspirehub apps
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
    const now = new Date();
    return now.toISOString().slice(11, 23); // HH:mm:ss.sss
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
                console.debug(`${formatTimestamp()} ${prefix} DEBUG:`, ...args);
            }
        },
        info: (...args: any[]) => {
            if (shouldLog('info')) {
                console.info(`${formatTimestamp()} ${prefix} INFO:`, ...args);
            }
        },
        warn: (...args: any[]) => {
            if (shouldLog('warn')) {
                console.warn(`${formatTimestamp()} ${prefix} WARN:`, ...args);
            }
        },
        error: (...args: any[]) => {
            if (shouldLog('error')) {
                console.error(`${formatTimestamp()} ${prefix} ERROR:`, ...args);
            }
        }
    };
}

// Pre-configured loggers for common modules
export const shellLog = createLogger('shell');
export const equipmentLog = createLogger('equipment');
export const priceListLog = createLogger('price-list');
