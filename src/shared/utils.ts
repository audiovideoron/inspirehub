/**
 * Shared utility functions for inspirehub
 * These pure functions are extracted for testability and reuse.
 */

/**
 * Extract filename from a file path (works with both / and \ separators)
 * @param path - Full file path
 * @returns The filename portion of the path
 */
export function getFilename(path: string): string {
    if (!path || typeof path !== 'string') {
        return '';
    }
    return path.split(/[/\\]/).pop() || '';
}

/**
 * Format a numeric price value with proper comma separators and decimals
 * @param value - The price value to format
 * @returns Formatted price string (e.g., "1,234" or "1,234.56")
 */
export function formatPrice(value: number): string {
    if (typeof value !== 'number' || isNaN(value)) {
        return '';
    }
    if (value === Math.floor(value)) {
        return value.toLocaleString('en-US');
    }
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Parse a price string (possibly with commas) into a number
 * @param str - Price string to parse (e.g., "1,234.56")
 * @returns The parsed number, or null if invalid or negative
 */
export function parsePrice(str: string): number | null {
    if (typeof str !== 'string') {
        return null;
    }
    const clean = str.replace(/,/g, '');
    const num = parseFloat(clean);
    // Reject NaN and negative prices
    if (isNaN(num) || num < 0) {
        return null;
    }
    return num;
}

/**
 * Check if a port number is valid
 * @param port - Port number to validate
 * @returns true if port is a valid number in range 1-65535
 */
export function isPortValid(port: number): boolean {
    return typeof port === 'number' && port > 0 && port <= 65535;
}

/**
 * Increment the year in a filename (e.g., "PriceList2024" -> "PriceList2025")
 *
 * Uses boundary-aware pattern to avoid matching product codes like "Model2025X".
 * Years followed by letters or digits are NOT incremented (product codes).
 * Years at end of string, or followed by _, ., -, space ARE incremented.
 *
 * @param filename - Filename to process (without extension)
 * @returns Filename with first matching year incremented
 */
export function incrementYearInFilename(filename: string): string {
    if (typeof filename !== 'string') {
        return '';
    }
    // Match 4-digit years (2000-2099) NOT followed by letters or digits
    // This prevents matching product codes like "Model2025X" or "Item2024ABC"
    // But allows "PriceList2024" (end of string) and "Report_2024_final" (followed by _)
    const yearPattern = /(20\d{2})(?![A-Za-z0-9])/;
    return filename.replace(yearPattern, (match, year) => {
        const yearNum = parseInt(year, 10);
        return String(yearNum + 1);
    });
}

/**
 * Generate a default export filename from an input filename
 * Increments the year and adds .pdf extension
 * @param inputPath - Full path or filename of the input PDF
 * @returns Suggested output filename
 */
export function generateExportFilename(inputPath: string): string {
    const filename = getFilename(inputPath);
    const inputName = filename.replace(/\.pdf$/i, '');
    return incrementYearInFilename(inputName) + '.pdf';
}

/**
 * Escape HTML special characters to prevent XSS
 * @param text - Text to escape
 * @returns Escaped text safe for HTML insertion
 */
export function escapeHtml(text: string): string {
    if (typeof text !== 'string') {
        return '';
    }
    const escapeMap: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, char => escapeMap[char]);
}

/**
 * Parse timestamp from Python log line (format: YYYY-MM-DD HH:MM:SS,mmm)
 * @param line - Log line to parse
 * @returns Date object if valid timestamp found, null otherwise
 */
export function parseLogTimestamp(line: string): Date | null {
    if (typeof line !== 'string') {
        return null;
    }
    const match = line.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}),(\d{3})/);
    if (!match) return null;

    const [, date, time, ms] = match;
    const parsed = new Date(`${date}T${time}.${ms}`);
    // Check for invalid date
    if (isNaN(parsed.getTime())) {
        return null;
    }
    return parsed;
}

/**
 * Check if a log line contains ERROR level logging.
 * Detects Python logging format: "YYYY-MM-DD HH:MM:SS,mmm - ERROR - message"
 *
 * IMPORTANT: This specifically matches the log level position in Python's
 * logging format. It cannot be spoofed by user input through /api/log because:
 * 1. That endpoint logs at INFO level, producing " - INFO - " at the level position
 * 2. Even if user includes " - ERROR - " in their message, it appears AFTER the level
 *
 * @param line - Log line to check
 * @returns true if line contains ERROR level log pattern at the correct position
 */
export function isErrorLevelLog(line: string): boolean {
    if (typeof line !== 'string') {
        return false;
    }
    // Match Python logging format: "TIMESTAMP - ERROR - message"
    // The pattern must match: timestamp, then " - ERROR - " as the level field
    // This prevents matching " - ERROR - " that appears in message content
    // Format: YYYY-MM-DD HH:MM:SS,mmm - LEVEL - message
    return /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},\d{3}\s+-\s+ERROR\s+-\s+/i.test(line);
}

/**
 * Check if log content contains ERROR level entries after a given time.
 *
 * @param logContent - Multi-line log content string
 * @param sessionStartTime - Only consider logs after this time (null = all logs)
 * @returns true if any ERROR level logs found in the time range
 */
export function hasErrorInLogContent(logContent: string, sessionStartTime: Date | null): boolean {
    if (typeof logContent !== 'string') {
        return false;
    }

    const lines = logContent.split('\n');
    for (const line of lines) {
        // Filter by session time if provided
        if (sessionStartTime) {
            const logTime = parseLogTimestamp(line);
            if (logTime && logTime < sessionStartTime) {
                continue;
            }
        }

        // Check for ERROR level
        if (isErrorLevelLog(line)) {
            return true;
        }
    }

    return false;
}

// =============================================================================
// Security validation functions for Bug Spray input sanitization
// =============================================================================

/** Maximum allowed length for bug descriptions */
export const MAX_DESCRIPTION_LENGTH = 10000;

/** Maximum allowed length for bug titles */
export const MAX_TITLE_LENGTH = 200;

/**
 * Sanitize a string for safe use as a shell command argument.
 * Escapes shell metacharacters to prevent command injection.
 *
 * @param input - The string to sanitize
 * @returns Sanitized string safe for shell argument
 */
export function sanitizeShellArg(input: string): string {
    if (typeof input !== 'string') {
        return '';
    }
    // Replace shell metacharacters with escaped versions
    // This covers: ` $ \ " ' ; & | < > ( ) { } [ ] * ? ! # ~ ^ newline
    return input
        .replace(/\\/g, '\\\\')      // Backslash first
        .replace(/`/g, '\\`')        // Backtick
        .replace(/\$/g, '\\$')       // Dollar sign
        .replace(/"/g, '\\"')        // Double quote
        .replace(/'/g, "\\'")        // Single quote
        .replace(/;/g, '\\;')        // Semicolon
        .replace(/&/g, '\\&')        // Ampersand
        .replace(/\|/g, '\\|')       // Pipe
        .replace(/</g, '\\<')        // Less than
        .replace(/>/g, '\\>')        // Greater than
        .replace(/\(/g, '\\(')       // Open paren
        .replace(/\)/g, '\\)')       // Close paren
        .replace(/\{/g, '\\{')       // Open brace
        .replace(/\}/g, '\\}')       // Close brace
        .replace(/\[/g, '\\[')       // Open bracket
        .replace(/\]/g, '\\]')       // Close bracket
        .replace(/\*/g, '\\*')       // Asterisk
        .replace(/\?/g, '\\?')       // Question mark
        .replace(/!/g, '\\!')        // Exclamation
        .replace(/#/g, '\\#')        // Hash
        .replace(/~/g, '\\~')        // Tilde
        .replace(/\^/g, '\\^')       // Caret
        .replace(/\n/g, ' ')         // Newline -> space
        .replace(/\r/g, ' ');        // Carriage return -> space
}

/**
 * Validate that a beads issue ID matches expected format.
 * Valid format: prefix-alphanumeric (e.g., "InspirePriceList-abc123", "bug-1234567890")
 *
 * @param id - The issue ID to validate
 * @returns true if ID matches expected format
 */
export function isValidBeadsId(id: string): boolean {
    if (typeof id !== 'string') {
        return false;
    }
    // Allow alphanumeric characters, hyphens, and underscores
    // Must start with alphanumeric, 3-100 characters total
    return /^[A-Za-z0-9][A-Za-z0-9_-]{2,99}$/.test(id);
}

/**
 * Validate that a file path is within an allowed base directory.
 * Prevents directory traversal attacks.
 *
 * @param filePath - The file path to validate
 * @param allowedBasePaths - Array of allowed base directories
 * @returns true if path is within one of the allowed directories
 */
export function isPathWithinAllowed(filePath: string, allowedBasePaths: string[]): boolean {
    if (typeof filePath !== 'string' || !filePath) {
        return false;
    }
    if (!Array.isArray(allowedBasePaths) || allowedBasePaths.length === 0) {
        return false;
    }

    // Normalize path separators
    const normalizedPath = filePath.replace(/\\/g, '/');

    // Check for directory traversal patterns
    if (normalizedPath.includes('..')) {
        return false;
    }

    // Check if path starts with one of the allowed base paths
    return allowedBasePaths.some(basePath => {
        const normalizedBase = basePath.replace(/\\/g, '/');
        // Ensure base path ends with / for proper prefix matching
        const baseWithSlash = normalizedBase.endsWith('/') ? normalizedBase : normalizedBase + '/';
        return normalizedPath.startsWith(baseWithSlash) || normalizedPath === normalizedBase;
    });
}

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated.
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum allowed length
 * @returns Truncated text
 */
export function truncateText(text: string, maxLength: number): string {
    if (typeof text !== 'string') {
        return '';
    }
    if (typeof maxLength !== 'number' || maxLength < 0 || isNaN(maxLength)) {
        return text;
    }
    if (text.length <= maxLength) {
        return text;
    }
    // Reserve 3 chars for ellipsis
    return text.substring(0, maxLength - 3) + '...';
}

/**
 * Validate and sanitize bug report title.
 * Truncates to max length and sanitizes for shell use.
 *
 * @param title - The title to validate
 * @returns Sanitized title
 */
export function sanitizeBugTitle(title: string): string {
    if (typeof title !== 'string') {
        return 'Bug report';
    }
    const trimmed = title.trim();
    if (!trimmed) {
        return 'Bug report';
    }
    const truncated = truncateText(trimmed, MAX_TITLE_LENGTH);
    return sanitizeShellArg(truncated);
}

/**
 * Validate and sanitize bug report description.
 * Truncates to max length and sanitizes for shell use.
 *
 * @param description - The description to validate
 * @returns Sanitized description
 */
export function sanitizeBugDescription(description: string): string {
    if (typeof description !== 'string') {
        return '';
    }
    const truncated = truncateText(description.trim(), MAX_DESCRIPTION_LENGTH);
    return sanitizeShellArg(truncated);
}
