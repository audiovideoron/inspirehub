/**
 * Copy static assets (HTML, CSS) from source to dist
 * Run after TypeScript compilation
 */

const fs = require('fs');
const path = require('path');

// Asset configurations: [sourceDir, destDir, files[]]
const assets = [
    // Shell (includes Bug Spray modal - shared component)
    ['src/shell', 'dist/shell', ['index.html', 'shell.css', 'bug-report-modal.css']],
    // Price List app
    ['src/apps/price-list', 'dist/apps/price-list', ['index.html', 'editor.css']],
    // Equipment app
    ['src/apps/equipment', 'dist/apps/equipment', ['index.html', 'equipment.css']],
    // Bug Spray app
    ['src/apps/bugspray', 'dist/apps/bugspray', ['index.html', 'bugspray.css']]
];

for (const [srcDir, destDir, files] of assets) {
    // Skip if source directory doesn't exist
    if (!fs.existsSync(srcDir)) {
        console.log(`Skipping ${srcDir} (not found)`);
        continue;
    }

    // Create destination directory
    fs.mkdirSync(destDir, { recursive: true });

    // Copy each file
    for (const file of files) {
        const srcPath = path.join(srcDir, file);
        const destPath = path.join(destDir, file);

        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
            console.log(`Copied ${srcPath} -> ${destPath}`);
        } else {
            console.log(`Skipping ${srcPath} (not found)`);
        }
    }
}

console.log('Asset copy complete');
