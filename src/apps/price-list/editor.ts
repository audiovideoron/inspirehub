// IIFE to create module scope and avoid TypeScript duplicate function errors
(function() {

// Type definitions
interface Price {
    id: number;
    numeric_value: number;
    description: string;
    has_hr_suffix: boolean;
    bbox: number[];
    font_size: number;
    color: number[];
    page_num: number;
}

interface PriceUpdate {
    id: number;
    bbox: number[];
    new_value: number;
    has_hr_suffix: boolean;
    font_size: number;
    color: number[];
    page_num: number;
}

interface LoadPDFResponse {
    success: boolean;
    pdf_path?: string;
    prices?: Price[];
    error?: string;
}

interface ExportPDFResponse {
    success: boolean;
    message?: string;
}

interface BackendStatusInfo {
    elapsed: number;
    maxWait: number;
}

// State
let prices: Price[] = [];
let currentPdfPath: string | null = null;
let lastExportedPath: string | null = null;
let pythonPort: number | null = null;
let backendAvailable: boolean = true;
const originalValues: { [key: number]: number } = {};
const currentValues: { [key: number]: number } = {};
const lastLoggedValues: { [key: number]: number } = {}; // Track what we've already logged

// Expose app state on window for bug report modal to access
// This provides a getter function so the modal always gets current values
(window as any).getAppState = () => ({
    currentPdfPath,
    prices,
    backendAvailable,
    pythonPort
});

// Listen for state requests from shell (Bug Spray modal)
window.addEventListener('message', (event) => {
    if (event.data?.type === 'get-app-state') {
        const state = (window as any).getAppState();
        const filename = state.currentPdfPath?.split('/').pop() || null;
        parent.postMessage({
            type: 'app-state-response',
            state: {
                appName: 'Price List Editor',
                currentFile: filename,
                pricesLoaded: state.prices?.length || 0,
                pricesModified: state.prices?.filter((p: any) => p.modified).length || 0,
                backendStatus: state.backendAvailable ? 'running' : 'unavailable'
            }
        }, '*');
    }
});

// Request timeout in milliseconds
const REQUEST_TIMEOUT = 30000;

/**
 * Sanitize a message by removing or redacting file paths to prevent leaking
 * sensitive PDF filenames in debug logs.
 * @param message - The message to sanitize
 * @returns Sanitized message with paths redacted
 */
function sanitizeLogMessage(message: string): string {
    // Match common path patterns:
    // - Unix absolute paths: /Users/name/Documents/file.pdf
    // - Windows paths: C:\Users\name\file.pdf or C:/Users/name/file.pdf
    // - Relative paths with directories: ./folder/file.pdf, ../folder/file.pdf
    const pathPatterns = [
        // Unix absolute paths (e.g., /Users/name/Documents/sensitive.pdf)
        /\/(?:Users|home|var|tmp|opt|etc|mnt|media|Volumes)[^\s:'"<>|]*\.pdf/gi,
        // Windows paths with drive letter (C:\path or C:/path)
        /[A-Za-z]:[\\\/][^\s:'"<>|]*\.pdf/gi,
        // Any path with multiple segments ending in .pdf
        /(?:\.\.?\/)?(?:[^\s/\\:'"<>|]+[/\\])+[^\s/\\:'"<>|]+\.pdf/gi,
    ];

    let sanitized = message;
    for (const pattern of pathPatterns) {
        sanitized = sanitized.replace(pattern, '[REDACTED_PATH]');
    }
    return sanitized;
}

// Log UI events to shell logging service (for bug reports)
function logEvent(message: string): void {
    // Sanitize message to prevent leaking sensitive file paths
    const sanitizedMessage = sanitizeLogMessage(message);

    // Fire and forget - don't await or block on logging
    // Uses shell logging service via api-bootstrap proxy
    if (window.api?.shellLog?.add) {
        window.api.shellLog.add({
            source: 'price-list',
            level: 'info',
            message: sanitizedMessage
        }).catch(() => {
            // Silently ignore logging failures
        });
    }
}

// Health check configuration
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const HEALTH_CHECK_TIMEOUT = 5000;   // 5 seconds timeout for health check
let healthCheckIntervalId: NodeJS.Timeout | null = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Wait a moment for API bootstrap to initialize (if in iframe)
    if (!window.api) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!window.api) {
        console.error('API not available');
        showBackendError('Unable to connect to application backend.');
        return;
    }

    // Reset bug session timestamp (filters out logs from before this load/reload)
    try {
        await window.api.resetBugSession();
    } catch (e) {
        // Ignore - may not be available in all contexts
    }

    // Get Python backend port
    pythonPort = await window.api.getPythonPort();
    console.log('Python backend port:', pythonPort);

    // Check if backend port is valid
    if (!isPortValid()) {
        console.error('Invalid Python backend port:', pythonPort);
        backendAvailable = false;
        showBackendError('The PDF processing backend failed to start. Please restart the application.');
    }

    // Set up event listeners
    const openBtn = document.getElementById('openBtn');
    const exportBtn = document.getElementById('exportBtn');

    if (openBtn) openBtn.addEventListener('click', openFile);
    if (exportBtn) exportBtn.addEventListener('click', exportPDF);

    // Listen for file-opened events from main process (menu)
    window.api.onFileOpened(loadPDF);

    // Listen for export request from menu
    window.api.onRequestExport(() => {
        if (getChangedPrices().length > 0) {
            exportPDF();
        }
    });

    // Listen for backend crash events
    window.api.onBackendCrashed((info: any) => {
        console.error('Backend crashed:', info);
        backendAvailable = false;
        logEvent(`Backend crashed: code ${info?.code || 'unknown'}`);
        showBackendError('The PDF processing backend has crashed unexpectedly. Please restart the application.');
    });

    // Listen for backend status changes
    window.api.onBackendStatusChange((status: string) => {
        console.log('Backend status changed:', status);
        backendAvailable = (status === 'running');
        if (!backendAvailable && status === 'crashed') {
            showBackendError('The PDF processing backend has crashed unexpectedly. Please restart the application.');
        }
    });

    // Listen for backend startup progress (useful if backend restarts)
    window.api.onBackendStartupProgress((info: BackendStatusInfo) => {
        console.log(`Backend starting: ${info.elapsed}s / ${info.maxWait}s`);
    });

    // Start periodic health check only if port is valid
    if (isPortValid()) {
        startHealthCheckInterval();
        // Perform initial health check
        performHealthCheck();
    }
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    stopHealthCheckInterval();
});

function getBackendUrl(): string {
    return `http://localhost:${pythonPort}`;
}

/**
 * Check if the Python port is valid
 * @returns true if port is a valid number
 */
function isPortValid(): boolean {
    return typeof pythonPort === 'number' && pythonPort > 0 && pythonPort <= 65535;
}

/**
 * Perform a health check against the backend
 * Updates backendAvailable flag and UI based on response
 */
async function performHealthCheck(): Promise<void> {
    if (!isPortValid()) {
        updateBackendStatus(false);
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    try {
        const response = await fetch(`${getBackendUrl()}/api/health`, {
            method: 'GET',
            signal: controller.signal
        });

        if (response.ok) {
            const wasUnavailable = !backendAvailable;
            updateBackendStatus(true);
            if (wasUnavailable) {
                console.log('Backend connection restored');
            }
        } else {
            console.warn('Health check failed: non-OK response', response.status);
            updateBackendStatus(false);
        }
    } catch (error: any) {
        if (error.name === 'AbortError') {
            console.warn('Health check timed out');
        } else {
            console.warn('Health check failed:', error.message);
        }
        updateBackendStatus(false);
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Update backend availability status and UI
 * @param available - Whether the backend is available
 */
function updateBackendStatus(available: boolean): void {
    const wasAvailable = backendAvailable;
    backendAvailable = available;

    // Update status indicator
    const indicator = document.getElementById('backendStatusIndicator');
    if (indicator) {
        if (available) {
            indicator.className = 'backend-status connected';
            indicator.title = 'Backend connected';
        } else {
            indicator.className = 'backend-status disconnected';
            indicator.title = 'Backend disconnected - please restart the application';
        }
    }

    // If backend just became unavailable, show error and disable buttons
    if (wasAvailable && !available) {
        showBackendError('Lost connection to the PDF processing backend. Please restart the application.');
    }

    // If backend became available again, re-enable buttons
    if (!wasAvailable && available) {
        const openBtn = document.getElementById('openBtn') as HTMLButtonElement | null;
        const exportBtn = document.getElementById('exportBtn') as HTMLButtonElement | null;
        const status = document.getElementById('status');

        if (openBtn) openBtn.disabled = false;
        if (status && status.classList.contains('error')) {
            status.classList.remove('visible');
        }
        // Only enable export button if there are changes
        if (exportBtn) {
            exportBtn.disabled = getChangedPrices().length === 0;
        }
    }
}

/**
 * Start the periodic health check interval
 */
function startHealthCheckInterval(): void {
    // Clear any existing interval to prevent multiple intervals running
    if (healthCheckIntervalId) {
        clearInterval(healthCheckIntervalId);
    }
    healthCheckIntervalId = setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
    console.log('Health check interval started');
}

/**
 * Stop the periodic health check interval
 */
function stopHealthCheckInterval(): void {
    if (healthCheckIntervalId) {
        clearInterval(healthCheckIntervalId);
        healthCheckIntervalId = null;
        console.log('Health check interval stopped');
    }
}

/**
 * Fetch with timeout support
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @param timeout - Timeout in milliseconds
 * @returns Promise resolving to Response
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout: number = REQUEST_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. The backend may be unresponsive.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Show a backend error message to the user
 * @param message - The error message
 */
function showBackendError(message: string): void {
    const status = document.getElementById('status');
    if (!status) return;

    status.className = 'status error visible';
    status.textContent = message;

    // Disable buttons when backend is unavailable
    const openBtn = document.getElementById('openBtn') as HTMLButtonElement | null;
    const exportBtn = document.getElementById('exportBtn') as HTMLButtonElement | null;
    if (openBtn) openBtn.disabled = true;
    if (exportBtn) exportBtn.disabled = true;
}

/**
 * Check if backend is available and show error if not
 * @returns true if backend is available
 */
function checkBackendAvailable(): boolean {
    if (!isPortValid()) {
        showBackendError('The PDF processing backend failed to start (invalid port). Please restart the application.');
        return false;
    }
    if (!backendAvailable) {
        showBackendError('The PDF processing backend is not available. Please restart the application.');
        return false;
    }
    return true;
}

async function openFile(): Promise<void> {
    const filePath = await window.api.openFileDialog();
    if (filePath) {
        await loadPDF(filePath);
    }
}

async function loadPDF(pdfPath: string): Promise<void> {
    if (!checkBackendAvailable()) {
        return;
    }

    const status = document.getElementById('status');
    if (status) status.className = 'status';

    try {
        const response = await fetchWithTimeout(`${getBackendUrl()}/api/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pdf_path: pdfPath })
        });

        const result: LoadPDFResponse = await response.json();

        if (result.success && result.pdf_path && result.prices) {
            currentPdfPath = result.pdf_path;
            prices = result.prices;

            // Update UI
            const currentFileEl = document.getElementById('currentFile');
            if (currentFileEl) {
                currentFileEl.textContent = getFilename(currentPdfPath);
                currentFileEl.classList.remove('no-file');
            }

            renderPrices();
            updateUI();
        } else {
            throw new Error(result.error || 'Failed to load PDF');
        }

    } catch (error: any) {
        console.error('Error loading PDF:', error);
        logEvent(`Load failed: ${error.message}`);

        // Check if this might be a backend crash
        const errorMessage = error.message.includes('timed out') || error.message.includes('fetch')
            ? `Failed to load PDF: ${error.message}. The backend may have crashed.`
            : `Failed to load PDF: ${error.message}`;

        await window.api.showMessage({
            type: 'error',
            title: 'Error',
            message: errorMessage
        });
    }
}

function getFilename(path: string): string {
    return path.split(/[/\\]/).pop() || '';
}

function formatPrice(value: number): string {
    if (value === null || value === undefined || typeof value !== 'number' || isNaN(value)) {
        return '';
    }
    if (value === Math.floor(value)) {
        return value.toLocaleString();
    }
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parsePrice(str: string): number | null {
    const clean = str.replace(/,/g, '');
    const num = parseFloat(clean);
    // Reject NaN, zero, and negative prices (backend requires positive prices)
    if (isNaN(num) || num <= 0) {
        return null;
    }
    return num;
}

/**
 * Increment year in filename for default export name suggestion.
 * Uses negative lookahead to avoid matching product codes like "Model2025X".
 * Years followed by letters or digits are NOT incremented.
 * Years at end of string, or followed by _, ., -, space ARE incremented.
 * @param filename - Input filename (without extension)
 * @returns Filename with year incremented
 */
function incrementYearInFilename(filename: string): string {
    // Match 4-digit years (2000-2099) NOT followed by letters or digits
    // This prevents matching product codes like "Model2025X" or "Item2024ABC"
    // But allows "PriceList2024" (end of string), "2025_Report" (start), and "Report_2024_final"
    const yearPattern = /(20\d{2})(?![A-Za-z0-9])/;
    return filename.replace(yearPattern, (match, year) => {
        const yearNum = parseInt(year, 10);
        return String(yearNum + 1);
    });
}

function renderPrices(): void {
    const container = document.getElementById('priceList');
    if (!container) return;

    if (prices.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📄</div>
                <div class="empty-state-text">Open a PDF to edit prices</div>
            </div>
        `;
        return;
    }

    container.innerHTML = '';

    // Clear tracking for new PDF
    Object.keys(lastLoggedValues).forEach(k => delete lastLoggedValues[Number(k)]);

    prices.forEach((price, index) => {
        originalValues[price.id] = price.numeric_value;
        currentValues[price.id] = price.numeric_value;

        const suffix = price.has_hr_suffix ? '/hr' : '';
        const originalText = `$${formatPrice(price.numeric_value)}${suffix}`;

        // Build DOM elements safely to prevent XSS (avoid innerHTML with user data)
        const item = document.createElement('div');
        item.className = 'price-item';
        item.id = `item-${price.id}`;

        const header = document.createElement('div');
        header.className = 'item-header';
        header.textContent = `Item #${index + 1}`;

        const description = document.createElement('div');
        description.className = 'item-description';
        description.textContent = price.description;

        const priceRow = document.createElement('div');
        priceRow.className = 'price-row';

        const priceLabel = document.createElement('span');
        priceLabel.className = 'price-label';
        priceLabel.textContent = 'Current:';

        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'price-input-wrapper';

        const dollarSign = document.createElement('span');
        dollarSign.className = 'dollar-sign';
        dollarSign.textContent = '$';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'price-input';
        input.id = `input-${price.id}`;
        input.value = formatPrice(price.numeric_value);
        input.dataset.id = String(price.id);
        input.dataset.suffix = suffix;
        input.addEventListener('input', handlePriceChange);
        input.addEventListener('blur', handlePriceBlur);

        inputWrapper.appendChild(dollarSign);
        inputWrapper.appendChild(input);

        const originalPrice = document.createElement('span');
        originalPrice.className = 'original-price';
        originalPrice.textContent = `(was: ${originalText})`;

        priceRow.appendChild(priceLabel);
        priceRow.appendChild(inputWrapper);
        priceRow.appendChild(originalPrice);

        const pageNum = document.createElement('div');
        pageNum.className = 'page-num';
        pageNum.textContent = `Page ${price.page_num + 1}`;

        item.appendChild(header);
        item.appendChild(description);
        item.appendChild(priceRow);
        item.appendChild(pageNum);

        container.appendChild(item);
    });
}

function handlePriceChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const id = parseInt(input.dataset.id || '0');
    const value = parsePrice(input.value);

    if (value !== null) {
        currentValues[id] = value;
        input.classList.remove('invalid');
        input.title = '';
    } else {
        // Show visual feedback for invalid input (null value is not stored)
        input.classList.add('invalid');
        input.title = 'Invalid price: enter a positive number';
    }

    updateUI();
}

function handlePriceBlur(e: Event): void {
    const input = e.target as HTMLInputElement;
    const id = parseInt(input.dataset.id || '0');
    const value = parsePrice(input.value);

    if (value !== null) {
        input.value = formatPrice(value);

        // Log only if value changed since we last logged it
        const lastLogged = lastLoggedValues[id];
        if (lastLogged === undefined || value !== lastLogged) {
            const original = originalValues[id];
            if (value !== original) {
                logEvent(`Edited price: $${formatPrice(original)} → $${formatPrice(value)}`);
            }
            lastLoggedValues[id] = value;
        }
    }
}

function updateUI(): void {
    let changesCount = 0;

    prices.forEach(price => {
        const original = originalValues[price.id];
        const current = currentValues[price.id];
        const isModified = current !== original;

        const item = document.getElementById(`item-${price.id}`);
        const input = document.getElementById(`input-${price.id}`) as HTMLInputElement | null;

        if (item && input) {
            if (isModified) {
                item.classList.add('modified');
                input.classList.add('modified');
                changesCount++;
            } else {
                item.classList.remove('modified');
                input.classList.remove('modified');
            }
        }
    });

    // Update summary and button
    const summary = document.getElementById('changesSummary');
    const btn = document.getElementById('exportBtn') as HTMLButtonElement | null;

    if (summary) {
        if (changesCount === 0) {
            summary.textContent = prices.length > 0 ? 'No changes made' : 'Open a PDF to edit prices';
        } else {
            summary.textContent = `${changesCount} price${changesCount > 1 ? 's' : ''} changed`;
        }
    }

    if (btn) {
        btn.disabled = changesCount === 0;
    }
}

function getChangedPrices(): PriceUpdate[] {
    const updates: PriceUpdate[] = [];

    prices.forEach(price => {
        const original = originalValues[price.id];
        const current = currentValues[price.id];

        if (current !== original) {
            updates.push({
                id: price.id,
                bbox: price.bbox,
                new_value: current,
                has_hr_suffix: price.has_hr_suffix,
                font_size: price.font_size,
                color: price.color,
                page_num: price.page_num
            });
        }
    });

    return updates;
}

async function openExportedPDF(): Promise<void> {
    if (lastExportedPath) {
        await window.api.openPath(lastExportedPath);
    }
}

async function exportPDF(): Promise<void> {
    if (!checkBackendAvailable()) {
        return;
    }

    const btn = document.getElementById('exportBtn') as HTMLButtonElement | null;
    const status = document.getElementById('status');

    if (!currentPdfPath) {
        await window.api.showMessage({
            type: 'warning',
            title: 'No PDF Loaded',
            message: 'Please open a PDF file first.'
        });
        return;
    }

    const updates = getChangedPrices();
    if (updates.length === 0) {
        return;
    }

    // Ask user where to save
    const inputName = getFilename(currentPdfPath).replace('.pdf', '');
    const defaultName = incrementYearInFilename(inputName) + '.pdf';

    const outputPath = await window.api.saveFileDialog(defaultName);
    if (!outputPath) {
        return; // User cancelled
    }

    logEvent(`Export clicked: ${updates.length} price${updates.length > 1 ? 's' : ''} to save`);

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Exporting...';
    }
    if (status) status.className = 'status';

    try {
        const response = await fetchWithTimeout(`${getBackendUrl()}/api/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates, output_path: outputPath })
        });

        const result: ExportPDFResponse = await response.json();

        if (result.success && status) {
            lastExportedPath = outputPath;

            status.className = 'status success';
            // Clear any existing content and build safely to prevent XSS
            status.textContent = '';

            const messageSpan = document.createElement('span');
            messageSpan.textContent = result.message || 'Export successful';
            status.appendChild(messageSpan);

            const openBtn = document.createElement('button');
            openBtn.className = 'open-pdf-btn';
            openBtn.id = 'openPdfBtn';
            openBtn.textContent = 'Open PDF';
            openBtn.addEventListener('click', openExportedPDF);
            status.appendChild(openBtn);

            status.classList.add('visible');

            if (btn) {
                btn.textContent = 'Export PDF';
                btn.disabled = false;
            }
        } else {
            throw new Error(result.message || 'Export failed');
        }

    } catch (error: any) {
        // Check if this might be a backend crash
        const errorMessage = error.message.includes('timed out') || error.message.includes('fetch')
            ? 'Error: ' + error.message + ' The backend may have crashed.'
            : 'Error: ' + error.message;

        logEvent(`Export failed: ${error.message}`);

        if (status) {
            status.className = 'status error visible';
            status.textContent = errorMessage;
        }
        if (btn) {
            btn.textContent = 'Export PDF';
            btn.disabled = false;
        }
    }
}

})(); // End IIFE
