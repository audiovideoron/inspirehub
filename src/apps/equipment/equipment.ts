/**
 * Equipment Catalog - Frontend TypeScript
 * Displays equipment types with availability and handles requests
 */

declare const api: {
    fetch: (path: string, options?: RequestInit) => Promise<Response>;
    getBaseUrl: () => string;
    waitForBackend: (port: number) => Promise<boolean>;
};

// IIFE to create module scope and avoid TypeScript duplicate function errors
(function() {

// ============================================================
// Types
// ============================================================

interface EquipmentType {
    id: number;
    name: string;
    category: string | null;
    description: string | null;
    image_url: string | null;
    created_at: string;
    updated_at: string;
}

interface EquipmentTypeWithParts extends EquipmentType {
    parts: PartInfo[];
}

interface PartInfo {
    id: number;
    name: string;
    category: string | null;
    required: boolean;
    quantity: number;
}

interface Location {
    id: number;
    branch_id: string;
    name: string;
    address: string | null;
    region: string | null;
    is_warehouse: boolean;
}

interface AvailabilityResponse {
    equipment_type_id: number;
    equipment_type_name: string;
    location_id: number | null;
    location_name: string | null;
    total_items: number;
    available_items: number;
    reserved_items: number;
}

interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    page_size: number;
    pages: number;
}

interface RequestLineCreate {
    equipment_type_id: number;
    quantity: number;
    include_parts: boolean;
}

interface RequestCreate {
    requesting_location_id: number;
    source_location_id: number;
    needed_from_date: string;
    needed_until_date: string | null;
    notes: string | null;
    lines: RequestLineCreate[];
}

interface WizardItem {
    typeId: number;
    type: EquipmentTypeWithParts;
    quantity: number;
    includeParts: boolean;
    selectedPartIds: Set<number>;
}

interface RequestLineResponse {
    id: number;
    equipment_type_id: number;
    quantity: number;
    assigned_item_id: number | null;
    include_parts: boolean;
    equipment_type: EquipmentType | null;
}

interface RequestResponse {
    id: number;
    requesting_location_id: number;
    source_location_id: number;
    requester_user_id: string | null;
    status: string;
    needed_from_date: string;
    needed_until_date: string | null;
    submitted_at: string;
    reviewed_at: string | null;
    reviewed_by_user_id: string | null;
    denial_reason: string | null;
    notes: string | null;
}

interface RequestDetail extends RequestResponse {
    requesting_location: Location | null;
    source_location: Location | null;
    lines: RequestLineResponse[];
}

interface BranchConfig {
    branchId: string;
    locationId: number;
    locationName: string;
    isWarehouse: boolean;
    region: string | null;
}

const STORAGE_KEY = 'equipment_branch_config';

// ============================================================
// State
// ============================================================

let equipmentTypes: EquipmentType[] = [];
let categories: string[] = [];
let availabilityByType: Map<number, AvailabilityResponse[]> = new Map();
let currentFilter = '';
let currentCategory = '';

// Wizard State
let locations: Location[] = [];
let wizardStep = 1;
let wizardItems: WizardItem[] = [];
let primaryTypeId: number | null = null;

// My Requests State
let currentView: 'catalog' | 'my-requests' | 'transfers' | 'inventory' | 'approvals' = 'catalog';
let myRequests: RequestDetail[] = [];
let requestFilter = '';
let requestStatusFilter = '';

// Branch Config State
let currentBranch: BranchConfig | null = null;
let validatedLocation: Location | null = null;

// Approvals State (Warehouse Only)
let approvalRequests: RequestDetail[] = [];
let approvalFilter = '';
let approvalStatusFilterValue = 'Submitted';
let pendingDenialRequestId: number | null = null;

// ============================================================
// DOM Elements
// ============================================================

const catalogGrid = document.getElementById('catalogGrid') as HTMLDivElement;
const loadingState = document.getElementById('loadingState') as HTMLDivElement;
const emptyState = document.getElementById('emptyState') as HTMLDivElement;
const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const categoryFilter = document.getElementById('categoryFilter') as HTMLSelectElement;
const backendStatus = document.getElementById('backendStatus') as HTMLDivElement;
const detailModal = document.getElementById('detailModal') as HTMLDivElement;
const modalTitle = document.getElementById('modalTitle') as HTMLHeadingElement;
const modalBody = document.getElementById('modalBody') as HTMLDivElement;
const modalClose = document.getElementById('modalClose') as HTMLButtonElement;
const modalCancelBtn = document.getElementById('modalCancelBtn') as HTMLButtonElement;
const modalRequestBtn = document.getElementById('modalRequestBtn') as HTMLButtonElement;

// Wizard DOM Elements
const requestWizard = document.getElementById('requestWizard') as HTMLDivElement;
const wizardClose = document.getElementById('wizardClose') as HTMLButtonElement;
const wizardBackBtn = document.getElementById('wizardBackBtn') as HTMLButtonElement;
const wizardCancelBtn = document.getElementById('wizardCancelBtn') as HTMLButtonElement;
const wizardNextBtn = document.getElementById('wizardNextBtn') as HTMLButtonElement;
const sourceLocationSelect = document.getElementById('sourceLocation') as HTMLSelectElement;
const needByDateInput = document.getElementById('needByDate') as HTMLInputElement;
const returnByDateInput = document.getElementById('returnByDate') as HTMLInputElement;
const permanentTransferCheckbox = document.getElementById('permanentTransfer') as HTMLInputElement;
const returnDateGroup = document.getElementById('returnDateGroup') as HTMLDivElement;
const selectedEquipmentDiv = document.getElementById('selectedEquipment') as HTMLDivElement;
const partsSection = document.getElementById('partsSection') as HTMLDivElement;
const partsChecklist = document.getElementById('partsChecklist') as HTMLDivElement;
const addMoreItemsBtn = document.getElementById('addMoreItemsBtn') as HTMLButtonElement;
const additionalItemsDiv = document.getElementById('additionalItems') as HTMLDivElement;
const requestNotesTextarea = document.getElementById('requestNotes') as HTMLTextAreaElement;

// Item Picker Elements
const itemPickerModal = document.getElementById('itemPickerModal') as HTMLDivElement;
const itemPickerClose = document.getElementById('itemPickerClose') as HTMLButtonElement;
const itemPickerSearch = document.getElementById('itemPickerSearch') as HTMLInputElement;
const itemPickerGrid = document.getElementById('itemPickerGrid') as HTMLDivElement;

// Navigation & View Elements
const navTabs = document.querySelectorAll('.nav-tab');
const catalogView = document.getElementById('catalogView') as HTMLDivElement;
const myRequestsView = document.getElementById('myRequestsView') as HTMLDivElement;
const myRequestsTab = document.getElementById('myRequestsTab') as HTMLButtonElement;
const transfersView = document.getElementById('transfersView') as HTMLDivElement;
const transfersTab = document.getElementById('transfersTab') as HTMLButtonElement;
const transfersBadge = document.getElementById('transfersBadge') as HTMLSpanElement;
const inventoryView = document.getElementById('inventoryView') as HTMLDivElement;
const inventoryTab = document.getElementById('inventoryTab') as HTMLButtonElement;
const pageTitle = document.getElementById('pageTitle') as HTMLHeadingElement;

// My Requests Elements
const requestList = document.getElementById('requestList') as HTMLDivElement;
const requestsLoadingState = document.getElementById('requestsLoadingState') as HTMLDivElement;
const requestsEmptyState = document.getElementById('requestsEmptyState') as HTMLDivElement;
const requestSearchInput = document.getElementById('requestSearchInput') as HTMLInputElement;
const requestStatusFilterSelect = document.getElementById('requestStatusFilter') as HTMLSelectElement;
const newRequestFromEmpty = document.getElementById('newRequestFromEmpty') as HTMLButtonElement;

// Branch Setup Elements
const branchSetupOverlay = document.getElementById('branchSetupOverlay') as HTMLDivElement;
const branchIdInput = document.getElementById('branchIdInput') as HTMLInputElement;
const branchValidation = document.getElementById('branchValidation') as HTMLDivElement;
const branchSubmitBtn = document.getElementById('branchSubmitBtn') as HTMLButtonElement;

// Approvals View Elements (Warehouse Only)
const approvalsTab = document.getElementById('approvalsTab') as HTMLButtonElement;
const approvalsBadge = document.getElementById('approvalsBadge') as HTMLSpanElement;
const approvalsView = document.getElementById('approvalsView') as HTMLDivElement;
const approvalQueue = document.getElementById('approvalQueue') as HTMLDivElement;
const approvalsLoadingState = document.getElementById('approvalsLoadingState') as HTMLDivElement;
const approvalsEmptyState = document.getElementById('approvalsEmptyState') as HTMLDivElement;
const approvalSearchInput = document.getElementById('approvalSearchInput') as HTMLInputElement;
const approvalStatusFilter = document.getElementById('approvalStatusFilter') as HTMLSelectElement;

// Denial Modal Elements
const denialModal = document.getElementById('denialModal') as HTMLDivElement;
const denialModalClose = document.getElementById('denialModalClose') as HTMLButtonElement;
const denialReasonInput = document.getElementById('denialReasonInput') as HTMLTextAreaElement;
const denialCancelBtn = document.getElementById('denialCancelBtn') as HTMLButtonElement;
const denialConfirmBtn = document.getElementById('denialConfirmBtn') as HTMLButtonElement;

// ============================================================
// API Functions
// ============================================================

async function fetchEquipmentTypes(): Promise<EquipmentType[]> {
    const response = await api.fetch('/api/equipment-types');
    if (!response.ok) {
        throw new Error(`Failed to fetch equipment types: ${response.status}`);
    }
    return response.json();
}

async function fetchEquipmentTypeWithParts(typeId: number): Promise<EquipmentTypeWithParts> {
    const response = await api.fetch(`/api/equipment-types/${typeId}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch equipment type: ${response.status}`);
    }
    return response.json();
}

async function fetchAvailability(typeId: number): Promise<AvailabilityResponse[]> {
    const response = await api.fetch(`/api/availability?equipment_type_id=${typeId}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch availability: ${response.status}`);
    }
    return response.json();
}

async function fetchLocations(): Promise<Location[]> {
    const response = await api.fetch('/api/locations');
    if (!response.ok) {
        throw new Error(`Failed to fetch locations: ${response.status}`);
    }
    return response.json();
}

async function createRequest(request: RequestCreate): Promise<void> {
    const response = await api.fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || `Failed to create request: ${response.status}`);
    }
}

async function fetchMyRequests(): Promise<RequestDetail[]> {
    // Fetch all requests - in a real app, would filter by user/location
    const response = await api.fetch('/api/requests');
    if (!response.ok) {
        throw new Error(`Failed to fetch requests: ${response.status}`);
    }
    const requests: RequestResponse[] = await response.json();

    // Fetch full details for each request
    const details: RequestDetail[] = [];
    for (const req of requests) {
        try {
            const detailResponse = await api.fetch(`/api/requests/${req.id}`);
            if (detailResponse.ok) {
                details.push(await detailResponse.json());
            }
        } catch (error) {
            console.warn(`Failed to fetch details for request ${req.id}:`, error);
        }
    }
    return details;
}

async function approveRequest(requestId: number): Promise<void> {
    const response = await api.fetch(`/api/requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'Approved',
            reviewed_by_user_id: currentBranch?.branchId ?? null
        })
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(error.detail || `Failed to approve request: ${response.status}`);
    }
}

async function denyRequest(requestId: number, reason: string): Promise<void> {
    const response = await api.fetch(`/api/requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'Denied',
            denial_reason: reason,
            reviewed_by_user_id: currentBranch?.branchId ?? null
        })
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(error.detail || `Failed to deny request: ${response.status}`);
    }
}

// ============================================================
// Branch Setup Functions
// ============================================================

function loadSavedBranch(): BranchConfig | null {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (error) {
        console.warn('Failed to load saved branch config:', error);
    }
    return null;
}

function saveBranchConfig(config: BranchConfig): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
        console.warn('Failed to save branch config:', error);
    }
}

async function validateBranchId(branchId: string): Promise<Location | null> {
    try {
        const response = await api.fetch('/api/locations');
        if (!response.ok) {
            throw new Error('Failed to fetch locations');
        }
        const allLocations: Location[] = await response.json();
        return allLocations.find(loc => loc.branch_id === branchId) ?? null;
    } catch (error) {
        console.error('Failed to validate branch:', error);
        return null;
    }
}

function showBranchSetup(): void {
    branchSetupOverlay.classList.remove('hidden');
    branchIdInput.value = '';
    branchIdInput.className = '';
    branchValidation.className = 'branch-validation';
    branchValidation.innerHTML = '';
    branchSubmitBtn.disabled = true;
    validatedLocation = null;
    branchIdInput.focus();
}

function hideBranchSetup(): void {
    branchSetupOverlay.classList.add('hidden');
}

function updateBranchValidationUI(state: 'loading' | 'success' | 'error', location?: Location): void {
    branchValidation.className = `branch-validation ${state}`;

    if (state === 'loading') {
        branchValidation.innerHTML = '<span>Validating...</span>';
        branchIdInput.className = '';
        branchSubmitBtn.disabled = true;
    } else if (state === 'success' && location) {
        const warehouseBadge = location.is_warehouse
            ? '<span class="branch-warehouse-badge">WAREHOUSE / ADMIN</span>'
            : '';
        branchValidation.innerHTML = `
            <span class="branch-name">${escapeHtml(location.name)}</span>
            <span class="branch-region">${escapeHtml(location.region ?? '')}</span>
            ${warehouseBadge}
        `;
        branchIdInput.className = 'valid';
        branchSubmitBtn.disabled = false;
        validatedLocation = location;
    } else {
        branchValidation.innerHTML = '<span>Branch not found. Please check the ID.</span>';
        branchIdInput.className = 'invalid';
        branchSubmitBtn.disabled = true;
        validatedLocation = null;
    }
}

let branchValidationTimeout: ReturnType<typeof setTimeout> | null = null;

async function handleBranchInput(): Promise<void> {
    const value = branchIdInput.value.replace(/\D/g, '').slice(0, 4);
    branchIdInput.value = value;

    // Clear any pending validation
    if (branchValidationTimeout) {
        clearTimeout(branchValidationTimeout);
        branchValidationTimeout = null;
    }

    // Reset if incomplete
    if (value.length < 4) {
        branchValidation.className = 'branch-validation';
        branchValidation.innerHTML = '';
        branchIdInput.className = '';
        branchSubmitBtn.disabled = true;
        validatedLocation = null;
        return;
    }

    // Debounce validation
    updateBranchValidationUI('loading');
    branchValidationTimeout = setTimeout(async () => {
        const location = await validateBranchId(value);
        if (location) {
            updateBranchValidationUI('success', location);
        } else {
            updateBranchValidationUI('error');
        }
    }, 300);
}

function handleBranchSubmit(): void {
    if (!validatedLocation) return;

    const config: BranchConfig = {
        branchId: validatedLocation.branch_id,
        locationId: validatedLocation.id,
        locationName: validatedLocation.name,
        isWarehouse: validatedLocation.is_warehouse,
        region: validatedLocation.region
    };

    saveBranchConfig(config);
    currentBranch = config;
    hideBranchSetup();

    // Update UI based on branch
    updateUIForBranch();
}

function updateUIForBranch(): void {
    if (!currentBranch) return;

    // Update page title to show branch
    if (pageTitle) {
        pageTitle.textContent = currentBranch.isWarehouse
            ? 'Equipment (Warehouse)'
            : `Equipment - ${currentBranch.locationName}`;
    }

    // Show/hide tabs based on role
    if (currentBranch.isWarehouse) {
        // Warehouse sees: Catalog, Inventory Management, Approval Queue
        myRequestsTab.style.display = 'none';
        transfersTab.style.display = 'none';
        inventoryTab.style.display = 'inline-flex';
        approvalsTab.style.display = 'inline-flex';
    } else {
        // Hotels see: Catalog, My Requests, Transfer Requests
        myRequestsTab.style.display = 'inline-flex';
        transfersTab.style.display = 'inline-flex';
        inventoryTab.style.display = 'none';
        approvalsTab.style.display = 'none';
    }

    // Update badge counts
    updateBadgeCounts();
}

async function updateBadgeCounts(): Promise<void> {
    if (!currentBranch) return;

    if (currentBranch.isWarehouse) {
        // Count pending approvals for warehouse
        try {
            const allRequests = await fetchMyRequests();
            const pendingCount = allRequests.filter((r: RequestDetail) => r.status === 'Submitted').length;
            if (approvalsBadge) {
                approvalsBadge.textContent = String(pendingCount);
                approvalsBadge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
            }
        } catch (error) {
            console.error('Failed to update approvals badge:', error);
        }
    } else {
        // Count pending transfers for hotels (placeholder - always 0 for now)
        if (transfersBadge) {
            transfersBadge.textContent = '0';
            transfersBadge.style.display = 'none'; // Hide when 0
        }
    }
}

// ============================================================
// Rendering Functions
// ============================================================

function getCategoryClass(category: string | null): string {
    if (!category) return '';
    const lower = category.toLowerCase();
    if (lower.includes('av') || lower.includes('audio') || lower.includes('video')) return 'av';
    if (lower.includes('furniture')) return 'furniture';
    if (lower.includes('staging')) return 'staging';
    if (lower.includes('lighting')) return 'lighting';
    if (lower.includes('accessor')) return 'accessories';
    return '';
}

function getCategoryIcon(category: string | null): string {
    if (!category) return '📦';
    const lower = category.toLowerCase();
    if (lower.includes('av') || lower.includes('audio') || lower.includes('video')) return '🎬';
    if (lower.includes('furniture')) return '🪑';
    if (lower.includes('staging')) return '🎪';
    if (lower.includes('lighting')) return '💡';
    if (lower.includes('accessor')) return '🔧';
    return '📦';
}

function renderEquipmentCard(type: EquipmentType): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'equipment-card';
    card.dataset.typeId = String(type.id);

    const availability = availabilityByType.get(type.id);
    const totalAvailable = availability?.reduce((sum, a) => sum + a.available_items, 0) ?? 0;
    const totalItems = availability?.reduce((sum, a) => sum + a.total_items, 0) ?? 0;

    let availClass = '';
    if (totalAvailable === 0) availClass = 'none';
    else if (totalAvailable < totalItems * 0.3) availClass = 'low';

    const categoryClass = getCategoryClass(type.category);
    const icon = getCategoryIcon(type.category);

    card.innerHTML = `
        <div class="card-image ${categoryClass}">
            ${icon}
        </div>
        <div class="card-body">
            <div class="card-title">${escapeHtml(type.name)}</div>
            <div class="card-category">${escapeHtml(type.category ?? 'Uncategorized')}</div>
            <div class="card-stats">
                <div class="stat">
                    <span class="stat-value ${availClass}">${totalAvailable}</span>
                    <span class="stat-label">Available</span>
                </div>
                <div class="stat">
                    <span class="stat-value">${totalItems}</span>
                    <span class="stat-label">Total</span>
                </div>
            </div>
            <div class="card-actions">
                <button class="btn btn-secondary view-details-btn">Details</button>
                <button class="btn btn-primary request-btn" ${totalAvailable === 0 ? 'disabled' : ''}>Request</button>
            </div>
        </div>
    `;

    // Event listeners
    card.querySelector('.view-details-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showDetailModal(type.id);
    });

    card.querySelector('.request-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openRequestWizard(type.id);
    });

    card.addEventListener('click', () => {
        showDetailModal(type.id);
    });

    return card;
}

function renderCatalog(): void {
    // Filter equipment types
    let filtered = equipmentTypes;

    if (currentFilter) {
        const search = currentFilter.toLowerCase();
        filtered = filtered.filter(t =>
            t.name.toLowerCase().includes(search) ||
            (t.category?.toLowerCase().includes(search)) ||
            (t.description?.toLowerCase().includes(search))
        );
    }

    if (currentCategory) {
        filtered = filtered.filter(t => t.category === currentCategory);
    }

    // Clear and render
    catalogGrid.innerHTML = '';

    if (filtered.length === 0) {
        emptyState.style.display = 'flex';
        return;
    }

    emptyState.style.display = 'none';

    for (const type of filtered) {
        catalogGrid.appendChild(renderEquipmentCard(type));
    }
}

function populateCategoryFilter(): void {
    // Extract unique categories
    const cats = new Set<string>();
    for (const type of equipmentTypes) {
        if (type.category) cats.add(type.category);
    }
    categories = Array.from(cats).sort();

    // Populate select
    categoryFilter.innerHTML = '<option value="">All Categories</option>';
    for (const cat of categories) {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        categoryFilter.appendChild(option);
    }
}

async function showDetailModal(typeId: number): Promise<void> {
    try {
        const type = await fetchEquipmentTypeWithParts(typeId);
        const allAvailability = availabilityByType.get(typeId) ?? [];

        // Filter to only locations with available items
        const availability = allAvailability.filter(a => a.available_items > 0);

        modalTitle.textContent = type.name;
        modalBody.innerHTML = `
            <div class="detail-section">
                <h3>Description</h3>
                <p class="detail-description">${escapeHtml(type.description ?? 'No description available.')}</p>
            </div>

            <div class="detail-section">
                <h3>Available Inventory</h3>
                ${availability.length > 0 ? `
                    <div class="inventory-list">
                        ${availability.map(a => `
                            <div class="inventory-item" data-location-id="${a.location_id}">
                                <div class="inventory-info">
                                    <div class="inventory-location">${escapeHtml(a.location_name ?? 'Unknown')}</div>
                                    <div class="inventory-count">
                                        <span class="inventory-available">${a.available_items}</span> available
                                        ${a.reserved_items > 0 ? `<span class="inventory-reserved">(${a.reserved_items} reserved)</span>` : ''}
                                    </div>
                                </div>
                                <button class="btn btn-sm btn-primary request-from-btn" data-location-id="${a.location_id}">
                                    Request
                                </button>
                            </div>
                        `).join('')}
                    </div>
                ` : `
                    <div class="no-inventory">
                        <p>No inventory currently available at any location.</p>
                    </div>
                `}
            </div>

            ${type.parts.length > 0 ? `
                <div class="detail-section">
                    <h3>Included Parts</h3>
                    <ul class="parts-list">
                        ${type.parts.map(p => `
                            <li>
                                <span class="part-name">
                                    ${escapeHtml(p.name)}
                                    ${p.required ? '<span class="part-required">Required</span>' : ''}
                                </span>
                                <span class="part-info">Qty: ${p.quantity}</span>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            ` : ''}
        `;

        // Add click handlers for per-location request buttons
        modalBody.querySelectorAll('.request-from-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const locationId = parseInt((btn as HTMLElement).dataset.locationId ?? '0');
                if (locationId) {
                    openRequestWizard(typeId, locationId);
                }
            });
        });

        // Update main request button state (hide if no availability)
        const totalAvailable = availability.reduce((sum, a) => sum + a.available_items, 0);
        modalRequestBtn.disabled = totalAvailable === 0;
        modalRequestBtn.dataset.typeId = String(typeId);
        // Hide the main request button since we have per-location buttons
        modalRequestBtn.style.display = availability.length > 0 ? 'none' : 'inline-block';

        detailModal.classList.add('active');
    } catch (error) {
        console.error('Failed to load equipment details:', error);
        alert('Failed to load equipment details');
    }
}

function closeModal(): void {
    detailModal.classList.remove('active');
}

// ============================================================
// Utility Functions
// ============================================================

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateBackendStatus(connected: boolean, message?: string): void {
    backendStatus.classList.remove('connected', 'error');
    const statusText = backendStatus.querySelector('.status-text') as HTMLSpanElement;

    if (connected) {
        backendStatus.classList.add('connected');
        statusText.textContent = message ?? 'Connected';
    } else {
        backendStatus.classList.add('error');
        statusText.textContent = message ?? 'Disconnected';
    }
}

// ============================================================
// Navigation Functions
// ============================================================

function switchView(view: 'catalog' | 'my-requests' | 'transfers' | 'inventory' | 'approvals'): void {
    currentView = view;

    // Update tab states
    navTabs.forEach(tab => {
        const tabView = (tab as HTMLElement).dataset.view;
        tab.classList.toggle('active', tabView === view);
    });

    // Update view panels
    catalogView.classList.toggle('active', view === 'catalog');
    myRequestsView.classList.toggle('active', view === 'my-requests');
    transfersView.classList.toggle('active', view === 'transfers');
    inventoryView.classList.toggle('active', view === 'inventory');
    approvalsView.classList.toggle('active', view === 'approvals');

    // Load data for the view
    if (view === 'my-requests') {
        loadMyRequests();
    } else if (view === 'approvals') {
        loadApprovals();
    }
    // TODO: Add loaders for 'transfers' and 'inventory' when implemented
}

// ============================================================
// My Requests Functions
// ============================================================

async function loadMyRequests(): Promise<void> {
    requestsLoadingState.style.display = 'flex';
    requestsEmptyState.style.display = 'none';
    requestList.innerHTML = '';
    requestList.appendChild(requestsLoadingState);

    try {
        myRequests = await fetchMyRequests();
        requestsLoadingState.style.display = 'none';
        renderMyRequests();
    } catch (error) {
        console.error('Failed to load requests:', error);
        requestsLoadingState.style.display = 'none';
        requestsEmptyState.style.display = 'flex';
    }
}

function renderMyRequests(): void {
    // Filter requests
    let filtered = myRequests;

    if (requestFilter) {
        const search = requestFilter.toLowerCase();
        filtered = filtered.filter(req => {
            const sourceName = req.source_location?.name?.toLowerCase() ?? '';
            const items = req.lines.map(l => l.equipment_type?.name?.toLowerCase() ?? '').join(' ');
            return sourceName.includes(search) ||
                   items.includes(search) ||
                   String(req.id).includes(search);
        });
    }

    if (requestStatusFilter) {
        filtered = filtered.filter(req => req.status === requestStatusFilter);
    }

    // Clear and render
    requestList.innerHTML = '';

    if (filtered.length === 0) {
        requestsEmptyState.style.display = 'flex';
        return;
    }

    requestsEmptyState.style.display = 'none';

    for (const req of filtered) {
        requestList.appendChild(renderRequestCard(req));
    }
}

function renderRequestCard(req: RequestDetail): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'request-card';
    card.dataset.requestId = String(req.id);

    const statusClass = req.status.toLowerCase();
    const submittedDate = new Date(req.submitted_at).toLocaleDateString();
    const itemCount = req.lines.reduce((sum, l) => sum + l.quantity, 0);
    const itemNames = req.lines
        .map(l => l.equipment_type?.name ?? `Type #${l.equipment_type_id}`)
        .slice(0, 2)
        .join(', ');
    const moreItems = req.lines.length > 2 ? ` +${req.lines.length - 2} more` : '';

    card.innerHTML = `
        <div class="request-card-header">
            <div class="request-card-left">
                <span class="request-id">Request #${req.id}</span>
                <span class="request-date">${submittedDate}</span>
                <div class="request-summary">
                    <span class="request-summary-item">${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
                    <span class="request-summary-item">${escapeHtml(itemNames)}${moreItems}</span>
                </div>
            </div>
            <div class="request-card-right">
                <span class="status-badge ${statusClass}">${escapeHtml(req.status)}</span>
                <span class="expand-icon">&#9660;</span>
            </div>
        </div>
        <div class="request-card-body">
            <div class="request-info-grid">
                <div class="request-info-item">
                    <span class="request-info-label">Source</span>
                    <span class="request-info-value">${escapeHtml(req.source_location?.name ?? 'Unknown')}</span>
                </div>
                <div class="request-info-item">
                    <span class="request-info-label">Destination</span>
                    <span class="request-info-value">${escapeHtml(req.requesting_location?.name ?? 'Unknown')}</span>
                </div>
                <div class="request-info-item">
                    <span class="request-info-label">Need By</span>
                    <span class="request-info-value">${req.needed_from_date}</span>
                </div>
                <div class="request-info-item">
                    <span class="request-info-label">Return By</span>
                    <span class="request-info-value">${req.needed_until_date ?? 'Permanent'}</span>
                </div>
                ${req.reviewed_at ? `
                <div class="request-info-item">
                    <span class="request-info-label">Reviewed</span>
                    <span class="request-info-value">${new Date(req.reviewed_at).toLocaleDateString()}</span>
                </div>
                ` : ''}
            </div>

            <div class="request-items-section">
                <h4>Requested Items</h4>
                <div class="request-items-list">
                    ${req.lines.map(line => `
                        <div class="request-item">
                            <div>
                                <span class="request-item-name">${escapeHtml(line.equipment_type?.name ?? `Type #${line.equipment_type_id}`)}</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <span class="request-item-qty">x${line.quantity}</span>
                                <span class="request-item-status ${line.assigned_item_id ? 'assigned' : 'pending'}">
                                    ${line.assigned_item_id ? 'Assigned' : 'Pending'}
                                </span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            ${req.notes ? `
            <div class="request-notes">
                <div class="request-notes-label">Notes</div>
                <div class="request-notes-text">${escapeHtml(req.notes)}</div>
            </div>
            ` : ''}

            ${req.denial_reason ? `
            <div class="denial-reason">
                <div class="denial-reason-label">Denial Reason</div>
                <div class="denial-reason-text">${escapeHtml(req.denial_reason)}</div>
            </div>
            ` : ''}
        </div>
    `;

    // Toggle expansion on header click
    const header = card.querySelector('.request-card-header');
    header?.addEventListener('click', () => {
        card.classList.toggle('expanded');
    });

    return card;
}

// ============================================================
// Approvals Functions (Warehouse Only)
// ============================================================

async function loadApprovals(): Promise<void> {
    approvalsLoadingState.style.display = 'flex';
    approvalsEmptyState.style.display = 'none';
    approvalQueue.innerHTML = '';
    approvalQueue.appendChild(approvalsLoadingState);

    try {
        approvalRequests = await fetchMyRequests(); // Reuse - gets all requests with details
        approvalsLoadingState.style.display = 'none';
        renderApprovals();
    } catch (error) {
        console.error('Failed to load approval requests:', error);
        approvalsLoadingState.style.display = 'none';
        approvalsEmptyState.style.display = 'flex';
    }
}

function renderApprovals(): void {
    approvalQueue.innerHTML = '';

    // Filter requests
    let filtered = approvalRequests;

    // Filter by status
    if (approvalStatusFilterValue) {
        filtered = filtered.filter(r => r.status === approvalStatusFilterValue);
    }

    // Filter by search
    if (approvalFilter) {
        const search = approvalFilter.toLowerCase();
        filtered = filtered.filter(r =>
            r.requesting_location?.name?.toLowerCase().includes(search) ||
            r.source_location?.name?.toLowerCase().includes(search) ||
            r.notes?.toLowerCase().includes(search) ||
            r.lines.some(l => l.equipment_type?.name?.toLowerCase().includes(search))
        );
    }

    if (filtered.length === 0) {
        approvalsEmptyState.style.display = 'flex';
        return;
    }

    approvalsEmptyState.style.display = 'none';

    for (const req of filtered) {
        approvalQueue.appendChild(renderApprovalCard(req));
    }
}

function renderApprovalCard(req: RequestDetail): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'approval-card';
    card.dataset.requestId = String(req.id);

    const submittedDate = new Date(req.submitted_at).toLocaleDateString();
    const itemCount = req.lines.reduce((sum, l) => sum + l.quantity, 0);

    // Check stock levels for each line item
    let hasStockWarning = false;
    const lineStockInfo: Array<{ line: typeof req.lines[0], available: number, isLow: boolean, isInsufficient: boolean }> = [];

    for (const line of req.lines) {
        const availability = availabilityByType.get(line.equipment_type_id) ?? [];
        const sourceAvail = availability.find(a => a.location_id === req.source_location_id);
        const availableCount = sourceAvail?.available_items ?? 0;
        const isInsufficient = availableCount < line.quantity;
        const isLow = availableCount <= line.quantity && availableCount > 0;

        if (isInsufficient || isLow) {
            hasStockWarning = true;
        }

        lineStockInfo.push({ line, available: availableCount, isLow, isInsufficient });
    }

    if (hasStockWarning) {
        card.classList.add('has-warning');
    }

    const isPending = req.status === 'Submitted';

    card.innerHTML = `
        <div class="approval-card-header">
            <div class="approval-card-left">
                <div class="approval-card-title">
                    <span class="approval-request-id">Request #${req.id}</span>
                    <span class="approval-date">${submittedDate}</span>
                    <span class="status-badge ${req.status.toLowerCase()}">${escapeHtml(req.status)}</span>
                </div>
                <div class="approval-route">
                    <span>${escapeHtml(req.source_location?.name ?? 'Unknown')}</span>
                    <span class="arrow">→</span>
                    <span>${escapeHtml(req.requesting_location?.name ?? 'Unknown')}</span>
                </div>
            </div>
            <div class="approval-card-right">
                <span class="approval-item-count">${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
                ${hasStockWarning ? `
                    <div class="stock-warning">
                        <span class="stock-warning-icon">⚠️</span>
                        <span>Stock concern</span>
                    </div>
                ` : ''}
            </div>
        </div>
        <div class="approval-card-body">
            <table class="approval-items-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th class="qty-cell">Qty</th>
                        <th class="stock-cell">Available</th>
                    </tr>
                </thead>
                <tbody>
                    ${lineStockInfo.map(({ line, available, isLow, isInsufficient }) => `
                        <tr>
                            <td>${escapeHtml(line.equipment_type?.name ?? `Type #${line.equipment_type_id}`)}</td>
                            <td class="qty-cell">${line.quantity}</td>
                            <td class="stock-cell ${isInsufficient ? 'stock-insufficient' : isLow ? 'stock-low' : 'stock-ok'}">
                                ${available}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            ${req.notes ? `
                <div class="approval-notes">
                    <div class="approval-notes-label">Notes</div>
                    <div class="approval-notes-text">${escapeHtml(req.notes)}</div>
                </div>
            ` : ''}

            ${req.denial_reason ? `
                <div class="denial-reason">
                    <div class="denial-reason-label">Denial Reason</div>
                    <div class="denial-reason-text">${escapeHtml(req.denial_reason)}</div>
                </div>
            ` : ''}

            ${isPending ? `
                <div class="approval-actions">
                    <button class="btn btn-deny deny-btn" data-request-id="${req.id}">Deny</button>
                    <button class="btn btn-approve approve-btn" data-request-id="${req.id}">Approve</button>
                </div>
            ` : ''}
        </div>
    `;

    // Toggle expansion on header click
    const header = card.querySelector('.approval-card-header');
    header?.addEventListener('click', () => {
        card.classList.toggle('expanded');
    });

    // Approve button handler
    const approveBtn = card.querySelector('.approve-btn');
    approveBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await handleApprove(req.id);
    });

    // Deny button handler
    const denyBtn = card.querySelector('.deny-btn');
    denyBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openDenialModal(req.id);
    });

    return card;
}

async function handleApprove(requestId: number): Promise<void> {
    try {
        await approveRequest(requestId);
        await loadApprovals(); // Reload the list
    } catch (error) {
        console.error('Failed to approve request:', error);
        alert(`Failed to approve: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

function openDenialModal(requestId: number): void {
    pendingDenialRequestId = requestId;
    denialReasonInput.value = '';
    denialModal.classList.add('active');
    denialReasonInput.focus();
}

function closeDenialModal(): void {
    denialModal.classList.remove('active');
    pendingDenialRequestId = null;
    denialReasonInput.value = '';
}

async function handleDenyConfirm(): Promise<void> {
    if (!pendingDenialRequestId) return;

    const reason = denialReasonInput.value.trim();
    if (!reason) {
        alert('Please provide a reason for denial.');
        return;
    }

    try {
        await denyRequest(pendingDenialRequestId, reason);
        closeDenialModal();
        await loadApprovals(); // Reload the list
    } catch (error) {
        console.error('Failed to deny request:', error);
        alert(`Failed to deny: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// ============================================================
// Request Wizard Functions
// ============================================================

function resetWizard(): void {
    wizardStep = 1;
    wizardItems = [];
    primaryTypeId = null;
    sourceLocationSelect.value = '';
    needByDateInput.value = '';
    returnByDateInput.value = '';
    permanentTransferCheckbox.checked = false;
    returnDateGroup.style.display = 'block';
    requestNotesTextarea.value = '';
    additionalItemsDiv.innerHTML = '';
    updateWizardStep();
}

async function openRequestWizard(typeId: number, preselectedSourceId?: number): Promise<void> {
    resetWizard();
    primaryTypeId = typeId;

    // Ensure locations are loaded
    if (locations.length === 0) {
        try {
            locations = await fetchLocations();
        } catch (error) {
            console.error('Failed to load locations:', error);
            alert('Failed to load locations');
            return;
        }
    }

    // Populate source location dropdown
    sourceLocationSelect.innerHTML = '<option value="">Select warehouse/location...</option>';
    for (const loc of locations) {
        const option = document.createElement('option');
        option.value = String(loc.id);
        option.textContent = `${loc.name} (${loc.branch_id})`;
        sourceLocationSelect.appendChild(option);
    }

    // Pre-select source location if provided
    if (preselectedSourceId) {
        sourceLocationSelect.value = String(preselectedSourceId);
    }

    // Set default need-by date to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    needByDateInput.value = tomorrow.toISOString().split('T')[0];
    needByDateInput.min = new Date().toISOString().split('T')[0];
    returnByDateInput.min = needByDateInput.value;

    // Load primary equipment type with parts
    try {
        const type = await fetchEquipmentTypeWithParts(typeId);
        const item: WizardItem = {
            typeId,
            type,
            quantity: 1,
            includeParts: true,
            selectedPartIds: new Set(type.parts.filter(p => p.required).map(p => p.id)),
        };
        wizardItems = [item];
    } catch (error) {
        console.error('Failed to load equipment type:', error);
        alert('Failed to load equipment details');
        return;
    }

    // Close detail modal if open and show wizard
    closeModal();
    requestWizard.classList.add('active');
    updateWizardStep();
}

function closeWizard(): void {
    requestWizard.classList.remove('active');
    resetWizard();
}

function updateWizardStep(): void {
    // Update step indicators
    document.querySelectorAll('.wizard-step').forEach((el, idx) => {
        el.classList.remove('active', 'completed');
        if (idx + 1 < wizardStep) el.classList.add('completed');
        if (idx + 1 === wizardStep) el.classList.add('active');
    });

    // Update panels
    document.querySelectorAll('.wizard-panel').forEach((el, idx) => {
        el.classList.toggle('active', idx + 1 === wizardStep);
    });

    // Update buttons
    wizardBackBtn.style.display = wizardStep > 1 ? 'inline-block' : 'none';
    wizardNextBtn.textContent = wizardStep === 3 ? 'Submit Request' : 'Next';

    // Render step-specific content
    if (wizardStep === 2) {
        renderStep2();
    } else if (wizardStep === 3) {
        renderStep3();
    }
}

function renderStep2(): void {
    const primary = wizardItems[0];
    if (!primary) return;

    const icon = getCategoryIcon(primary.type.category);

    selectedEquipmentDiv.innerHTML = `
        <div class="selected-equipment-item">
            <div class="selected-equipment-icon">${icon}</div>
            <div class="selected-equipment-info">
                <div class="selected-equipment-name">${escapeHtml(primary.type.name)}</div>
                <div class="selected-equipment-category">${escapeHtml(primary.type.category ?? 'Uncategorized')}</div>
            </div>
            <div class="selected-equipment-qty">
                <label>Qty:</label>
                <input type="number" class="qty-input" id="primaryQty" value="${primary.quantity}" min="1" max="99" />
            </div>
        </div>
    `;

    // Quantity change handler
    const qtyInput = document.getElementById('primaryQty') as HTMLInputElement;
    qtyInput?.addEventListener('change', () => {
        primary.quantity = Math.max(1, parseInt(qtyInput.value) || 1);
    });

    // Render parts checklist
    if (primary.type.parts.length > 0) {
        partsSection.style.display = 'block';
        partsChecklist.innerHTML = primary.type.parts.map(part => `
            <div class="part-checkbox-item ${part.required ? 'required' : ''}">
                <input type="checkbox"
                       id="part_${part.id}"
                       ${part.required ? 'checked disabled' : (primary.selectedPartIds.has(part.id) ? 'checked' : '')}
                       data-part-id="${part.id}" />
                <div class="part-checkbox-label">
                    <span class="part-name">${escapeHtml(part.name)}</span>
                    <span class="part-qty">(x${part.quantity})</span>
                </div>
                ${part.required ? '<span class="part-required-badge">Required</span>' : ''}
            </div>
        `).join('');

        // Part checkbox handlers
        partsChecklist.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                const partId = parseInt(target.dataset.partId || '0');
                if (target.checked) {
                    primary.selectedPartIds.add(partId);
                } else {
                    primary.selectedPartIds.delete(partId);
                }
            });
        });
    } else {
        partsSection.style.display = 'none';
    }

    // Render additional items
    renderAdditionalItems();
}

function renderAdditionalItems(): void {
    const additional = wizardItems.slice(1);
    if (additional.length === 0) {
        additionalItemsDiv.innerHTML = '';
        return;
    }

    additionalItemsDiv.innerHTML = additional.map((item, idx) => `
        <div class="additional-item" data-index="${idx + 1}">
            <div class="additional-item-info">
                <div class="additional-item-name">${escapeHtml(item.type.name)}</div>
                <div class="additional-item-category">${escapeHtml(item.type.category ?? 'Uncategorized')}</div>
            </div>
            <input type="number" class="qty-input additional-qty" value="${item.quantity}" min="1" max="99" data-index="${idx + 1}" />
            <button class="remove-item-btn" data-index="${idx + 1}">&times;</button>
        </div>
    `).join('');

    // Quantity handlers
    additionalItemsDiv.querySelectorAll('.additional-qty').forEach(input => {
        input.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            const index = parseInt(target.dataset.index || '0');
            if (wizardItems[index]) {
                wizardItems[index].quantity = Math.max(1, parseInt(target.value) || 1);
            }
        });
    });

    // Remove handlers
    additionalItemsDiv.querySelectorAll('.remove-item-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.target as HTMLButtonElement;
            const index = parseInt(target.dataset.index || '0');
            wizardItems.splice(index, 1);
            renderAdditionalItems();
        });
    });
}

function renderStep3(): void {
    const sourceId = parseInt(sourceLocationSelect.value);
    const source = locations.find(l => l.id === sourceId);

    document.getElementById('reviewSource')!.textContent = source?.name ?? '-';
    document.getElementById('reviewNeedBy')!.textContent = needByDateInput.value || '-';
    document.getElementById('reviewReturnBy')!.textContent =
        permanentTransferCheckbox.checked ? 'Permanent Transfer' : (returnByDateInput.value || '-');

    const reviewItems = document.getElementById('reviewItems')!;
    reviewItems.innerHTML = wizardItems.map(item => {
        const partNames = item.type.parts
            .filter(p => item.selectedPartIds.has(p.id))
            .map(p => p.name)
            .join(', ');

        return `
            <div class="review-item">
                <div>
                    <div class="review-item-name">${escapeHtml(item.type.name)}</div>
                    ${partNames ? `<div class="review-item-parts">+ ${escapeHtml(partNames)}</div>` : ''}
                </div>
                <span class="review-item-qty">x${item.quantity}</span>
            </div>
        `;
    }).join('');
}

function validateStep1(): boolean {
    if (!sourceLocationSelect.value) {
        alert('Please select a source location');
        sourceLocationSelect.focus();
        return false;
    }
    if (!needByDateInput.value) {
        alert('Please select a need-by date');
        needByDateInput.focus();
        return false;
    }
    if (!permanentTransferCheckbox.checked && !returnByDateInput.value) {
        alert('Please select a return date or mark as permanent transfer');
        returnByDateInput.focus();
        return false;
    }
    if (!permanentTransferCheckbox.checked && returnByDateInput.value < needByDateInput.value) {
        alert('Return date must be after need-by date');
        returnByDateInput.focus();
        return false;
    }
    return true;
}

function validateStep2(): boolean {
    if (wizardItems.length === 0) {
        alert('Please select at least one equipment item');
        return false;
    }
    return true;
}

async function submitRequest(): Promise<void> {
    // Get requesting location (user's branch) - for now use first non-warehouse location
    const requestingLocation = locations.find(l => !l.is_warehouse) || locations[0];
    if (!requestingLocation) {
        alert('No requesting location available');
        return;
    }

    const request: RequestCreate = {
        requesting_location_id: requestingLocation.id,
        source_location_id: parseInt(sourceLocationSelect.value),
        needed_from_date: needByDateInput.value,
        needed_until_date: permanentTransferCheckbox.checked ? null : returnByDateInput.value,
        notes: requestNotesTextarea.value.trim() || null,
        lines: wizardItems.map(item => ({
            equipment_type_id: item.typeId,
            quantity: item.quantity,
            include_parts: item.selectedPartIds.size > 0,
        })),
    };

    wizardNextBtn.disabled = true;
    wizardNextBtn.textContent = 'Submitting...';

    try {
        await createRequest(request);
        closeWizard();
        alert('Request submitted successfully!');
    } catch (error) {
        console.error('Failed to submit request:', error);
        alert(`Failed to submit request: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
        wizardNextBtn.disabled = false;
        wizardNextBtn.textContent = 'Submit Request';
    }
}

function nextWizardStep(): void {
    if (wizardStep === 1 && !validateStep1()) return;
    if (wizardStep === 2 && !validateStep2()) return;

    if (wizardStep === 3) {
        submitRequest();
        return;
    }

    wizardStep++;
    updateWizardStep();
}

function prevWizardStep(): void {
    if (wizardStep > 1) {
        wizardStep--;
        updateWizardStep();
    }
}

function openItemPicker(): void {
    itemPickerSearch.value = '';
    renderItemPicker();
    itemPickerModal.classList.add('active');
}

function closeItemPicker(): void {
    itemPickerModal.classList.remove('active');
}

function renderItemPicker(filter = ''): void {
    const search = filter.toLowerCase();
    const existingIds = new Set(wizardItems.map(i => i.typeId));

    const filtered = equipmentTypes.filter(t => {
        if (existingIds.has(t.id)) return false;
        if (!search) return true;
        return t.name.toLowerCase().includes(search) ||
               t.category?.toLowerCase().includes(search);
    });

    itemPickerGrid.innerHTML = filtered.map(type => {
        const avail = availabilityByType.get(type.id);
        const totalAvailable = avail?.reduce((sum, a) => sum + a.available_items, 0) ?? 0;
        const icon = getCategoryIcon(type.category);

        return `
            <div class="item-picker-card" data-type-id="${type.id}">
                <div class="item-picker-icon">${icon}</div>
                <div class="item-picker-name">${escapeHtml(type.name)}</div>
                <div class="item-picker-category">${escapeHtml(type.category ?? 'Uncategorized')}</div>
                <div class="item-picker-availability">${totalAvailable} available</div>
            </div>
        `;
    }).join('');

    // Click handlers
    itemPickerGrid.querySelectorAll('.item-picker-card').forEach(card => {
        card.addEventListener('click', async () => {
            const typeId = parseInt((card as HTMLElement).dataset.typeId || '0');
            try {
                const type = await fetchEquipmentTypeWithParts(typeId);
                wizardItems.push({
                    typeId,
                    type,
                    quantity: 1,
                    includeParts: true,
                    selectedPartIds: new Set(type.parts.filter(p => p.required).map(p => p.id)),
                });
                closeItemPicker();
                renderAdditionalItems();
            } catch (error) {
                console.error('Failed to add item:', error);
                alert('Failed to add item');
            }
        });
    });
}

// ============================================================
// Initialization
// ============================================================

async function loadData(): Promise<void> {
    loadingState.style.display = 'flex';
    emptyState.style.display = 'none';

    try {
        // Fetch equipment types
        equipmentTypes = await fetchEquipmentTypes();
        populateCategoryFilter();

        // Fetch availability for all types in parallel
        const availabilityPromises = equipmentTypes.map(async (type) => {
            try {
                const avail = await fetchAvailability(type.id);
                availabilityByType.set(type.id, avail);
            } catch (error) {
                console.warn(`Failed to fetch availability for type ${type.id}:`, error);
                availabilityByType.set(type.id, []);
            }
        });

        await Promise.all(availabilityPromises);

        loadingState.style.display = 'none';
        renderCatalog();
        updateBackendStatus(true);
    } catch (error) {
        console.error('Failed to load equipment data:', error);
        loadingState.style.display = 'none';
        emptyState.style.display = 'flex';
        updateBackendStatus(false, 'Failed to load');
    }
}

async function init(): Promise<void> {
    // Set up event listeners
    searchInput.addEventListener('input', () => {
        currentFilter = searchInput.value.trim();
        renderCatalog();
    });

    categoryFilter.addEventListener('change', () => {
        currentCategory = categoryFilter.value;
        renderCatalog();
    });

    modalClose.addEventListener('click', closeModal);
    modalCancelBtn.addEventListener('click', closeModal);
    detailModal.addEventListener('click', (e) => {
        if (e.target === detailModal) closeModal();
    });

    modalRequestBtn.addEventListener('click', () => {
        const typeId = parseInt(modalRequestBtn.dataset.typeId || '0');
        if (typeId) {
            openRequestWizard(typeId);
        }
    });

    // Wizard event listeners
    wizardClose.addEventListener('click', closeWizard);
    wizardCancelBtn.addEventListener('click', closeWizard);
    wizardBackBtn.addEventListener('click', prevWizardStep);
    wizardNextBtn.addEventListener('click', nextWizardStep);
    requestWizard.addEventListener('click', (e) => {
        if (e.target === requestWizard) closeWizard();
    });

    permanentTransferCheckbox.addEventListener('change', () => {
        returnDateGroup.style.display = permanentTransferCheckbox.checked ? 'none' : 'block';
    });

    needByDateInput.addEventListener('change', () => {
        returnByDateInput.min = needByDateInput.value;
        if (returnByDateInput.value && returnByDateInput.value < needByDateInput.value) {
            returnByDateInput.value = needByDateInput.value;
        }
    });

    addMoreItemsBtn.addEventListener('click', openItemPicker);

    // Item picker event listeners
    itemPickerClose.addEventListener('click', closeItemPicker);
    itemPickerModal.addEventListener('click', (e) => {
        if (e.target === itemPickerModal) closeItemPicker();
    });
    itemPickerSearch.addEventListener('input', () => {
        renderItemPicker(itemPickerSearch.value);
    });

    // Navigation tabs
    navTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const view = (tab as HTMLElement).dataset.view as 'catalog' | 'my-requests' | 'transfers' | 'inventory' | 'approvals';
            if (view) {
                switchView(view);
            }
        });
    });

    // My Requests filters
    requestSearchInput.addEventListener('input', () => {
        requestFilter = requestSearchInput.value.trim();
        renderMyRequests();
    });

    requestStatusFilterSelect.addEventListener('change', () => {
        requestStatusFilter = requestStatusFilterSelect.value;
        renderMyRequests();
    });

    newRequestFromEmpty.addEventListener('click', () => {
        switchView('catalog');
    });

    // Branch setup event listeners
    branchIdInput.addEventListener('input', handleBranchInput);
    branchSubmitBtn.addEventListener('click', handleBranchSubmit);
    branchIdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !branchSubmitBtn.disabled) {
            handleBranchSubmit();
        }
    });

    // Approval filters (warehouse only)
    approvalSearchInput.addEventListener('input', () => {
        approvalFilter = approvalSearchInput.value.trim();
        renderApprovals();
    });

    approvalStatusFilter.addEventListener('change', () => {
        approvalStatusFilterValue = approvalStatusFilter.value;
        renderApprovals();
    });

    // Denial modal event listeners
    denialModalClose.addEventListener('click', closeDenialModal);
    denialCancelBtn.addEventListener('click', closeDenialModal);
    denialConfirmBtn.addEventListener('click', handleDenyConfirm);
    denialModal.addEventListener('click', (e) => {
        if (e.target === denialModal) closeDenialModal();
    });

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (denialModal.classList.contains('active')) {
                closeDenialModal();
            } else if (itemPickerModal.classList.contains('active')) {
                closeItemPicker();
            } else if (requestWizard.classList.contains('active')) {
                closeWizard();
            } else if (detailModal.classList.contains('active')) {
                closeModal();
            }
        }
    });

    // Wait for backend and load data
    try {
        updateBackendStatus(false, 'Connecting...');
        await api.waitForBackend(8090);

        // Check for saved branch config
        currentBranch = loadSavedBranch();
        if (currentBranch) {
            // Branch already configured - hide setup and load data
            hideBranchSetup();
            updateUIForBranch();
            await loadData();
        } else {
            // First launch - show branch setup
            showBranchSetup();
            // Still load data in background so catalog is ready
            await loadData();
        }
    } catch (error) {
        console.error('Backend connection failed:', error);
        updateBackendStatus(false, 'Backend unavailable');
    }
}

// Start the app
init();

})(); // End IIFE
