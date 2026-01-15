/**
 * Configuration Manager
 * Handles persistent app configuration including branch_id
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

interface AppConfig {
    branch_id?: string;
    // Add more config options as needed
}

const CONFIG_FILENAME = 'config.json';

let configPath: string;
let config: AppConfig = {};

/**
 * Initialize config manager - must be called after app.whenReady()
 */
export function initConfig(): void {
    configPath = path.join(app.getPath('userData'), CONFIG_FILENAME);
    loadConfig();
}

/**
 * Load configuration from disk
 */
function loadConfig(): void {
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            config = JSON.parse(data);
            console.log('Config loaded:', { branch_id: config.branch_id ? '***' : 'not set' });
        } else {
            console.log('No config file found, using defaults');
            config = {};
        }
    } catch (error) {
        console.error('Error loading config:', error);
        config = {};
    }
}

/**
 * Save configuration to disk
 */
function saveConfig(): void {
    try {
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        console.log('Config saved');
    } catch (error) {
        console.error('Error saving config:', error);
    }
}

/**
 * Get the branch ID
 */
export function getBranchId(): string | null {
    return config.branch_id || null;
}

/**
 * Set the branch ID
 */
export function setBranchId(branchId: string): void {
    // Validate branch ID - alphanumeric with spaces, dashes, and underscores
    const sanitized = branchId.trim();
    if (!sanitized || sanitized.length > 100) {
        throw new Error('Branch ID must be 1-100 characters');
    }
    if (!/^[\w\s\-]+$/.test(sanitized)) {
        throw new Error('Branch ID can only contain letters, numbers, spaces, dashes, and underscores');
    }
    config.branch_id = sanitized;
    saveConfig();
}

/**
 * Check if this is the first run (no branch_id configured)
 */
export function isFirstRun(): boolean {
    return !config.branch_id;
}
