/**
 * API Bootstrap for iframe apps
 *
 * Apps include this script to get access to the shell's API via postMessage.
 * Works transparently - apps use window.api the same way they would with preload.
 *
 * Usage: Include this script before your app's main script
 */

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

function isInIframe(): boolean {
    try {
        return window.self !== window.top;
    } catch (e) {
        return true;
    }
}

function createAPIProxy(): any {
    // All API methods that can be proxied
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
        'sendAppState',
        // Bug Spray App methods
        'isDevelopmentMode',
        'getBugReports',
        'getBugReportDetail',
        'triageBugReport',
        'getAttachment'
    ];

    // Event listeners
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

    // Proxy regular API methods
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

                window.parent.postMessage(request, '*');

                // Timeout
                setTimeout(() => {
                    if (pendingRequests.has(id)) {
                        pendingRequests.delete(id);
                        reject(new Error(`API call ${method} timed out`));
                    }
                }, 30000);
            });
        };
    }

    // Proxy event listeners
    for (const method of eventListeners) {
        proxy[method] = (callback: (...args: any[]) => void) => {
            const listenerId = `listener_${++requestIdCounter}`;

            const handler = (event: MessageEvent) => {
                const data = event.data;
                if (data?.type === 'api-event' && data.method === method) {
                    callback(...(data.args || []));
                }
            };
            window.addEventListener('message', handler);

            window.parent.postMessage({
                type: 'api-listen',
                listenerId,
                method
            }, '*');

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

    // Listen for responses
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

// Auto-initialize: If we're in an iframe and window.api doesn't exist, create proxy
(function initAPIBootstrap() {
    if (isInIframe() && !(window as any).api) {
        (window as any).api = createAPIProxy();
        console.log('[API Bootstrap] Iframe API proxy initialized');
    } else if ((window as any).api) {
        console.log('[API Bootstrap] API already available (main window)');
    }
})();
