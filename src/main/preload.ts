import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

interface SanitizedError {
    error: true;
    message: string;
}

// Sanitize errors to prevent exposing internal details to renderer
function sanitizeError(error: any): SanitizedError {
    // Return a generic error object without stack traces or internal paths
    const message = error?.message || 'An unexpected error occurred';
    // Remove file paths and stack traces from error messages
    const sanitizedMessage = message
        .replace(/\/[^\s:]+/g, '[path]')  // Remove Unix paths
        .replace(/[A-Z]:\\[^\s:]+/gi, '[path]')  // Remove Windows paths
        .replace(/at\s+.+\(.+\)/g, '')  // Remove stack trace lines
        .replace(/\s+/g, ' ')  // Normalize whitespace
        .trim();
    return { error: true, message: sanitizedMessage };
}

// Wrap IPC invoke calls with error handling
async function safeInvoke(channel: string, ...args: any[]): Promise<any> {
    try {
        const result = await ipcRenderer.invoke(channel, ...args);
        // Validate the result is a safe type (not exposing Error objects)
        if (result instanceof Error) {
            return sanitizeError(result);
        }
        return result;
    } catch (error) {
        console.error(`IPC error on channel ${channel}:`, error);
        return sanitizeError(error);
    }
}

type UnsubscribeFunction = () => void;

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
    // Get the Python backend port
    getPythonPort: (): Promise<any> => safeInvoke('get-python-port'),

    // Get the Python backend status
    getBackendStatus: (): Promise<any> => safeInvoke('get-backend-status'),

    // Equipment backend
    getEquipmentPort: (): Promise<any> => safeInvoke('get-equipment-port'),
    getEquipmentStatus: (): Promise<any> => safeInvoke('get-equipment-status'),

    // Branch ID (configuration)
    getBranchId: (): Promise<string | null> => safeInvoke('get-branch-id'),
    setBranchId: (branchId: string): Promise<{ success: boolean; error?: string }> => safeInvoke('set-branch-id', branchId),

    // File dialogs
    openFileDialog: (): Promise<any> => safeInvoke('open-file-dialog'),
    saveFileDialog: (defaultName: string): Promise<any> => safeInvoke('save-file-dialog', defaultName),

    // Show message box
    showMessage: (options: any): Promise<any> => safeInvoke('show-message', options),

    // Open file with system default app
    openPath: (filePath: string): Promise<any> => safeInvoke('open-path', filePath),

    // Listen for events from main process
    // Each listener automatically removes any previous handler for the same channel
    // to prevent handler accumulation when called multiple times.
    // Returns an unsubscribe function for explicit cleanup.
    onFileOpened: (() => {
        let currentHandler: ((event: IpcRendererEvent, filePath: string) => void) | null = null;
        return (callback: (filePath: string) => void): UnsubscribeFunction => {
            if (currentHandler) {
                ipcRenderer.removeListener('file-opened', currentHandler);
            }
            currentHandler = (event: IpcRendererEvent, filePath: string) => callback(filePath);
            ipcRenderer.on('file-opened', currentHandler);
            return () => {
                if (currentHandler) {
                    ipcRenderer.removeListener('file-opened', currentHandler);
                    currentHandler = null;
                }
            };
        };
    })(),
    onRequestExport: (() => {
        let currentHandler: (() => void) | null = null;
        return (callback: () => void): UnsubscribeFunction => {
            if (currentHandler) {
                ipcRenderer.removeListener('request-export', currentHandler);
            }
            currentHandler = () => callback();
            ipcRenderer.on('request-export', currentHandler);
            return () => {
                if (currentHandler) {
                    ipcRenderer.removeListener('request-export', currentHandler);
                    currentHandler = null;
                }
            };
        };
    })(),
    onBackendCrashed: (() => {
        let currentHandler: ((event: IpcRendererEvent, info: any) => void) | null = null;
        return (callback: (info: any) => void): UnsubscribeFunction => {
            if (currentHandler) {
                ipcRenderer.removeListener('backend-crashed', currentHandler);
            }
            currentHandler = (event: IpcRendererEvent, info: any) => callback(info);
            ipcRenderer.on('backend-crashed', currentHandler);
            return () => {
                if (currentHandler) {
                    ipcRenderer.removeListener('backend-crashed', currentHandler);
                    currentHandler = null;
                }
            };
        };
    })(),
    onBackendStatusChange: (() => {
        let currentHandler: ((event: IpcRendererEvent, status: string) => void) | null = null;
        return (callback: (status: string) => void): UnsubscribeFunction => {
            if (currentHandler) {
                ipcRenderer.removeListener('backend-status-change', currentHandler);
            }
            currentHandler = (event: IpcRendererEvent, status: string) => callback(status);
            ipcRenderer.on('backend-status-change', currentHandler);
            return () => {
                if (currentHandler) {
                    ipcRenderer.removeListener('backend-status-change', currentHandler);
                    currentHandler = null;
                }
            };
        };
    })(),
    onBackendStartupProgress: (() => {
        let currentHandler: ((event: IpcRendererEvent, info: any) => void) | null = null;
        return (callback: (info: any) => void): UnsubscribeFunction => {
            if (currentHandler) {
                ipcRenderer.removeListener('backend-startup-progress', currentHandler);
            }
            currentHandler = (event: IpcRendererEvent, info: any) => callback(info);
            ipcRenderer.on('backend-startup-progress', currentHandler);
            return () => {
                if (currentHandler) {
                    ipcRenderer.removeListener('backend-startup-progress', currentHandler);
                    currentHandler = null;
                }
            };
        };
    })(),

    // Logging (file-based)
    logError: (source: string, error: {
        message: string;
        stack?: string;
        filename?: string;
        lineno?: number;
        colno?: number;
    }): Promise<void> => safeInvoke('log-renderer-error', source, error),
    logConsole: (source: string, level: string, message: string, args?: any[]): Promise<void> =>
        safeInvoke('log-renderer-console', source, level, message, args),
    getLogFilePath: (): Promise<string> => safeInvoke('get-log-file-path'),

    // Bug reporting
    submitBugReport: (bugData: any): Promise<any> => safeInvoke('submit-bug-report', bugData),
    searchSimilarBugs: (query: string): Promise<any> => safeInvoke('search-similar-bugs', query),
    meTooVote: (issueId: string, note: string): Promise<any> => safeInvoke('me-too-vote', issueId, note),
    getFilteredLogs: (): Promise<string[]> => safeInvoke('get-filtered-logs'),
    resetBugSession: (): Promise<void> => safeInvoke('reset-bug-session'),
    hasErrorInLogs: (): Promise<boolean> => safeInvoke('has-error-in-logs'),

    // Bug Spray App (development mode only)
    isDevelopmentMode: (): Promise<boolean> => safeInvoke('is-development-mode'),
    getBugReports: (filters?: any): Promise<any[]> => safeInvoke('get-bug-reports', filters),
    getBugReportDetail: (id: string): Promise<any> => safeInvoke('get-bug-report-detail', id),
    triageBugReport: (id: string, params: any): Promise<{ success: boolean; error?: string }> => safeInvoke('triage-bug-report', id, params),
    getAttachment: (id: string, type: string): Promise<string | null> => safeInvoke('get-attachment', id, type),
    onShowBugReportModal: (() => {
        let currentHandler: (() => void) | null = null;
        return (callback: () => void): UnsubscribeFunction => {
            if (currentHandler) {
                ipcRenderer.removeListener('show-bug-report-modal', currentHandler);
            }
            currentHandler = () => callback();
            ipcRenderer.on('show-bug-report-modal', currentHandler);
            return () => {
                if (currentHandler) {
                    ipcRenderer.removeListener('show-bug-report-modal', currentHandler);
                    currentHandler = null;
                }
            };
        };
    })(),
    onRequestAppState: (() => {
        let currentHandler: (() => void) | null = null;
        return (callback: () => void): UnsubscribeFunction => {
            if (currentHandler) {
                ipcRenderer.removeListener('request-app-state', currentHandler);
            }
            currentHandler = () => callback();
            ipcRenderer.on('request-app-state', currentHandler);
            return () => {
                if (currentHandler) {
                    ipcRenderer.removeListener('request-app-state', currentHandler);
                    currentHandler = null;
                }
            };
        };
    })(),
    sendAppState: (state: any): void => {
        ipcRenderer.send('app-state-response', state);
    }
});
