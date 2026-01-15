import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { app } from 'electron';
import kill from 'tree-kill';
import { EventEmitter } from 'events';

// Event emitter for backend status changes
const backendEvents = new EventEmitter();

type BackendStatus = 'stopped' | 'starting' | 'running' | 'crashed';

// Price List backend state
let pythonProcess: ChildProcess | null = null;
let pythonPort: number | null = null;
let shutdownToken: string | null = null;
let backendStatus: BackendStatus = 'stopped';

// Equipment backend state
let equipmentProcess: ChildProcess | null = null;
let equipmentPort: number | null = null;
let equipmentShutdownToken: string | null = null;
let equipmentStatus: BackendStatus = 'stopped';

// Event emitter for equipment backend
const equipmentEvents = new EventEmitter();

// Debug logging to file with size limit and rotation
const logFile = path.join(app.getPath('userData'), 'python-bridge.log');
const logFileOld = path.join(app.getPath('userData'), 'python-bridge.log.old');
const LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Rotate log file if it exceeds the size limit
 * Renames current log to .old (overwriting previous .old if any)
 */
function rotateLogIfNeeded(): void {
    try {
        const stats = fs.statSync(logFile);
        if (stats.size >= LOG_MAX_SIZE_BYTES) {
            // Rotate: rename current to .old (overwrites existing .old)
            fs.renameSync(logFile, logFileOld);
        }
    } catch (e) {
        // File doesn't exist or other error - ignore
    }
}

/**
 * Clear log file at startup (called once when backend starts)
 * Keeps old log for debugging by renaming to .old
 */
function clearLogOnStartup(): void {
    try {
        if (fs.existsSync(logFile)) {
            // Save previous session's log for debugging
            fs.renameSync(logFile, logFileOld);
        }
    } catch (e) {
        // Ignore - file may not exist or rename may fail
    }
}

function log(msg: string): void {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} - ${msg}\n`;
    console.log(msg);
    try {
        rotateLogIfNeeded();
        fs.appendFileSync(logFile, line);
    } catch (e) {
        // ignore
    }
}

interface PythonPathInfo {
    executable: string;
    args: string[];
}

/**
 * Get the path to the Python backend executable/script.
 * Validates that the executable exists before returning.
 * @returns Path info for Python backend
 * @throws {Error} If the executable does not exist
 */
function getPythonPath(): PythonPathInfo {
    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
        // Development: use project's virtual environment
        const projectRoot = path.join(__dirname, '../..');
        const venvPython = process.platform === 'win32'
            ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
            : path.join(projectRoot, '.venv', 'bin', 'python');

        // Validate that the virtual environment Python exists
        if (!fs.existsSync(venvPython)) {
            throw new Error(
                `Python virtual environment not found at: ${venvPython}\n` +
                'Please run "uv sync" or "python -m venv .venv && pip install -r requirements.txt" to create it.'
            );
        }

        const backendScript = path.join(projectRoot, 'python/price_list/backend.py');
        if (!fs.existsSync(backendScript)) {
            throw new Error(`Python backend script not found at: ${backendScript}`);
        }

        // Note: --debug flag removed to prevent sensitive data leakage to debug.log
        // To enable debug mode, set PYTHON_BACKEND_DEBUG=1 environment variable
        const args = [backendScript];
        if (process.env.PYTHON_BACKEND_DEBUG === '1') {
            log('WARNING: Debug mode enabled via PYTHON_BACKEND_DEBUG=1. Debug logs may contain sensitive data.');
            args.push('--debug');
        }

        return {
            executable: venvPython,
            args
        };
    }

    // Production: use bundled PyInstaller executable
    const resourcesPath = process.resourcesPath;
    const platform = process.platform;

    let binaryName = 'python-backend';
    if (platform === 'win32') {
        binaryName = 'python-backend.exe';
    }

    const executable = path.join(resourcesPath, 'python-backend', binaryName);

    // Validate that the bundled executable exists
    if (!fs.existsSync(executable)) {
        throw new Error(
            `Python backend executable not found at: ${executable}\n` +
            'The application may not have been packaged correctly.'
        );
    }

    return {
        executable,
        args: []
    };
}

// Startup configuration
// Increased to 45s to accommodate slow machines and large PDFs during extraction.
// The backend performs CPU-intensive PDF parsing which can vary significantly based on:
// - Machine CPU speed and available resources
// - PDF file size and complexity
// - Virtual machine overhead
// A 45s timeout provides sufficient headroom while still being reasonable for user UX.
const STARTUP_TIMEOUT_MS = 45000;  // 45 seconds max wait
const PROGRESS_INTERVAL_MS = 2000; // Emit progress every 2 seconds

// Port ranges for different backends (non-overlapping)
const PRICE_LIST_PORT_START = 8080;
const PRICE_LIST_PORT_END = 8089;
const EQUIPMENT_PORT_START = 8090;
const EQUIPMENT_PORT_END = 8099;

/**
 * Check if a port is available
 * @param port - Port to check
 * @returns True if port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => {
            resolve(false);
        });
        server.once('listening', () => {
            server.close(() => {
                resolve(true);
            });
        });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * Find an available port in the specified range
 * @param startPort - First port to try
 * @param endPort - Last port to try
 * @param name - Name for logging
 * @returns An available port
 * @throws {Error} If no ports are available in the range
 */
async function findAvailablePortInRange(startPort: number, endPort: number, name: string): Promise<number> {
    for (let port = startPort; port <= endPort; port++) {
        if (await isPortAvailable(port)) {
            log(`Found available port for ${name}: ${port}`);
            return port;
        }
        log(`Port ${port} is in use, trying next...`);
    }
    throw new Error(`No available ports for ${name} in range ${startPort}-${endPort}`);
}

/**
 * Create a sanitized environment for the Python subprocess.
 * Only passes necessary environment variables, excluding sensitive ones
 * like SSH keys, cloud credentials, and personal identifiers.
 * @returns Sanitized environment object
 */
function createSanitizedEnv(): NodeJS.ProcessEnv {
    // Allowlist of environment variables that the Python backend needs
    const allowedVars = [
        // Path variables essential for finding executables and libraries
        'PATH',
        'PYTHONPATH',
        'PYTHONHOME',
        // System locale settings for proper text handling
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        // Temp directory for file operations
        'TMPDIR',
        'TEMP',
        'TMP',
        // Platform-specific
        'SystemRoot',      // Windows: required for many operations
        'SYSTEMROOT',      // Windows: alternate casing
        'WINDIR',          // Windows: Windows directory
        'COMSPEC',         // Windows: command processor
        // macOS-specific paths that may be needed for fonts/libraries
        'DYLD_LIBRARY_PATH',
        'DYLD_FALLBACK_LIBRARY_PATH',
        // Linux library paths
        'LD_LIBRARY_PATH',
        // Development/debug flags (only if explicitly set for this app)
        'NODE_ENV',
        'PYTHON_BACKEND_DEBUG'
    ];

    const sanitizedEnv: NodeJS.ProcessEnv = {};

    for (const varName of allowedVars) {
        if (process.env[varName] !== undefined) {
            sanitizedEnv[varName] = process.env[varName];
        }
    }

    return sanitizedEnv;
}

/**
 * Start the Python backend server
 * @returns The port the server is running on
 */
async function startPythonBackend(): Promise<number> {
    // Clear log from previous session
    clearLogOnStartup();

    // Get Python path with validation (throws if executable not found)
    let executable: string, args: string[];
    try {
        ({ executable, args } = getPythonPath());
    } catch (err) {
        log(`Failed to get Python path: ${err instanceof Error ? err.message : String(err)}`);
        backendStatus = 'stopped';
        backendEvents.emit('status-change', backendStatus);
        throw err;
    }

    backendStatus = 'starting';
    backendEvents.emit('status-change', backendStatus);

    log(`Starting Python backend: ${executable} ${args.join(' ')}`);
    log(`Resources path: ${process.resourcesPath}`);
    log(`NODE_ENV: ${process.env.NODE_ENV}`);

    // Find an available port in the price-list range
    let port: number;
    try {
        port = await findAvailablePortInRange(PRICE_LIST_PORT_START, PRICE_LIST_PORT_END, 'price-list');
    } catch (err) {
        backendStatus = 'stopped';
        backendEvents.emit('status-change', backendStatus);
        throw err;
    }

    return new Promise((resolve, reject) => {
        // Add port argument
        const fullArgs = [...args, '--port', port.toString()];

        // Use sanitized environment to avoid exposing sensitive variables
        // (SSH_AUTH_SOCK, AWS credentials, HOME, USER, etc.)
        const sanitizedEnv = createSanitizedEnv();

        pythonProcess = spawn(executable, fullArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: sanitizedEnv
        });

        let started = false;
        let finished = false;
        const startTime = Date.now();

        // Emit progress events during startup so the user knows something is happening
        const progressInterval = setInterval(() => {
            if (!started) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                log(`Startup progress: ${elapsed}s elapsed`);
                backendEvents.emit('startup-progress', {
                    elapsed,
                    maxWait: Math.round(STARTUP_TIMEOUT_MS / 1000)
                });
            }
        }, PROGRESS_INTERVAL_MS);

        // Timeout if backend doesn't start
        const startupTimeout = setTimeout(() => {
            if (!started) {
                finish(false, new Error(`Python backend failed to start within ${STARTUP_TIMEOUT_MS / 1000} seconds`));
            }
        }, STARTUP_TIMEOUT_MS);

        // Helper to clean up timers and finish (only runs once)
        const finish = (success: boolean, result: number | Error): void => {
            if (finished) return; // Prevent multiple calls
            finished = true;
            clearInterval(progressInterval);
            clearTimeout(startupTimeout);
            if (success) {
                resolve(result as number);
            } else {
                reject(result);
            }
        };

        pythonProcess.stdout?.on('data', (data: Buffer) => {
            const output = data.toString();

            // Look for the READY signal with format READY:port:token
            // Regex anchored to line boundaries to avoid matching partial lines like 'NOT_READY:8080:token'
            if (!started && output.includes('READY:')) {
                const match = output.match(/^READY:(\d+):([A-Za-z0-9_-]+)$/m);
                if (match) {
                    pythonPort = parseInt(match[1], 10);
                    shutdownToken = match[2];
                    started = true;
                    backendStatus = 'running';
                    backendEvents.emit('status-change', backendStatus);
                    // Security: Log only that READY was received, no token metadata
                    log(`[Python stdout] READY signal received on port ${pythonPort}`);
                    finish(true, pythonPort);
                    return; // Don't log the raw READY line containing the token
                }
            }

            // Log other stdout lines normally
            log(`[Python stdout] ${output}`);
        });

        pythonProcess.stderr?.on('data', (data: Buffer) => {
            log(`[Python stderr] ${data.toString()}`);
        });

        pythonProcess.on('error', (error: Error) => {
            log(`Failed to start Python process: ${error.message}`);
            if (!started) {
                finish(false, error);
            }
        });

        pythonProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            log(`Python process exited with code ${code}, signal ${signal}`);
            const wasRunning = backendStatus === 'running';
            pythonProcess = null;
            pythonPort = null;
            shutdownToken = null;

            // Only emit crash if it was running (not intentional stop)
            if (wasRunning && code !== 0) {
                backendStatus = 'crashed';
                backendEvents.emit('status-change', backendStatus, { code, signal });
                backendEvents.emit('crashed', { code, signal });
            } else {
                backendStatus = 'stopped';
                backendEvents.emit('status-change', backendStatus);
            }

            // If process exits before startup completed, reject the promise
            if (!started) {
                finish(false, new Error(`Python process exited unexpectedly (code: ${code}, signal: ${signal})`));
            }
        });
    });
}

/**
 * Kill a process with timeout, returning a promise
 * @param pid - Process ID to kill
 * @param signal - Signal to send (SIGTERM or SIGKILL)
 * @param timeoutMs - Timeout in milliseconds
 */
function killWithTimeout(pid: number, signal: string, timeoutMs: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Kill ${signal} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        kill(pid, signal, (err?: Error) => {
            clearTimeout(timeout);
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

/**
 * Check if a process is still running
 * @param pid - Process ID to check
 */
function isProcessRunning(pid: number): boolean {
    try {
        // Sending signal 0 checks if process exists without killing it
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        // ESRCH means process doesn't exist, EPERM means it exists but we can't signal it
        return e.code === 'EPERM';
    }
}

/**
 * Stop the Python backend server
 * Uses async cleanup with multiple fallback strategies
 */
async function stopPythonBackend(): Promise<void> {
    if (!pythonProcess) {
        return;
    }

    log('Stopping Python backend...');

    // Mark as stopping to prevent crash event
    backendStatus = 'stopped';

    // Save PID before clearing reference
    const pid = pythonProcess.pid;
    if (!pid) {
        log('No PID available for Python process');
        return;
    }

    // Clear references immediately to prevent re-entry
    pythonProcess = null;
    pythonPort = null;
    shutdownToken = null;
    backendEvents.emit('status-change', backendStatus);

    // Attempt graceful shutdown with SIGTERM
    try {
        await killWithTimeout(pid, 'SIGTERM', 3000);
        log(`Successfully stopped Python backend (PID ${pid}) with SIGTERM`);
        return;
    } catch (err) {
        log(`SIGTERM failed for PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Check if process is still running before trying SIGKILL
    if (!isProcessRunning(pid)) {
        log(`Process ${pid} already terminated`);
        return;
    }

    // Force kill with SIGKILL
    try {
        await killWithTimeout(pid, 'SIGKILL', 3000);
        log(`Successfully stopped Python backend (PID ${pid}) with SIGKILL`);
        return;
    } catch (err) {
        log(`SIGKILL failed for PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Final check - if process is still running, log warning
    if (isProcessRunning(pid)) {
        log(`WARNING: Failed to terminate process ${pid}. Manual cleanup may be required.`);
        // On Unix, we could try kill -9 directly as last resort
        if (process.platform !== 'win32') {
            try {
                process.kill(pid, 'SIGKILL');
                log(`Direct SIGKILL sent to PID ${pid}`);
            } catch (e) {
                log(`Direct SIGKILL failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    } else {
        log(`Process ${pid} confirmed terminated`);
    }
}

// ============================================================
// Equipment Backend Functions
// ============================================================

/**
 * Get the path to the Equipment API script.
 * @returns Path info for Equipment backend
 * @throws {Error} If the script does not exist
 */
function getEquipmentPath(): PythonPathInfo {
    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
        const projectRoot = path.join(__dirname, '../..');
        const venvPython = process.platform === 'win32'
            ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
            : path.join(projectRoot, '.venv', 'bin', 'python');

        if (!fs.existsSync(venvPython)) {
            throw new Error(
                `Python virtual environment not found at: ${venvPython}\n` +
                'Please run "uv sync" to create it.'
            );
        }

        // Equipment backend runs as a module from python/ directory
        return {
            executable: venvPython,
            args: ['-m', 'equipment.api']
        };
    }

    // Production: use bundled PyInstaller executable
    const resourcesPath = process.resourcesPath;
    const platform = process.platform;

    let binaryName = 'equipment-backend';
    if (platform === 'win32') {
        binaryName = 'equipment-backend.exe';
    }

    const executable = path.join(resourcesPath, 'equipment-backend', binaryName);

    if (!fs.existsSync(executable)) {
        throw new Error(
            `Equipment backend executable not found at: ${executable}\n` +
            'The application may not have been packaged correctly.'
        );
    }

    return {
        executable,
        args: []
    };
}

/**
 * Start the Equipment backend server
 * @returns The port the server is running on
 */
async function startEquipmentBackend(): Promise<number> {
    let executable: string, args: string[];
    try {
        ({ executable, args } = getEquipmentPath());
    } catch (err) {
        log(`Failed to get Equipment path: ${err instanceof Error ? err.message : String(err)}`);
        equipmentStatus = 'stopped';
        equipmentEvents.emit('status-change', equipmentStatus);
        throw err;
    }

    equipmentStatus = 'starting';
    equipmentEvents.emit('status-change', equipmentStatus);

    log(`Starting Equipment backend: ${executable} ${args.join(' ')}`);

    // Find an available port in the equipment range
    let port: number;
    try {
        port = await findAvailablePortInRange(EQUIPMENT_PORT_START, EQUIPMENT_PORT_END, 'equipment');
    } catch (err) {
        equipmentStatus = 'stopped';
        equipmentEvents.emit('status-change', equipmentStatus);
        throw err;
    }

    return new Promise((resolve, reject) => {
        const fullArgs = [...args, '--port', port.toString()];
        const sanitizedEnv = createSanitizedEnv();

        // For module execution, set working directory to python/
        const cwd = process.env.NODE_ENV === 'development'
            ? path.join(__dirname, '../../python')
            : undefined;

        equipmentProcess = spawn(executable, fullArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: sanitizedEnv,
            cwd
        });

        let started = false;
        let finished = false;
        const startTime = Date.now();

        const progressInterval = setInterval(() => {
            if (!started) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                log(`Equipment startup progress: ${elapsed}s elapsed`);
                equipmentEvents.emit('startup-progress', {
                    elapsed,
                    maxWait: Math.round(STARTUP_TIMEOUT_MS / 1000)
                });
            }
        }, PROGRESS_INTERVAL_MS);

        const startupTimeout = setTimeout(() => {
            if (!started) {
                finish(false, new Error(`Equipment backend failed to start within ${STARTUP_TIMEOUT_MS / 1000} seconds`));
            }
        }, STARTUP_TIMEOUT_MS);

        const finish = (success: boolean, result: number | Error): void => {
            if (finished) return;
            finished = true;
            clearInterval(progressInterval);
            clearTimeout(startupTimeout);
            if (success) {
                resolve(result as number);
            } else {
                reject(result);
            }
        };

        equipmentProcess.stdout?.on('data', (data: Buffer) => {
            const output = data.toString();

            if (!started && output.includes('READY:')) {
                const match = output.match(/^READY:(\d+):([A-Za-z0-9_-]+)$/m);
                if (match) {
                    equipmentPort = parseInt(match[1], 10);
                    equipmentShutdownToken = match[2];
                    started = true;
                    equipmentStatus = 'running';
                    equipmentEvents.emit('status-change', equipmentStatus);
                    log(`[Equipment stdout] READY signal received on port ${equipmentPort}`);
                    finish(true, equipmentPort);
                    return;
                }
            }

            log(`[Equipment stdout] ${output}`);
        });

        equipmentProcess.stderr?.on('data', (data: Buffer) => {
            log(`[Equipment stderr] ${data.toString()}`);
        });

        equipmentProcess.on('error', (error: Error) => {
            log(`Failed to start Equipment process: ${error.message}`);
            if (!started) {
                finish(false, error);
            }
        });

        equipmentProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            log(`Equipment process exited with code ${code}, signal ${signal}`);
            const wasRunning = equipmentStatus === 'running';
            equipmentProcess = null;
            equipmentPort = null;
            equipmentShutdownToken = null;

            if (wasRunning && code !== 0) {
                equipmentStatus = 'crashed';
                equipmentEvents.emit('status-change', equipmentStatus, { code, signal });
                equipmentEvents.emit('crashed', { code, signal });
            } else {
                equipmentStatus = 'stopped';
                equipmentEvents.emit('status-change', equipmentStatus);
            }

            if (!started) {
                finish(false, new Error(`Equipment process exited unexpectedly (code: ${code}, signal: ${signal})`));
            }
        });
    });
}

/**
 * Stop the Equipment backend server
 */
async function stopEquipmentBackend(): Promise<void> {
    if (!equipmentProcess) {
        return;
    }

    log('Stopping Equipment backend...');
    equipmentStatus = 'stopped';

    const pid = equipmentProcess.pid;
    if (!pid) {
        log('No PID available for Equipment process');
        return;
    }

    equipmentProcess = null;
    equipmentPort = null;
    equipmentShutdownToken = null;
    equipmentEvents.emit('status-change', equipmentStatus);

    try {
        await killWithTimeout(pid, 'SIGTERM', 3000);
        log(`Successfully stopped Equipment backend (PID ${pid}) with SIGTERM`);
        return;
    } catch (err) {
        log(`SIGTERM failed for Equipment PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!isProcessRunning(pid)) {
        log(`Equipment process ${pid} already terminated`);
        return;
    }

    try {
        await killWithTimeout(pid, 'SIGKILL', 3000);
        log(`Successfully stopped Equipment backend (PID ${pid}) with SIGKILL`);
        return;
    } catch (err) {
        log(`SIGKILL failed for Equipment PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (isProcessRunning(pid)) {
        log(`WARNING: Failed to terminate Equipment process ${pid}`);
        if (process.platform !== 'win32') {
            try {
                process.kill(pid, 'SIGKILL');
                log(`Direct SIGKILL sent to Equipment PID ${pid}`);
            } catch (e) {
                log(`Direct SIGKILL failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    } else {
        log(`Equipment process ${pid} confirmed terminated`);
    }
}

// ============================================================
// Exported Functions - Price List Backend
// ============================================================

/**
 * Get the current Python backend port
 */
export function getPythonPort(): number | null {
    return pythonPort;
}

/**
 * Get the shutdown token for authenticated shutdown requests
 */
export function getShutdownToken(): string | null {
    return shutdownToken;
}

/**
 * Check if Python backend is running
 * Uses backendStatus to ensure process is fully started (not just spawned)
 */
export function isPythonRunning(): boolean {
    return backendStatus === 'running' && pythonProcess !== null && pythonPort !== null;
}

/**
 * Get the current backend status
 */
export function getBackendStatus(): BackendStatus {
    return backendStatus;
}

/**
 * Get the backend event emitter
 */
export function getBackendEvents(): EventEmitter {
    return backendEvents;
}

export { startPythonBackend, stopPythonBackend };

// ============================================================
// Exported Functions - Equipment Backend
// ============================================================

/**
 * Get the current Equipment backend port
 */
export function getEquipmentPort(): number | null {
    return equipmentPort;
}

/**
 * Get the Equipment backend status
 */
export function getEquipmentStatus(): BackendStatus {
    return equipmentStatus;
}

/**
 * Get the Equipment backend event emitter
 */
export function getEquipmentEvents(): EventEmitter {
    return equipmentEvents;
}

/**
 * Check if Equipment backend is running
 */
export function isEquipmentRunning(): boolean {
    return equipmentStatus === 'running' && equipmentProcess !== null && equipmentPort !== null;
}

export { startEquipmentBackend, stopEquipmentBackend };
