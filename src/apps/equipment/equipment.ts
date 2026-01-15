/**
 * Equipment Request App
 * Handles equipment browsing, availability checking, and reservation management
 */

// Type definitions
interface Equipment {
    id: number;
    name: string;
    category: string | null;
    total_count: number;
    description: string | null;
    image_url: string | null;
    created_at: string;
    updated_at: string;
}

interface Reservation {
    id: number;
    equipment_id: number;
    quantity: number;
    start_date: string;
    end_date: string;
    customer_name: string;
    location: string | null;
    status: 'pending' | 'approved' | 'denied';
    created_at: string;
    created_by: string | null;
    approved_by: string | null;
    approved_at: string | null;
    notes: string | null;
}

interface EquipmentAvailability {
    equipment_id: number;
    name: string;
    total_count: number;
    reserved_count: number;
    available_count: number;
    start_date: string;
    end_date: string;
}

// State
let apiBaseUrl: string = '';
let equipment: Equipment[] = [];
let reservations: Reservation[] = [];
let selectedEquipment: Equipment | null = null;
let categories: string[] = [];

// DOM Elements
let backendStatusEl: HTMLElement;
let equipmentGrid: HTMLElement;
let requestsList: HTMLElement;
let requestModal: HTMLElement;
let searchInput: HTMLInputElement;
let categoryFilter: HTMLSelectElement;
let statusFilter: HTMLSelectElement;
let requestForm: HTMLFormElement;

// Initialize app
async function initApp(): Promise<void> {
    // Get DOM elements
    backendStatusEl = document.getElementById('backendStatus')!;
    equipmentGrid = document.getElementById('equipmentGrid')!;
    requestsList = document.getElementById('requestsList')!;
    requestModal = document.getElementById('requestModal')!;
    searchInput = document.getElementById('searchInput') as HTMLInputElement;
    categoryFilter = document.getElementById('categoryFilter') as HTMLSelectElement;
    statusFilter = document.getElementById('statusFilter') as HTMLSelectElement;
    requestForm = document.getElementById('requestForm') as HTMLFormElement;

    // Set up event listeners
    setupEventListeners();

    // Connect to backend
    await connectToBackend();
}

function setupEventListeners(): void {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.getAttribute('data-tab');
            switchTab(tabId!);
        });
    });

    // Search and filters
    searchInput.addEventListener('input', filterEquipment);
    categoryFilter.addEventListener('change', filterEquipment);
    statusFilter.addEventListener('change', filterRequests);

    // Modal controls
    document.getElementById('modalClose')!.addEventListener('click', closeModal);
    document.getElementById('cancelBtn')!.addEventListener('click', closeModal);
    requestModal.addEventListener('click', (e) => {
        if (e.target === requestModal) closeModal();
    });

    // Form submission
    requestForm.addEventListener('submit', handleSubmitRequest);

    // Date changes trigger availability check
    document.getElementById('startDate')!.addEventListener('change', checkAvailability);
    document.getElementById('endDate')!.addEventListener('change', checkAvailability);
}

function switchTab(tabId: string): void {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.getAttribute('data-tab') === tabId);
    });

    // Update content visibility
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `${tabId}-view`);
    });

    // Refresh data when switching tabs
    if (tabId === 'catalog') {
        loadEquipment();
    } else if (tabId === 'requests') {
        loadReservations();
    }
}

async function connectToBackend(): Promise<void> {
    updateBackendStatus('connecting', 'Connecting...');

    try {
        const port = await window.api.getEquipmentPort();
        if (!port) {
            throw new Error('Equipment backend not available');
        }

        apiBaseUrl = `http://localhost:${port}`;

        // Test connection with health check
        const response = await fetch(`${apiBaseUrl}/api/health`);
        if (!response.ok) {
            throw new Error('Health check failed');
        }

        updateBackendStatus('connected', 'Connected');

        // Load initial data
        await loadEquipment();

    } catch (error) {
        console.error('Failed to connect to backend:', error);
        updateBackendStatus('disconnected', 'Disconnected');
        equipmentGrid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">!</div><div>Failed to connect to equipment backend</div></div>';
    }
}

function updateBackendStatus(status: string, text: string): void {
    backendStatusEl.className = `backend-status ${status}`;
    backendStatusEl.querySelector('.status-text')!.textContent = text;
}

// Equipment functions
async function loadEquipment(): Promise<void> {
    try {
        const response = await fetch(`${apiBaseUrl}/api/equipment`);
        if (!response.ok) throw new Error('Failed to load equipment');

        equipment = await response.json();

        // Extract unique categories
        categories = [...new Set(equipment.map(e => e.category).filter(Boolean))] as string[];
        populateCategoryFilter();

        renderEquipment(equipment);

    } catch (error) {
        console.error('Error loading equipment:', error);
        equipmentGrid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">!</div><div>Failed to load equipment</div></div>';
    }
}

function populateCategoryFilter(): void {
    const currentValue = categoryFilter.value;
    categoryFilter.innerHTML = '<option value="">All Categories</option>';
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        categoryFilter.appendChild(option);
    });
    categoryFilter.value = currentValue;
}

function filterEquipment(): void {
    const searchTerm = searchInput.value.toLowerCase();
    const category = categoryFilter.value;

    const filtered = equipment.filter(item => {
        const matchesSearch = !searchTerm ||
            item.name.toLowerCase().includes(searchTerm) ||
            (item.description && item.description.toLowerCase().includes(searchTerm));
        const matchesCategory = !category || item.category === category;
        return matchesSearch && matchesCategory;
    });

    renderEquipment(filtered);
}

function renderEquipment(items: Equipment[]): void {
    if (items.length === 0) {
        equipmentGrid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><div>No equipment found</div></div>';
        return;
    }

    equipmentGrid.innerHTML = items.map(item => `
        <div class="equipment-card" data-id="${item.id}">
            <h3>${escapeHtml(item.name)}</h3>
            <div class="category">${escapeHtml(item.category || 'Uncategorized')}</div>
            ${item.description ? `<div class="description">${escapeHtml(item.description)}</div>` : ''}
            <div class="count">Available: <strong>${item.total_count}</strong></div>
            <button class="request-btn" onclick="openRequestModal(${item.id})">Request</button>
        </div>
    `).join('');
}

// Request modal functions
function openRequestModal(equipmentId: number): void {
    selectedEquipment = equipment.find(e => e.id === equipmentId) || null;
    if (!selectedEquipment) return;

    // Reset form
    requestForm.reset();
    (document.getElementById('equipmentId') as HTMLInputElement).value = String(equipmentId);
    document.getElementById('selectedEquipment')!.textContent = selectedEquipment.name;

    // Set default dates (today and tomorrow)
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    (document.getElementById('startDate') as HTMLInputElement).value = formatDate(today);
    (document.getElementById('endDate') as HTMLInputElement).value = formatDate(tomorrow);

    // Reset availability info
    document.getElementById('availabilityInfo')!.className = 'availability-info';
    document.getElementById('availabilityInfo')!.textContent = 'Select dates to check availability';

    // Show modal
    requestModal.classList.add('active');

    // Check availability for default dates
    checkAvailability();
}

function closeModal(): void {
    requestModal.classList.remove('active');
    selectedEquipment = null;
}

async function checkAvailability(): Promise<void> {
    if (!selectedEquipment) return;

    const startDate = (document.getElementById('startDate') as HTMLInputElement).value;
    const endDate = (document.getElementById('endDate') as HTMLInputElement).value;
    const availabilityInfo = document.getElementById('availabilityInfo')!;
    const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;

    if (!startDate || !endDate) {
        availabilityInfo.className = 'availability-info';
        availabilityInfo.textContent = 'Select dates to check availability';
        return;
    }

    try {
        const response = await fetch(
            `${apiBaseUrl}/api/equipment/${selectedEquipment.id}/availability?start_date=${startDate}&end_date=${endDate}`
        );

        if (!response.ok) throw new Error('Failed to check availability');

        const availability: EquipmentAvailability = await response.json();

        if (availability.available_count > 0) {
            availabilityInfo.className = 'availability-info available';
            availabilityInfo.textContent = `${availability.available_count} available (${availability.reserved_count} reserved of ${availability.total_count})`;
            submitBtn.disabled = false;
        } else {
            availabilityInfo.className = 'availability-info unavailable';
            availabilityInfo.textContent = `Not available (all ${availability.total_count} reserved)`;
            submitBtn.disabled = true;
        }

    } catch (error) {
        console.error('Error checking availability:', error);
        availabilityInfo.className = 'availability-info';
        availabilityInfo.textContent = 'Failed to check availability';
    }
}

async function handleSubmitRequest(e: Event): Promise<void> {
    e.preventDefault();

    const formData = new FormData(requestForm);
    const data = {
        equipment_id: Number(formData.get('equipment_id')),
        quantity: Number(formData.get('quantity')),
        start_date: formData.get('start_date') as string,
        end_date: formData.get('end_date') as string,
        customer_name: formData.get('customer_name') as string,
        location: formData.get('location') as string || null,
        notes: formData.get('notes') as string || null
    };

    const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
        const response = await fetch(`${apiBaseUrl}/api/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to submit request');
        }

        closeModal();

        // Show success and switch to requests tab
        alert('Request submitted successfully!');
        switchTab('requests');

    } catch (error) {
        console.error('Error submitting request:', error);
        alert(`Failed to submit request: ${error instanceof Error ? error.message : 'Unknown error'}`);

    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Request';
    }
}

// Reservations functions
async function loadReservations(): Promise<void> {
    try {
        let url = `${apiBaseUrl}/api/reservations`;
        const status = statusFilter.value;
        if (status) {
            url += `?status=${status}`;
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to load reservations');

        reservations = await response.json();
        renderReservations(reservations);

    } catch (error) {
        console.error('Error loading reservations:', error);
        requestsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">!</div><div>Failed to load requests</div></div>';
    }
}

function filterRequests(): void {
    loadReservations();
}

function renderReservations(items: Reservation[]): void {
    if (items.length === 0) {
        requestsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div>No requests found</div></div>';
        return;
    }

    requestsList.innerHTML = items.map(item => {
        const equipmentItem = equipment.find(e => e.id === item.equipment_id);
        const equipmentName = equipmentItem?.name || `Equipment #${item.equipment_id}`;

        return `
            <div class="request-item" data-id="${item.id}">
                <div class="request-item-header">
                    <div>
                        <h4>${escapeHtml(equipmentName)}</h4>
                        <div class="customer">${escapeHtml(item.customer_name)}</div>
                    </div>
                    <span class="status-badge ${item.status}">${item.status}</span>
                </div>
                <div class="request-item-details">
                    <div>
                        <div class="label">Quantity</div>
                        <div>${item.quantity}</div>
                    </div>
                    <div>
                        <div class="label">Dates</div>
                        <div>${formatDisplayDate(item.start_date)} - ${formatDisplayDate(item.end_date)}</div>
                    </div>
                    ${item.location ? `
                    <div>
                        <div class="label">Location</div>
                        <div>${escapeHtml(item.location)}</div>
                    </div>
                    ` : ''}
                    <div>
                        <div class="label">Requested</div>
                        <div>${formatDisplayDate(item.created_at)}</div>
                    </div>
                </div>
                ${item.notes ? `<div class="request-item-notes">${escapeHtml(item.notes)}</div>` : ''}
                ${item.status === 'pending' ? `
                <div class="request-item-actions">
                    <button class="btn-approve" onclick="updateReservationStatus(${item.id}, 'approved')">Approve</button>
                    <button class="btn-deny" onclick="updateReservationStatus(${item.id}, 'denied')">Deny</button>
                </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

async function updateReservationStatus(id: number, status: 'approved' | 'denied'): Promise<void> {
    try {
        const response = await fetch(`${apiBaseUrl}/api/reservations/${id}?approved_by=app_user`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to update status');
        }

        // Reload reservations
        loadReservations();

    } catch (error) {
        console.error('Error updating reservation:', error);
        alert(`Failed to ${status} request: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// Utility functions
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

function formatDisplayDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Expose functions to global scope for onclick handlers
(window as any).openRequestModal = openRequestModal;
(window as any).updateReservationStatus = updateReservationStatus;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);

// Empty export to make this a module (prevents global scope conflicts)
export {};
