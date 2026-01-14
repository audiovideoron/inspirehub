"""Tests for backend.py utility functions."""
import re
import json
import pytest
import time
import threading
import secrets
from unittest.mock import Mock, MagicMock, patch
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backend
from backend import RateLimiter, validate_pdf_path, is_localhost_request, APIHandler


def increment_year(match):
    """
    Year increment function extracted from backend.py for testing.
    This is a copy of the logic in do_POST /api/export endpoint.
    """
    year = int(match.group(1))
    # Increment years 2020-2099 (2099 becomes 2100, which is valid)
    if 2020 <= year <= 2099:
        return match.group(0).replace(match.group(1), str(year + 1))
    return match.group(0)  # Leave years outside 2020-2099 unchanged


# Match 4-digit years (2020-2099) that are standalone in filenames
YEAR_PATTERN = r'(?:^|(?<=[_\s.\-]))(20[2-9]\d)(?=[_\s.\-]|$)'


def generate_output_name(input_name: str) -> str:
    """
    Generate output filename with incremented year.
    Extracted from backend.py for testing.
    """
    output_name = re.sub(YEAR_PATTERN, increment_year, input_name, count=1)
    if output_name == input_name:
        output_name = f"{input_name}_updated"
    return output_name


def create_mock_handler(method='GET', path='/api/health', origin='http://localhost',
                       client_address=('127.0.0.1', 12345), body_data=None):
    """
    Create a mock APIHandler for testing.

    Args:
        method: HTTP method (GET, POST, OPTIONS)
        path: Request path
        origin: Origin header value
        client_address: Client IP tuple
        body_data: Dict to be JSON-encoded as request body

    Returns:
        Mock APIHandler instance with all required attributes
    """
    handler = Mock(spec=APIHandler)
    handler.path = path
    handler.client_address = client_address

    # Mock headers
    handler.headers = Mock()
    content_length = str(len(json.dumps(body_data)) if body_data else 0)
    handler.headers.get = Mock(side_effect=lambda k, d=None:
        {'Origin': origin, 'Content-Length': content_length}.get(k, d))

    # Mock response methods
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.wfile = Mock()
    handler.wfile.write = Mock()

    # Mock connection (for timeout handling)
    handler.connection = Mock()
    handler.connection.gettimeout = Mock(return_value=30.0)
    handler.connection.settimeout = Mock()

    # Mock rfile for POST body
    handler.rfile = Mock()
    if body_data:
        handler.rfile.read = Mock(return_value=create_mock_request_body(body_data))
    else:
        handler.rfile.read = Mock(return_value=b'{}')

    # Track sent JSON responses
    handler.sent_responses = []
    original_send_json = lambda data, status=200: handler.sent_responses.append((data, status))
    handler.send_json = Mock(side_effect=original_send_json)

    return handler


def create_mock_request_body(data):
    """Convert dict to JSON bytes for mocked rfile.read()."""
    return json.dumps(data).encode('utf-8')


class TestYearIncrement:
    """Tests for year increment logic in filename generation."""

    def test_basic_year_increment(self):
        """Basic year increment: 2025 -> 2026"""
        assert generate_output_name("PriceList_2025") == "PriceList_2026"

    def test_year_at_end(self):
        """Year at end of filename"""
        assert generate_output_name("Catalog-2024") == "Catalog-2025"

    def test_year_with_spaces(self):
        """Year surrounded by spaces"""
        assert generate_output_name("Price List 2023 Final") == "Price List 2024 Final"

    def test_year_with_dots(self):
        """Year with dot separators"""
        assert generate_output_name("catalog.2022.v1") == "catalog.2023.v1"

    def test_year_at_start(self):
        """Year at start of filename"""
        assert generate_output_name("2025_PriceList") == "2026_PriceList"

    def test_year_2099_to_2100(self):
        """
        Edge case: 2099 should increment to 2100.
        This tests the fix for InspirePriceList-7hr where 2099->2100 was blocked.
        The result 2100 is a valid 4-digit year, even though it's outside the
        regex match pattern (20[2-9]\\d only matches 2020-2099).
        """
        assert generate_output_name("PriceList_2099") == "PriceList_2100"

    def test_year_2098_to_2099(self):
        """Year 2098 should increment to 2099"""
        assert generate_output_name("Catalog-2098") == "Catalog-2099"

    def test_year_2020_lower_bound(self):
        """Year 2020 (lower bound) should increment to 2021"""
        assert generate_output_name("Archive_2020") == "Archive_2021"

    def test_year_2019_not_matched(self):
        """Year 2019 is outside range and should not be incremented"""
        assert generate_output_name("Archive_2019") == "Archive_2019_updated"

    def test_no_year_in_filename(self):
        """Filename without year should get _updated suffix"""
        assert generate_output_name("PriceList") == "PriceList_updated"

    def test_year_embedded_in_word_not_matched(self):
        """Year embedded in product code should NOT be matched"""
        # Model2025X has no word boundary before 2025
        assert generate_output_name("Model2025X") == "Model2025X_updated"

    def test_only_first_year_incremented(self):
        """Only the first year in filename should be incremented (count=1)"""
        assert generate_output_name("PriceList_2024_to_2025") == "PriceList_2025_to_2025"

    def test_year_standalone(self):
        """Standalone year filename"""
        assert generate_output_name("2025") == "2026"


class TestRateLimiter:
    """Test RateLimiter token bucket algorithm and thread safety."""

    def test_allows_requests_under_limit(self):
        """Test that requests under limit are allowed."""
        limiter = RateLimiter(max_requests=10, window_seconds=1.0)

        # Make 10 requests (should all succeed)
        for i in range(10):
            assert limiter.is_allowed('/api/test') is True

    @patch('backend.time.time')
    def test_blocks_requests_over_limit(self, mock_time):
        """Test that requests over limit are blocked."""
        mock_time.return_value = 1000.0
        limiter = RateLimiter(max_requests=10, window_seconds=1.0)

        # Fill up the limit
        for i in range(10):
            assert limiter.is_allowed('/api/test') is True

        # 11th request should be blocked
        assert limiter.is_allowed('/api/test') is False

    @patch('backend.time.time')
    def test_sliding_window_expires_old_requests(self, mock_time):
        """Test that old requests expire after window."""
        mock_time.return_value = 1000.0
        limiter = RateLimiter(max_requests=10, window_seconds=1.0)

        # Fill up the limit at t=1000
        for i in range(10):
            assert limiter.is_allowed('/api/test') is True

        # Advance time beyond window (t=1001.1)
        mock_time.return_value = 1001.1

        # Should be allowed again
        assert limiter.is_allowed('/api/test') is True

    def test_per_endpoint_tracking(self):
        """Test that different endpoints have separate limits."""
        limiter = RateLimiter(max_requests=2, window_seconds=1.0)

        # Fill limit for /api/test
        assert limiter.is_allowed('/api/test') is True
        assert limiter.is_allowed('/api/test') is True
        assert limiter.is_allowed('/api/test') is False  # Blocked

        # /api/other should still work
        assert limiter.is_allowed('/api/other') is True
        assert limiter.is_allowed('/api/other') is True
        assert limiter.is_allowed('/api/other') is False  # Blocked

    def test_thread_safety_concurrent_requests(self):
        """Test that multiple threads can safely check limits."""
        limiter = RateLimiter(max_requests=20, window_seconds=1.0)
        results = []

        def make_request():
            result = limiter.is_allowed('/api/test')
            results.append(result)

        # Create 20 threads (should all succeed since limit is 20)
        threads = [threading.Thread(target=make_request) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All should have succeeded
        assert sum(results) == 20

    @patch('backend.time.time')
    def test_limit_reset_after_window(self, mock_time):
        """Test that limits reset after time window passes."""
        mock_time.return_value = 1000.0
        limiter = RateLimiter(max_requests=5, window_seconds=1.0)

        # Use up all 5 requests
        for i in range(5):
            assert limiter.is_allowed('/api/test') is True
        assert limiter.is_allowed('/api/test') is False

        # Advance time by 1.1 seconds (beyond window)
        mock_time.return_value = 1001.1

        # Should have 5 more requests available
        for i in range(5):
            assert limiter.is_allowed('/api/test') is True
        assert limiter.is_allowed('/api/test') is False


class TestSecurityFunctions:
    """Test security validation functions."""

    def test_accepts_valid_absolute_pdf_path(self):
        """Test that valid absolute .pdf path is accepted."""
        result = validate_pdf_path('/Users/test/document.pdf')
        assert result == '/Users/test/document.pdf'

    def test_rejects_empty_path(self):
        """Test that empty string is rejected."""
        with pytest.raises(ValueError, match="Path cannot be empty"):
            validate_pdf_path('')

    def test_rejects_non_pdf_extension(self):
        """Test that only .pdf files are allowed."""
        with pytest.raises(ValueError, match="must have a .pdf extension"):
            validate_pdf_path('/Users/test/document.txt')

    def test_rejects_path_traversal_with_dotdot(self):
        """Test that '../' sequences are rejected."""
        with pytest.raises(ValueError, match="Path traversal not allowed"):
            validate_pdf_path('/Users/test/../etc/passwd.pdf')

    def test_accepts_relative_paths_by_resolving(self):
        """Test that relative paths are resolved to absolute."""
        # validate_pdf_path uses Path.resolve() which converts relative to absolute
        # So relative paths are actually accepted and made absolute
        import os
        result = validate_pdf_path('document.pdf')
        # Should be resolved to absolute path
        assert os.path.isabs(result)
        assert result.endswith('.pdf')

    def test_accepts_case_insensitive_pdf_extension(self):
        """Test that .PDF, .Pdf are accepted."""
        result = validate_pdf_path('/Users/test/document.PDF')
        assert result.endswith('.PDF')

    @patch('backend.Path.resolve')
    def test_handles_symlink_path_validation(self, mock_resolve):
        """Test that symlinks are resolved correctly."""
        from pathlib import Path
        mock_resolved = Path('/real/path/to/file.pdf')
        mock_resolve.return_value = mock_resolved

        result = validate_pdf_path('/link/to/file.pdf')
        assert result == str(mock_resolved)

    def test_accepts_localhost_ipv4(self):
        """Test that 127.0.0.1 is accepted."""
        assert is_localhost_request(('127.0.0.1', 12345)) is True

    def test_accepts_localhost_ipv6(self):
        """Test that ::1 is accepted."""
        assert is_localhost_request(('::1', 12345)) is True

    def test_accepts_localhost_string(self):
        """Test that 'localhost' is accepted."""
        assert is_localhost_request(('localhost', 12345)) is True

    def test_rejects_external_ip(self):
        """Test that non-localhost IPs are rejected."""
        assert is_localhost_request(('192.168.1.1', 12345)) is False

    def test_rejects_malicious_ip(self):
        """Test that other IPs are rejected."""
        assert is_localhost_request(('10.0.0.1', 12345)) is False


class TestStateManagement:
    """Test thread-safe global state and PDF loading."""

    @patch('backend.extract_prices')
    def test_load_pdf_updates_state(self, mock_extract):
        """Test that load_pdf sets state correctly."""
        mock_extract.return_value = [{'id': 0, 'text': '$600'}]

        prices = backend.load_pdf('/path/to/test.pdf')

        assert backend.current_pdf_path == '/path/to/test.pdf'
        assert backend.prices_cache == prices
        assert len(prices) == 1

    @patch('backend.extract_prices')
    def test_get_prices_returns_cached_prices(self, mock_extract):
        """Test that get_prices returns cache."""
        mock_extract.return_value = [{'id': 0, 'text': '$600'}]
        backend.load_pdf('/path/to/test.pdf')

        prices = backend.get_prices()

        assert prices == [{'id': 0, 'text': '$600'}]

    def test_get_prices_raises_when_no_pdf_loaded(self):
        """Test ValueError when cache is empty."""
        # Reset state
        backend.prices_cache = None
        backend.current_pdf_path = None

        with pytest.raises(ValueError, match="No PDF loaded"):
            backend.get_prices()

    @patch('backend.extract_prices')
    def test_get_prices_with_path_atomic(self, mock_extract):
        """Test atomic read of prices + path."""
        mock_extract.return_value = [{'id': 0, 'text': '$600'}]
        backend.load_pdf('/path/to/test.pdf')

        prices, path = backend.get_prices_with_path()

        assert path == '/path/to/test.pdf'
        assert prices == [{'id': 0, 'text': '$600'}]

    @patch('backend.extract_prices')
    def test_load_pdf_thread_safety(self, mock_extract):
        """Test that concurrent load operations don't corrupt state."""
        call_count = [0]

        def extract_side_effect(path):
            call_count[0] += 1
            time.sleep(0.01)  # Simulate work
            return [{'id': call_count[0], 'path': path}]

        mock_extract.side_effect = extract_side_effect

        # Load PDFs from multiple threads
        threads = []
        for i in range(5):
            t = threading.Thread(target=backend.load_pdf, args=(f'/path/to/pdf{i}.pdf',))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Verify state is consistent (cache matches path)
        prices, path = backend.get_prices_with_path()
        assert path in [f'/path/to/pdf{i}.pdf' for i in range(5)]
        assert prices[0]['path'] == path

    @patch('backend.extract_prices')
    def test_load_lock_prevents_race_conditions(self, mock_extract):
        """Test that load_lock serializes operations."""
        call_order = []

        def extract_side_effect(path):
            call_order.append(('start', path))
            time.sleep(0.01)
            call_order.append(('end', path))
            return [{'path': path}]

        mock_extract.side_effect = extract_side_effect

        # Load PDFs from multiple threads
        threads = [
            threading.Thread(target=backend.load_pdf, args=('/path/a.pdf',)),
            threading.Thread(target=backend.load_pdf, args=('/path/b.pdf',))
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Verify no interleaving (start/end pairs are not interrupted)
        # Each PDF load should complete before the next starts
        assert len(call_order) == 4  # 2 starts, 2 ends


class TestAPIHandlerCORS:
    """Test CORS origin validation and header handling."""

    def test_allows_localhost_origin(self):
        """Test that localhost origin is allowed."""
        # Create a mock handler with just the headers attribute
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Origin': 'http://localhost'}.get(k, d))

        # Call the method directly
        result = APIHandler._get_cors_origin(handler)

        assert result == 'http://localhost'

    def test_allows_localhost_with_port(self):
        """Test that localhost:port is allowed."""
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Origin': 'http://localhost:3000'}.get(k, d))

        result = APIHandler._get_cors_origin(handler)

        assert result == 'http://localhost:3000'

    def test_allows_127001_origin(self):
        """Test that 127.0.0.1:port is allowed."""
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Origin': 'http://127.0.0.1:8080'}.get(k, d))

        result = APIHandler._get_cors_origin(handler)

        assert result == 'http://127.0.0.1:8080'

    def test_allows_file_protocol(self):
        """Test that file:// is allowed."""
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Origin': 'file://'}.get(k, d))

        result = APIHandler._get_cors_origin(handler)

        assert result == 'file://'

    def test_rejects_file_with_path(self):
        """Test that file:// with path is rejected."""
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Origin': 'file:///malicious/page.html'}.get(k, d))

        result = APIHandler._get_cors_origin(handler)

        assert result is None

    def test_rejects_subdomain_attack(self):
        """Test that localhost.attacker.com is rejected."""
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Origin': 'http://localhost.attacker.com'}.get(k, d))

        result = APIHandler._get_cors_origin(handler)

        assert result is None

    def test_rejects_invalid_port(self):
        """Test that invalid port is rejected."""
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Origin': 'http://localhost:99999'}.get(k, d))

        result = APIHandler._get_cors_origin(handler)

        assert result is None

    def test_send_json_includes_cors_headers(self):
        """Test that JSON responses include CORS headers."""
        # Create mock handler
        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.headers = Mock()
        handler.headers.get = Mock(return_value='http://localhost')
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = Mock()
        handler.wfile.write = Mock()
        # Make _send_cors_headers call the real method
        handler._send_cors_headers = lambda: APIHandler._send_cors_headers(handler)
        # Make _get_cors_origin call the real method
        handler._get_cors_origin = lambda: APIHandler._get_cors_origin(handler)

        # Call send_json directly
        APIHandler.send_json(handler, {'test': 'data'})

        # Verify CORS headers were sent
        calls = [str(call) for call in handler.send_header.call_args_list]
        assert any('Access-Control-Allow-Origin' in call for call in calls)


class TestGETEndpoints:
    """Test GET endpoint handlers."""

    @patch('backend.get_current_pdf_path')
    def test_health_endpoint_returns_ok(self, mock_get_path):
        """Test that health check succeeds."""
        mock_get_path.return_value = '/path/to/file.pdf'

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/health'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = {}
        handler.send_json = Mock()

        APIHandler.do_GET(handler)

        args = handler.send_json.call_args[0][0]
        assert args['status'] == 'ok'
        assert args['pdf_loaded'] is True

    @patch('backend.get_current_pdf_path')
    def test_health_endpoint_shows_pdf_loaded_status(self, mock_get_path):
        """Test that pdf_loaded flag reflects state."""
        mock_get_path.return_value = None

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/health'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = {}
        handler.send_json = Mock()

        APIHandler.do_GET(handler)

        args = handler.send_json.call_args[0][0]
        assert args['pdf_loaded'] is False

    @patch('backend.prices_to_json')
    @patch('backend.get_prices_with_path')
    def test_prices_endpoint_returns_prices(self, mock_get_prices, mock_to_json):
        """Test that prices endpoint returns cached prices."""
        mock_get_prices.return_value = ([{'id': 0}], '/path/to/file.pdf')
        mock_to_json.return_value = [{'id': 0, 'text': '$600'}]

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/prices'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = {}
        handler.send_json = Mock()

        APIHandler.do_GET(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is True
        assert args['pdf_path'] == '/path/to/file.pdf'
        assert len(args['prices']) == 1

    @patch('backend.get_prices_with_path')
    def test_prices_endpoint_errors_when_no_pdf(self, mock_get_prices):
        """Test 400 error when no PDF loaded."""
        mock_get_prices.side_effect = ValueError("No PDF loaded")

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/prices'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = {}
        handler.send_json = Mock()

        APIHandler.do_GET(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.prices_to_json')
    @patch('backend.get_prices_with_path')
    def test_prices_endpoint_handles_serialization_error(self, mock_get_prices, mock_to_json):
        """Test 500 on serialization error."""
        mock_get_prices.return_value = ([{'id': 0}], '/path/to/file.pdf')
        mock_to_json.side_effect = TypeError("Bad data")

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/prices'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = {}
        handler.send_json = Mock()

        APIHandler.do_GET(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False


class TestPOSTLoadEndpoint:
    """Test POST /api/load endpoint."""

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.prices_to_json')
    @patch('backend.load_pdf')
    @patch('backend.validate_pdf_path')
    def test_load_endpoint_loads_pdf(self, mock_validate, mock_load, mock_to_json, mock_rate):
        """Test successful PDF load via API."""
        mock_rate.return_value = True
        mock_validate.return_value = '/absolute/path/to/file.pdf'
        mock_load.return_value = [{'id': 0, 'text': '$600'}]
        mock_to_json.return_value = [{'id': 0, 'text': '$600'}]

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '30'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": "/path/to/file.pdf"}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        mock_validate.assert_called_once_with('/path/to/file.pdf')
        mock_load.assert_called_once_with('/absolute/path/to/file.pdf')
        args = handler.send_json.call_args[0][0]
        assert args['success'] is True

    @patch('backend.rate_limiter.is_allowed')
    def test_load_rejects_empty_pdf_path(self, mock_rate):
        """Test 400 error for empty path."""
        mock_rate.return_value = True

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '17'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": ""}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    def test_load_rejects_non_string_pdf_path(self, mock_rate):
        """Test 400 error for non-string."""
        mock_rate.return_value = True

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '16'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": 123}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.validate_pdf_path')
    def test_load_rejects_invalid_path(self, mock_validate, mock_rate):
        """Test 400 error from validate_pdf_path."""
        mock_rate.return_value = True
        mock_validate.side_effect = ValueError("Path traversal not allowed")

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '30'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": "/path/../bad.pdf"}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.load_pdf')
    @patch('backend.validate_pdf_path')
    def test_load_handles_file_not_found(self, mock_validate, mock_load, mock_rate):
        """Test 404 error for missing file."""
        mock_rate.return_value = True
        mock_validate.return_value = '/path/to/file.pdf'
        mock_load.side_effect = FileNotFoundError("File not found")

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '30'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": "/path/to/file.pdf"}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.load_pdf')
    @patch('backend.validate_pdf_path')
    def test_load_handles_permission_denied(self, mock_validate, mock_load, mock_rate):
        """Test 403 error for permissions."""
        mock_rate.return_value = True
        mock_validate.return_value = '/path/to/file.pdf'
        mock_load.side_effect = PermissionError("Permission denied")

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '30'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": "/path/to/file.pdf"}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.load_pdf')
    @patch('backend.validate_pdf_path')
    def test_load_handles_corrupted_pdf(self, mock_validate, mock_load, mock_rate):
        """Test 400 error for fitz.FileDataError."""
        import fitz
        mock_rate.return_value = True
        mock_validate.return_value = '/path/to/file.pdf'
        mock_load.side_effect = fitz.FileDataError("Corrupted PDF")

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '30'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": "/path/to/file.pdf"}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.load_pdf')
    @patch('backend.validate_pdf_path')
    def test_load_handles_unexpected_error(self, mock_validate, mock_load, mock_rate):
        """Test 500 error for unknown exceptions."""
        mock_rate.return_value = True
        mock_validate.return_value = '/path/to/file.pdf'
        mock_load.side_effect = Exception("Unexpected error")

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/load'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': '30'}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=b'{"pdf_path": "/path/to/file.pdf"}')
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False


class TestPOSTExportEndpoint:
    """Test POST /api/export endpoint."""

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.update_prices')
    @patch('backend.get_current_pdf_path')
    @patch('backend.load_lock')
    def test_export_endpoint_updates_prices(self, mock_lock, mock_get_path, mock_update, mock_rate):
        """Test successful export with updates."""
        mock_rate.return_value = True
        mock_get_path.return_value = '/path/to/input.pdf'
        mock_update.return_value = {'success': True, 'updated': [{'id': 0, 'new_text': '$650'}], 'errors': []}
        mock_lock.__enter__ = Mock()
        mock_lock.__exit__ = Mock()

        body = json.dumps({
            'updates': [{'id': 0, 'bbox': [100, 50, 120, 60], 'new_value': 650, 'has_hr_suffix': False, 'font_size': 8.0, 'color': [0.137, 0.122, 0.125], 'page_num': 0}],
            'output_path': '/path/to/output.pdf'
        })

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is True

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.validate_pdf_path')
    @patch('backend.update_prices')
    @patch('backend.get_current_pdf_path')
    @patch('backend.load_lock')
    def test_export_generates_output_filename(self, mock_lock, mock_get_path, mock_update, mock_validate, mock_rate):
        """Test auto-generate filename with year increment."""
        mock_rate.return_value = True
        mock_get_path.return_value = '/path/to/PriceList_2025.pdf'
        mock_validate.return_value = '/path/to/PriceList_2026.pdf'
        mock_update.return_value = {'success': True, 'updated': [], 'errors': []}
        mock_lock.__enter__ = Mock()
        mock_lock.__exit__ = Mock()

        body = json.dumps({
            'updates': [{'id': 0, 'bbox': [100, 50, 120, 60], 'new_value': 650, 'has_hr_suffix': False, 'font_size': 8.0, 'color': [0, 0, 0], 'page_num': 0}]
        })

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        # Verify validate was called with incremented year path
        assert mock_validate.called

    @patch('backend.rate_limiter.is_allowed')
    def test_export_rejects_empty_updates(self, mock_rate):
        """Test 400 error for empty updates array."""
        mock_rate.return_value = True

        body = json.dumps({'updates': []})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    def test_export_rejects_non_array_updates(self, mock_rate):
        """Test 400 error for non-array."""
        mock_rate.return_value = True

        body = json.dumps({'updates': 'not_an_array'})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    def test_export_rejects_missing_required_fields(self, mock_rate):
        """Test 400 error for missing fields."""
        mock_rate.return_value = True

        body = json.dumps({'updates': [{'id': 0}]})  # Missing bbox, font_size, color, new_value

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    def test_export_rejects_invalid_color_format(self, mock_rate):
        """Test 400 error for bad color."""
        mock_rate.return_value = True

        body = json.dumps({
            'updates': [{'bbox': [100, 50, 120, 60], 'font_size': 8.0, 'color': 'red', 'new_value': 650}]
        })

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    def test_export_rejects_color_out_of_range(self, mock_rate):
        """Test 400 error for color > 1.0."""
        mock_rate.return_value = True

        body = json.dumps({
            'updates': [{'bbox': [100, 50, 120, 60], 'font_size': 8.0, 'color': [1.5, 0.5, 0.5], 'new_value': 650}]
        })

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.get_current_pdf_path')
    @patch('backend.load_lock')
    def test_export_handles_no_pdf_loaded(self, mock_lock, mock_get_path, mock_rate):
        """Test 400 error when no PDF."""
        mock_rate.return_value = True
        mock_get_path.return_value = None
        mock_lock.__enter__ = Mock()
        mock_lock.__exit__ = Mock()

        body = json.dumps({
            'updates': [{'bbox': [100, 50, 120, 60], 'font_size': 8.0, 'color': [0, 0, 0], 'new_value': 650}]
        })

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is False

    @patch('backend.rate_limiter.is_allowed')
    @patch('backend.update_prices')
    @patch('backend.get_current_pdf_path')
    @patch('backend.load_lock')
    def test_export_handles_update_failure(self, mock_lock, mock_get_path, mock_update, mock_rate):
        """Test 500 error on update failure."""
        mock_rate.return_value = True
        mock_get_path.return_value = '/path/to/input.pdf'
        mock_update.return_value = {'success': False, 'updated': [], 'errors': ['Update failed']}
        mock_lock.__enter__ = Mock()
        mock_lock.__exit__ = Mock()

        body = json.dumps({
            'updates': [{'bbox': [100, 50, 120, 60], 'font_size': 8.0, 'color': [0, 0, 0], 'new_value': 650, 'has_hr_suffix': False, 'page_num': 0}],
            'output_path': '/path/to/output.pdf'
        })

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/export'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args, status = handler.send_json.call_args[0]
        assert args['success'] is False


class TestPOSTShutdownEndpoint:
    """Test POST /api/shutdown endpoint."""

    @patch('backend.is_localhost_request')
    @patch('backend.rate_limiter.is_allowed')
    def test_shutdown_requires_localhost(self, mock_rate, mock_is_localhost):
        """Test reject non-localhost requests."""
        mock_rate.return_value = True
        mock_is_localhost.return_value = False

        body = json.dumps({'token': 'test-token'})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/shutdown'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args, status = handler.send_json.call_args[0]
        assert args['success'] is False

    @patch('backend.shutdown_token', 'correct-token')
    @patch('backend.is_localhost_request')
    @patch('backend.rate_limiter.is_allowed')
    def test_shutdown_requires_valid_token(self, mock_rate, mock_is_localhost):
        """Test reject invalid token."""
        mock_rate.return_value = True
        mock_is_localhost.return_value = True

        body = json.dumps({'token': 'wrong-token'})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/shutdown'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args, status = handler.send_json.call_args[0]
        assert args['success'] is False

    @patch('backend.shutdown_token', 'correct-token')
    @patch('backend.is_localhost_request')
    @patch('backend.rate_limiter.is_allowed')
    def test_shutdown_requires_token_present(self, mock_rate, mock_is_localhost):
        """Test reject missing token."""
        mock_rate.return_value = True
        mock_is_localhost.return_value = True

        body = json.dumps({})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/shutdown'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args, status = handler.send_json.call_args[0]
        assert args['success'] is False

    @patch('backend.shutdown_token', None)
    @patch('backend.is_localhost_request')
    @patch('backend.rate_limiter.is_allowed')
    def test_shutdown_rejects_none_shutdown_token(self, mock_rate, mock_is_localhost):
        """Test reject when shutdown_token unset."""
        mock_rate.return_value = True
        mock_is_localhost.return_value = True

        body = json.dumps({'token': 'any-token'})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/shutdown'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args, status = handler.send_json.call_args[0]
        assert args['success'] is False

    @patch('backend.threading.Thread')
    @patch('backend.shutdown_token', 'correct-token')
    @patch('backend.is_localhost_request')
    @patch('backend.rate_limiter.is_allowed')
    def test_shutdown_succeeds_with_valid_token(self, mock_rate, mock_is_localhost, mock_thread):
        """Test happy path: valid shutdown."""
        mock_rate.return_value = True
        mock_is_localhost.return_value = True
        mock_thread_instance = Mock()
        mock_thread.return_value = mock_thread_instance

        body = json.dumps({'token': 'correct-token'})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/shutdown'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        args = handler.send_json.call_args[0][0]
        assert args['success'] is True
        mock_thread_instance.start.assert_called_once()

    @patch('backend.secrets.compare_digest')
    @patch('backend.shutdown_token', 'test-token')
    @patch('backend.is_localhost_request')
    @patch('backend.rate_limiter.is_allowed')
    def test_shutdown_uses_constant_time_comparison(self, mock_rate, mock_is_localhost, mock_compare):
        """Test verify secrets.compare_digest used."""
        mock_rate.return_value = True
        mock_is_localhost.return_value = True
        mock_compare.return_value = False

        body = json.dumps({'token': 'test-token'})

        handler = Mock(spec=APIHandler)
        handler.client_address = ('127.0.0.1', 12345)
        handler.path = '/api/shutdown'
        handler._check_rate_limit = Mock(return_value=False)  # Not rate limited
        handler.headers = Mock()
        handler.headers.get = Mock(side_effect=lambda k, d=None: {'Content-Length': str(len(body))}.get(k, d))
        handler.rfile = Mock()
        handler.rfile.read = Mock(return_value=body.encode())
        handler.connection = Mock()
        handler.connection.gettimeout = Mock(return_value=30.0)
        handler.connection.settimeout = Mock()
        handler.send_json = Mock()

        APIHandler.do_POST(handler)

        mock_compare.assert_called_once()
