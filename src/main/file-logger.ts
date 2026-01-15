/**
 * File-based logger for main process
 * Writes logs to userData/logs/ for debugging
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

let logDir: string;
let logFile: string;
let initialized = false;

/**
 * Initialize the file logger
 * Call this after app.whenReady()
 */
export function initFileLogger(): void {
    if (initialized) return;

    logDir = path.join(app.getPath('userData'), 'logs');

    // Ensure logs directory exists
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    // Use date-based log file
    const today = new Date().toISOString().split('T')[0];
    logFile = path.join(logDir, `app-${today}.log`);

    initialized = true;

    // Log startup
    writeLog('INFO', 'main', 'File logger initialized', { logFile });
}

/**
 * Get the path to the current log file
 */
export function getLogFilePath(): string {
    return logFile;
}

/**
 * Get the logs directory path
 */
export function getLogDir(): string {
    return logDir;
}

function formatTimestamp(): string {
    return new Date().toISOString();
}

function writeLog(level: LogLevel, source: string, message: string, data?: any): void {
    if (!initialized) {
        console.warn('File logger not initialized');
        return;
    }

    const entry = {
        timestamp: formatTimestamp(),
        level,
        source,
        message,
        ...(data && { data })
    };

    const line = JSON.stringify(entry) + '\n';

    try {
        fs.appendFileSync(logFile, line);
    } catch (err) {
        console.error('Failed to write to log file:', err);
    }
}

// Main process loggers
export const mainLog = {
    debug: (message: string, data?: any) => writeLog('DEBUG', 'main', message, data),
    info: (message: string, data?: any) => writeLog('INFO', 'main', message, data),
    warn: (message: string, data?: any) => writeLog('WARN', 'main', message, data),
    error: (message: string, data?: any) => writeLog('ERROR', 'main', message, data)
};

/**
 * Log a renderer error (called via IPC from renderer process)
 */
export function logRendererError(source: string, error: {
    message: string;
    stack?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
}): void {
    writeLog('ERROR', `renderer:${source}`, error.message, {
        stack: error.stack,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno
    });
}

/**
 * Log a renderer console message (called via IPC)
 */
export function logRendererConsole(source: string, level: string, message: string, args?: any[]): void {
    const logLevel = level.toUpperCase() as LogLevel;
    if (['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(logLevel)) {
        writeLog(logLevel, `renderer:${source}`, message, args?.length ? { args } : undefined);
    }
}

/**
 * Read recent log entries (for debugging)
 * @param lines Number of lines to read from end
 */
export function readRecentLogs(lines: number = 50): string[] {
    if (!initialized || !fs.existsSync(logFile)) {
        return [];
    }

    try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const allLines = content.trim().split('\n');
        return allLines.slice(-lines);
    } catch (err) {
        console.error('Failed to read log file:', err);
        return [];
    }
}
