/**
 * Global type definitions for the renderer process
 */

interface Window {
    api: {
        getPythonPort(): Promise<number | null>;
        getBackendStatus(): Promise<string>;
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
    };
}
