/**
 * Shell Logging Service - Centralized in-memory logging for all InspireHub modules
 *
 * Provides a circular buffer of log entries that can be queried by Bug Spray.
 * Modules submit logs via IPC, and the buffer is accessible for bug reports.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    timestamp: string;
    source: string;  // 'price-list', 'equipment', 'shell', etc.
    level: LogLevel;
    message: string;
    data?: any;
}

// Configuration
const MAX_BUFFER_SIZE = 1000;  // Keep last 1000 entries

// In-memory circular buffer
let logBuffer: LogEntry[] = [];

/**
 * Add a log entry to the buffer
 */
export function addLog(
    source: string,
    level: LogLevel,
    message: string,
    data?: any,
    timestamp?: string
): void {
    const entry: LogEntry = {
        timestamp: timestamp || new Date().toISOString(),
        source: sanitizeSource(source),
        level: validateLevel(level),
        message: sanitizeMessage(message),
        ...(data !== undefined && { data: sanitizeData(data) })
    };

    logBuffer.push(entry);

    // Trim buffer if it exceeds max size (circular buffer behavior)
    if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer = logBuffer.slice(-MAX_BUFFER_SIZE);
    }
}

/**
 * Get logs from the buffer with optional filtering
 *
 * @param source - Filter by source module (e.g., 'equipment', 'price-list')
 * @param since - Only return logs after this ISO timestamp
 * @param level - Minimum log level to include (e.g., 'warn' includes warn and error)
 * @param limit - Maximum number of entries to return (default: all matching)
 */
export function getLogs(options?: {
    source?: string;
    since?: string;
    level?: LogLevel;
    limit?: number;
}): LogEntry[] {
    let result = [...logBuffer];

    // Filter by source
    if (options?.source) {
        result = result.filter(entry => entry.source === options.source);
    }

    // Filter by timestamp
    if (options?.since) {
        const sinceTime = options.since;
        result = result.filter(entry => entry.timestamp >= sinceTime);
    }

    // Filter by minimum level
    if (options?.level) {
        const minLevel = levelToNumber(options.level);
        result = result.filter(entry => levelToNumber(entry.level) >= minLevel);
    }

    // Apply limit (from end, most recent first)
    if (options?.limit && options.limit > 0) {
        result = result.slice(-options.limit);
    }

    return result;
}

/**
 * Get all logs formatted as strings for Bug Spray display
 */
export function getLogsForBugSpray(options?: {
    source?: string;
    since?: string;
    level?: LogLevel;
    limit?: number;
}): string[] {
    const entries = getLogs(options);
    return entries.map(entry => formatLogEntry(entry));
}

/**
 * Check if any ERROR level logs exist in the buffer
 */
export function hasErrorLogs(source?: string): boolean {
    return logBuffer.some(entry =>
        entry.level === 'error' &&
        (!source || entry.source === source)
    );
}

/**
 * Clear all logs (for testing or session reset)
 */
export function clearLogs(): void {
    logBuffer = [];
}

/**
 * Get the current buffer size
 */
export function getBufferSize(): number {
    return logBuffer.length;
}

/**
 * Get list of unique sources in the buffer
 */
export function getSources(): string[] {
    return [...new Set(logBuffer.map(entry => entry.source))];
}

// Helper functions

function sanitizeSource(source: string): string {
    // Only allow alphanumeric, dash, underscore
    if (typeof source !== 'string') return 'unknown';
    return source.replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 50) || 'unknown';
}

function validateLevel(level: LogLevel): LogLevel {
    const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (validLevels.includes(level)) return level;
    return 'info';
}

function sanitizeMessage(message: string): string {
    if (typeof message !== 'string') return String(message);
    // Limit message length to prevent memory issues
    return message.substring(0, 5000);
}

function sanitizeData(data: any): any {
    // Limit data size by JSON serializing and truncating
    try {
        const json = JSON.stringify(data);
        if (json.length > 10000) {
            return { _truncated: true, preview: json.substring(0, 1000) };
        }
        return data;
    } catch {
        return { _error: 'Could not serialize data' };
    }
}

function levelToNumber(level: LogLevel): number {
    const levels: Record<LogLevel, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3
    };
    return levels[level] ?? 1;
}

function formatLogEntry(entry: LogEntry): string {
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    return `${entry.timestamp} - ${entry.level.toUpperCase()} - [${entry.source}] ${entry.message}${dataStr}`;
}

// Convenience loggers for main process
export const shellLog = {
    debug: (message: string, data?: any) => addLog('shell', 'debug', message, data),
    info: (message: string, data?: any) => addLog('shell', 'info', message, data),
    warn: (message: string, data?: any) => addLog('shell', 'warn', message, data),
    error: (message: string, data?: any) => addLog('shell', 'error', message, data)
};
