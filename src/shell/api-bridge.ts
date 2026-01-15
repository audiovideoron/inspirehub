/**
 * API Bridge for iframe communication
 *
 * This module handles postMessage communication between:
 * - Shell (main window with preload API access)
 * - Iframe apps (no direct preload access)
 *
 * Apps in iframes use postMessage to request API calls,
 * and the shell relays these to the main process via IPC.
 */

// Declare window.api for TypeScript
declare const window: Window & {
    api?: any;
};

interface APIRequest {
    type: 'api-request';
    id: string;
    method: string;
    args: any[];
}

interface APIResponse {
    type: 'api-response';
    id: string;
    result?: any;
    error?: string;
}

const pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}>();

let requestIdCounter = 0;

/**
 * Initialize the API bridge in the shell
 * Listens for postMessage requests from iframes and relays to main process
 */
export function initShellBridge(): void {
    window.addEventListener('message', async (event) => {
        // Only handle messages from our iframes (same origin)
        if (event.origin !== 'file://') return;

        const data = event.data as APIRequest;
        if (data?.type !== 'api-request') return;

        const { id, method, args } = data;
        const source = event.source as Window;

        try {
            // Get the API method from the preload
            const api = window.api;
            if (!api) {
                throw new Error('API not available');
            }

            const apiMethod = api[method];
            if (typeof apiMethod !== 'function') {
                throw new Error(`Unknown API method: ${method}`);
            }

            // Call the API and get result
            const result = await apiMethod(...args);

            // Send response back to iframe
            const response: APIResponse = { type: 'api-response', id, result };
            source.postMessage(response, '*');

        } catch (error) {
            // Send error back to iframe
            const response: APIResponse = {
                type: 'api-response',
                id,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            source.postMessage(response, '*');
        }
    });

    console.log('Shell API bridge initialized');
}

/**
 * Create a proxy API object for use in iframes
 * Calls are sent to parent window via postMessage
 */
export function createIframeAPIProxy(): any {
    // List of API methods that can be called
    const apiMethods = [
        'getPythonPort',
        'getBackendStatus',
        'getEquipmentPort',
        'getEquipmentStatus',
        'getBranchId',
        'setBranchId',
        'openFileDialog',
        'saveFileDialog',
        'showMessage',
        'openPath',
        'logError',
        'logConsole',
        'getLogFilePath',
        'submitBugReport',
        'searchSimilarBugs',
        'meTooVote',
        'getFilteredLogs',
        'resetBugSession',
        'hasErrorInLogs',
        'sendAppState'
    ];

    // Event listeners that need special handling
    const eventListeners = [
        'onFileOpened',
        'onRequestExport',
        'onBackendCrashed',
        'onBackendStatusChange',
        'onBackendStartupProgress',
        'onShowBugReportModal',
        'onRequestAppState'
    ];

    const proxy: any = {};

    // Create proxy methods for regular API calls
    for (const method of apiMethods) {
        proxy[method] = (...args: any[]) => {
            return new Promise((resolve, reject) => {
                const id = `req_${++requestIdCounter}`;
                pendingRequests.set(id, { resolve, reject });

                const request: APIRequest = {
                    type: 'api-request',
                    id,
                    method,
                    args
                };

                // Send to parent window (shell)
                window.parent.postMessage(request, '*');

                // Timeout after 30 seconds
                setTimeout(() => {
                    if (pendingRequests.has(id)) {
                        pendingRequests.delete(id);
                        reject(new Error(`API call ${method} timed out`));
                    }
                }, 30000);
            });
        };
    }

    // For event listeners, we need to set up message passing
    // These are more complex and need bidirectional communication
    for (const method of eventListeners) {
        proxy[method] = (callback: (...args: any[]) => void) => {
            // Register event listener via postMessage
            const listenerId = `listener_${++requestIdCounter}`;

            // Set up listener for events from shell
            const handler = (event: MessageEvent) => {
                const data = event.data;
                if (data?.type === 'api-event' && data.method === method) {
                    callback(...(data.args || []));
                }
            };
            window.addEventListener('message', handler);

            // Tell shell to set up the listener
            window.parent.postMessage({
                type: 'api-listen',
                listenerId,
                method
            }, '*');

            // Return unsubscribe function
            return () => {
                window.removeEventListener('message', handler);
                window.parent.postMessage({
                    type: 'api-unlisten',
                    listenerId,
                    method
                }, '*');
            };
        };
    }

    // Listen for responses from shell
    window.addEventListener('message', (event) => {
        const data = event.data as APIResponse;
        if (data?.type !== 'api-response') return;

        const pending = pendingRequests.get(data.id);
        if (pending) {
            pendingRequests.delete(data.id);
            if (data.error) {
                pending.reject(new Error(data.error));
            } else {
                pending.resolve(data.result);
            }
        }
    });

    return proxy;
}

/**
 * Check if running in an iframe
 */
export function isInIframe(): boolean {
    try {
        return window.self !== window.top;
    } catch (e) {
        return true;
    }
}

/**
 * Initialize API access - works in both main window and iframes
 */
export function initAPIAccess(): void {
    if (isInIframe()) {
        // In iframe - use postMessage proxy
        if (!window.api) {
            (window as any).api = createIframeAPIProxy();
            console.log('Iframe API proxy initialized');
        }
    }
    // In main window - preload already set up window.api
}
