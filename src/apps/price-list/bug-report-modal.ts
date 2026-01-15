/**
 * Bug Report Modal UI
 */

interface SimilarBug {
    id: string;
    title: string;
    status: string;
    description: string;
}

class BugReportModal {
    private isOpen: boolean = false;
    private similarBugs: SimilarBug[] = [];
    private searchDebounceTimer: NodeJS.Timeout | null = null;
    private hasErrorInLogs: boolean = false;
    private noteInputHandler: (() => void) | null = null;

    constructor() {
        this.init();
    }

    private init(): void {
        // Create modal HTML
        this.createModal();

        // Bug reporting APIs only available in main window, not in iframes
        if (!window.api?.onShowBugReportModal) {
            console.log('Bug reporting not available (running in iframe)');
            return;
        }

        // Listen for show modal event
        window.api.onShowBugReportModal(() => {
            this.show();
        });

        // Listen for app state requests
        window.api.onRequestAppState(() => {
            this.sendAppState();
        });
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

    private async show(): Promise<void> {
        const modal = document.getElementById('bug-report-modal');
        if (modal) {
            modal.classList.remove('bug-hidden');
            this.isOpen = true;

            // Check if logs contain ERROR level entries
            this.hasErrorInLogs = await window.api.hasErrorInLogs();

            // Update UI based on error status
            this.updateNoteRequirement();

            // Update context and activity
            this.updateContext();
            this.loadActivity();
        }
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

    private updateContext(): void {
        const contextEl = document.getElementById('bug-context');
        if (!contextEl) return;

        const appState = (window as any).getAppState?.() || {};

        if (appState.currentPdfPath) {
            const filename = appState.currentPdfPath.split('/').pop() || appState.currentPdfPath;
            let text = `While editing ${filename}`;

            if (appState.prices && appState.prices.length > 0) {
                const modified = appState.prices.filter((p: any) => p.modified).length;
                if (modified > 0) {
                    text += ` (${modified} price${modified === 1 ? '' : 's'} changed)`;
                }
            }

            contextEl.textContent = text;
        } else {
            contextEl.textContent = 'No PDF loaded';
        }
        contextEl.classList.remove('bug-hidden');
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

            // Reset error state
            this.hasErrorInLogs = false;
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
                includeScreenshot: true
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

    private sendAppState(): void {
        // Collect current app state from the editor
        // Use getAppState() function exposed by editor.ts
        const appState = (window as any).getAppState?.() || {};
        const state = {
            currentPdf: appState.currentPdfPath || null,
            pricesLoaded: appState.prices ? appState.prices.length : 0,
            pricesModified: appState.prices ?
                appState.prices.filter((p: any) => p.modified).length : 0,
            backendStatus: appState.backendAvailable ? 'running' : 'unavailable',
            backendPort: appState.pythonPort || null
        };

        window.api.sendAppState(state);
    }
}

// Initialize on DOM load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new BugReportModal();
    });
} else {
    new BugReportModal();
}
