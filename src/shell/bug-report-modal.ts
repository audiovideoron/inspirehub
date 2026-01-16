/**
 * Bug Report Modal UI (Shell-level component)
 *
 * This modal runs in the shell window, not in app iframes.
 * It communicates with the active app via postMessage to get context.
 */

interface SimilarBug {
    id: string;
    title: string;
    status: string;
    description: string;
}

interface AppState {
    appName: string;
    currentFile?: string;
    recentActions?: string[];
    pricesLoaded?: number;
    pricesModified?: number;
    backendStatus?: string;
    error?: string;
}

class BugReportModal {
    private isOpen: boolean = false;
    private similarBugs: SimilarBug[] = [];
    private searchDebounceTimer: NodeJS.Timeout | null = null;
    private hasErrorInLogs: boolean = false;
    private noteInputHandler: (() => void) | null = null;
    private currentAppState: AppState | null = null;
    private appStateResolve: ((state: AppState) => void) | null = null;

    constructor() {
        this.init();
    }

    private init(): void {
        // Create modal HTML
        this.createModal();

        // Verify we're in the shell (main window), not an iframe
        if (!window.api?.onShowBugReportModal) {
            console.error('Bug Spray: API not available - modal initialization failed');
            return;
        }

        // Listen for show modal event from main process
        window.api.onShowBugReportModal(() => {
            console.warn('Bug Spray: Modal show triggered');
            this.show();
        });

        // Listen for app state requests from main process (for bug submission)
        window.api.onRequestAppState(() => {
            console.warn('Bug Spray: Main process requested app state');
            this.getAppStateFromIframe().then(state => {
                console.warn('Bug Spray: Sending app state to main process');
                window.api.sendAppState(state);
            });
        });

        // Listen for app state responses from iframes
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'app-state-response') {
                console.warn('Bug Spray: Received app state from iframe');
                this.currentAppState = event.data.state;
                this.updateContextDisplay();
                // Resolve pending promise if any
                if (this.appStateResolve) {
                    this.appStateResolve(event.data.state);
                    this.appStateResolve = null;
                }
            }
        });

        console.warn('Bug Spray: Modal initialized in shell');
    }

    private createModal(): void {
        const modalHtml = `
            <div id="bug-report-modal" class="bug-modal bug-hidden">
                <div class="bug-modal-content">
                    <div class="bug-modal-header">
                        <h2>Bug Spray</h2>
                        <button class="bug-close-button" id="bugCloseBtn">&times;</button>
                    </div>

                    <div class="bug-modal-body">
                        <p id="bug-context" class="bug-context"></p>
                        <ul id="bug-activity" class="bug-activity"></ul>

                        <div class="bug-form-group">
                            <label for="bug-description">Add a note (optional):</label>
                            <textarea
                                id="bug-description"
                                rows="2"
                                placeholder="e.g., Expected the PDF to save but nothing happened"
                            ></textarea>
                        </div>

                        <div id="similar-bugs" class="bug-hidden">
                            <h3>Similar bugs:</h3>
                            <ul id="similar-bugs-list"></ul>
                        </div>
                    </div>

                    <div class="bug-modal-footer">
                        <button class="bug-button-secondary" id="bugCancelBtn">Cancel</button>
                        <button class="bug-button-primary" id="bugSubmitBtn">Submit</button>
                    </div>

                    <div id="submission-status" class="bug-submission-status bug-hidden"></div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Add event listeners
        const closeBtn = document.getElementById('bugCloseBtn');
        const cancelBtn = document.getElementById('bugCancelBtn');
        const submitBtn = document.getElementById('bugSubmitBtn');
        if (closeBtn) closeBtn.addEventListener('click', () => this.hide());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.hide());
        if (submitBtn) submitBtn.addEventListener('click', () => this.submit());
    }

    public async show(): Promise<void> {
        const modal = document.getElementById('bug-report-modal');
        if (modal) {
            modal.classList.remove('bug-hidden');
            this.isOpen = true;

            // Check if logs contain ERROR level entries
            this.hasErrorInLogs = await window.api.hasErrorInLogs();

            // Update UI based on error status
            this.updateNoteRequirement();

            // Request app state from active iframe
            this.requestAppState();

            // Load activity logs
            this.loadActivity();
        }
    }

    private requestAppState(): void {
        // Reset previous state
        this.currentAppState = null;

        // Find the active app iframe and request its state
        const iframe = document.getElementById('app-frame') as HTMLIFrameElement;
        if (iframe?.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'get-app-state' }, '*');
        }

        // Set a fallback context if no response
        setTimeout(() => {
            if (!this.currentAppState) {
                this.currentAppState = { appName: 'Unknown' };
                this.updateContextDisplay();
            }
        }, 500);
    }

    /**
     * Get app state from iframe with promise-based timeout
     * Used by main process when capturing bug context
     */
    private getAppStateFromIframe(): Promise<AppState> {
        return new Promise((resolve) => {
            // Store resolve function for when iframe responds
            this.appStateResolve = resolve;

            // Request state from iframe
            const iframe = document.getElementById('app-frame') as HTMLIFrameElement;
            if (iframe?.contentWindow) {
                iframe.contentWindow.postMessage({ type: 'get-app-state' }, '*');
            }

            // Timeout after 3 seconds
            setTimeout(() => {
                if (this.appStateResolve) {
                    console.warn('Bug Spray: App state request timed out');
                    this.appStateResolve = null;
                    resolve({ appName: 'Unknown', error: 'Timeout' });
                }
            }, 3000);
        });
    }

    private updateContextDisplay(): void {
        const contextEl = document.getElementById('bug-context');
        if (!contextEl) return;

        const state = this.currentAppState;
        if (!state) {
            contextEl.textContent = 'Loading context...';
            return;
        }

        let text = '';

        if (state.currentFile) {
            const filename = state.currentFile.split('/').pop() || state.currentFile;
            text = `While editing ${filename}`;

            if (state.pricesModified && state.pricesModified > 0) {
                text += ` (${state.pricesModified} price${state.pricesModified === 1 ? '' : 's'} changed)`;
            }
        } else if (state.appName) {
            text = `In ${state.appName}`;
        } else {
            text = 'No file loaded';
        }

        contextEl.textContent = text;
        contextEl.classList.remove('bug-hidden');
    }

    private updateNoteRequirement(): void {
        const label = document.querySelector('label[for="bug-description"]');
        const descInput = document.getElementById('bug-description') as HTMLTextAreaElement;
        const submitBtn = document.getElementById('bugSubmitBtn') as HTMLButtonElement;

        if (!label || !descInput || !submitBtn) return;

        // Remove existing input handler if any
        if (this.noteInputHandler) {
            descInput.removeEventListener('input', this.noteInputHandler);
            this.noteInputHandler = null;
        }

        if (this.hasErrorInLogs) {
            // Error detected: note is optional
            label.textContent = 'Add a note (optional):';
            descInput.placeholder = 'e.g., Expected the PDF to save but nothing happened';
            submitBtn.disabled = false;
        } else {
            // No error: require description
            label.textContent = 'Describe what went wrong:';
            descInput.placeholder = 'What were you trying to do? What happened instead?';
            submitBtn.disabled = descInput.value.trim().length === 0;

            // Add input listener to enable submit when text entered
            this.noteInputHandler = () => {
                submitBtn.disabled = descInput.value.trim().length === 0;
            };
            descInput.addEventListener('input', this.noteInputHandler);
        }
    }

    private async loadActivity(): Promise<void> {
        const activityEl = document.getElementById('bug-activity');
        if (!activityEl) return;

        try {
            const logs = await window.api.getFilteredLogs();
            if (logs.length > 0) {
                activityEl.innerHTML = logs.map(log => `<li>${this.escapeHtml(log)}</li>`).join('');
                activityEl.classList.remove('bug-hidden');
            } else {
                activityEl.classList.add('bug-hidden');
            }
        } catch (error) {
            console.error('Failed to load activity:', error);
            activityEl.classList.add('bug-hidden');
        }
    }

    private hide(): void {
        const modal = document.getElementById('bug-report-modal');
        if (modal) {
            modal.classList.add('bug-hidden');
            this.isOpen = false;

            // Clear form
            const descInput = document.getElementById('bug-description') as HTMLTextAreaElement;
            const similarBugsDiv = document.getElementById('similar-bugs');
            const statusDiv = document.getElementById('submission-status');
            const submitBtn = document.getElementById('bugSubmitBtn') as HTMLButtonElement;

            // Remove input handler
            if (this.noteInputHandler && descInput) {
                descInput.removeEventListener('input', this.noteInputHandler);
                this.noteInputHandler = null;
            }

            if (descInput) descInput.value = '';
            if (similarBugsDiv) similarBugsDiv.classList.add('bug-hidden');
            if (statusDiv) statusDiv.classList.add('bug-hidden');
            if (submitBtn) submitBtn.disabled = false;

            const activityEl = document.getElementById('bug-activity');
            if (activityEl) activityEl.innerHTML = '';

            // Reset state
            this.hasErrorInLogs = false;
            this.currentAppState = null;
        }
    }

    private async onTitleChange(title: string): Promise<void> {
        // Debounce search
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        if (title.length < 3) {
            const similarBugsDiv = document.getElementById('similar-bugs');
            if (similarBugsDiv) similarBugsDiv.classList.add('bug-hidden');
            return;
        }

        this.searchDebounceTimer = setTimeout(async () => {
            await this.searchSimilarBugs(title);
        }, 500);
    }

    private async searchSimilarBugs(query: string): Promise<void> {
        try {
            const response = await window.api.searchSimilarBugs(query);

            if (response.success && response.results && response.results.length > 0) {
                this.similarBugs = response.results;
                this.displaySimilarBugs();
            } else {
                const similarBugsDiv = document.getElementById('similar-bugs');
                if (similarBugsDiv) similarBugsDiv.classList.add('bug-hidden');
            }
        } catch (error) {
            console.error('Failed to search similar bugs:', error);
            // Fail silently, don't block submission
        }
    }

    private displaySimilarBugs(): void {
        const container = document.getElementById('similar-bugs');
        const list = document.getElementById('similar-bugs-list');

        if (!container || !list) return;

        list.innerHTML = this.similarBugs.map(bug => `
            <li>
                <div class="bug-similar-header">
                    <strong>${bug.id}:</strong> ${this.escapeHtml(bug.title)}
                    <span class="bug-status-badge">[${bug.status}]</span>
                    <button class="bug-me-too-btn" data-issue-id="${bug.id}">Me Too</button>
                </div>
                <div class="bug-similar-desc">${this.escapeHtml(bug.description)}</div>
            </li>
        `).join('');

        // Add click handlers for Me Too buttons
        list.querySelectorAll('.bug-me-too-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const issueId = (e.target as HTMLElement).getAttribute('data-issue-id');
                if (issueId) this.handleMeToo(issueId);
            });
        });

        container.classList.remove('bug-hidden');
    }

    private async handleMeToo(issueId: string): Promise<void> {
        const descInput = document.getElementById('bug-description') as HTMLTextAreaElement;
        const note = descInput?.value.trim() || '';

        this.showStatus('Adding your vote...', 'loading');

        try {
            const response = await window.api.meTooVote(issueId, note);

            if (response.success) {
                this.showStatus(
                    `Vote added to ${issueId}! (${response.voteCount} total votes)`,
                    'success'
                );
                setTimeout(() => this.hide(), 2000);
            } else {
                this.showError(`Failed to add vote: ${response.error || 'Unknown error'}`);
            }
        } catch (error) {
            this.showError(`Failed to add vote: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    private async submit(): Promise<void> {
        const descInput = document.getElementById('bug-description') as HTMLTextAreaElement;
        const activityEl = document.getElementById('bug-activity');

        const note = descInput?.value.trim() || '';

        // If no error detected, require a description
        if (!this.hasErrorInLogs && note.length === 0) {
            this.showError('Please describe what went wrong');
            return;
        }

        // Generate title from last activity event or context
        const activityItems = activityEl?.querySelectorAll('li');
        let title = 'Bug report';
        if (activityItems && activityItems.length > 0) {
            const lastActivity = activityItems[activityItems.length - 1].textContent?.trim() || '';
            if (lastActivity) {
                title = lastActivity.length > 80 ? lastActivity.substring(0, 77) + '...' : lastActivity;
            }
        }

        // Show loading state
        this.showStatus('Submitting...', 'loading');

        try {
            const response = await window.api.submitBugReport({
                title,
                userDescription: note,
                includeScreenshot: true,
                context: this.currentAppState
            });

            if (response.success) {
                this.showStatus(`Submitted: ${response.bugId}`, 'success');

                setTimeout(() => {
                    this.hide();
                }, 3000);
            } else {
                this.showError(`Failed to submit bug report: ${response.error || 'Unknown error'}`);
            }
        } catch (error) {
            this.showError(`Failed to submit bug report: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private showStatus(message: string, type: 'loading' | 'success' | 'error'): void {
        const statusDiv = document.getElementById('submission-status');
        if (!statusDiv) return;

        statusDiv.textContent = message;
        statusDiv.className = `bug-submission-status bug-status-${type}`;
        statusDiv.classList.remove('bug-hidden');
    }

    private showError(message: string): void {
        this.showStatus(message, 'error');
    }
}

// Initialize on DOM load and expose show function
let modalInstance: BugReportModal | null = null;

function initModal(): void {
    modalInstance = new BugReportModal();
    // Expose show function for error toast to call
    (window as any).showBugReportModal = () => {
        modalInstance?.show();
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModal);
} else {
    initModal();
}
