"""
Pytest configuration and shared fixtures for price_list tests.
"""

import pytest
from unittest.mock import patch


@pytest.fixture
def mock_tempfile():
    """
    Mock tempfile.mkstemp to prevent tests from creating actual temp files.
    Returns a mock that returns (/dev/null-like fd, "/tmp/mock_update_pdf.pdf").
    """
    with patch("update_pdf.tempfile.mkstemp") as mock_mkstemp:
        with patch("update_pdf.os.close") as mock_close:
            mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")
            yield {
                "mkstemp": mock_mkstemp,
                "close": mock_close
            }
