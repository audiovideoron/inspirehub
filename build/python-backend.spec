# -*- mode: python ; coding: utf-8 -*-
import os

# Get the directory containing this spec file, then go up to project root
SPEC_DIR = os.path.dirname(os.path.abspath(SPECPATH))
PROJECT_ROOT = os.path.dirname(SPEC_DIR)

a = Analysis(
    [os.path.join(PROJECT_ROOT, 'python', 'backend.py')],
    pathex=[],
    binaries=[],
    datas=[
        (os.path.join(PROJECT_ROOT, 'python', 'extract_prices.py'), '.'),
        (os.path.join(PROJECT_ROOT, 'python', 'update_pdf.py'), '.')
    ],
    hiddenimports=['fitz', 'pymupdf'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='python-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='python-backend',
)
