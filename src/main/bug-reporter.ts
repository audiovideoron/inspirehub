import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow, app, ipcMain, IpcMainEvent, net } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    parseLogTimestamp,
    hasErrorInLogContent,
    sanitizeShellArg,
    sanitizeBugTitle,
    sanitizeBugDescription,
    isValidBeadsId,
    isPathWithinAllowed,
    MAX_DESCRIPTION_LENGTH,
    MAX_TITLE_LENGTH
} from '../shared/utils';
import { getLogsForBugSpray, hasErrorLogs, LogEntry } from './shell-logger';

// GitHub API configuration for user bug reports
const GITHUB_REPO = 'audiovideoron/inspirehub';

// Load PAT from config file (injected at build time) or environment
function loadGitHubPAT(): string {
    // First try environment variable (for development)
    if (process.env.BUGSPRAY_GITHUB_PAT) {
        return process.env.BUGSPRAY_GITHUB_PAT;
    }
    // Then try config file (for packaged app)
    try {
        const configPath = path.join(__dirname, '..', 'config.json');
        const config = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
        return config.BUGSPRAY_GITHUB_PAT || '';
    } catch {
        return '';
    }
}
const GITHUB_PAT = loadGitHubPAT();

/**
 * Interface for bug context data
 */
interface BugContext {
    screenshot: string | null;
    logs: { [filename: string]: string };
    appState: any;
    systemInfo: SystemInfo;
}

/**
 * System information
 */
interface SystemInfo {
    app_name: string;
    app_version: string;
    os: string;
    arch: string;
    memory_total_gb: string;
    memory_free_gb: string;
    timestamp: string;
}

/**
 * Bug data for submission
 */
interface BugData {
    title: string;
    userDescription: string;
    includeScreenshot: boolean;
    context?: BugContext;
}

/**
 * Similar bug result from bd search
 */
interface SimilarBug {
    id: string;
    title: string;
    status: string;
    description: string;
}

/**
 * Bug report for list view
 */
export interface BugReport {
    id: string;
    title: string;
    status: string;
    priority: number;
    type: string;
    labels: string[];
    created: string;
    voteCount?: number;
}

/**
 * Detailed bug report with full context
 */
export interface BugReportDetail extends BugReport {
    description: string;
    hasScreenshot: boolean;
    hasLogs: boolean;
    hasSystemInfo: boolean;
}

/**
 * Filters for listing bug reports
 */
export interface BugReportFilters {
    status?: 'open' | 'in_progress' | 'deferred' | 'closed';
    label?: string;
    needsTriage?: boolean;
}

/**
 * Triage action types
 */
export type TriageAction = 'approve' | 'reject' | 'prioritize' | 'start_work' | 'mark_fixed' | 'close';

/**
 * Triage action parameters
 */
export interface TriageParams {
    action: TriageAction;
    priority?: number;
    reason?: string;
}

/**
 * BugReporter class handles capturing and submitting bug reports
 */
export class BugReporter {
    private mainWindow: BrowserWindow;
    private attachmentDir: string;
    private sessionStartTime: Date;

    constructor(mainWindow: BrowserWindow) {
        this.mainWindow = mainWindow;
        this.attachmentDir = path.join(app.getPath('userData'), 'bug-attachments');
        this.sessionStartTime = new Date();
    }

    /**
     * Reset session start time (call when renderer reloads)
     */
    resetSession(): void {
        this.sessionStartTime = new Date();
    }

    /**
     * Capture all bug context (screenshot, logs, app state, system info)
     */
    async captureContext(): Promise<BugContext> {
        const [screenshot, logs, appState] = await Promise.all([
            this.captureScreenshot(),
            this.captureLogs(),
            this.captureAppState()
        ]);

        return {
            screenshot,
            logs,
            appState,
            systemInfo: this.getSystemInfo()
        };
    }

    /**
     * Take screenshot of main window
     */
    async captureScreenshot(): Promise<string | null> {
        try {
            const image = await this.mainWindow.webContents.capturePage();
            const timestamp = Date.now();
            const filename = `screenshot-${timestamp}.png`;
            const filepath = path.join(this.attachmentDir, filename);

            await fs.mkdir(this.attachmentDir, { recursive: true });
            await fs.writeFile(filepath, image.toPNG());

            return filepath;
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            return null;
        }
    }

    /**
     * Collect logs from shell logging service (frontend) and backend log files.
     * Discovers all InspireHub backend logs from /tmp/inspirehub-*.log
     */
    async captureLogs(): Promise<{ [filename: string]: string }> {
        const logs: { [filename: string]: string } = {};

        // 1. Get frontend logs from shell logging service (in-memory buffer)
        try {
            const frontendLogs = getLogsForBugSpray({ limit: 100 });
            if (frontendLogs.length > 0) {
                logs['frontend-logs.txt'] = this.sanitizeLogs(frontendLogs.join('\n'));
            }
        } catch (error) {
            console.error('Failed to get frontend logs:', error);
        }

        // 2. Discover and read backend logs from /tmp/inspirehub-*.log
        const backendLogDir = process.platform === 'win32'
            ? os.tmpdir()
            : '/tmp';

        try {
            const files = await fs.readdir(backendLogDir);
            const inspirehubLogs = files.filter(f => f.startsWith('inspirehub-') && f.endsWith('.log'));

            for (const logFile of inspirehubLogs) {
                try {
                    const logPath = path.join(backendLogDir, logFile);
                    const content = await fs.readFile(logPath, 'utf-8');
                    const lines = content.split('\n');
                    // Last 50 lines, sanitized
                    const last50 = lines.slice(-50).join('\n');
                    logs[logFile] = this.sanitizeLogs(last50);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        logs[logFile] = `Error reading log: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }
        } catch (error) {
            console.error('Failed to discover backend logs:', error);
        }

        // 3. Also check legacy log locations for backwards compatibility
        const legacyLogFiles = [
            path.join(app.getPath('userData'), 'python-bridge.log'),
            '/tmp/debug.log'
        ];

        for (const logFile of legacyLogFiles) {
            try {
                const content = await fs.readFile(logFile, 'utf-8');
                const lines = content.split('\n');
                const last50 = lines.slice(-50).join('\n');
                logs[path.basename(logFile)] = this.sanitizeLogs(last50);
            } catch (error) {
                // File might not exist, that's okay
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    logs[path.basename(logFile)] = `Error reading log: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
        }

        return logs;
    }

    /**
     * Sanitize logs to remove sensitive data
     */
    private sanitizeLogs(content: string): string {
        return content
            // Remove potential API keys and tokens
            .replace(/([A-Za-z_]*(?:key|token|secret|password|auth)[A-Za-z_]*)\s*[:=]\s*['"]?[A-Za-z0-9_\-./]{8,}['"]?/gi, '$1=[REDACTED]')
            // Remove email addresses
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
            // Remove IP addresses (but keep localhost)
            .replace(/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]')
            // Remove home directory paths (macOS/Linux)
            .replace(/\/Users\/[^/\s]+/g, '/Users/[USER]')
            .replace(/\/home\/[^/\s]+/g, '/home/[USER]')
            // Remove Windows user paths
            .replace(/C:\\Users\\[^\\s]+/gi, 'C:\\Users\\[USER]');
    }

    /**
     * Check if current session logs contain ERROR level entries.
     * Checks both frontend (shell logging service) and backend log files.
     * ERROR level logs from backend cannot be injected via /api/log.
     * Used to determine if bug report should auto-approve (skip triage).
     */
    async hasErrorInLogs(): Promise<boolean> {
        // 1. Check frontend logs from shell logging service (fast, in-memory)
        if (hasErrorLogs()) {
            return true;
        }

        // 2. Check backend log files for ERROR level entries
        const backendLogDir = process.platform === 'win32'
            ? os.tmpdir()
            : '/tmp';

        try {
            const files = await fs.readdir(backendLogDir);
            const inspirehubLogs = files.filter(f => f.startsWith('inspirehub-') && f.endsWith('.log'));

            for (const logFile of inspirehubLogs) {
                try {
                    const logPath = path.join(backendLogDir, logFile);
                    const content = await fs.readFile(logPath, 'utf-8');
                    if (hasErrorInLogContent(content, this.sessionStartTime)) {
                        return true;
                    }
                } catch {
                    // File read error, continue checking others
                }
            }
        } catch {
            // Directory read error
        }

        // 3. Also check legacy log locations
        const legacyLogFiles = [
            path.join(app.getPath('userData'), 'python-bridge.log'),
            '/tmp/debug.log'
        ];

        for (const logFile of legacyLogFiles) {
            try {
                const content = await fs.readFile(logFile, 'utf-8');
                if (hasErrorInLogContent(content, this.sessionStartTime)) {
                    return true;
                }
            } catch {
                // File doesn't exist or read error
            }
        }

        return false;
    }

    /**
     * Get filtered, human-readable logs for display in Bug Spray
     * Only shows events from current session (since last renderer load)
     */
    async getFilteredLogsForDisplay(): Promise<string[]> {
        const events: string[] = [];

        // 1. Get frontend events from shell logging service (structured, in-memory)
        try {
            const frontendLogs = getLogsForBugSpray({
                since: this.sessionStartTime.toISOString(),
                limit: 50
            });
            for (const line of frontendLogs) {
                const event = this.formatLogLine(line);
                if (event && !this.isNoiseLog(line)) {
                    if (events.length === 0 || events[events.length - 1] !== event) {
                        events.push(event);
                    }
                }
            }
        } catch {
            // Shell logging not available
        }

        // 2. Get backend events from log files
        const backendLogDir = process.platform === 'win32'
            ? os.tmpdir()
            : '/tmp';

        try {
            const files = await fs.readdir(backendLogDir);
            const inspirehubLogs = files.filter(f => f.startsWith('inspirehub-') && f.endsWith('.log'));

            for (const logFile of inspirehubLogs) {
                try {
                    const logPath = path.join(backendLogDir, logFile);
                    const content = await fs.readFile(logPath, 'utf-8');
                    const lines = content.split('\n');

                    for (const line of lines) {
                        if (this.isNoiseLog(line)) continue;
                        if (!line.trim()) continue;

                        // Filter by session time
                        const logTime = parseLogTimestamp(line);
                        if (logTime && logTime < this.sessionStartTime) continue;

                        const event = this.formatLogLine(line);
                        if (event) {
                            if (events.length === 0 || events[events.length - 1] !== event) {
                                events.push(event);
                            }
                        }
                    }
                } catch {
                    // File read error
                }
            }
        } catch {
            // Directory read error
        }

        // Return last 10 meaningful events
        return events.slice(-10);
    }

    /**
     * Check if a log line is noise that should be filtered out
     */
    private isNoiseLog(line: string): boolean {
        return line.includes('/api/health') ||
               line.includes('Debug mode:') ||
               (line.includes('Port:') && !line.includes('Loading')) ||
               line.includes('READY signal') ||
               line.includes('Logging initialized');
    }

    /**
     * Format a log line into human-readable text
     */
    private formatLogLine(line: string): string | null {
        // UI events from frontend (passed through /api/log)
        let match = line.match(/\[UI\]\s*(.+)/i);
        if (match) return match[1].trim();

        // Loading PDF
        match = line.match(/Loading PDF:.*\/([^/]+\.pdf)/i);
        if (match) return `Opened ${match[1]}`;

        // Found prices (only match "Found X prices total" to avoid duplicates)
        match = line.match(/Found (\d+) prices total/i);
        if (match) return `Found ${match[1]} prices`;

        // Export
        match = line.match(/Exporting.*to.*\/([^/]+\.pdf)/i);
        if (match) return `Exported to ${match[1]}`;

        match = line.match(/Export complete/i);
        if (match) return 'Export complete';

        // Errors
        match = line.match(/ERROR.*?[-:]\s*(.+)/i);
        if (match) return `Error: ${match[1].substring(0, 100)}`;

        match = line.match(/Exception.*?[-:]\s*(.+)/i);
        if (match) return `Exception: ${match[1].substring(0, 100)}`;

        // Skip "Processing page" - internal noise

        return null;
    }

    /**
     * Get current app state from renderer
     */
    async captureAppState(): Promise<any> {
        return new Promise((resolve) => {
            // Request state from renderer
            this.mainWindow.webContents.send('request-app-state');

            // Listen for response with timeout
            const timeout = setTimeout(() => {
                resolve({ error: 'Timeout getting app state' });
            }, 5000);

            const handler = (event: IpcMainEvent, state: any) => {
                clearTimeout(timeout);
                ipcMain.removeListener('app-state-response', handler);
                resolve(state);
            };

            ipcMain.once('app-state-response', handler);
        });
    }

    /**
     * Get system information
     */
    getSystemInfo(): SystemInfo {
        return {
            app_name: 'inspirehub',
            app_version: app.getVersion(),
            os: `${os.platform()} ${os.release()}`,
            arch: os.arch(),
            memory_total_gb: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
            memory_free_gb: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Search for similar bugs in beads (development only)
     */
    async searchSimilarBugs(query: string): Promise<SimilarBug[]> {
        // Skip search in packaged app - no access to beads
        if (app.isPackaged) {
            return [];
        }

        // Security: Sanitize query to prevent command injection
        const sanitizedQuery = sanitizeShellArg(query.substring(0, 200)); // Limit query length too

        return new Promise((resolve, reject) => {
            const proc = spawn('bd', ['search', sanitizedQuery, '--type=bug', '--limit=5', '--json']);

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => stdout += data.toString());
            proc.stderr.on('data', (data: Buffer) => stderr += data.toString());

            proc.on('close', (code: number | null) => {
                if (code !== 0) {
                    // bd search might fail if no beads repo, that's okay
                    resolve([]);
                } else {
                    try {
                        const results = this.parseBdSearchJson(stdout);
                        resolve(results);
                    } catch (error) {
                        console.error('Failed to parse bd search output:', error);
                        resolve([]);
                    }
                }
            });
        });
    }

    /**
     * Parse bd search JSON output into SimilarBug objects
     */
    private parseBdSearchJson(output: string): SimilarBug[] {
        try {
            const issues = JSON.parse(output);
            if (!Array.isArray(issues)) return [];

            return issues.map((issue: any) => ({
                id: issue.id,
                title: issue.title,
                status: issue.status,
                description: this.extractUserReport(issue.description || '')
            }));
        } catch {
            return [];
        }
    }

    /**
     * Extract the user report section from a bug description
     */
    private extractUserReport(description: string): string {
        // Look for "## User Report" section
        const match = description.match(/## User Report\s*\n([\s\S]*?)(?=\n##|$)/);
        if (match) {
            return match[1].trim().substring(0, 200); // Truncate to 200 chars
        }
        // Fallback: return first 200 chars
        return description.substring(0, 200).trim();
    }

    /**
     * Submit bug to beads (development) or GitHub Issues (packaged app)
     */
    async submitBug(bugData: BugData): Promise<{ success: boolean; bugId?: string; error?: string; autoApproved?: boolean }> {
        try {
            const { title, userDescription, context } = bugData;

            if (!context) {
                return { success: false, error: 'No context provided' };
            }

            // Check if logs contain ERROR level entries (auto-approve if true)
            const hasError = await this.hasErrorInLogs();

            // Build bug description with context (same format for both paths)
            const logsContent = Object.entries(context.logs)
                .map(([file, content]) => `=== ${file} ===\n${content}`)
                .join('\n\n');

            const fullDescription = `## User Report
${userDescription}

## System Context
- **App Version:** ${context.systemInfo.app_version}
- **OS:** ${context.systemInfo.os}
- **Memory:** ${context.systemInfo.memory_free_gb}GB free / ${context.systemInfo.memory_total_gb}GB total
- **Timestamp:** ${context.systemInfo.timestamp}

## App State
\`\`\`json
${JSON.stringify(context.appState, null, 2)}
\`\`\`

## Logs
\`\`\`
${logsContent}
\`\`\`
`;

            // Packaged app: submit to GitHub Issues
            if (app.isPackaged) {
                return await this.createGitHubIssue(title, fullDescription, hasError);
            }

            // Development: submit to beads
            const bugId = `bug-${Date.now()}`;
            const bugAttachmentDir = path.join(this.attachmentDir, bugId);
            await fs.mkdir(bugAttachmentDir, { recursive: true });

            // Copy screenshot to bug directory
            if (context.screenshot && bugData.includeScreenshot) {
                try {
                    const screenshotDest = path.join(bugAttachmentDir, 'screenshot.png');
                    await fs.copyFile(context.screenshot, screenshotDest);
                } catch (error) {
                    console.error('Failed to copy screenshot:', error);
                }
            }

            // Write logs to bug directory
            const logsFile = path.join(bugAttachmentDir, 'logs.txt');
            await fs.writeFile(logsFile, logsContent);

            // Write system info to bug directory
            const sysInfoFile = path.join(bugAttachmentDir, 'system-info.json');
            await fs.writeFile(sysInfoFile, JSON.stringify({
                ...context.systemInfo,
                appState: context.appState
            }, null, 2));

            // Call bd create
            const beadsId = await this.createBeadsIssue(title, fullDescription, hasError);

            // Copy attachments to .beads/attachments/ if successful
            if (beadsId) {
                await this.copyAttachmentsToBeads(bugAttachmentDir, beadsId);
                return { success: true, bugId: beadsId, autoApproved: hasError };
            } else {
                return { success: false, error: 'Failed to create beads issue' };
            }

        } catch (error) {
            console.error('Bug submission failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Create GitHub issue for packaged app bug reports
     */
    private async createGitHubIssue(
        title: string,
        description: string,
        hasError: boolean
    ): Promise<{ success: boolean; bugId?: string; error?: string; autoApproved?: boolean }> {
        if (!GITHUB_PAT) {
            return { success: false, error: 'Bug reporting not configured' };
        }

        const labels = hasError
            ? ['user-reported', 'has-error']
            : ['user-reported', 'needs-triage'];

        const body = JSON.stringify({
            title: `[User Report] ${title}`,
            body: description,
            labels: labels
        });

        return new Promise((resolve) => {
            const request = net.request({
                method: 'POST',
                url: `https://api.github.com/repos/${GITHUB_REPO}/issues`
            });

            request.setHeader('Authorization', `Bearer ${GITHUB_PAT}`);
            request.setHeader('Accept', 'application/vnd.github+json');
            request.setHeader('Content-Type', 'application/json');
            request.setHeader('User-Agent', 'inspirehub-BugSpray');

            let responseData = '';

            request.on('response', (response) => {
                response.on('data', (chunk) => {
                    responseData += chunk.toString();
                });

                response.on('end', () => {
                    if (response.statusCode === 201) {
                        try {
                            const issue = JSON.parse(responseData);
                            resolve({
                                success: true,
                                bugId: `#${issue.number}`,
                                autoApproved: hasError
                            });
                        } catch {
                            resolve({ success: false, error: 'Failed to parse GitHub response' });
                        }
                    } else {
                        console.error('GitHub API error:', response.statusCode, responseData);
                        resolve({
                            success: false,
                            error: `GitHub API error: ${response.statusCode}`
                        });
                    }
                });
            });

            request.on('error', (error) => {
                console.error('GitHub request failed:', error);
                resolve({ success: false, error: 'Network error submitting bug report' });
            });

            request.write(body);
            request.end();
        });
    }

    /**
     * Create a beads issue using bd CLI
     * @param title - Issue title
     * @param description - Issue description
     * @param hasError - If true, skip deferral (ERROR in logs = auto-approve for bd ready)
     */
    private createBeadsIssue(title: string, description: string, hasError: boolean): Promise<string | null> {
        return new Promise((resolve) => {
            // Security: Sanitize inputs to prevent command injection
            const sanitizedTitle = sanitizeBugTitle(title);
            const sanitizedDescription = sanitizeBugDescription(description);

            // Use different labels based on whether error was detected
            const labels = hasError
                ? ['user-reported', 'has-error']  // Auto-approved, visible to bd ready
                : ['user-reported', 'needs-triage'];  // Requires human triage

            const proc = spawn('bd', [
                'create',
                '--title', `[User Report] ${sanitizedTitle}`,
                '--type', 'bug',
                '--priority', hasError ? '1' : '2',  // Higher priority if error detected
                '--label', labels[0],
                '--label', labels[1],
                '--description', sanitizedDescription
            ]);

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => stdout += data.toString());
            proc.stderr.on('data', (data: Buffer) => stderr += data.toString());

            proc.on('close', (code: number | null) => {
                if (code !== 0) {
                    console.error('bd create failed:', stderr);
                    resolve(null);
                } else {
                    // Extract bug ID from output (format: "Created issue: inspirehub-abc123")
                    const match = stdout.match(/Created issue:\s*([\w-]+)/i);
                    const beadsId = match ? match[1] : null;

                    if (beadsId) {
                        if (hasError) {
                            // Error detected: leave as open (visible to bd ready)
                            resolve(beadsId);
                        } else {
                            // No error: defer for human triage
                            this.deferIssue(beadsId).then(() => resolve(beadsId));
                        }
                    } else {
                        resolve(null);
                    }
                }
            });
        });
    }

    /**
     * Set issue status to deferred (hidden from bd ready until triaged)
     */
    private deferIssue(beadsId: string): Promise<void> {
        return new Promise((resolve) => {
            // Security: Validate beads ID format
            if (!isValidBeadsId(beadsId)) {
                console.error('Invalid beads ID format:', beadsId);
                resolve();
                return;
            }
            const proc = spawn('bd', ['update', beadsId, '--status', 'deferred']);
            proc.on('close', () => resolve());
        });
    }

    /**
     * Add a "me too" vote to an existing issue
     * Stores votes in .beads/attachments/<issue-id>/votes.json
     */
    async addMeTooVote(issueId: string, note: string): Promise<{ success: boolean; voteCount?: number; error?: string }> {
        try {
            // Security: Validate issue ID format to prevent path traversal
            if (!isValidBeadsId(issueId)) {
                return { success: false, error: 'Invalid issue ID format' };
            }

            const beadsBase = path.join(process.cwd(), '.beads', 'attachments');
            const votesDir = path.join(beadsBase, issueId);

            // Security: Verify path is within allowed directory
            if (!isPathWithinAllowed(votesDir, [beadsBase])) {
                return { success: false, error: 'Invalid path' };
            }

            const votesFile = path.join(votesDir, 'votes.json');

            await fs.mkdir(votesDir, { recursive: true });

            // Read existing votes or start fresh
            let votes: Array<{ timestamp: string; note: string; systemInfo: SystemInfo }> = [];
            try {
                const existing = await fs.readFile(votesFile, 'utf-8');
                votes = JSON.parse(existing);
            } catch {
                // File doesn't exist yet, start with empty array
            }

            // Add new vote
            votes.push({
                timestamp: new Date().toISOString(),
                note: note || 'Me too',
                systemInfo: this.getSystemInfo()
            });

            await fs.writeFile(votesFile, JSON.stringify(votes, null, 2));

            return { success: true, voteCount: votes.length };
        } catch (error) {
            console.error('Failed to add me too vote:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Get vote count for an issue
     */
    async getVoteCount(issueId: string): Promise<number> {
        try {
            // Security: Validate issue ID format to prevent path traversal
            if (!isValidBeadsId(issueId)) {
                return 0;
            }

            const beadsBase = path.join(process.cwd(), '.beads', 'attachments');
            const votesFile = path.join(beadsBase, issueId, 'votes.json');

            // Security: Verify path is within allowed directory
            if (!isPathWithinAllowed(votesFile, [beadsBase])) {
                return 0;
            }

            const content = await fs.readFile(votesFile, 'utf-8');
            const votes = JSON.parse(content);
            return Array.isArray(votes) ? votes.length : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Copy attachments to beads directory
     */
    private async copyAttachmentsToBeads(sourceDir: string, beadsId: string): Promise<void> {
        try {
            // Security: Validate beads ID format
            if (!isValidBeadsId(beadsId)) {
                console.error('Invalid beads ID format:', beadsId);
                return;
            }

            // Assuming beads attachments go in project root/.beads/attachments/
            const beadsBase = path.join(process.cwd(), '.beads', 'attachments');
            const beadsAttachmentDir = path.join(beadsBase, beadsId);

            // Security: Verify destination path is within allowed directory
            if (!isPathWithinAllowed(beadsAttachmentDir, [beadsBase])) {
                console.error('Invalid destination path');
                return;
            }

            await fs.mkdir(beadsAttachmentDir, { recursive: true });

            const files = await fs.readdir(sourceDir);
            for (const file of files) {
                // Security: Validate filename to prevent directory traversal
                if (file.includes('..') || file.includes('/') || file.includes('\\')) {
                    console.error('Invalid filename in source directory:', file);
                    continue;
                }
                const src = path.join(sourceDir, file);
                const dest = path.join(beadsAttachmentDir, file);
                await fs.copyFile(src, dest);
            }
        } catch (error) {
            console.error('Failed to copy attachments to beads:', error);
            // Non-fatal, continue
        }
    }

    // ========== Bug Spray App Methods (Development Mode Only) ==========

    /**
     * List bug reports from beads (development mode only)
     * In packaged app, returns empty array - users see their reports via GitHub
     */
    async listBugReports(filters?: BugReportFilters): Promise<BugReport[]> {
        // Only available in development mode
        if (app.isPackaged) {
            return [];
        }

        return new Promise((resolve) => {
            const args = ['list', '--label=user-reported', '--json'];

            // Add status filter with validation
            // Status is from enum type, but sanitize anyway for defense in depth
            const validStatuses = ['open', 'in_progress', 'deferred', 'closed'];
            if (filters?.status && validStatuses.includes(filters.status)) {
                args.push('--status', filters.status);
            }
            if (filters?.needsTriage) {
                args.push('--label=needs-triage');
            }
            // Security: Sanitize label filter
            if (filters?.label && typeof filters.label === 'string') {
                const sanitizedLabel = sanitizeShellArg(filters.label.substring(0, 100));
                args.push('--label', sanitizedLabel);
            }

            const proc = spawn('bd', args);

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => stdout += data.toString());
            proc.stderr.on('data', (data: Buffer) => stderr += data.toString());

            proc.on('close', async (code: number | null) => {
                if (code !== 0) {
                    console.error('bd list failed:', stderr);
                    resolve([]);
                    return;
                }

                try {
                    const issues = JSON.parse(stdout);
                    if (!Array.isArray(issues)) {
                        resolve([]);
                        return;
                    }

                    // Map to BugReport format and add vote counts
                    const reports: BugReport[] = await Promise.all(
                        issues.map(async (issue: any) => ({
                            id: issue.id,
                            title: issue.title,
                            status: issue.status,
                            priority: issue.priority || 2,
                            type: issue.issue_type || issue.type || 'bug',
                            labels: issue.labels || [],
                            created: issue.created_at || issue.created || '',
                            voteCount: await this.getVoteCount(issue.id)
                        }))
                    );

                    resolve(reports);
                } catch (error) {
                    console.error('Failed to parse bd list output:', error);
                    resolve([]);
                }
            });
        });
    }

    /**
     * Get detailed bug report (development mode only)
     */
    async getBugReportDetail(id: string): Promise<BugReportDetail | null> {
        // Only available in development mode
        if (app.isPackaged) {
            return null;
        }

        // Security: Validate issue ID format
        if (!isValidBeadsId(id)) {
            console.error('Invalid beads ID format:', id);
            return null;
        }

        return new Promise((resolve) => {
            const proc = spawn('bd', ['show', id, '--json']);

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => stdout += data.toString());
            proc.stderr.on('data', (data: Buffer) => stderr += data.toString());

            proc.on('close', async (code: number | null) => {
                if (code !== 0) {
                    console.error('bd show failed:', stderr);
                    resolve(null);
                    return;
                }

                try {
                    const parsed = JSON.parse(stdout);
                    // bd show --json returns an array with one element
                    const issue = Array.isArray(parsed) ? parsed[0] : parsed;
                    if (!issue) {
                        resolve(null);
                        return;
                    }

                    // Check for attachments
                    const attachmentDir = path.join(process.cwd(), '.beads', 'attachments', id);
                    let hasScreenshot = false;
                    let hasLogs = false;
                    let hasSystemInfo = false;

                    try {
                        const files = await fs.readdir(attachmentDir);
                        hasScreenshot = files.some((f: string) => f.includes('screenshot'));
                        hasLogs = files.some((f: string) => f.includes('logs'));
                        hasSystemInfo = files.some((f: string) => f.includes('system-info'));
                    } catch {
                        // Attachment dir doesn't exist
                    }

                    const detail: BugReportDetail = {
                        id: issue.id,
                        title: issue.title,
                        status: issue.status,
                        priority: issue.priority || 2,
                        type: issue.issue_type || issue.type || 'bug',
                        labels: issue.labels || [],
                        created: issue.created_at || issue.created || '',
                        description: issue.description || '',
                        voteCount: await this.getVoteCount(id),
                        hasScreenshot,
                        hasLogs,
                        hasSystemInfo
                    };

                    resolve(detail);
                } catch (error) {
                    console.error('Failed to parse bd show output:', error);
                    resolve(null);
                }
            });
        });
    }

    /**
     * Triage a bug report (development mode only)
     * - approve: Move from deferred to open, remove needs-triage label
     * - reject: Close the issue with a reason
     * - prioritize: Set priority level
     */
    async triageBugReport(id: string, params: TriageParams): Promise<{ success: boolean; error?: string }> {
        // Only available in development mode
        if (app.isPackaged) {
            return { success: false, error: 'Triage not available in packaged app' };
        }

        // Security: Validate issue ID format
        if (!isValidBeadsId(id)) {
            return { success: false, error: 'Invalid issue ID format' };
        }

        // Security: Validate and sanitize reason if provided
        const sanitizedReason = params.reason
            ? sanitizeShellArg(params.reason.substring(0, 500))
            : undefined;

        // Security: Validate priority is a valid number
        const validPriority = params.priority !== undefined
            && typeof params.priority === 'number'
            && params.priority >= 1
            && params.priority <= 5
            ? params.priority
            : 2;

        return new Promise((resolve) => {
            let args: string[];

            switch (params.action) {
                case 'approve':
                    // Move to open status and remove needs-triage label
                    args = ['update', id, '--status', 'open', '--remove-label', 'needs-triage'];
                    break;

                case 'reject':
                    // Close the issue with a reason
                    args = ['close', id];
                    if (sanitizedReason) {
                        args.push('--reason', sanitizedReason);
                    }
                    break;

                case 'prioritize':
                    // Set priority
                    args = ['update', id, '--priority', String(validPriority)];
                    break;

                case 'start_work':
                    // Change status to in_progress
                    args = ['update', id, '--status', 'in_progress'];
                    break;

                case 'mark_fixed':
                    // Close the issue as fixed
                    args = ['close', id, '--reason', 'Fixed'];
                    break;

                case 'close':
                    // Close without specific reason
                    args = ['close', id];
                    if (sanitizedReason) {
                        args.push('--reason', sanitizedReason);
                    }
                    break;

                default:
                    resolve({ success: false, error: `Unknown triage action: ${params.action}` });
                    return;
            }

            const proc = spawn('bd', args);

            let stderr = '';
            proc.stderr.on('data', (data: Buffer) => stderr += data.toString());

            proc.on('close', (code: number | null) => {
                if (code !== 0) {
                    console.error('bd triage failed:', stderr);
                    resolve({ success: false, error: stderr || 'Triage command failed' });
                } else {
                    resolve({ success: true });
                }
            });
        });
    }

    /**
     * Get attachment content (development mode only)
     * @param id - Issue ID
     * @param type - 'logs' | 'screenshot' | 'system-info'
     * @returns Content as string (base64 for screenshot) or null if not found
     */
    async getAttachment(id: string, type: 'logs' | 'screenshot' | 'system-info'): Promise<string | null> {
        // Only available in development mode
        if (app.isPackaged) {
            return null;
        }

        // Security: Validate issue ID format to prevent path traversal
        if (!isValidBeadsId(id)) {
            console.error('Invalid beads ID format:', id);
            return null;
        }

        const beadsBase = path.join(process.cwd(), '.beads', 'attachments');
        const attachmentDir = path.join(beadsBase, id);

        // Security: Verify path is within allowed directory
        if (!isPathWithinAllowed(attachmentDir, [beadsBase])) {
            console.error('Invalid attachment path');
            return null;
        }

        try {
            const files = await fs.readdir(attachmentDir);
            let filename: string | undefined;

            switch (type) {
                case 'logs':
                    filename = files.find((f: string) => f.includes('logs'));
                    break;
                case 'screenshot':
                    filename = files.find((f: string) => f.includes('screenshot'));
                    break;
                case 'system-info':
                    filename = files.find((f: string) => f.includes('system-info'));
                    break;
            }

            if (!filename) {
                return null;
            }

            // Security: Validate filename doesn't contain path traversal
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                console.error('Invalid filename:', filename);
                return null;
            }

            const filePath = path.join(attachmentDir, filename);

            if (type === 'screenshot') {
                // Return as base64 data URL
                const content = await fs.readFile(filePath);
                return `data:image/png;base64,${content.toString('base64')}`;
            } else {
                // Return as text
                return await fs.readFile(filePath, 'utf-8');
            }
        } catch (error) {
            console.error(`Failed to get attachment ${type} for ${id}:`, error);
            return null;
        }
    }
}
