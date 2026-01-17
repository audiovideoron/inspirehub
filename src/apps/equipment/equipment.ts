/**
 * Equipment Catalog - Frontend TypeScript
 * Displays equipment types with availability and handles requests
 */

declare const api: {
    fetch: (path: string, options?: RequestInit) => Promise<Response>;
    getBaseUrl: () => string;
    waitForBackend: (port: number) => Promise<boolean>;
};

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

// ============================================================
// State
// ============================================================

let equipmentTypes: EquipmentType[] = [];
let categories: string[] = [];
let availabilityByType: Map<number, AvailabilityResponse[]> = new Map();
let currentFilter = '';
let currentCategory = '';

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
        // TODO: Implement request flow (bead kzxe)
        alert('Request flow coming soon!');
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
        const availability = availabilityByType.get(typeId) ?? [];

        modalTitle.textContent = type.name;
        modalBody.innerHTML = `
            <div class="detail-section">
                <h3>Description</h3>
                <p class="detail-description">${escapeHtml(type.description ?? 'No description available.')}</p>
            </div>

            <div class="detail-section">
                <h3>Availability by Location</h3>
                <div class="availability-grid">
                    ${availability.map(a => `
                        <div class="availability-item">
                            <div class="availability-location">${escapeHtml(a.location_name ?? 'Unknown')}</div>
                            <div class="availability-count">
                                <span class="available">${a.available_items}</span> / ${a.total_items} available
                            </div>
                        </div>
                    `).join('')}
                    ${availability.length === 0 ? '<p>No availability data</p>' : ''}
                </div>
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

        // Update request button state
        const totalAvailable = availability.reduce((sum, a) => sum + a.available_items, 0);
        modalRequestBtn.disabled = totalAvailable === 0;
        modalRequestBtn.dataset.typeId = String(typeId);

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
        // TODO: Implement request flow (bead kzxe)
        alert('Request flow coming soon!');
    });

    // Escape key closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && detailModal.classList.contains('active')) {
            closeModal();
        }
    });

    // Wait for backend and load data
    try {
        updateBackendStatus(false, 'Connecting...');
        await api.waitForBackend(8090);
        await loadData();
    } catch (error) {
        console.error('Backend connection failed:', error);
        updateBackendStatus(false, 'Backend unavailable');
    }
}

// Start the app
init();
