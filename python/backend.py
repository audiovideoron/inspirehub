#!/usr/bin/env python3
"""
Price List Editor Backend - API-only server for Electron app.
"""
import argparse
import json
import logging
import os
import re
import secrets
import socket
import sys
import threading
import time
from collections import defaultdict
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import fitz  # PyMuPDF - needed for exception types

from extract_prices import extract_prices, prices_to_json
from update_pdf import update_prices

# Configuration
DEFAULT_PORT = 8080
DEBUG_LOG = "debug.log"
MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024  # 10MB limit for request bodies
RATE_LIMIT_REQUESTS = 10  # Maximum requests per second per endpoint
RATE_LIMIT_WINDOW = 1.0  # Time window in seconds
REQUEST_BODY_READ_TIMEOUT = 10.0  # Timeout in seconds for reading request body


class RateLimiter:
    """
    Simple token bucket rate limiter for API endpoints.

    Tracks request counts per endpoint within a sliding time window.
    Thread-safe using a lock for concurrent access.
    """

    def __init__(self, max_requests: int = RATE_LIMIT_REQUESTS, window_seconds: float = RATE_LIMIT_WINDOW):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: dict[str, list[float]] = defaultdict(list)
        self.lock = threading.Lock()

    def is_allowed(self, endpoint: str) -> bool:
        """
        Check if a request to the given endpoint is allowed.

        Returns True if the request is within rate limits, False otherwise.
        """
        now = time.time()
        cutoff = now - self.window_seconds

        with self.lock:
            # Remove expired timestamps
            self.requests[endpoint] = [t for t in self.requests[endpoint] if t > cutoff]

            # Check if under limit
            if len(self.requests[endpoint]) < self.max_requests:
                self.requests[endpoint].append(now)
                return True
            return False


# Global rate limiter instance
rate_limiter = RateLimiter()

# Global state
current_pdf_path = None
prices_cache = None
state_lock = threading.Lock()  # Protects current_pdf_path and prices_cache
load_lock = threading.Lock()  # Serializes PDF load operations to prevent race conditions
server_instance = None  # Reference to HTTPServer for shutdown
shutdown_token = None  # Token required for /api/shutdown authentication
logger = logging.getLogger(__name__)


def setup_logging(debug: bool):
    """Configure logging to stdout (and optionally file in debug mode)."""
    import tempfile
    log_format = '%(asctime)s - %(levelname)s - %(message)s'
    level = logging.DEBUG if debug else logging.INFO

    root_logger = logging.getLogger()
    root_logger.handlers = []

    # Only add file handler in debug mode, using temp directory
    if debug:
        try:
            log_path = os.path.join(tempfile.gettempdir(), DEBUG_LOG)
            file_handler = logging.FileHandler(log_path, mode='w')
            file_handler.setFormatter(logging.Formatter(log_format))
            file_handler.setLevel(level)
            root_logger.addHandler(file_handler)
        except Exception as e:
            print(f"Warning: Could not create log file at {log_path}: {e}", file=sys.stderr)

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(logging.Formatter(log_format))
    stdout_handler.setLevel(level)

    root_logger.setLevel(level)
    root_logger.addHandler(stdout_handler)


def load_pdf(pdf_path: str) -> list:
    """Load and extract prices from a PDF.

    Uses load_lock to serialize PDF load operations, preventing race conditions
    where concurrent requests could cause state inconsistency between
    current_pdf_path and prices_cache.
    """
    global current_pdf_path, prices_cache
    # Serialize load operations to prevent race conditions
    # Without this lock, concurrent calls could interleave:
    #   Thread 1: extract(A) -> Thread 2: extract(B) -> Thread 1: set state(A) -> Thread 2: set state(B)
    # This could leave prices_cache inconsistent with current_pdf_path
    with load_lock:
        prices = extract_prices(pdf_path)
        with state_lock:
            current_pdf_path = pdf_path
            prices_cache = prices
        return prices


def get_prices() -> list:
    """Get cached prices."""
    with state_lock:
        if prices_cache is None:
            raise ValueError("No PDF loaded. Call /api/load first.")
        return prices_cache


def get_current_pdf_path() -> str | None:
    """Get the current PDF path (thread-safe)."""
    with state_lock:
        return current_pdf_path


def get_prices_with_path() -> tuple[list, str]:
    """
    Atomically get cached prices and current PDF path together.

    This ensures consistency between the prices and the PDF path they came from,
    preventing race conditions where the PDF could be reloaded between separate calls.

    Returns:
        Tuple of (prices, pdf_path)

    Raises:
        ValueError: If no PDF is loaded
    """
    with state_lock:
        if prices_cache is None or current_pdf_path is None:
            raise ValueError("No PDF loaded. Call /api/load first.")
        return prices_cache, current_pdf_path


def is_localhost_request(client_address: tuple) -> bool:
    """Check if request comes from localhost (security check for shutdown)."""
    client_ip = client_address[0]
    return client_ip in ('127.0.0.1', '::1', 'localhost')


def validate_pdf_path(path: str) -> str:
    """
    Validate and sanitize a PDF file path to prevent path traversal attacks.

    Args:
        path: The file path to validate

    Returns:
        The normalized absolute path if valid

    Raises:
        ValueError: If the path is invalid or contains path traversal sequences
    """
    if not path:
        raise ValueError("Path cannot be empty")

    # Convert to Path object for normalization
    path_obj = Path(path)

    # Resolve to absolute path (this normalizes "..", ".", symlinks, etc.)
    try:
        resolved_path = path_obj.resolve(strict=False)
    except (OSError, RuntimeError) as e:
        raise ValueError(f"Invalid path: {e}")

    # Check that the path is absolute
    if not resolved_path.is_absolute():
        raise ValueError("Path must be absolute")

    # Check for path traversal: the resolved path should not differ in unexpected ways
    # from what we expect. Specifically, check that ".." doesn't appear in the original path
    # after normalization would remove it (indicating an attempt to traverse)
    original_parts = Path(path).parts
    if '..' in original_parts:
        raise ValueError("Path traversal not allowed: '..' is not permitted in paths")

    # Ensure the file has a .pdf extension (case-insensitive)
    if resolved_path.suffix.lower() != '.pdf':
        raise ValueError("File must have a .pdf extension")

    return str(resolved_path)


def delayed_shutdown():
    """Shutdown the server after a brief delay to allow response to be sent."""
    global server_instance
    time.sleep(0.1)  # Brief delay to allow HTTP response to be fully sent
    if server_instance:
        logger.info("Initiating graceful shutdown...")
        server_instance.shutdown()


class APIHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the price editor API."""

    # Allowed origin patterns for CORS (localhost and Electron file:// protocol)
    ALLOWED_ORIGIN_PREFIXES = (
        'http://localhost:',
        'http://localhost',  # Without port
        'http://127.0.0.1:',
        'http://127.0.0.1',  # Without port
        'file://',
    )

    def _get_cors_origin(self) -> str | None:
        """
        Get allowed CORS origin from request.

        Returns the Origin header value if it matches allowed patterns,
        otherwise returns None.
        """
        origin = self.headers.get('Origin', '')
        if not origin:
            return None

        # Check against exact localhost/127.0.0.1 origins (with optional port)
        # This prevents subdomain attacks like http://localhost.attacker.com
        if origin in ('http://localhost', 'http://127.0.0.1'):
            return origin
        if origin.startswith('http://localhost:') or origin.startswith('http://127.0.0.1:'):
            # Verify the rest is a valid port number (1-65535)
            port_part = origin.split(':', 2)[-1]  # Get the port after host:port
            if port_part.isdigit():
                port_num = int(port_part)
                if 1 <= port_num <= 65535:
                    return origin
        # Allow file:// protocol for Electron (only local file access)
        # Security: Only allow the exact "file://" origin that Electron sends
        # Reject any file:// origin with a path component to prevent malicious local files
        # from making requests (e.g., file:///malicious/page.html)
        if origin == 'file://':
            return origin
        if origin.startswith('file://'):
            logger.warning("Rejected file:// origin with path component")
            return None

        logger.warning(f"Rejected CORS request from origin: {origin}")
        return None

    def _send_cors_headers(self):
        """Send CORS headers if origin is allowed."""
        origin = self._get_cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, format, *args):
        """Override to use our logger."""
        logger.info(f"{self.address_string()} - {format % args}")

    def send_json(self, data: dict, status: int = 200):
        """Send JSON response with CORS headers."""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def send_pdf(self, pdf_bytes: bytes, filename: str):
        """Send PDF as binary response."""
        self.send_response(200)
        self.send_header('Content-Type', 'application/pdf')
        self._send_cors_headers()
        self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.send_header('Content-Length', len(pdf_bytes))
        self.end_headers()
        self.wfile.write(pdf_bytes)

    def _check_rate_limit(self) -> bool:
        """
        Check if the current request exceeds rate limits.

        Returns True if rate limited (caller should return early),
        False if request is allowed to proceed.
        """
        if not rate_limiter.is_allowed(self.path):
            logger.warning(f"Rate limit exceeded for {self.path} from {self.client_address[0]}")
            self.send_json({
                'success': False,
                'error': 'Rate limit exceeded. Please try again later.'
            }, 429)
            return True
        return False

    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        """Handle GET requests."""
        # Rate limiting check
        if self._check_rate_limit():
            return

        if self.path == '/api/health':
            self.send_json({'status': 'ok', 'pdf_loaded': get_current_pdf_path() is not None})

        elif self.path == '/api/prices':
            try:
                # Use atomic function to get consistent prices and path together
                prices, pdf_path = get_prices_with_path()
                self.send_json({
                    'success': True,
                    'pdf_path': pdf_path,
                    'prices': prices_to_json(prices)
                })
            except ValueError as e:
                self.send_json({'success': False, 'error': str(e)}, 400)
            except (TypeError, AttributeError) as e:
                # Malformed price data in cache (shouldn't happen but handle gracefully)
                logger.error(f"Error serializing prices - {type(e).__name__}: {e}")
                self.send_json({'success': False, 'error': f'Data serialization error: {e}'}, 500)

        elif self.path == '/api/test-error':
            # Test endpoint to trigger ERROR level log for Bug Spray testing
            logger.error("Test error triggered via /api/test-error endpoint")
            self.send_json({'success': True, 'message': 'ERROR level log created'})

        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        """Handle POST requests."""
        # Rate limiting check
        if self._check_rate_limit():
            return

        content_length = int(self.headers.get('Content-Length', 0))

        # Security: Limit request body size to prevent DoS attacks
        if content_length > MAX_REQUEST_BODY_SIZE:
            self.send_json({
                'success': False,
                'error': f'Request body too large. Maximum size is {MAX_REQUEST_BODY_SIZE // (1024 * 1024)}MB'
            }, 413)
            return

        # Security: Set socket timeout to prevent indefinite blocking on read
        # This protects against slow-loris style attacks where client sends data very slowly
        try:
            original_timeout = self.connection.gettimeout()
            self.connection.settimeout(REQUEST_BODY_READ_TIMEOUT)
            try:
                raw_body = self.rfile.read(content_length)
            finally:
                # Restore original timeout
                self.connection.settimeout(original_timeout)
        except socket.timeout:
            logger.warning(f"Request body read timeout from {self.client_address[0]}")
            self.send_json({
                'success': False,
                'error': 'Request timeout: client too slow sending data'
            }, 408)
            return
        except (ConnectionResetError, BrokenPipeError) as e:
            logger.warning(f"Connection error reading request body: {e}")
            return  # Client disconnected, nothing to send back

        # Decode request body with proper error handling
        try:
            body = raw_body.decode('utf-8')
        except UnicodeDecodeError as e:
            logger.warning(f"Invalid UTF-8 in request body from {self.client_address[0]}")
            self.send_json({
                'success': False,
                'error': 'Invalid request encoding: request body must be valid UTF-8'
            }, 400)
            return

        if self.path == '/api/load':
            try:
                data = json.loads(body)
                pdf_path = data.get('pdf_path')

                # Type validation: pdf_path must be a string
                if not isinstance(pdf_path, str) or not pdf_path:
                    self.send_json({'success': False, 'error': 'pdf_path must be a non-empty string'}, 400)
                    return

                # Security: Validate and sanitize the PDF path
                try:
                    pdf_path = validate_pdf_path(pdf_path)
                except ValueError as e:
                    logger.warning(f"Invalid pdf_path rejected: {e}")
                    self.send_json({'success': False, 'error': str(e)}, 400)
                    return

                logger.info(f"Loading PDF: {pdf_path}")
                prices = load_pdf(pdf_path)
                logger.info(f"Found {len(prices)} prices")

                self.send_json({
                    'success': True,
                    'pdf_path': pdf_path,
                    'prices': prices_to_json(prices)
                })

            except json.JSONDecodeError as e:
                self.send_json({'success': False, 'error': 'Invalid JSON'}, 400)
            except FileNotFoundError as e:
                logger.error(f"PDF file not found - FileNotFoundError: {e}")
                self.send_json({'success': False, 'error': 'File not found'}, 404)
            except PermissionError as e:
                logger.error(f"Permission denied reading PDF - PermissionError: {e}")
                self.send_json({'success': False, 'error': 'Permission denied'}, 403)
            except (fitz.FileDataError, fitz.EmptyFileError) as e:
                # Corrupted or empty PDF file
                logger.error(f"Invalid PDF file - {type(e).__name__}: {e}")
                self.send_json({'success': False, 'error': 'Invalid or corrupted PDF file'}, 400)
            except OSError as e:
                # Other I/O errors (disk full, network issues, etc.)
                logger.error(f"I/O error loading PDF - OSError: {e}")
                self.send_json({'success': False, 'error': 'I/O error while loading PDF'}, 500)
            except Exception as e:
                # Catch-all for unexpected errors (KeyError, AttributeError, etc.)
                logger.error(f"Unexpected error loading PDF - {type(e).__name__}: {e}")
                self.send_json({'success': False, 'error': 'An unexpected error occurred while loading the PDF'}, 500)

        elif self.path == '/api/export':
            try:
                data = json.loads(body)
                updates = data.get('updates', [])
                output_path = data.get('output_path')

                # Type validation: updates must be a non-empty list
                if not isinstance(updates, list) or not updates:
                    self.send_json({'success': False, 'error': 'updates must be a non-empty array'}, 400)
                    return

                # Validate each update has required fields before acquiring load_lock
                required_fields = ('bbox', 'font_size', 'color', 'new_value')
                for i, update in enumerate(updates):
                    if not isinstance(update, dict):
                        self.send_json({'success': False, 'error': f'updates[{i}] must be an object'}, 400)
                        return
                    missing_fields = [f for f in required_fields if f not in update]
                    if missing_fields:
                        self.send_json({
                            'success': False,
                            'error': f'updates[{i}] missing required fields: {", ".join(missing_fields)}'
                        }, 400)
                        return

                    # Validate color field: must be a list/tuple of 3 numeric RGB values in [0, 1]
                    color = update['color']
                    if not isinstance(color, (list, tuple)):
                        self.send_json({
                            'success': False,
                            'error': f'updates[{i}] color must be an array, got {type(color).__name__}'
                        }, 400)
                        return
                    if len(color) != 3:
                        self.send_json({
                            'success': False,
                            'error': f'updates[{i}] color must have exactly 3 RGB values, got {len(color)}'
                        }, 400)
                        return
                    color_names = ['red', 'green', 'blue']
                    for color_idx, component in enumerate(color):
                        if not isinstance(component, (int, float)):
                            self.send_json({
                                'success': False,
                                'error': f'updates[{i}] color {color_names[color_idx]} must be a number, got {type(component).__name__}'
                            }, 400)
                            return
                        if not (0 <= component <= 1):
                            self.send_json({
                                'success': False,
                                'error': f'updates[{i}] color {color_names[color_idx]} ({component}) must be in range [0, 1]'
                            }, 400)
                            return

                # Type validation: output_path must be a string if provided
                if output_path is not None and not isinstance(output_path, str):
                    self.send_json({'success': False, 'error': 'output_path must be a string'}, 400)
                    return

                # Acquire load_lock to prevent race conditions with concurrent load operations
                # This ensures the PDF path remains consistent throughout the export
                with load_lock:
                    # Get current PDF path (thread-safe via state_lock inside)
                    pdf_path = get_current_pdf_path()
                    if not pdf_path:
                        self.send_json({'success': False, 'error': 'No PDF loaded'}, 400)
                        return

                    # Generate output filename if not provided
                    if not output_path:
                        input_name = Path(pdf_path).stem
                        # Replace year in filename (2025 -> 2026, etc.)
                        # Use boundaries to avoid matching product codes like "Model2025X"
                        def increment_year(match):
                            year = int(match.group(1))
                            # Increment years 2020-2099 (2099 becomes 2100, which is valid)
                            if 2020 <= year <= 2099:
                                return match.group(0).replace(match.group(1), str(year + 1))
                            return match.group(0)  # Leave years outside 2020-2099 unchanged

                        # Match 4-digit years (2020-2099) that are standalone in filenames
                        # Uses lookarounds to match years at start/end or surrounded by
                        # common filename separators (space, dash, underscore, dot)
                        year_pattern = r'(?:^|(?<=[_\s.\-]))(20[2-9]\d)(?=[_\s.\-]|$)'
                        output_name = re.sub(year_pattern, increment_year, input_name, count=1)
                        if output_name == input_name:
                            output_name = f"{input_name}_updated"
                        output_path = str(Path(pdf_path).parent / f"{output_name}.pdf")

                    # Security: Validate and sanitize the output path
                    try:
                        output_path = validate_pdf_path(output_path)
                    except ValueError as e:
                        logger.warning(f"Invalid output_path rejected: {e}")
                        self.send_json({'success': False, 'error': str(e)}, 400)
                        return

                    logger.info(f"Exporting {len(updates)} updates to {output_path}")
                    result = update_prices(pdf_path, output_path, updates)

                if result['success']:
                    self.send_json({
                        'success': True,
                        'output_path': output_path,
                        'message': f"Updated {len(result['updated'])} prices",
                        'details': result
                    })
                else:
                    self.send_json({
                        'success': False,
                        'message': 'Some updates failed',
                        'details': result
                    }, 500)

            except json.JSONDecodeError as e:
                self.send_json({'success': False, 'error': 'Invalid JSON'}, 400)
            except FileNotFoundError as e:
                logger.error(f"File not found during export - FileNotFoundError: {e}")
                self.send_json({'success': False, 'error': 'File not found'}, 404)
            except PermissionError as e:
                logger.error(f"Permission denied during export - PermissionError: {e}")
                self.send_json({'success': False, 'error': 'Permission denied'}, 403)
            except (fitz.FileDataError, fitz.EmptyFileError) as e:
                # Corrupted or empty PDF file
                logger.error(f"Invalid PDF during export - {type(e).__name__}: {e}")
                self.send_json({'success': False, 'error': 'Invalid or corrupted PDF file'}, 400)
            except (ValueError, TypeError, AttributeError) as e:
                # Malformed update data (invalid bbox, color, etc.)
                logger.error(f"Invalid update data - {type(e).__name__}: {e}")
                self.send_json({'success': False, 'error': 'Invalid update data format'}, 400)
            except OSError as e:
                # Other I/O errors (disk full, network issues, etc.)
                logger.error(f"I/O error during export - OSError: {e}")
                self.send_json({'success': False, 'error': 'I/O error during export'}, 500)
            except Exception as e:
                # Catch-all for unexpected errors
                logger.error(f"Unexpected error during export - {type(e).__name__}: {e}")
                self.send_json({'success': False, 'error': 'An unexpected error occurred during export'}, 500)

        elif self.path == '/api/log':
            # Log endpoint for UI events (used by bug reports)
            # Security note: This endpoint is localhost-only by server binding (127.0.0.1).
            # While any local process could technically call this endpoint, the risk is
            # accepted because: (1) it only writes to application logs, (2) log injection
            # is mitigated by sanitizing input below, and (3) localhost access implies
            # the caller already has local machine access.
            try:
                data = json.loads(body) if body else {}
            except json.JSONDecodeError:
                self.send_json({'success': False, 'error': 'Invalid JSON'}, 400)
                return

            message = data.get('message', '')

            # Type validation: message must be a string
            if not isinstance(message, str):
                self.send_json({'success': False, 'error': 'message must be a string'}, 400)
                return

            # Security: Sanitize message to prevent log injection attacks
            # Strip newlines and control characters that could forge log entries
            # or inject malicious content into log files
            sanitized_message = ''.join(
                char for char in message
                if char >= ' ' or char == '\t'  # Allow printable chars and tabs
            )

            # Truncate long messages to prevent log flooding
            max_length = 500
            original_length = len(sanitized_message)
            if original_length > max_length:
                sanitized_message = sanitized_message[:max_length]
                # Security: Log when truncation occurs so hidden content is visible
                logger.info(f"[UI] {sanitized_message}... [TRUNCATED: {original_length - max_length} chars hidden]")
            else:
                logger.info(f"[UI] {sanitized_message}")

            self.send_json({'success': True})

        elif self.path == '/api/shutdown':
            # Security: only allow shutdown from localhost
            if not is_localhost_request(self.client_address):
                logger.warning(f"Shutdown request rejected from non-localhost: {self.client_address[0]}")
                self.send_json({'success': False, 'error': 'Forbidden: shutdown only allowed from localhost'}, 403)
                return

            # Security: require valid shutdown token (provided at startup via READY message)
            try:
                data = json.loads(body) if body else {}
            except json.JSONDecodeError:
                data = {}

            provided_token = data.get('token')
            # Security: Ensure shutdown_token is set before comparing
            # If shutdown_token is None, reject the request to prevent bypass
            if not shutdown_token or not provided_token or not secrets.compare_digest(provided_token, shutdown_token):
                logger.warning(f"Shutdown request rejected: invalid or missing token from {self.client_address[0]}")
                self.send_json({'success': False, 'error': 'Unauthorized: invalid shutdown token'}, 401)
                return

            logger.info("Shutdown requested via API (authenticated)")
            self.send_json({'success': True, 'message': 'Server shutting down'})

            # Schedule shutdown in a separate thread so response can be sent first
            shutdown_thread = threading.Thread(target=delayed_shutdown, daemon=True)
            shutdown_thread.start()

        else:
            self.send_json({'error': 'Not found'}, 404)


def main():
    parser = argparse.ArgumentParser(description='Price List Editor Backend')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'Port (default: {DEFAULT_PORT})')
    parser.add_argument('--pdf', type=str, help='Initial PDF to load')
    args = parser.parse_args()

    setup_logging(args.debug)
    logger.info(f"Debug mode: {args.debug}")
    logger.info(f"Port: {args.port}")

    # Pre-load PDF if specified
    if args.pdf:
        try:
            # Security: Validate the PDF path before loading
            validated_path = validate_pdf_path(args.pdf)
            if os.path.exists(validated_path):
                logger.info(f"Pre-loading PDF: {validated_path}")
                load_pdf(validated_path)
            else:
                logger.warning(f"PDF not found: {validated_path}")
        except ValueError as e:
            logger.warning(f"Invalid PDF path rejected: {e}")

    # Start server
    global server_instance, shutdown_token
    try:
        server = HTTPServer(('127.0.0.1', args.port), APIHandler)
    except OSError as e:
        # Handle port binding failures (port already in use, permission denied, etc.)
        # Error codes vary by platform:
        #   EADDRINUSE: macOS=48, Linux=98, Windows=10048 (WSAEADDRINUSE)
        #   EACCES: Unix=13, Windows=10013 (WSAEACCES)
        if e.errno in (48, 98, 10048):  # Port already in use
            print(f"Error: Port {args.port} is already in use", file=sys.stderr)
            logger.error(f"Port {args.port} is already in use")
        elif e.errno in (13, 10013):  # Permission denied (e.g., port < 1024)
            print(f"Error: Permission denied to bind to port {args.port}", file=sys.stderr)
            logger.error(f"Permission denied to bind to port {args.port}")
        elif e.errno in (99, 10049):  # EADDRNOTAVAIL / WSAEADDRNOTAVAIL
            print(f"Error: Address not available for port {args.port}", file=sys.stderr)
            logger.error(f"Address not available for port {args.port}")
        elif e.errno in (22, 10022):  # EINVAL / WSAEINVAL - invalid port number
            print(f"Error: Invalid port number {args.port}", file=sys.stderr)
            logger.error(f"Invalid port number {args.port}")
        else:
            print(f"Error: Failed to start server on port {args.port}: {e} (errno={e.errno})", file=sys.stderr)
            logger.error(f"Failed to start server on port {args.port}: {e} (errno={e.errno})")
        sys.exit(1)
    except Exception as e:
        print(f"Error: Unexpected error starting server: {e}", file=sys.stderr)
        logger.error(f"Unexpected error starting server: {e}")
        sys.exit(1)

    # Generate a secure shutdown token for Electron IPC
    # Security: Token is printed to stdout for Electron to capture via IPC pipe
    # This is intentional - Electron's python-bridge reads this directly.
    # The token should NOT be logged to files or other outputs.
    shutdown_token = secrets.token_urlsafe(32)

    server_instance = server  # Store reference for shutdown endpoint
    logger.info(f"Backend server running at http://localhost:{args.port}")

    # Print ready message for Electron to detect (includes shutdown token for authentication)
    # Format: READY:port:token
    # Security: This goes to stdout IPC pipe only - do not log this line
    print(f"READY:{args.port}:{shutdown_token}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.shutdown()
    except Exception as e:
        print(f"Error: Server error during operation: {e}", file=sys.stderr)
        logger.error(f"Server error during operation: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
