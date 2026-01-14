#!/usr/bin/env node
/**
 * Development script - launches Electron with NODE_ENV=development
 * In dev mode, python-bridge.js runs Python directly instead of bundled binary
 */

const { spawn } = require('child_process');
const path = require('path');

// Set development environment
process.env.NODE_ENV = 'development';

// Path to electron
const electronPath = require.resolve('electron/cli.js');
const appPath = path.join(__dirname, '..');

console.log('Starting in development mode...');
console.log('Electron path:', electronPath);
console.log('App path:', appPath);

// Spawn electron
const electron = spawn('node', [electronPath, appPath], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' }
});

electron.on('close', (code) => {
    console.log(`Electron exited with code ${code}`);
    process.exit(code);
});

electron.on('error', (err) => {
    console.error('Failed to start Electron:', err);
    process.exit(1);
});
