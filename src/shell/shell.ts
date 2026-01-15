/**
 * Shell navigation controller
 * Manages switching between apps in the sidebar
 */

import { initShellBridge } from './api-bridge';

// Declare window.api for TypeScript
declare const window: Window & {
    api?: {
        logError: (source: string, error: {
            message: string;
            stack?: string;
            filename?: string;
            lineno?: number;
            colno?: number;
        }) => Promise<void>;
        logConsole: (source: string, level: string, message: string, args?: any[]) => Promise<void>;
        getLogFilePath: () => Promise<string>;
    };
};

interface AppConfig {
    id: string;
    path: string;
}

const apps: AppConfig[] = [
    { id: 'price-list', path: '../apps/price-list/index.html' },
    { id: 'equipment', path: '../apps/equipment/index.html' }
];

let currentApp: string = 'price-list';

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
