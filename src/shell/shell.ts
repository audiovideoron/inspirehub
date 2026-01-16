/**
 * Shell navigation controller
 * Manages switching between apps in the sidebar
 */

// Note: window.api types are defined in src/apps/*/global.d.ts

/**
 * Initialize the API bridge for iframe communication
 * Relays postMessage requests from iframes to main process via preload API
 */
function initShellBridge(): void {
    window.addEventListener('message', async (event) => {
        // Only handle API requests
        const data = event.data;
        if (data?.type !== 'api-request') return;

        const { id, method, args } = data;
        const source = event.source as Window;

        try {
            const api = window.api;
            if (!api) {
                throw new Error('API not available');
            }

            const apiMethod = api[method];
            if (typeof apiMethod !== 'function') {
                throw new Error(`Unknown API method: ${method}`);
            }

            const result = await apiMethod(...args);
            source.postMessage({ type: 'api-response', id, result }, '*');

        } catch (error) {
            source.postMessage({
                type: 'api-response',
                id,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, '*');
        }
    });

    console.log('Shell API bridge initialized');
}

interface AppConfig {
    id: string;
    path: string;
}

const apps: AppConfig[] = [
    { id: 'price-list', path: '../apps/price-list/index.html' },
    { id: 'equipment', path: '../apps/equipment/index.html' },
    { id: 'bugspray', path: '../apps/bugspray/index.html' }
];

let currentApp: string = 'price-list';

// Error toast state
const promptedErrors = new Set<string>();
let promptCount = 0;
const MAX_PROMPTS_PER_SESSION = 3;
const TOAST_AUTO_DISMISS_MS = 10000;
let toastTimeout: number | null = null;

/**
 * Show the error toast notification
 */
function showErrorToast(errorMessage: string): void {
    // Create a dedupe key from the error message
    const key = errorMessage.slice(0, 100);

    // Skip if we've already prompted for this error
    if (promptedErrors.has(key)) {
        console.log('Error toast: skipping duplicate error');
        return;
    }

    // Skip if we've hit the session limit
    if (promptCount >= MAX_PROMPTS_PER_SESSION) {
        console.log('Error toast: session limit reached');
        return;
    }

    // Track this error
    promptedErrors.add(key);
    promptCount++;

    const toast = document.getElementById('errorToast');
    if (!toast) return;

    // Show the toast
    toast.style.display = 'flex';
    toast.classList.remove('hiding');

    // Auto-dismiss after timeout
    if (toastTimeout) {
        clearTimeout(toastTimeout);
    }
    toastTimeout = window.setTimeout(() => {
        hideErrorToast();
    }, TOAST_AUTO_DISMISS_MS);

    console.log(`Error toast: shown (${promptCount}/${MAX_PROMPTS_PER_SESSION})`);
}

/**
 * Hide the error toast notification
 */
function hideErrorToast(): void {
    const toast = document.getElementById('errorToast');
    if (!toast) return;

    if (toastTimeout) {
        clearTimeout(toastTimeout);
        toastTimeout = null;
    }

    // Animate out
    toast.classList.add('hiding');
    setTimeout(() => {
        toast.style.display = 'none';
        toast.classList.remove('hiding');
    }, 300);
}

/**
 * Set up error toast event listeners
 */
function setupErrorToast(): void {
    const reportBtn = document.getElementById('errorToastReport');
    const dismissBtn = document.getElementById('errorToastDismiss');

    reportBtn?.addEventListener('click', () => {
        hideErrorToast();
        // Trigger Bug Spray modal (exposed by bug-report-modal.ts)
        (window as any).showBugReportModal?.();
    });

    dismissBtn?.addEventListener('click', () => {
        hideErrorToast();
    });
}

/**
 * Set up global error capturing for the shell and iframes
 */
function setupErrorCapture(): void {
    // Capture uncaught errors in shell
    window.onerror = (message, filename, lineno, colno, error) => {
        const errorInfo = {
            message: String(message),
            stack: error?.stack,
            filename: filename,
            lineno: lineno,
            colno: colno
        };
        console.error('[Shell Error]', errorInfo);
        window.api?.logError('shell', errorInfo);
        showErrorToast(String(message));
        return false; // Don't suppress the error
    };

    // Capture unhandled promise rejections
    window.onunhandledrejection = (event) => {
        const errorInfo = {
            message: `Unhandled Promise Rejection: ${event.reason}`,
            stack: event.reason?.stack
        };
        console.error('[Shell Unhandled Rejection]', errorInfo);
        window.api?.logError('shell', errorInfo);
        showErrorToast(errorInfo.message);
    };
}

/**
 * Set up error capture for iframe content
 * Note: This only works for same-origin iframes
 */
function setupIframeErrorCapture(iframe: HTMLIFrameElement, appId: string): void {
    iframe.addEventListener('load', () => {
        try {
            const iframeWindow = iframe.contentWindow;
            if (!iframeWindow) return;

            // Capture errors in iframe
            iframeWindow.onerror = (message, filename, lineno, colno, error) => {
                const errorInfo = {
                    message: String(message),
                    stack: error?.stack,
                    filename: filename,
                    lineno: lineno,
                    colno: colno
                };
                console.error(`[${appId} Error]`, errorInfo);
                window.api?.logError(appId, errorInfo);
                showErrorToast(String(message));
                return false;
            };

            // Capture unhandled promise rejections in iframe
            iframeWindow.onunhandledrejection = (event: PromiseRejectionEvent) => {
                const errorInfo = {
                    message: `Unhandled Promise Rejection: ${event.reason}`,
                    stack: event.reason?.stack
                };
                console.error(`[${appId} Unhandled Rejection]`, errorInfo);
                window.api?.logError(appId, errorInfo);
                showErrorToast(errorInfo.message);
            };

        } catch (e) {
            // Cross-origin iframe - can't access contentWindow
            console.warn(`Cannot capture errors for ${appId} (cross-origin)`);
        }
    });
}

function initShell(): void {
    // Initialize API bridge for iframe communication
    initShellBridge();

    // Set up error capture
    setupErrorCapture();

    // Set up error toast
    setupErrorToast();

    const navItems = document.querySelectorAll('.nav-item');
    const appFrame = document.getElementById('app-frame') as HTMLIFrameElement;

    if (!appFrame) {
        console.error('App frame not found');
        return;
    }

    // Set up error capture for iframe
    setupIframeErrorCapture(appFrame, currentApp);

    // Set up navigation click handlers
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const appId = item.getAttribute('data-app');
            if (appId && appId !== currentApp) {
                navigateToApp(appId);
            }
        });
    });

    // Load default app
    navigateToApp(currentApp);
}

function navigateToApp(appId: string): void {
    const app = apps.find(a => a.id === appId);
    if (!app) {
        console.error(`Unknown app: ${appId}`);
        return;
    }

    const appFrame = document.getElementById('app-frame') as HTMLIFrameElement;
    const navItems = document.querySelectorAll('.nav-item');

    // Update active state in sidebar
    navItems.forEach(item => {
        if (item.getAttribute('data-app') === appId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // Set up error capture for the new app before loading
    setupIframeErrorCapture(appFrame, appId);

    // Load app in iframe
    appFrame.src = app.path;
    currentApp = appId;

    console.log(`Navigated to app: ${appId}`);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initShell);
