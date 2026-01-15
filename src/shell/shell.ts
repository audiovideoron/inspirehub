/**
 * Shell navigation controller
 * Manages switching between apps in the sidebar
 */

interface AppConfig {
    id: string;
    path: string;
}

const apps: AppConfig[] = [
    { id: 'price-list', path: '../apps/price-list/index.html' },
    { id: 'equipment', path: '../apps/equipment/index.html' }
];

let currentApp: string = 'price-list';

function initShell(): void {
    const navItems = document.querySelectorAll('.nav-item');
    const appFrame = document.getElementById('app-frame') as HTMLIFrameElement;

    if (!appFrame) {
        console.error('App frame not found');
        return;
    }

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

    // Load app in iframe
    appFrame.src = app.path;
    currentApp = appId;

    console.log(`Navigated to app: ${appId}`);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initShell);

// Empty export to make this a module
export {};
