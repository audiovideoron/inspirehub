"""
Extract prices from PDF with their positions and descriptions.
"""
import re
import fitz  # PyMuPDF
from dataclasses import dataclass
from typing import List, Optional
import logging

logger = logging.getLogger(__name__)

# Price pattern: $X, $X.XX, $X,XXX, $X/hr, etc.
# Negative lookahead (?!-) ensures no negative prices like '$-500'
# Negative lookahead (?!0(?:[.,]0*)?(?:/hr)?$) prevents zero-dollar amounts like '$0', '$0.00'
PRICE_PATTERN = re.compile(r'\$(?!-)(?!0(?:[.,]0*)?(?:/hr)?$)[\d,]+(?:\.\d{2})?(?:/hr)?')


@dataclass
class PriceItem:
    """A price found in the PDF with its metadata."""
    id: int
    text: str  # e.g., "$600" or "$110/hr"
    numeric_value: float  # e.g., 600.0 or 110.0
    has_hr_suffix: bool  # True if "/hr" suffix
    description: str  # Associated description text
    bbox: tuple  # (x0, y0, x1, y1)
    page_num: int
    font_size: float
    color: tuple  # RGB tuple (r, g, b)


# Maximum reasonable price value to prevent overflow issues
# Must match the limit in update_pdf.py to ensure loaded prices can be exported
MAX_PRICE_VALUE = 10_000_000  # 10 million


def parse_price_value(text: str) -> tuple:
    """Parse price text to get numeric value and suffix info.

    Args:
        text: Price text to parse (e.g., "$600", "$110/hr", "$1,000.00")

    Returns:
        Tuple of (numeric_value, has_hr_suffix)

    Raises:
        ValueError: If the text cannot be parsed as a valid price,
                   if the value is negative, or if it exceeds MAX_PRICE_VALUE
    """
    has_hr = text.endswith('/hr')
    # Remove $ and /hr, then parse number
    clean = text.replace('$', '').replace('/hr', '').replace(',', '')
    try:
        value = float(clean)
    except ValueError:
        raise ValueError(f"Failed to parse price value from text: '{text}'")

    # Validate numeric range
    if value < 0:
        raise ValueError(f"Price value cannot be negative: {value}")
    if value > MAX_PRICE_VALUE:
        raise ValueError(f"Price value exceeds maximum allowed ({MAX_PRICE_VALUE}): {value}")

    return value, has_hr


def color_int_to_rgb(color_int: int) -> tuple:
    """Convert integer color to RGB tuple (0-1 range)."""
    r = ((color_int >> 16) & 0xFF) / 255
    g = ((color_int >> 8) & 0xFF) / 255
    b = (color_int & 0xFF) / 255
    return (r, g, b)


def find_description_for_price(price_bbox: tuple, all_spans: list, tolerance: float = 5.0) -> str:
    """
    Find the description text associated with a price.

    Strategy:
    1. Look for text on the same line (within tolerance) to the LEFT of the price
    2. If none found, look for nearest text block ABOVE the price
    """
    px0, py0, px1, py1 = price_bbox
    price_center_y = (py0 + py1) / 2

    # Collect candidate descriptions
    same_line_candidates = []
    above_candidates = []

    for span in all_spans:
        text = span['text'].strip()
        if not text or PRICE_PATTERN.match(text):
            # Skip empty or price texts
            continue

        sx0, sy0, sx1, sy1 = span['bbox']
        span_center_y = (sy0 + sy1) / 2

        # Check if on same line (within tolerance) and to the LEFT
        if abs(span_center_y - price_center_y) <= tolerance and sx1 < px0:
            # Distance from span's right edge to price's left edge
            distance = px0 - sx1
            same_line_candidates.append((distance, text, span['bbox']))

        # Check if above the price
        elif sy1 < py0 and sx0 < px1 and sx1 > px0:
            # Vertically above and horizontally overlapping
            distance = py0 - sy1
            above_candidates.append((distance, text, span['bbox']))

    # Prefer same-line candidates (closest one)
    if same_line_candidates:
        same_line_candidates.sort(key=lambda x: x[0])
        return same_line_candidates[0][1]

    # Fall back to above candidates (closest one)
    if above_candidates:
        above_candidates.sort(key=lambda x: x[0])
        return above_candidates[0][1]

    return "Unknown item"


def extract_prices(pdf_path: str) -> List[PriceItem]:
    """
    Extract all prices from the PDF.

    Returns list of PriceItem objects with unique IDs, descriptions, and metadata.
    """
    # CRITICAL: Set small glyph heights to prevent bbox overlap
    # This prevents redaction from affecting neighboring text
    fitz.TOOLS.set_small_glyph_heights(True)

    logger.info(f"Opening PDF: {pdf_path}")
    prices = []
    price_id = 0

    with fitz.open(pdf_path) as doc:
        for page_num, page in enumerate(doc):
            logger.info(f"Processing page {page_num + 1}")

            # Get all text with detailed info
            blocks = page.get_text('dict')['blocks']

            # Collect all spans for description lookup
            all_spans = []
            for block in blocks:
                if 'lines' in block:
                    for line in block['lines']:
                        for span in line['spans']:
                            if span['text'].strip():
                                all_spans.append(span)

            # Find prices
            for block in blocks:
                if 'lines' not in block:
                    continue

                for line in block['lines']:
                    for span in line['spans']:
                        text = span['text'].strip()

                        if PRICE_PATTERN.fullmatch(text):
                            bbox = span['bbox']
                            font_size = span['size']
                            color_int = span['color']
                            color_rgb = color_int_to_rgb(color_int)

                            try:
                                numeric_value, has_hr = parse_price_value(text)
                            except ValueError as e:
                                logger.warning(f"Skipping unparseable price: {e}")
                                continue
                            description = find_description_for_price(bbox, all_spans)

                            item = PriceItem(
                                id=price_id,
                                text=text,
                                numeric_value=numeric_value,
                                has_hr_suffix=has_hr,
                                description=description,
                                bbox=bbox,
                                page_num=page_num,
                                font_size=font_size,
                                color=color_rgb
                            )
                            prices.append(item)

                            logger.debug(
                                f"Found price #{price_id}: {text} "
                                f"desc='{description[:30]}...' "
                                f"bbox={bbox} size={font_size}"
                            )
                            price_id += 1

    logger.info(f"Found {len(prices)} prices total")
    return prices


def prices_to_json(prices: List[PriceItem]) -> list:
    """Convert list of PriceItem to JSON-serializable list."""
    return [
        {
            'id': p.id,
            'text': p.text,
            'numeric_value': p.numeric_value,
            'has_hr_suffix': p.has_hr_suffix,
            'description': p.description,
            'bbox': list(p.bbox),
            'page_num': p.page_num,
            'font_size': p.font_size,
            'color': list(p.color)
        }
        for p in prices
    ]


if __name__ == '__main__':
    # Test extraction
    import sys
    logging.basicConfig(level=logging.DEBUG)

    pdf_path = sys.argv[1] if len(sys.argv) > 1 else 'AV Inspire 2025 Price List.pdf'
    prices = extract_prices(pdf_path)

    print(f"\nExtracted {len(prices)} prices:\n")
    for p in prices:
        print(f"#{p.id}: {p.text:10} | {p.description[:40]:40} | page {p.page_num + 1}")
