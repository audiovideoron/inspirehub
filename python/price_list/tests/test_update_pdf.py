"""
Unit tests for update_pdf.py

Tests the core PDF update functions using mocked PyMuPDF objects.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from update_pdf import (
    get_font_path,
    format_new_price,
    _replace_with_retry,
    CALIBRI_FONT_PATHS,
    FALLBACK_FONT,
    WINDOWS_REPLACE_MAX_RETRIES,
)


class TestGetFontPath:
    """Test get_font_path function."""

    @patch("os.path.exists")
    def test_returns_calibri_when_exists(self, mock_exists):
        """Test that Calibri path is returned when file exists."""
        mock_exists.return_value = True
        result = get_font_path()
        # Result should be the platform-specific Calibri path
        expected_path = CALIBRI_FONT_PATHS.get(sys.platform)
        assert result == expected_path

    @patch("os.path.exists")
    def test_returns_none_when_calibri_missing(self, mock_exists):
        """Test that None is returned when Calibri not found."""
        mock_exists.return_value = False
        result = get_font_path()
        assert result is None


class TestFormatNewPrice:
    """Test format_new_price function."""

    def test_whole_number_price(self):
        """Test formatting whole number prices."""
        assert format_new_price(600, False) == "$600"
        assert format_new_price(50, False) == "$50"
        assert format_new_price(1, False) == "$1"

    def test_price_with_commas(self):
        """Test formatting prices with thousand separators."""
        assert format_new_price(1000, False) == "$1,000"
        assert format_new_price(10000, False) == "$10,000"
        assert format_new_price(1000000, False) == "$1,000,000"

    def test_price_with_cents(self):
        """Test formatting prices with decimal places."""
        assert format_new_price(600.50, False) == "$600.50"
        assert format_new_price(50.99, False) == "$50.99"
        assert format_new_price(1000.25, False) == "$1,000.25"

    def test_price_with_hr_suffix(self):
        """Test formatting hourly rates."""
        assert format_new_price(110, True) == "$110/hr"
        assert format_new_price(50, True) == "$50/hr"
        assert format_new_price(1000, True) == "$1,000/hr"

    def test_float_whole_number(self):
        """Test that float values like 600.0 are formatted as whole numbers."""
        assert format_new_price(600.0, False) == "$600"
        assert format_new_price(1000.0, True) == "$1,000/hr"


class TestReplaceWithRetry:
    """Test _replace_with_retry function for Windows file locking handling."""

    @patch("update_pdf.sys.platform", "darwin")
    @patch("update_pdf.os.replace")
    def test_non_windows_single_attempt(self, mock_replace):
        """Test that non-Windows platforms use single os.replace call."""
        _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")
        mock_replace.assert_called_once_with("/tmp/temp.pdf", "/output/file.pdf")

    @patch("update_pdf.sys.platform", "linux")
    @patch("update_pdf.os.replace")
    def test_linux_single_attempt(self, mock_replace):
        """Test that Linux uses single os.replace call."""
        _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")
        mock_replace.assert_called_once_with("/tmp/temp.pdf", "/output/file.pdf")

    @patch("update_pdf.sys.platform", "darwin")
    @patch("update_pdf.os.replace")
    def test_non_windows_raises_immediately(self, mock_replace):
        """Test that non-Windows platforms raise OSError immediately without retry."""
        mock_replace.side_effect = OSError("Permission denied")
        with pytest.raises(OSError, match="Permission denied"):
            _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")
        mock_replace.assert_called_once()

    @patch("update_pdf.sys.platform", "win32")
    @patch("update_pdf.time.sleep")
    @patch("update_pdf.os.replace")
    def test_windows_success_first_attempt(self, mock_replace, mock_sleep):
        """Test Windows succeeds on first attempt without retry."""
        _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")
        mock_replace.assert_called_once_with("/tmp/temp.pdf", "/output/file.pdf")
        mock_sleep.assert_not_called()

    @patch("update_pdf.sys.platform", "win32")
    @patch("update_pdf.time.sleep")
    @patch("update_pdf.os.replace")
    def test_windows_retry_on_permission_error(self, mock_replace, mock_sleep):
        """Test Windows retries on PermissionError and succeeds."""
        # Fail twice, then succeed
        mock_replace.side_effect = [
            PermissionError("File in use"),
            PermissionError("File in use"),
            None,  # Success
        ]
        _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")
        assert mock_replace.call_count == 3
        assert mock_sleep.call_count == 2  # Sleep between retries

    @patch("update_pdf.sys.platform", "win32")
    @patch("update_pdf.time.sleep")
    @patch("update_pdf.os.replace")
    def test_windows_exhausts_retries(self, mock_replace, mock_sleep):
        """Test Windows raises after exhausting all retries."""
        mock_replace.side_effect = PermissionError("File in use")
        with pytest.raises(PermissionError, match="File in use"):
            _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")
        assert mock_replace.call_count == WINDOWS_REPLACE_MAX_RETRIES
        # Sleep is called between retries (max_retries - 1 times)
        assert mock_sleep.call_count == WINDOWS_REPLACE_MAX_RETRIES - 1

    @patch("update_pdf.sys.platform", "win32")
    @patch("update_pdf.time.sleep")
    @patch("update_pdf.os.replace")
    def test_windows_non_permission_error_no_retry(self, mock_replace, mock_sleep):
        """Test Windows does not retry on non-PermissionError OSError."""
        mock_replace.side_effect = OSError("Disk full")
        with pytest.raises(OSError, match="Disk full"):
            _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")
        mock_replace.assert_called_once()
        mock_sleep.assert_not_called()

    @patch("update_pdf.sys.platform", "win32")
    @patch("update_pdf.time.sleep")
    @patch("update_pdf.os.replace")
    def test_windows_exponential_backoff(self, mock_replace, mock_sleep):
        """Test Windows uses exponential backoff for retry delays."""
        # Fail all attempts
        mock_replace.side_effect = PermissionError("File in use")
        with pytest.raises(PermissionError):
            _replace_with_retry("/tmp/temp.pdf", "/output/file.pdf")

        # Verify exponential backoff: 0.1, 0.2, 0.4, 0.8 seconds
        sleep_calls = [call[0][0] for call in mock_sleep.call_args_list]
        assert len(sleep_calls) == WINDOWS_REPLACE_MAX_RETRIES - 1
        # First delay should be initial delay (0.1)
        assert sleep_calls[0] == pytest.approx(0.1)
        # Each subsequent delay should be double the previous
        for i in range(1, len(sleep_calls)):
            assert sleep_calls[i] == pytest.approx(sleep_calls[i-1] * 2.0)


def create_mock_page(width=612, height=792):
    """Helper to create a mock page with rect dimensions (default: US Letter size)."""
    mock_page = MagicMock()
    mock_rect = MagicMock()
    mock_rect.width = width
    mock_rect.height = height
    mock_page.rect = mock_rect
    mock_page.insert_text.return_value = 1
    return mock_page


class TestUpdatePrices:
    """Test update_prices function with mocked PyMuPDF."""

    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.close")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_update_single_price(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_close, mock_mkstemp):
        """Test updating a single price in a PDF."""
        # Setup mocks
        mock_get_font.return_value = None  # Use fallback font
        mock_mkstemp.return_value = (5, "/tmp/update_pdf_test.pdf")  # (fd, path)
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        # Mock Rect
        mock_fitz.Rect.return_value = MagicMock()

        # Mock redaction constants
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.137, 0.122, 0.125],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        # Verify
        mock_fitz.TOOLS.set_small_glyph_heights.assert_called_with(True)
        mock_fitz.open.assert_called_with("input.pdf")
        mock_page.add_redact_annot.assert_called_once()
        mock_page.apply_redactions.assert_called_once()
        mock_page.clean_contents.assert_called_once()
        mock_page.insert_text.assert_called_once()
        mock_doc.save.assert_called_once_with("/tmp/update_pdf_test.pdf", garbage=4, deflate=True)
        mock_replace.assert_called_once_with("/tmp/update_pdf_test.pdf", "output.pdf")

        assert result["success"] is True
        assert len(result["updated"]) == 1
        assert result["updated"][0]["new_text"] == "$650"

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_update_price_with_hr_suffix(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test updating a price with /hr suffix."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 140, 60],
                "new_value": 125,
                "has_hr_suffix": True,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is True
        assert len(result["updated"]) == 1
        assert result["updated"][0]["new_text"] == "$125/hr"

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_update_multiple_prices_same_page(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test updating multiple prices on the same page."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            },
            {
                "id": 1,
                "bbox": [100, 80, 120, 90],
                "new_value": 750,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            },
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is True
        assert len(result["updated"]) == 2
        # Redact should be called twice (once for each price)
        assert mock_page.add_redact_annot.call_count == 2
        # Apply redactions should be called once per page
        assert mock_page.apply_redactions.call_count == 1
        # Insert text should be called twice
        assert mock_page.insert_text.call_count == 2

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_update_prices_multiple_pages(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test updating prices on multiple pages."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page0 = create_mock_page()
        mock_page1 = create_mock_page()
        mock_doc.__getitem__ = Mock(side_effect=lambda x: mock_page0 if x == 0 else mock_page1)
        mock_doc.__len__ = Mock(return_value=2)  # PDF has 2 pages

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            },
            {
                "id": 1,
                "bbox": [100, 50, 120, 60],
                "new_value": 750,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 1,
            },
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is True
        assert len(result["updated"]) == 2
        # Each page should have its redactions applied
        mock_page0.apply_redactions.assert_called_once()
        mock_page1.apply_redactions.assert_called_once()

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_insert_text_failure(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test handling of insert_text failure."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        # Simulate insert_text failure
        mock_page.insert_text.return_value = -1

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        # Should still succeed overall but record error
        assert len(result["errors"]) == 1
        assert "insert_text returned -1" in result["errors"][0]

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_save_failure(self, mock_fitz, mock_get_font, mock_mkstemp, mock_close):
        """Test handling of save failure (I/O error like permission denied)."""
        mock_get_font.return_value = None
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        # Preserve real exception types from fitz module for proper exception handling
        import fitz as real_fitz
        mock_fitz.FileDataError = real_fitz.FileDataError
        mock_fitz.EmptyFileError = real_fitz.EmptyFileError

        # Simulate save failure with OSError (permission denied, disk full, etc.)
        mock_doc.save.side_effect = OSError("Permission denied")

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "Failed to save PDF" in result["errors"][0]

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_uses_calibri_when_available(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test that Calibri font is used when available."""
        calibri_path = CALIBRI_FONT_PATHS.get(sys.platform)
        mock_get_font.return_value = calibri_path
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        mock_page.insert_text.return_value = 1

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.137, 0.122, 0.125],
                "page_num": 0,
            }
        ]

        update_prices("input.pdf", "output.pdf", price_updates)

        # Check that insert_text was called with fontfile parameter
        call_kwargs = mock_page.insert_text.call_args[1]
        assert "fontfile" in call_kwargs
        assert call_kwargs["fontfile"] == calibri_path

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_empty_updates_list(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test handling of empty updates list."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        result = update_prices("input.pdf", "output.pdf", [])

        assert result["success"] is True
        assert len(result["updated"]) == 0
        assert len(result["errors"]) == 0
        mock_doc.save.assert_called_once()

    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.close")
    @patch("update_pdf.os.remove")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_atomic_rename_failure(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_remove, mock_close, mock_mkstemp):
        """Test handling of atomic rename failure with temp file cleanup."""
        mock_get_font.return_value = None
        mock_mkstemp.return_value = (5, "/tmp/update_pdf_test.pdf")  # (fd, path)

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        # Simulate atomic rename failure
        mock_replace.side_effect = OSError("Permission denied")
        mock_exists.return_value = True  # Temp file exists

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "atomic rename failed" in result["errors"][0]
        # Verify temp file cleanup was attempted with the mkstemp-generated path
        mock_remove.assert_called_once_with("/tmp/update_pdf_test.pdf")


class TestPathValidation:
    """Test input/output path validation."""

    def test_rejects_same_input_output_path(self):
        """Test that same input and output paths are rejected to prevent data loss."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        # Use same path for input and output
        result = update_prices("same_file.pdf", "same_file.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "same as input path" in result["errors"][0]
        assert "data loss" in result["errors"][0]

    @patch("update_pdf.os.path.realpath")
    def test_rejects_same_path_via_symlink(self, mock_realpath):
        """Test that paths resolving to the same file (via symlink) are rejected."""
        from update_pdf import update_prices

        # Simulate symlink: different paths resolve to same file
        mock_realpath.side_effect = lambda p: "/real/path/to/file.pdf"

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "symlink_to_input.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "same as input path" in result["errors"][0]


class TestBboxValidation:
    """Test bbox coordinate validation."""

    def test_rejects_nan_coordinates(self):
        """Test that NaN coordinates are rejected."""
        import math
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, float('nan'), 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "NaN" in result["errors"][0]

    def test_rejects_infinite_coordinates(self):
        """Test that infinite coordinates are rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, float('inf'), 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "infinite" in result["errors"][0]

    def test_rejects_negative_coordinates(self):
        """Test that negative coordinates are rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [-10, 50, 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "negative" in result["errors"][0]

    def test_rejects_inverted_x_coordinates(self):
        """Test that x0 >= x1 is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [120, 50, 100, 60],  # x0 > x1
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "x0" in result["errors"][0] and "x1" in result["errors"][0]

    def test_rejects_inverted_y_coordinates(self):
        """Test that y0 >= y1 is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 60, 120, 50],  # y0 > y1
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "y0" in result["errors"][0] and "y1" in result["errors"][0]

    def test_rejects_too_small_dimensions(self):
        """Test that bbox with too small dimensions is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 100.01, 50.01],  # Very tiny rectangle
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "too small" in result["errors"][0]

    def test_rejects_non_numeric_coordinates(self):
        """Test that non-numeric coordinates are rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, "fifty", 120, 60],
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "must be a number" in result["errors"][0]

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_rejects_coordinates_outside_page_bounds(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test that coordinates outside page bounds are rejected."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        # Create page with small dimensions (200x200)
        mock_page = create_mock_page(width=200, height=200)
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 250, 60],  # x1=250 exceeds page width=200
                "new_value": 650,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        # Should fail because partial failures are now surfaced to user
        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "exceeds page width" in result["errors"][0]
        assert len(result["updated"]) == 0


class TestNewValueValidation:
    """Test new_value validation."""

    def test_rejects_nan_new_value(self):
        """Test that NaN new_value is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": float('nan'),
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "new_value" in result["errors"][0]
        assert "NaN" in result["errors"][0]

    def test_rejects_infinite_new_value(self):
        """Test that infinite new_value is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": float('inf'),
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "new_value" in result["errors"][0]
        assert "infinite" in result["errors"][0]

    def test_rejects_negative_infinite_new_value(self):
        """Test that negative infinite new_value is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": float('-inf'),
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "new_value" in result["errors"][0]
        assert "infinite" in result["errors"][0]

    def test_rejects_zero_new_value(self):
        """Test that zero new_value is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 0,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "new_value" in result["errors"][0]
        assert "positive" in result["errors"][0]

    def test_rejects_negative_new_value(self):
        """Test that negative new_value is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": -100,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "new_value" in result["errors"][0]
        assert "positive" in result["errors"][0]

    def test_rejects_non_numeric_new_value(self):
        """Test that non-numeric new_value is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": "six hundred",
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "new_value" in result["errors"][0]
        assert "must be a number" in result["errors"][0]

    def test_rejects_excessively_large_new_value(self):
        """Test that new_value exceeding 10 million is rejected."""
        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 10_000_001,
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is False
        assert len(result["errors"]) == 1
        assert "new_value" in result["errors"][0]
        assert "exceeds maximum" in result["errors"][0]

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_accepts_valid_new_value(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test that valid new_value is accepted."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 10_000_000,  # Maximum allowed
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is True
        assert len(result["updated"]) == 1
        assert result["updated"][0]["new_text"] == "$10,000,000"

    @patch("update_pdf.os.close")
    @patch("update_pdf.tempfile.mkstemp")
    @patch("update_pdf.os.path.getsize")
    @patch("update_pdf.os.path.exists")
    @patch("update_pdf.os.replace")
    @patch("update_pdf.get_font_path")
    @patch("update_pdf.fitz")
    def test_accepts_small_positive_new_value(self, mock_fitz, mock_get_font, mock_replace, mock_exists, mock_getsize, mock_mkstemp, mock_close):
        """Test that small positive new_value is accepted."""
        mock_get_font.return_value = None
        mock_exists.return_value = True  # Output file exists after save
        mock_getsize.return_value = 1024  # Output file has content
        mock_mkstemp.return_value = (999, "/tmp/mock_update_pdf.pdf")

        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__.return_value = mock_doc

        mock_page = create_mock_page()
        mock_doc.__getitem__ = Mock(return_value=mock_page)
        mock_doc.__len__ = Mock(return_value=1)  # PDF has 1 page

        mock_fitz.Rect.return_value = MagicMock()
        mock_fitz.PDF_REDACT_IMAGE_NONE = 0
        mock_fitz.PDF_REDACT_LINE_ART_NONE = 0

        from update_pdf import update_prices

        price_updates = [
            {
                "id": 0,
                "bbox": [100, 50, 120, 60],
                "new_value": 0.01,  # Small positive value
                "has_hr_suffix": False,
                "font_size": 8.0,
                "color": [0.0, 0.0, 0.0],
                "page_num": 0,
            }
        ]

        result = update_prices("input.pdf", "output.pdf", price_updates)

        assert result["success"] is True
        assert len(result["updated"]) == 1
        assert result["updated"][0]["new_text"] == "$0.01"