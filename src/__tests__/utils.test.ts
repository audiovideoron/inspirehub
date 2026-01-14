/**
 * Unit tests for shared utility functions
 * These tests cover pure functions that don't require Electron
 */

import {
    getFilename,
    formatPrice,
    parsePrice,
    isPortValid,
    incrementYearInFilename,
    generateExportFilename,
    escapeHtml,
    parseLogTimestamp,
    isErrorLevelLog,
    hasErrorInLogContent
} from '../shared/utils';

describe('getFilename', () => {
    test('extracts filename from Unix path', () => {
        expect(getFilename('/Users/test/documents/pricelist.pdf')).toBe('pricelist.pdf');
    });

    test('extracts filename from Windows path', () => {
        expect(getFilename('C:\\Users\\test\\documents\\pricelist.pdf')).toBe('pricelist.pdf');
    });

    test('extracts filename from mixed path separators', () => {
        expect(getFilename('/Users/test\\documents/pricelist.pdf')).toBe('pricelist.pdf');
    });

    test('returns filename if no path separators', () => {
        expect(getFilename('pricelist.pdf')).toBe('pricelist.pdf');
    });

    test('handles empty string', () => {
        expect(getFilename('')).toBe('');
    });

    test('handles null/undefined', () => {
        expect(getFilename(null as any)).toBe('');
        expect(getFilename(undefined as any)).toBe('');
    });

    test('handles path ending with separator', () => {
        expect(getFilename('/Users/test/')).toBe('');
    });
});

describe('formatPrice', () => {
    test('formats whole numbers with commas', () => {
        expect(formatPrice(1000)).toBe('1,000');
        expect(formatPrice(1000000)).toBe('1,000,000');
    });

    test('formats small whole numbers without commas', () => {
        expect(formatPrice(100)).toBe('100');
        expect(formatPrice(999)).toBe('999');
    });

    test('formats decimal numbers with two decimal places', () => {
        expect(formatPrice(1234.56)).toBe('1,234.56');
        expect(formatPrice(99.99)).toBe('99.99');
    });

    test('formats single decimal to two places', () => {
        expect(formatPrice(100.5)).toBe('100.50');
    });

    test('handles zero', () => {
        expect(formatPrice(0)).toBe('0');
    });

    test('handles negative numbers', () => {
        expect(formatPrice(-1000)).toBe('-1,000');
        expect(formatPrice(-99.99)).toBe('-99.99');
    });

    test('handles invalid input', () => {
        expect(formatPrice(NaN)).toBe('');
        expect(formatPrice('string' as any)).toBe('');
        expect(formatPrice(null as any)).toBe('');
    });
});

describe('parsePrice', () => {
    test('parses simple numbers', () => {
        expect(parsePrice('100')).toBe(100);
        expect(parsePrice('99.99')).toBe(99.99);
    });

    test('parses numbers with commas', () => {
        expect(parsePrice('1,000')).toBe(1000);
        expect(parsePrice('1,234,567.89')).toBe(1234567.89);
    });

    test('rejects negative numbers', () => {
        expect(parsePrice('-100')).toBe(null);
        expect(parsePrice('-1,000.50')).toBe(null);
    });

    test('returns null for invalid strings', () => {
        expect(parsePrice('abc')).toBe(null);
        expect(parsePrice('')).toBe(null);
        expect(parsePrice('$100')).toBe(null); // Dollar sign not handled
    });

    test('returns null for non-string input', () => {
        expect(parsePrice(null as any)).toBe(null);
        expect(parsePrice(undefined as any)).toBe(null);
        expect(parsePrice(100 as any)).toBe(null); // Already a number
    });

    test('handles whitespace-only strings', () => {
        expect(parsePrice('   ')).toBe(null);
    });
});

describe('isPortValid', () => {
    test('returns true for valid ports', () => {
        expect(isPortValid(80)).toBe(true);
        expect(isPortValid(8080)).toBe(true);
        expect(isPortValid(1)).toBe(true);
        expect(isPortValid(65535)).toBe(true);
    });

    test('returns false for port 0', () => {
        expect(isPortValid(0)).toBe(false);
    });

    test('returns false for negative ports', () => {
        expect(isPortValid(-1)).toBe(false);
        expect(isPortValid(-8080)).toBe(false);
    });

    test('returns false for ports above 65535', () => {
        expect(isPortValid(65536)).toBe(false);
        expect(isPortValid(100000)).toBe(false);
    });

    test('returns false for non-number input', () => {
        expect(isPortValid('8080' as any)).toBe(false);
        expect(isPortValid(null as any)).toBe(false);
        expect(isPortValid(undefined as any)).toBe(false);
        expect(isPortValid(NaN)).toBe(false);
    });
});

describe('incrementYearInFilename', () => {
    test('increments 4-digit year in filename', () => {
        expect(incrementYearInFilename('PriceList2024')).toBe('PriceList2025');
        expect(incrementYearInFilename('Inspire_Prices_2023')).toBe('Inspire_Prices_2024');
    });

    test('increments year at end of filename', () => {
        expect(incrementYearInFilename('prices2024')).toBe('prices2025');
    });

    test('increments year followed by period', () => {
        expect(incrementYearInFilename('PriceList2024.backup')).toBe('PriceList2025.backup');
    });

    test('does NOT increment product codes (years followed by letters/digits)', () => {
        // Product codes like "Model2025X" should NOT be incremented
        // This prevents incorrect modification of model numbers and SKUs
        expect(incrementYearInFilename('Model2025X')).toBe('Model2025X');
        expect(incrementYearInFilename('Item2024ABC')).toBe('Item2024ABC');
        expect(incrementYearInFilename('SKU20241234')).toBe('SKU20241234');
    });

    test('handles year followed by underscore or dash', () => {
        expect(incrementYearInFilename('Report2024_final')).toBe('Report2025_final');
        expect(incrementYearInFilename('Report2024-v2')).toBe('Report2025-v2');
    });

    test('only increments first matching year', () => {
        expect(incrementYearInFilename('Report2024_2025')).toBe('Report2025_2025');
    });

    test('handles empty or null input', () => {
        expect(incrementYearInFilename('')).toBe('');
        expect(incrementYearInFilename(null as any)).toBe('');
    });

    test('handles filename without year', () => {
        expect(incrementYearInFilename('PriceList')).toBe('PriceList');
    });

    test('handles year 2099 edge case', () => {
        expect(incrementYearInFilename('PriceList2099')).toBe('PriceList2100');
    });

    test('handles 2000-2019 years', () => {
        expect(incrementYearInFilename('Archive2019')).toBe('Archive2020');
        expect(incrementYearInFilename('Report2000')).toBe('Report2001');
    });
});

describe('generateExportFilename', () => {
    test('generates export filename with incremented year', () => {
        expect(generateExportFilename('/path/to/PriceList2024.pdf')).toBe('PriceList2025.pdf');
    });

    test('handles Windows paths', () => {
        expect(generateExportFilename('C:\\Users\\test\\PriceList2024.pdf')).toBe('PriceList2025.pdf');
    });

    test('handles filename without year', () => {
        expect(generateExportFilename('/path/to/PriceList.pdf')).toBe('PriceList.pdf');
    });

    test('handles just filename input', () => {
        expect(generateExportFilename('Prices2024.pdf')).toBe('Prices2025.pdf');
    });

    test('case insensitive PDF extension', () => {
        expect(generateExportFilename('PriceList2024.PDF')).toBe('PriceList2025.pdf');
    });
});

describe('escapeHtml', () => {
    test('escapes ampersand', () => {
        expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    test('escapes less than and greater than', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    test('escapes quotes', () => {
        expect(escapeHtml('"quoted" and \'quoted\'')).toBe('&quot;quoted&quot; and &#39;quoted&#39;');
    });

    test('handles plain text without special chars', () => {
        expect(escapeHtml('Hello World')).toBe('Hello World');
    });

    test('handles empty string', () => {
        expect(escapeHtml('')).toBe('');
    });

    test('handles non-string input', () => {
        expect(escapeHtml(null as any)).toBe('');
        expect(escapeHtml(undefined as any)).toBe('');
        expect(escapeHtml(123 as any)).toBe('');
    });

    test('handles multiple special chars', () => {
        expect(escapeHtml('a<b>c&d"e\'f')).toBe('a&lt;b&gt;c&amp;d&quot;e&#39;f');
    });
});

describe('parseLogTimestamp', () => {
    test('parses valid Python log timestamp', () => {
        const result = parseLogTimestamp('2026-01-11 09:49:09,239 - ERROR - Test error');
        expect(result).toBeInstanceOf(Date);
        expect(result?.getFullYear()).toBe(2026);
        expect(result?.getMonth()).toBe(0); // January is 0
        expect(result?.getDate()).toBe(11);
        expect(result?.getHours()).toBe(9);
        expect(result?.getMinutes()).toBe(49);
        expect(result?.getSeconds()).toBe(9);
    });

    test('returns null for line without timestamp', () => {
        expect(parseLogTimestamp('Some log message without timestamp')).toBe(null);
        expect(parseLogTimestamp('ERROR - something went wrong')).toBe(null);
    });

    test('returns null for invalid input', () => {
        expect(parseLogTimestamp(null as any)).toBe(null);
        expect(parseLogTimestamp(undefined as any)).toBe(null);
        expect(parseLogTimestamp(123 as any)).toBe(null);
    });

    test('returns null for empty string', () => {
        expect(parseLogTimestamp('')).toBe(null);
    });

    test('handles timestamp at different positions in line', () => {
        const result = parseLogTimestamp('[Python stdout] 2026-01-11 09:00:00,123 - INFO - message');
        expect(result).toBeInstanceOf(Date);
    });
});

describe('isErrorLevelLog', () => {
    test('detects ERROR level log line', () => {
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - ERROR - Test error triggered')).toBe(true);
    });

    test('detects ERROR regardless of case', () => {
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - error - lowercase error')).toBe(true);
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - Error - mixed case')).toBe(true);
    });

    test('returns false for INFO level', () => {
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - INFO - Normal message')).toBe(false);
    });

    test('returns false for WARNING level', () => {
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - WARNING - Warning message')).toBe(false);
    });

    test('returns false for DEBUG level', () => {
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - DEBUG - Debug message')).toBe(false);
    });

    test('CRITICAL: rejects injection attempt via /api/log', () => {
        // When user calls /api/log with message containing "ERROR", it logs at INFO level
        // The actual log line would be: " - INFO - [UI] User typed ERROR"
        // This should NOT be detected as an error
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - INFO - [UI] User typed ERROR in chat')).toBe(false);
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - INFO - [UI] ERROR fake injection')).toBe(false);
    });

    test('CRITICAL: rejects fake ERROR in message content', () => {
        // Even if message contains " - ERROR - ", the actual log level matters
        // This tests that we match the logging format, not arbitrary text
        expect(isErrorLevelLog('2026-01-11 09:49:09,239 - INFO - Message with - ERROR - in it')).toBe(false);
    });

    test('returns false for invalid input', () => {
        expect(isErrorLevelLog(null as any)).toBe(false);
        expect(isErrorLevelLog(undefined as any)).toBe(false);
        expect(isErrorLevelLog(123 as any)).toBe(false);
        expect(isErrorLevelLog('')).toBe(false);
    });

    test('returns false for partial pattern match', () => {
        expect(isErrorLevelLog('ERROR - missing leading dash')).toBe(false);
        expect(isErrorLevelLog(' -ERROR - missing space')).toBe(false);
        expect(isErrorLevelLog(' - ERROR- missing trailing space')).toBe(false);
    });
});

describe('hasErrorInLogContent', () => {
    const sampleLogs = `2026-01-11 09:00:00,000 - INFO - Application started
2026-01-11 09:00:01,000 - INFO - Loading PDF
2026-01-11 09:00:02,000 - ERROR - Failed to process PDF
2026-01-11 09:00:03,000 - INFO - Cleanup complete`;

    test('returns true when ERROR is present', () => {
        expect(hasErrorInLogContent(sampleLogs, null)).toBe(true);
    });

    test('returns false when no ERROR present', () => {
        const infoOnly = `2026-01-11 09:00:00,000 - INFO - App started
2026-01-11 09:00:01,000 - INFO - All good`;
        expect(hasErrorInLogContent(infoOnly, null)).toBe(false);
    });

    test('respects session start time filter', () => {
        // Session started at 09:00:01,500 - ERROR at 09:00:02 is AFTER session start
        const sessionStart = new Date('2026-01-11T09:00:01.500');
        expect(hasErrorInLogContent(sampleLogs, sessionStart)).toBe(true);

        // Session started at 09:00:02,500 - ERROR at 09:00:02 is BEFORE session start
        const laterSessionStart = new Date('2026-01-11T09:00:02.500');
        expect(hasErrorInLogContent(sampleLogs, laterSessionStart)).toBe(false);
    });

    test('handles empty content', () => {
        expect(hasErrorInLogContent('', null)).toBe(false);
    });

    test('handles invalid input', () => {
        expect(hasErrorInLogContent(null as any, null)).toBe(false);
        expect(hasErrorInLogContent(undefined as any, null)).toBe(false);
    });

    test('handles single line with ERROR', () => {
        expect(hasErrorInLogContent('2026-01-11 09:00:00,000 - ERROR - Single error', null)).toBe(true);
    });

    test('handles single line without ERROR', () => {
        expect(hasErrorInLogContent('2026-01-11 09:00:00,000 - INFO - Single info', null)).toBe(false);
    });

    test('CRITICAL: injection via message content does not trigger error detection', () => {
        // Simulates what happens when user calls /api/log with malicious content
        const injectionAttempt = `2026-01-11 09:00:00,000 - INFO - [UI] Normal event
2026-01-11 09:00:01,000 - INFO - [UI]  - ERROR - fake injection attempt
2026-01-11 09:00:02,000 - INFO - [UI] Another normal event`;
        expect(hasErrorInLogContent(injectionAttempt, null)).toBe(false);
    });
});
