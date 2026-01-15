const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const pythonDir = path.join(projectRoot, 'python', 'price_list');
const distDir = path.join(projectRoot, 'dist', 'python-backend');

console.log('Building Python backend with PyInstaller...');

// Ensure dist directory exists
if (!fs.existsSync(path.join(projectRoot, 'dist'))) {
    fs.mkdirSync(path.join(projectRoot, 'dist'));
}

const isWin = process.platform === 'win32';

// Install PyInstaller using uv
console.log('Ensuring PyInstaller is installed...');
try {
    execSync('uv pip install pyinstaller', {
        stdio: 'inherit',
        cwd: projectRoot
    });
} catch (error) {
    console.error('Failed to install PyInstaller:', error.message);
    process.exit(1);
}

// Get pyinstaller path from venv
const venvBin = isWin
    ? path.join(projectRoot, '.venv', 'Scripts')
    : path.join(projectRoot, '.venv', 'bin');
const pyinstaller = path.join(venvBin, isWin ? 'pyinstaller.exe' : 'pyinstaller');

// Build the Python backend
const backendScript = path.join(pythonDir, 'backend.py');

// PyInstaller arguments as array - properly handles paths with spaces
const pyinstallerArgs = [
    '--onedir',
    '--name', 'python-backend',
    '--distpath', path.join(projectRoot, 'dist'),
    '--workpath', path.join(projectRoot, 'build'),
    '--specpath', path.join(projectRoot, 'build'),
    '--clean',
    '--noconfirm',
    // Include the other Python modules
    '--add-data', `${path.join(pythonDir, 'extract_prices.py')}${isWin ? ';' : ':' }.`,
    '--add-data', `${path.join(pythonDir, 'update_pdf.py')}${isWin ? ';' : ':' }.`,
    // Hidden imports for PyMuPDF
    '--hidden-import', 'fitz',
    '--hidden-import', 'pymupdf',
    backendScript
];

console.log('Running PyInstaller...');
console.log(`${pyinstaller} ${pyinstallerArgs.join(' ')}`);

const result = spawnSync(pyinstaller, pyinstallerArgs, {
    stdio: 'inherit',
    cwd: projectRoot
});

if (result.error) {
    console.error('Failed to run PyInstaller:', result.error.message);
    process.exit(1);
}

if (result.status !== 0) {
    console.error('PyInstaller exited with code:', result.status);
    process.exit(result.status);
}

console.log('Python backend built successfully!');
console.log(`Output: ${distDir}`);
