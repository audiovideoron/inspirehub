/**
 * Injects build-time configuration into dist/config.json
 * Run during CI build to bake secrets into the packaged app
 */
const fs = require('fs');
const path = require('path');

const config = {
    BUGSPRAY_GITHUB_PAT: process.env.BUGSPRAY_GITHUB_PAT || ''
};

const distDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const configPath = path.join(distDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

console.log(`Config written to ${configPath}`);
console.log(`BUGSPRAY_GITHUB_PAT: ${config.BUGSPRAY_GITHUB_PAT ? '[SET]' : '[NOT SET]'}`);
