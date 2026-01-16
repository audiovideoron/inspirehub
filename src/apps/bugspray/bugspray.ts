/**
 * Bug Spray App
 * View and triage bug reports from user submissions
 *
 * - Dev Mode: Full triage capabilities via bd CLI
 * - User Mode: Read-only view of submitted reports (in packaged app)
 */

// State
let isDev = false;
let reports: BugReport[] = [];
let currentTab: 'all' | 'triage' = 'all';
let selectedReport: BugReportDetail | null = null;
let searchQuery = '';
let statusFilter = '';

// DOM Elements
let modeBadge: HTMLElement;
let devTabs: HTMLElement;
let devFilters: HTMLElement;
let reportsList: HTMLElement;
let searchInput: HTMLInputElement;
let statusFilterEl: HTMLSelectElement;
let detailModal: HTMLElement;
let modalTitle: HTMLElement;
let modalBody: HTMLElement;
let modalFooter: HTMLElement;
let userInfoPanel: HTMLElement;

// Polling interval for updates (30s when visible)
let pollInterval: number | null = null;

/**
 * Initialize the app
 */
async function initApp(): Promise<void> {
    // Get DOM elements
    modeBadge = document.getElementById('modeBadge')!;
    devTabs = document.getElementById('devTabs')!;
    devFilters = document.getElementById('devFilters')!;
    reportsList = document.getElementById('reportsList')!;
    searchInput = document.getElementById('searchInput') as HTMLInputElement;
    statusFilterEl = document.getElementById('statusFilter') as HTMLSelectElement;
    detailModal = document.getElementById('detailModal')!;
    modalTitle = document.getElementById('modalTitle')!;
    modalBody = document.getElementById('modalBody')!;
    modalFooter = document.getElementById('modalFooter')!;
    userInfoPanel = document.getElementById('userInfoPanel')!;

    // Detect mode
    isDev = await window.api.isDevelopmentMode();
    setupUI();

    // Set up event listeners
    setupEventListeners();

    // Load reports
    await loadReports();

    // Start polling when visible
    startPolling();
}

/**
 * Set up UI based on mode (dev vs user)
 */
function setupUI(): void {
    if (isDev) {
        modeBadge.classList.add('dev');
        modeBadge.querySelector('.mode-text')!.textContent = 'Dev Mode';
        devTabs.style.display = 'flex';
        devFilters.style.display = 'flex';
        userInfoPanel.style.display = 'none';
    } else {
        modeBadge.classList.add('user');
        modeBadge.querySelector('.mode-text')!.textContent = 'User View';
        devTabs.style.display = 'none';
        devFilters.style.display = 'none';
        userInfoPanel.style.display = 'flex';
    }
}

/**
 * Set up event listeners
 */
function setupEventListeners(): void {
    // Tab switching (dev mode)
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.getAttribute('data-tab') as 'all' | 'triage';
            if (tabId && tabId !== currentTab) {
                currentTab = tabId;
                updateTabUI();
                loadReports();
            }
        });
    });

    // Search input
    searchInput?.addEventListener('input', debounce(() => {
        searchQuery = searchInput.value;
        renderReports();
    }, 300));

    // Status filter
    statusFilterEl?.addEventListener('change', () => {
        statusFilter = statusFilterEl.value;
        loadReports();
    });

    // Modal close
    document.getElementById('modalClose')?.addEventListener('click', closeModal);
    detailModal?.addEventListener('click', (e) => {
        if (e.target === detailModal) closeModal();
    });

    // Listen for app state requests from shell
    window.addEventListener('message', (event) => {
        if (event.data?.type === 'get-app-state') {
            parent.postMessage({
                type: 'app-state-response',
                state: {
                    appName: 'Bug Spray',
                    mode: isDev ? 'dev' : 'user',
                    reportCount: reports.length,
                    currentTab
                }
            }, '*');
        }
    });

    // Visibility change for polling
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPolling();
        } else {
            startPolling();
        }
    });
}

/**
 * Update tab UI
 */
function updateTabUI(): void {
    document.querySelectorAll('.tab').forEach(tab => {
        const tabId = tab.getAttribute('data-tab');
        if (tabId === currentTab) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}

/**
 * Load bug reports
 */
async function loadReports(): Promise<void> {
    reportsList.innerHTML = '<div class="loading">Loading reports...</div>';

    try {
        const filters: BugReportFilters = {};

        if (statusFilter) {
            filters.status = statusFilter as any;
        }

        if (currentTab === 'triage') {
            filters.needsTriage = true;
            filters.status = 'deferred';
        }

        reports = await window.api.getBugReports(filters);
        renderReports();

        // Update triage tab badge
        if (isDev) {
            const triageCount = reports.filter(r =>
                r.labels.includes('needs-triage') && r.status === 'deferred'
            ).length;
            const triageTab = document.querySelector('.tab[data-tab="triage"]');
            if (triageTab) {
                const existingBadge = triageTab.querySelector('.badge');
                if (existingBadge) existingBadge.remove();
                if (triageCount > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'badge';
                    badge.textContent = String(triageCount);
                    triageTab.appendChild(badge);
                }
            }
        }
    } catch (error) {
        console.error('Failed to load reports:', error);
        reportsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                </div>
                <h3>Failed to load reports</h3>
                <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
            </div>
        `;
    }
}

/**
 * Render reports list
 */
function renderReports(): void {
    let filtered = reports;

    // Apply search filter
    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        filtered = filtered.filter(r =>
            r.title.toLowerCase().includes(query) ||
            r.id.toLowerCase().includes(query)
        );
    }

    if (filtered.length === 0) {
        reportsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="22"></line>
                    </svg>
                </div>
                <h3>No bug reports</h3>
                <p>${currentTab === 'triage' ? 'No reports need triage' : 'No reports found'}</p>
            </div>
        `;
        return;
    }

    reportsList.innerHTML = filtered.map(report => `
        <div class="report-card" data-id="${report.id}">
            <div class="report-card-header">
                <h3>${escapeHtml(report.title)}</h3>
                <span class="report-id">${report.id}</span>
            </div>
            <div class="report-card-meta">
                <span class="status-badge ${report.status}">${report.status.replace('_', ' ')}</span>
                <span class="priority-badge p${report.priority}">P${report.priority}</span>
                ${report.labels.map(label => `
                    <span class="label-badge ${label}">${label}</span>
                `).join('')}
                ${report.voteCount ? `
                    <span class="vote-count">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                        </svg>
                        ${report.voteCount}
                    </span>
                ` : ''}
            </div>
            ${report.created ? `<div class="created">Submitted ${formatDate(report.created)}</div>` : ''}
        </div>
    `).join('');

    // Add click handlers
    reportsList.querySelectorAll('.report-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-id');
            if (id) openReportDetail(id);
        });
    });
}

/**
 * Open report detail modal
 */
async function openReportDetail(id: string): Promise<void> {
    modalBody.innerHTML = '<div class="loading">Loading details...</div>';
    modalFooter.style.display = 'none';
    detailModal.classList.add('active');

    try {
        const detail = await window.api.getBugReportDetail(id);
        if (!detail) {
            modalBody.innerHTML = '<p>Report not found</p>';
            return;
        }

        selectedReport = detail;
        modalTitle.textContent = detail.title;

        // Build modal content
        let content = `
            <div class="report-card-meta" style="margin-bottom: 16px;">
                <span class="status-badge ${detail.status}">${detail.status.replace('_', ' ')}</span>
                <span class="priority-badge p${detail.priority}">P${detail.priority}</span>
                ${detail.labels.map(label => `
                    <span class="label-badge ${label}">${label}</span>
                `).join('')}
            </div>
        `;

        // Description section
        if (detail.description) {
            content += `
                <div class="detail-section">
                    <h4>Description</h4>
                    <div class="content">${escapeHtml(detail.description)}</div>
                </div>
            `;
        }

        // Attachments section
        if (detail.hasLogs || detail.hasScreenshot || detail.hasSystemInfo) {
            content += `
                <div class="detail-section">
                    <h4>Attachments</h4>
                    <div class="attachment-tabs">
                        ${detail.hasLogs ? '<button class="attachment-tab" data-type="logs">Logs</button>' : ''}
                        ${detail.hasScreenshot ? '<button class="attachment-tab" data-type="screenshot">Screenshot</button>' : ''}
                        ${detail.hasSystemInfo ? '<button class="attachment-tab" data-type="system-info">System Info</button>' : ''}
                    </div>
                    <div class="attachment-content" id="attachmentContent">
                        <p style="color: #94a3b8; font-size: 14px;">Click a tab to view attachment</p>
                    </div>
                </div>
            `;
        }

        modalBody.innerHTML = content;

        // Attachment tab handlers
        modalBody.querySelectorAll('.attachment-tab').forEach(tab => {
            tab.addEventListener('click', async () => {
                const type = tab.getAttribute('data-type') as 'logs' | 'screenshot' | 'system-info';
                await loadAttachment(id, type);

                // Update active tab
                modalBody.querySelectorAll('.attachment-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
            });
        });

        // Show triage actions in dev mode
        if (isDev && detail.labels.includes('needs-triage')) {
            modalFooter.style.display = 'flex';
            modalFooter.innerHTML = `
                <button class="btn btn-success" id="approveBtn">Approve</button>
                <button class="btn btn-danger" id="rejectBtn">Reject</button>
            `;

            document.getElementById('approveBtn')?.addEventListener('click', () => triageReport('approve'));
            document.getElementById('rejectBtn')?.addEventListener('click', () => triageReport('reject'));
        } else if (isDev) {
            // Show priority controls for non-triage reports
            modalFooter.style.display = 'flex';
            modalFooter.innerHTML = `
                <div style="flex: 1;">
                    <label style="font-size: 13px; color: #64748b;">Priority:</label>
                    <div class="priority-selector" style="margin-top: 4px;">
                        ${[1, 2, 3, 4].map(p => `
                            <button class="priority-btn ${detail.priority === p ? 'selected' : ''}" data-priority="${p}">P${p}</button>
                        `).join('')}
                    </div>
                </div>
            `;

            modalFooter.querySelectorAll('.priority-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const priority = parseInt(btn.getAttribute('data-priority') || '2');
                    await triageReport('prioritize', priority);
                });
            });
        }

    } catch (error) {
        console.error('Failed to load report detail:', error);
        modalBody.innerHTML = `<p>Error loading details: ${error instanceof Error ? error.message : 'Unknown error'}</p>`;
    }
}

/**
 * Load and display an attachment
 */
async function loadAttachment(id: string, type: 'logs' | 'screenshot' | 'system-info'): Promise<void> {
    const container = document.getElementById('attachmentContent');
    if (!container) return;

    container.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const content = await window.api.getAttachment(id, type);
        if (!content) {
            container.innerHTML = '<p>Attachment not found</p>';
            return;
        }

        if (type === 'screenshot') {
            container.innerHTML = `<img src="${content}" class="screenshot" alt="Screenshot" />`;
        } else {
            container.innerHTML = `<div class="content ${type === 'logs' ? 'logs' : ''}">${escapeHtml(content)}</div>`;
        }
    } catch (error) {
        container.innerHTML = `<p>Error loading attachment: ${error instanceof Error ? error.message : 'Unknown error'}</p>`;
    }
}

/**
 * Triage a bug report
 */
async function triageReport(action: 'approve' | 'reject' | 'prioritize', priority?: number): Promise<void> {
    if (!selectedReport) return;

    let reason: string | undefined;
    if (action === 'reject') {
        const input = prompt('Reason for rejection:');
        if (input === null) return; // User cancelled
        reason = input || undefined;
    }

    try {
        const result = await window.api.triageBugReport(selectedReport.id, {
            action,
            priority,
            reason
        });

        if (result.success) {
            closeModal();
            await loadReports();
        } else {
            alert(`Triage failed: ${result.error || 'Unknown error'}`);
        }
    } catch (error) {
        alert(`Triage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Close the detail modal
 */
function closeModal(): void {
    detailModal.classList.remove('active');
    selectedReport = null;
}

/**
 * Start polling for updates
 */
function startPolling(): void {
    if (pollInterval) return;
    pollInterval = window.setInterval(() => {
        loadReports();
    }, 30000);
}

/**
 * Stop polling
 */
function stopPolling(): void {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

// Utility functions

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateStr: string): string {
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch {
        return dateStr;
    }
}

function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {
    let timeoutId: number | null = null;
    return (...args: Parameters<T>) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => fn(...args), delay);
    };
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);

// Make this a module to avoid global scope collisions with other apps
export {};
