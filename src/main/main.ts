import { app, BrowserWindow, ipcMain, dialog, Menu, shell, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import * as path from 'path';
import {
    startPythonBackend, stopPythonBackend, getPythonPort, getBackendStatus, getBackendEvents,
    startEquipmentBackend, stopEquipmentBackend, getEquipmentPort, getEquipmentStatus
} from './python-bridge';
import { BugReporter } from './bug-reporter';
import { initConfig, isFirstRun, getBranchId, setBranchId } from './config-manager';
import { initFileLogger, mainLog, logRendererError, logRendererConsole, getLogFilePath } from './file-logger';

let mainWindow: BrowserWindow | null = null;
let bugReporter: BugReporter | null = null;

interface BackendEventListeners {
    crashed: (info: any) => void;
    statusChange: (status: string) => void;
    startupProgress: (info: { elapsed: number; maxWait: number }) => void;
}

let backendEventListeners: BackendEventListeners | null = null;

function setupBackendEventListeners(): void {
    const backendEvents = getBackendEvents();

    // Remove any existing listeners first to prevent duplicates
    cleanupBackendEventListeners();

    // Create named listener functions so we can remove them later
    backendEventListeners = {
        crashed: (info: any) => {
            console.log('Backend crashed, notifying renderer:', info);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('backend-crashed', info);
            }
        },
        statusChange: (status: string) => {
            console.log('Backend status changed:', status);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('backend-status-change', status);
            }
        },
        startupProgress: (info: { elapsed: number; maxWait: number }) => {
            console.log(`Backend startup progress: ${info.elapsed}s / ${info.maxWait}s`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('backend-startup-progress', info);
            }
        }
    };

    backendEvents.on('crashed', backendEventListeners.crashed);
    backendEvents.on('status-change', backendEventListeners.statusChange);
    backendEvents.on('startup-progress', backendEventListeners.startupProgress);
}

function cleanupBackendEventListeners(): void {
    if (backendEventListeners) {
        const backendEvents = getBackendEvents();
        backendEvents.off('crashed', backendEventListeners.crashed);
        backendEvents.off('status-change', backendEventListeners.statusChange);
        backendEvents.off('startup-progress', backendEventListeners.startupProgress);
        backendEventListeners = null;
    }
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    // Load the shell (which contains navigation and embeds apps)
    // Both dev and prod load from dist/shell/ (compiled output)
    const shellPath = path.join(__dirname, '../shell/index.html');
    mainWindow.loadFile(shellPath);

    // Open DevTools only in development (use app.isPackaged for reliable check)
    if (!app.isPackaged && process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    // Initialize bug reporter
    bugReporter = new BugReporter(mainWindow);

    mainWindow.on('closed', () => {
        cleanupBackendEventListeners();
        bugReporter = null;
        mainWindow = null;
    });
}

function createMenu(): void {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open PDF...',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        if (!mainWindow) return;
                        const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openFile'],
                            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('file-opened', result.filePaths[0]);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Export PDF...',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.webContents.send('request-export');
                        }
                    }
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                // Only include DevTools in development (app.isPackaged is false when running from source)
                ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' }
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Bug Spray...',
                    accelerator: 'CmdOrCtrl+Shift+B',
                    click: () => {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('show-bug-report-modal');
                        }
                    }
                }
            ]
        }
    ];

    // macOS specific menu adjustments
    if (process.platform === 'darwin') {
        template.unshift({
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// IPC Handlers
ipcMain.handle('get-python-port', (): number | null => {
    return getPythonPort();
});

ipcMain.handle('get-backend-status', (): string => {
    return getBackendStatus();
});

// Equipment backend IPC handlers
ipcMain.handle('get-equipment-port', (): number | null => {
    return getEquipmentPort();
});

ipcMain.handle('get-equipment-status', (): string => {
    return getEquipmentStatus();
});

// Branch ID IPC handlers
ipcMain.handle('get-branch-id', (): string | null => {
    return getBranchId();
});

ipcMain.handle('set-branch-id', (event: IpcMainInvokeEvent, branchId: string): { success: boolean; error?: string } => {
    try {
        setBranchId(branchId);
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// Logging IPC handlers
ipcMain.handle('log-renderer-error', (event: IpcMainInvokeEvent, source: string, error: {
    message: string;
    stack?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
}): void => {
    logRendererError(source, error);
});

ipcMain.handle('log-renderer-console', (event: IpcMainInvokeEvent, source: string, level: string, message: string, args?: any[]): void => {
    logRendererConsole(source, level, message, args);
});

ipcMain.handle('get-log-file-path', (): string => {
    return getLogFilePath();
});

ipcMain.handle('open-file-dialog', async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

ipcMain.handle('save-file-dialog', async (event: IpcMainInvokeEvent, defaultName: string): Promise<string | null> => {
    if (!mainWindow) return null;

    // Validate and sanitize the default filename
    let safeName = 'updated_price_list.pdf';
    if (typeof defaultName === 'string' && defaultName.length > 0) {
        // Extract just the filename, removing any path components
        const baseName = path.basename(defaultName);
        // Only allow alphanumeric, spaces, dashes, underscores, and dots
        const sanitized = baseName.replace(/[^a-zA-Z0-9\s\-_\.]/g, '_');
        // Ensure it ends with .pdf
        safeName = sanitized.endsWith('.pdf') ? sanitized : sanitized + '.pdf';
        // Limit filename length
        if (safeName.length > 255) {
            safeName = safeName.substring(0, 251) + '.pdf';
        }
    }

    const result: Electron.SaveDialogReturnValue = await dialog.showSaveDialog(mainWindow, {
        defaultPath: safeName,
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    });
    if (!result.canceled) {
        return result.filePath || null;
    }
    return null;
});

interface ShowMessageOptions {
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
    title?: string;
    message?: string;
    detail?: string;
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
}

ipcMain.handle('show-message', async (event: IpcMainInvokeEvent, options: ShowMessageOptions): Promise<Electron.MessageBoxReturnValue> => {
    if (!mainWindow) return { response: 0, checkboxChecked: false };

    // Validate and sanitize message box options
    if (!options || typeof options !== 'object') {
        return { response: 0, checkboxChecked: false };
    }

    // Only allow safe, expected properties for dialog.showMessageBox
    const allowedTypes: Array<'none' | 'info' | 'error' | 'question' | 'warning'> = ['none', 'info', 'error', 'question', 'warning'];
    const safeOptions: MessageBoxOptions = {
        type: (options.type && allowedTypes.includes(options.type)) ? options.type : 'info',
        title: typeof options.title === 'string' ? options.title.substring(0, 200) : '',
        message: typeof options.message === 'string' ? options.message.substring(0, 1000) : '',
        detail: typeof options.detail === 'string' ? options.detail.substring(0, 2000) : undefined,
        buttons: Array.isArray(options.buttons)
            ? options.buttons.filter(b => typeof b === 'string').map(b => b.substring(0, 50)).slice(0, 10)
            : ['OK'],
        defaultId: typeof options.defaultId === 'number' ? Math.max(0, Math.min(options.defaultId, 9)) : 0,
        cancelId: typeof options.cancelId === 'number' ? Math.max(-1, Math.min(options.cancelId, 9)) : -1
    };

    return dialog.showMessageBox(mainWindow, safeOptions);
});

ipcMain.handle('open-path', async (event: IpcMainInvokeEvent, filePath: string): Promise<string> => {
    // Security validation: only allow opening PDF files with valid paths
    if (typeof filePath !== 'string' || !filePath) {
        return 'Invalid file path';
    }

    // Must be an absolute path
    if (!path.isAbsolute(filePath)) {
        return 'Path must be absolute';
    }

    // Normalize and check for path traversal attempts
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath !== filePath && normalizedPath !== filePath.replace(/\/$/, '')) {
        return 'Invalid path: traversal detected';
    }

    // Only allow PDF files
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
        return 'Only PDF files can be opened';
    }

    return shell.openPath(filePath);
});

// Bug reporting IPC handlers
ipcMain.handle('submit-bug-report', async (event: IpcMainInvokeEvent, bugData: any): Promise<{ success: boolean; bugId?: string; error?: string }> => {
    if (!bugReporter) {
        return { success: false, error: 'Bug reporter not initialized' };
    }

    try {
        const context = await bugReporter.captureContext();
        const result = await bugReporter.submitBug({
            ...bugData,
            context
        });
        return result;
    } catch (error) {
        console.error('Bug report submission failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
});

ipcMain.handle('search-similar-bugs', async (event: IpcMainInvokeEvent, query: string): Promise<{ success: boolean; results: any[] }> => {
    if (!bugReporter) {
        return { success: false, results: [] };
    }

    try {
        const results = await bugReporter.searchSimilarBugs(query);
        return { success: true, results };
    } catch (error) {
        console.error('Bug search failed:', error);
        // Fail silently, don't block submission
        return { success: true, results: [] };
    }
});

ipcMain.handle('me-too-vote', async (event: IpcMainInvokeEvent, issueId: string, note: string): Promise<{ success: boolean; voteCount?: number; error?: string }> => {
    if (!bugReporter) {
        return { success: false, error: 'Bug reporter not initialized' };
    }

    try {
        return await bugReporter.addMeTooVote(issueId, note);
    } catch (error) {
        console.error('Me too vote failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
});

ipcMain.handle('get-filtered-logs', async (): Promise<string[]> => {
    if (!bugReporter) {
        return [];
    }

    try {
        return await bugReporter.getFilteredLogsForDisplay();
    } catch (error) {
        console.error('Failed to get filtered logs:', error);
        return [];
    }
});

// Reset bug reporter session when renderer loads/reloads
ipcMain.handle('reset-bug-session', (): void => {
    if (bugReporter) {
        bugReporter.resetSession();
    }
});

// Check if current session has ERROR level logs (for auto-approve decision)
ipcMain.handle('has-error-in-logs', async (): Promise<boolean> => {
    if (!bugReporter) {
        return false;
    }
    return bugReporter.hasErrorInLogs();
});

// Handle backend startup failure with retry options
async function handleBackendStartupFailure(error: Error): Promise<'retry' | 'continue' | 'quit'> {
    const response: Electron.MessageBoxReturnValue = await dialog.showMessageBox({
        type: 'error',
        title: 'Backend Error',
        message: 'Failed to start Python backend',
        detail: `${error.message}\n\nThe Python backend is required for PDF processing. You can retry, continue with limited functionality, or quit the application.`,
        buttons: ['Retry', 'Continue Without Backend', 'Quit'],
        defaultId: 0,
        cancelId: 2
    });

    switch (response.response) {
        case 0: // Retry
            return 'retry';
        case 1: // Continue Without Backend
            return 'continue';
        case 2: // Quit
        default:
            return 'quit';
    }
}

// Attempt to start backend with retry logic
const MAX_BACKEND_RETRIES = 5;

async function attemptBackendStart(): Promise<boolean | null> {
    let retryCount = 0;

    while (retryCount < MAX_BACKEND_RETRIES) {
        try {
            await startPythonBackend();
            console.log(`Python backend running on port ${getPythonPort()}`);
            return true;
        } catch (error) {
            retryCount++;
            console.error(`Failed to start Python backend (attempt ${retryCount}/${MAX_BACKEND_RETRIES}):`, error);

            // Check if we've exhausted all retries
            if (retryCount >= MAX_BACKEND_RETRIES) {
                const exhaustedResponse: Electron.MessageBoxReturnValue = await dialog.showMessageBox({
                    type: 'error',
                    title: 'Backend Error',
                    message: 'Failed to start Python backend after multiple attempts',
                    detail: `The backend failed to start after ${MAX_BACKEND_RETRIES} attempts.\n\nLast error: ${error instanceof Error ? error.message : String(error)}\n\nYou can continue with limited functionality or quit the application.`,
                    buttons: ['Continue Without Backend', 'Quit'],
                    defaultId: 0,
                    cancelId: 1
                });

                if (exhaustedResponse.response === 0) {
                    console.log('Max retries exhausted - continuing without backend');
                    return false;
                } else {
                    app.quit();
                    return null;
                }
            }

            const action = await handleBackendStartupFailure(error instanceof Error ? error : new Error(String(error)));

            if (action === 'retry') {
                console.log(`Retrying backend startup (attempt ${retryCount + 1}/${MAX_BACKEND_RETRIES})...`);
                continue;
            } else if (action === 'continue') {
                console.log('Continuing without backend - limited functionality');
                return false;
            } else {
                // quit
                app.quit();
                return null;
            }
        }
    }

    return false;
}

// App lifecycle
// Prompt for branch ID on first run
async function promptForBranchId(): Promise<boolean> {
    // Use a simple prompt dialog
    const result = await dialog.showMessageBox({
        type: 'question',
        title: 'Welcome to Inspire Hub',
        message: 'Please identify your location',
        detail: 'Enter a name for your hotel or branch (e.g., "La Jolla Marriott", "Minneapolis Hilton"). This will be used to track equipment requests.',
        buttons: ['Continue', 'Quit'],
        defaultId: 0,
        cancelId: 1
    });

    if (result.response === 1) {
        // User chose to quit
        return false;
    }

    // Show input dialog
    // Since Electron doesn't have a native input dialog, we'll use a BrowserWindow
    return new Promise((resolve) => {
        const inputWindow = new BrowserWindow({
            width: 450,
            height: 200,
            title: 'Set Branch ID',
            modal: true,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; background: #f5f5f5; }
                    h2 { font-size: 16px; margin-bottom: 8px; }
                    p { font-size: 13px; color: #666; margin-bottom: 16px; }
                    input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
                    input:focus { outline: none; border-color: #6366f1; }
                    .buttons { display: flex; gap: 12px; justify-content: flex-end; }
                    button { padding: 8px 20px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
                    .primary { background: #6366f1; color: white; }
                    .primary:hover { background: #4f46e5; }
                    .secondary { background: #e5e5e5; }
                    .secondary:hover { background: #d5d5d5; }
                    .error { color: #dc2626; font-size: 12px; margin-top: -12px; margin-bottom: 12px; display: none; }
                </style>
            </head>
            <body>
                <h2>Enter Branch Name</h2>
                <p>This identifies your hotel or branch for equipment requests.</p>
                <input type="text" id="branchId" placeholder="e.g., La Jolla Marriott" autofocus>
                <div class="error" id="error"></div>
                <div class="buttons">
                    <button class="secondary" onclick="cancel()">Quit</button>
                    <button class="primary" onclick="save()">Save</button>
                </div>
                <script>
                    const input = document.getElementById('branchId');
                    const error = document.getElementById('error');
                    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') save(); });
                    function save() {
                        const value = input.value.trim();
                        if (!value) {
                            error.textContent = 'Please enter a branch name';
                            error.style.display = 'block';
                            return;
                        }
                        if (!/^[\\w\\s\\-]+$/.test(value)) {
                            error.textContent = 'Only letters, numbers, spaces, and dashes allowed';
                            error.style.display = 'block';
                            return;
                        }
                        window.api.setBranchId(value).then(result => {
                            if (result.success) {
                                window.close();
                            } else {
                                error.textContent = result.error || 'Failed to save';
                                error.style.display = 'block';
                            }
                        });
                    }
                    function cancel() {
                        window.api.sendAppState({ action: 'quit' });
                        window.close();
                    }
                </script>
            </body>
            </html>
        `;

        inputWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(htmlContent)}`);
        inputWindow.once('ready-to-show', () => inputWindow.show());

        let userQuit = false;

        // Listen for quit signal
        const quitHandler = (event: Electron.IpcMainEvent, state: any) => {
            if (state?.action === 'quit') {
                userQuit = true;
                inputWindow.close();
            }
        };
        ipcMain.on('app-state-response', quitHandler);

        inputWindow.on('closed', () => {
            ipcMain.off('app-state-response', quitHandler);
            if (userQuit) {
                resolve(false);
            } else if (getBranchId()) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

app.whenReady().then(async () => {
    // Initialize file logger first
    initFileLogger();
    mainLog.info('App starting', { version: app.getVersion() });

    // Initialize configuration
    initConfig();

    // Check for first run and prompt for branch ID
    if (isFirstRun()) {
        console.log('First run detected, prompting for branch ID...');
        const continued = await promptForBranchId();
        if (!continued) {
            app.quit();
            return;
        }
        console.log('Branch ID set:', getBranchId());
    } else {
        console.log('Branch ID:', getBranchId());
    }

    console.log('Starting Python backend...');

    const backendStarted = await attemptBackendStart();
    if (backendStarted === null) {
        // User chose to quit
        return;
    }

    // Start equipment backend (non-blocking, failures don't prevent app start)
    console.log('Starting Equipment backend...');
    try {
        await startEquipmentBackend();
        console.log(`Equipment backend running on port ${getEquipmentPort()}`);
    } catch (error) {
        console.error('Failed to start Equipment backend:', error);
        // Equipment backend is optional - continue without it
    }

    createMenu();
    createWindow();
    setupBackendEventListeners();
});

// Register activate handler at module level (not inside whenReady to avoid duplicate registrations)
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        setupBackendEventListeners();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

let isCleaningUp = false;
app.on('will-quit', async (event) => {
    if (isCleaningUp) {
        return; // Already cleaned up, allow quit to proceed
    }
    event.preventDefault();
    isCleaningUp = true;
    console.log('Stopping backends...');
    cleanupBackendEventListeners();
    // Stop both backends in parallel
    await Promise.all([
        stopPythonBackend(),
        stopEquipmentBackend()
    ]);
    app.quit();
});
