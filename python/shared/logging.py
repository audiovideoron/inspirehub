"""
Standardized logging for InspireHub Python backends.

All backends log to /tmp/inspirehub-{module}.log with consistent format.
Bug Spray collects these logs for bug reports.

Usage:
    from shared.logging import setup_logging, get_logger

    # At startup:
    setup_logging('equipment')

    # In your code:
    logger = get_logger(__name__)
    logger.info('Server started')
    logger.error('Something failed', exc_info=True)

Log format:
    2026-01-16T20:30:00.123Z - INFO - [module] message
"""

import logging
import os
import sys
from pathlib import Path
from typing import Optional

# Log directory - use /tmp on Unix for Bug Spray compatibility
# On Windows, use temp directory
if sys.platform == 'win32':
    import tempfile
    LOG_DIR = tempfile.gettempdir()
else:
    LOG_DIR = '/tmp'

# Log format matching shell logging service format
LOG_FORMAT = '%(asctime)s - %(levelname)s - [%(name)s] %(message)s'
DATE_FORMAT = '%Y-%m-%dT%H:%M:%S'

# Track initialized modules
_initialized_modules: set[str] = set()


def get_log_path(module: str) -> str:
    """Get the log file path for a module.

    Args:
        module: Module name (e.g., 'equipment', 'price-list')

    Returns:
        Path to the log file (e.g., '/tmp/inspirehub-equipment.log')
    """
    # Sanitize module name
    safe_module = ''.join(c for c in module if c.isalnum() or c == '-')
    return os.path.join(LOG_DIR, f'inspirehub-{safe_module}.log')


def setup_logging(
    module: str,
    level: int = logging.INFO,
    also_stdout: bool = True,
    max_bytes: int = 5 * 1024 * 1024,  # 5MB
) -> logging.Logger:
    """Set up logging for a backend module.

    Creates a file handler that writes to /tmp/inspirehub-{module}.log
    and optionally a stdout handler for development.

    Args:
        module: Module name (e.g., 'equipment', 'price-list')
        level: Minimum log level (default: INFO)
        also_stdout: Also log to stdout (default: True)
        max_bytes: Max log file size before rotation (default: 5MB)

    Returns:
        The configured root logger
    """
    global _initialized_modules

    # Avoid duplicate initialization
    if module in _initialized_modules:
        return logging.getLogger()

    log_path = get_log_path(module)

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Clear any existing handlers
    root_logger.handlers = []

    # Create formatter
    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)

    # File handler - write to module-specific log file
    try:
        file_handler = logging.FileHandler(log_path, mode='a', encoding='utf-8')
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)
    except Exception as e:
        print(f"Warning: Could not create log file at {log_path}: {e}", file=sys.stderr)

    # Optional stdout handler
    if also_stdout:
        stdout_handler = logging.StreamHandler(sys.stdout)
        stdout_handler.setLevel(level)
        stdout_handler.setFormatter(formatter)
        root_logger.addHandler(stdout_handler)

    _initialized_modules.add(module)

    # Log initialization
    root_logger.info(f'Logging initialized for {module}')

    return root_logger


def get_logger(name: Optional[str] = None) -> logging.Logger:
    """Get a logger instance.

    Args:
        name: Logger name (typically __name__). If None, returns root logger.

    Returns:
        Logger instance
    """
    return logging.getLogger(name)


def get_all_log_paths() -> list[str]:
    """Get paths to all InspireHub log files.

    Returns:
        List of paths to existing inspirehub-*.log files
    """
    log_dir = Path(LOG_DIR)
    return [
        str(p) for p in log_dir.glob('inspirehub-*.log')
        if p.is_file()
    ]


def clear_logs(module: Optional[str] = None) -> None:
    """Clear log file(s).

    Args:
        module: Specific module to clear, or None to clear all InspireHub logs
    """
    if module:
        log_path = get_log_path(module)
        if os.path.exists(log_path):
            with open(log_path, 'w') as f:
                pass  # Truncate file
    else:
        for path in get_all_log_paths():
            with open(path, 'w') as f:
                pass  # Truncate file
