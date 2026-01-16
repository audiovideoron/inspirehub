/**
 * Global type definitions for the Bug Spray app
 */

interface BugReport {
    id: string;
    title: string;
    status: string;
    priority: number;
    type: string;
    labels: string[];
    created: string;
    voteCount?: number;
}

interface BugReportDetail extends BugReport {
    description: string;
    hasScreenshot: boolean;
    hasLogs: boolean;
    hasSystemInfo: boolean;
}

interface BugReportFilters {
    status?: 'open' | 'in_progress' | 'deferred' | 'closed';
    label?: string;
    needsTriage?: boolean;
}

interface TriageParams {
    action: 'approve' | 'reject' | 'prioritize' | 'start_work' | 'mark_fixed' | 'close';
    priority?: number;
    reason?: string;
}

interface Window {
    api: {
        // Core APIs
        getPythonPort(): Promise<number | null>;
        getBackendStatus(): Promise<string>;
        getEquipmentPort(): Promise<number | null>;
        getEquipmentStatus(): Promise<string>;
        getBranchId(): Promise<string | null>;
        setBranchId(branchId: string): Promise<{ success: boolean; error?: string }>;
        openFileDialog(): Promise<string | null>;
        saveFileDialog(defaultName: string): Promise<string | null>;
        showMessage(options: any): Promise<any>;
        openPath(filePath: string): Promise<string>;

        // Event listeners
        onFileOpened(callback: (filePath: string) => void): () => void;
        onRequestExport(callback: () => void): () => void;
        onBackendCrashed(callback: (info: any) => void): () => void;
        onBackendStatusChange(callback: (status: string) => void): () => void;
        onBackendStartupProgress(callback: (info: { elapsed: number; maxWait: number }) => void): () => void;
        onShowBugReportModal(callback: () => void): () => void;
        onRequestAppState(callback: () => void): () => void;
        sendAppState(state: any): void;

        // Bug reporting (submission)
        submitBugReport(bugData: any): Promise<any>;
        searchSimilarBugs(query: string): Promise<any>;
        meTooVote(issueId: string, note: string): Promise<any>;
        getFilteredLogs(): Promise<string[]>;
        resetBugSession(): Promise<void>;
        hasErrorInLogs(): Promise<boolean>;

        // Bug Spray App APIs (dev mode only)
        isDevelopmentMode(): Promise<boolean>;
        getBugReports(filters?: BugReportFilters): Promise<BugReport[]>;
        getBugReportDetail(id: string): Promise<BugReportDetail | null>;
        triageBugReport(id: string, params: TriageParams): Promise<{ success: boolean; error?: string }>;
        getAttachment(id: string, type: 'logs' | 'screenshot' | 'system-info'): Promise<string | null>;

        // Logging
        logError(source: string, error: { message: string; stack?: string; filename?: string; lineno?: number; colno?: number }): Promise<void>;
        logConsole(source: string, level: string, message: string, args?: any[]): Promise<void>;
        getLogFilePath(): Promise<string>;

        // Index signature for dynamic access
        [key: string]: any;
    };
}
