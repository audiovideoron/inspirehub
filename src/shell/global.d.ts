/**
 * Global type definitions for the shell
 * Same as apps but may not always have api (preload loads after shell)
 */

interface Window {
    api?: {
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
        onFileOpened(callback: (filePath: string) => void): () => void;
        onRequestExport(callback: () => void): () => void;
        onBackendCrashed(callback: (info: any) => void): () => void;
        onBackendStatusChange(callback: (status: string) => void): () => void;
        onBackendStartupProgress(callback: (info: { elapsed: number; maxWait: number }) => void): () => void;
        submitBugReport(bugData: any): Promise<any>;
        searchSimilarBugs(query: string): Promise<any>;
        meTooVote(issueId: string, note: string): Promise<any>;
        getFilteredLogs(): Promise<string[]>;
        resetBugSession(): Promise<void>;
        hasErrorInLogs(): Promise<boolean>;
        onShowBugReportModal(callback: () => void): () => void;
        onRequestAppState(callback: () => void): () => void;
        sendAppState(state: any): void;
        // Logging
        logError(source: string, error: { message: string; stack?: string; filename?: string; lineno?: number; colno?: number }): Promise<void>;
        logConsole(source: string, level: string, message: string, args?: any[]): Promise<void>;
        getLogFilePath(): Promise<string>;
        // Index signature for dynamic access
        [key: string]: any;
    };
}
