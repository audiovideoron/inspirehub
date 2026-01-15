"""
Unit tests for extract_prices.py

Tests the core price extraction functions using mocked PyMuPDF objects.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from extract_prices import (
    parse_price_value,
    color_int_to_rgb,
    find_description_for_price,
    prices_to_json,
    PriceItem,
    PRICE_PATTERN,
)


class TestPricePattern:
    """Test the PRICE_PATTERN regex."""

    def test_simple_price(self):
        """Test matching simple dollar amounts."""
        assert PRICE_PATTERN.fullmatch("$600")
        assert PRICE_PATTERN.fullmatch("$50")
        assert PRICE_PATTERN.fullmatch("$1")

    def test_price_with_cents(self):
        """Test matching prices with cents."""
        assert PRICE_PATTERN.fullmatch("$600.00")
        assert PRICE_PATTERN.fullmatch("$50.99")
        assert PRICE_PATTERN.fullmatch("$1.50")

    def test_price_with_commas(self):
        """Test matching prices with thousand separators."""
        assert PRICE_PATTERN.fullmatch("$1,000")
        assert PRICE_PATTERN.fullmatch("$10,000")
        assert PRICE_PATTERN.fullmatch("$1,000,000")

    def test_price_with_hr_suffix(self):
        """Test matching hourly rates."""
        assert PRICE_PATTERN.fullmatch("$110/hr")
        assert PRICE_PATTERN.fullmatch("$50/hr")
        assert PRICE_PATTERN.fullmatch("$1,000/hr")

    def test_invalid_prices(self):
        """Test that invalid formats don't match."""
        assert not PRICE_PATTERN.fullmatch("600")  # No dollar sign
        assert not PRICE_PATTERN.fullmatch("$")  # No amount
        assert not PRICE_PATTERN.fullmatch("$600.5")  # Only one decimal place
        assert not PRICE_PATTERN.fullmatch("$600/hour")  # Wrong suffix

    def test_negative_prices_rejected(self):
        """Test that negative prices are not matched."""
        assert not PRICE_PATTERN.fullmatch("$-500")  # Negative after dollar sign
        assert not PRICE_PATTERN.fullmatch("$-100.00")  # Negative with cents
        assert not PRICE_PATTERN.fullmatch("$-1,000")  # Negative with comma
        assert not PRICE_PATTERN.fullmatch("$-50/hr")  # Negative hourly rate
        assert not PRICE_PATTERN.fullmatch("-$500")  # Negative before dollar sign


class TestParsePriceValue:
    """Test parse_price_value function."""

    def test_simple_price(self):
        """Test parsing simple dollar amounts."""
        value, has_hr = parse_price_value("$600")
        assert value == 600.0
        assert has_hr is False

    def test_price_with_cents(self):
        """Test parsing prices with cents."""
        value, has_hr = parse_price_value("$600.50")
        assert value == 600.50
        assert has_hr is False

    def test_price_with_commas(self):
        """Test parsing prices with thousand separators."""
        value, has_hr = parse_price_value("$1,000")
        assert value == 1000.0
        assert has_hr is False

        value, has_hr = parse_price_value("$10,000")
        assert value == 10000.0
        assert has_hr is False

    def test_price_with_hr_suffix(self):
        """Test parsing hourly rates."""
        value, has_hr = parse_price_value("$110/hr")
        assert value == 110.0
        assert has_hr is True

    def test_invalid_price(self):
        """Test parsing invalid price raises ValueError."""
        with pytest.raises(ValueError) as exc_info:
            parse_price_value("$invalid")
        assert "Failed to parse price value" in str(exc_info.value)
        assert "$invalid" in str(exc_info.value)


class TestColorIntToRgb:
    """Test color_int_to_rgb function."""

    def test_black(self):
        """Test black color conversion."""
        r, g, b = color_int_to_rgb(0x000000)
        assert r == 0.0
        assert g == 0.0
        assert b == 0.0

    def test_white(self):
        """Test white color conversion."""
        r, g, b = color_int_to_rgb(0xFFFFFF)
        assert r == 1.0
        assert g == 1.0
        assert b == 1.0

    def test_red(self):
        """Test red color conversion."""
        r, g, b = color_int_to_rgb(0xFF0000)
        assert r == 1.0
        assert g == 0.0
        assert b == 0.0

    def test_green(self):
        """Test green color conversion."""
        r, g, b = color_int_to_rgb(0x00FF00)
        assert r == 0.0
        assert g == 1.0
        assert b == 0.0

    def test_blue(self):
        """Test blue color conversion."""
        r, g, b = color_int_to_rgb(0x0000FF)
        assert r == 0.0
        assert g == 0.0
        assert b == 1.0

    def test_mixed_color(self):
        """Test mixed color conversion."""
        r, g, b = color_int_to_rgb(0x231F20)  # Dark gray from the PDF
        assert abs(r - 0.137) < 0.01
        assert abs(g - 0.122) < 0.01
        assert abs(b - 0.125) < 0.01


class TestFindDescriptionForPrice:
    """Test find_description_for_price function."""

    def test_find_description_on_same_line(self):
        """Test finding description text on the same line to the left."""
        price_bbox = (100, 50, 120, 60)  # Price at x=100-120, y=50-60
        all_spans = [
            {"text": "LCD Projector Package", "bbox": (20, 50, 95, 60)},  # Left of price
            {"text": "$600", "bbox": (100, 50, 120, 60)},  # The price itself
        ]
        desc = find_description_for_price(price_bbox, all_spans)
        assert desc == "LCD Projector Package"

    def test_find_description_above_price(self):
        """Test finding description text above the price."""
        price_bbox = (100, 100, 120, 110)  # Price at y=100-110
        all_spans = [
            {"text": "Service Description", "bbox": (90, 80, 130, 90)},  # Above price
            {"text": "$600", "bbox": (100, 100, 120, 110)},  # The price itself
        ]
        desc = find_description_for_price(price_bbox, all_spans)
        assert desc == "Service Description"

    def test_prefer_same_line_over_above(self):
        """Test that same-line descriptions are preferred over above."""
        price_bbox = (100, 100, 120, 110)
        all_spans = [
            {"text": "Above Text", "bbox": (90, 80, 130, 90)},  # Above
            {"text": "Same Line Text", "bbox": (20, 100, 95, 110)},  # Same line, left
            {"text": "$600", "bbox": (100, 100, 120, 110)},
        ]
        desc = find_description_for_price(price_bbox, all_spans)
        assert desc == "Same Line Text"

    def test_unknown_item_when_no_description(self):
        """Test that 'Unknown item' is returned when no description found."""
        price_bbox = (100, 100, 120, 110)
        all_spans = [
            {"text": "$600", "bbox": (100, 100, 120, 110)},  # Only the price
        ]
        desc = find_description_for_price(price_bbox, all_spans)
        assert desc == "Unknown item"

    def test_skip_price_patterns_as_description(self):
        """Test that price patterns are not used as descriptions."""
        price_bbox = (100, 100, 120, 110)
        all_spans = [
            {"text": "$500", "bbox": (20, 100, 40, 110)},  # Another price to the left
            {"text": "$600", "bbox": (100, 100, 120, 110)},
        ]
        desc = find_description_for_price(price_bbox, all_spans)
        assert desc == "Unknown item"


class TestPricesToJson:
    """Test prices_to_json function."""

    def test_convert_single_price(self):
        """Test converting a single PriceItem to JSON."""
        price = PriceItem(
            id=0,
            text="$600",
            numeric_value=600.0,
            has_hr_suffix=False,
            description="LCD Projector Package",
            bbox=(100, 50, 120, 60),
            page_num=0,
            font_size=8.0,
            color=(0.137, 0.122, 0.125),
        )
        result = prices_to_json([price])
        assert len(result) == 1
        assert result[0]["id"] == 0
        assert result[0]["text"] == "$600"
        assert result[0]["numeric_value"] == 600.0
        assert result[0]["has_hr_suffix"] is False
        assert result[0]["description"] == "LCD Projector Package"
        assert result[0]["bbox"] == [100, 50, 120, 60]
        assert result[0]["page_num"] == 0
        assert result[0]["font_size"] == 8.0
        assert result[0]["color"] == [0.137, 0.122, 0.125]

    def test_convert_multiple_prices(self):
        """Test converting multiple PriceItems to JSON."""
        prices = [
            PriceItem(
                id=0,
                text="$600",
                numeric_value=600.0,
                has_hr_suffix=False,
                description="Item 1",
                bbox=(100, 50, 120, 60),
                page_num=0,
                font_size=8.0,
                color=(0.0, 0.0, 0.0),
            ),
            PriceItem(
                id=1,
                text="$110/hr",
                numeric_value=110.0,
                has_hr_suffix=True,
                description="Item 2",
                bbox=(100, 80, 130, 90),
                page_num=0,
                font_size=8.0,
                color=(0.0, 0.0, 0.0),
            ),
        ]
        result = prices_to_json(prices)
        assert len(result) == 2
        assert result[0]["text"] == "$600"
        assert result[1]["text"] == "$110/hr"
        assert result[1]["has_hr_suffix"] is True

    def test_empty_list(self):
        """Test converting empty list."""
        result = prices_to_json([])
        assert result == []


class TestExtractPrices:
    """Test extract_prices function with mocked PyMuPDF."""

    @patch("extract_prices.fitz")
    def test_extract_prices_basic(self, mock_fitz):
        """Test basic price extraction with mocked PDF."""
        # Set up mock document with context manager support
        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__ = Mock(return_value=mock_doc)
        mock_fitz.open.return_value.__exit__ = Mock(return_value=False)

        # Set up mock page
        mock_page = MagicMock()
        mock_doc.__iter__ = Mock(return_value=iter([mock_page]))

        # Set up mock text blocks
        mock_page.get_text.return_value = {
            "blocks": [
                {
                    "lines": [
                        {
                            "spans": [
                                {
                                    "text": "LCD Projector Package",
                                    "bbox": (20, 50, 95, 60),
                                    "size": 8.0,
                                    "color": 0x231F20,
                                },
                                {
                                    "text": "$600",
                                    "bbox": (100, 50, 120, 60),
                                    "size": 8.0,
                                    "color": 0x231F20,
                                },
                            ]
                        }
                    ]
                }
            ]
        }

        # Import and call the function
        from extract_prices import extract_prices

        prices = extract_prices("test.pdf")

        # Verify
        mock_fitz.TOOLS.set_small_glyph_heights.assert_called_with(True)
        mock_fitz.open.assert_called_with("test.pdf")
        assert len(prices) == 1
        assert prices[0].text == "$600"
        assert prices[0].numeric_value == 600.0
        assert prices[0].description == "LCD Projector Package"
        # Context manager ensures cleanup via __exit__, not explicit close()
        mock_fitz.open.return_value.__exit__.assert_called_once()

    @patch("extract_prices.fitz")
    def test_extract_prices_multiple_pages(self, mock_fitz):
        """Test extraction from multiple pages."""
        mock_doc = MagicMock()
        mock_fitz.open.return_value.__enter__ = Mock(return_value=mock_doc)
        mock_fitz.open.return_value.__exit__ = Mock(return_value=False)

        # Two pages
        mock_page1 = MagicMock()
        mock_page2 = MagicMock()
        mock_doc.__iter__ = Mock(return_value=iter([mock_page1, mock_page2]))

        mock_page1.get_text.return_value = {
            "blocks": [
                {
                    "lines": [
                        {
                            "spans": [
                                {"text": "$100", "bbox": (100, 50, 120, 60), "size": 8.0, "color": 0},
                            ]
                        }
                    ]
                }
            ]
        }

        mock_page2.get_text.return_value = {
            "blocks": [
                {
                    "lines": [
                        {
                            "spans": [
                                {"text": "$200", "bbox": (100, 50, 120, 60), "size": 8.0, "color": 0},
                            ]
                        }
                    ]
                }
            ]
        }

        from extract_prices import extract_prices

        prices = extract_prices("test.pdf")

        assert len(prices) == 2
        assert prices[0].text == "$100"
        assert prices[0].page_num == 0
        assert prices[1].text == "$200"
        assert prices[1].page_num == 1
