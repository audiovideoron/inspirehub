"""
Update PDF prices using redaction with graphics preservation.
Uses tight bounding boxes and fill=False to avoid visible white rectangles.
"""
import os
import sys
import math
import tempfile
import time
import fitz  # PyMuPDF
from typing import List, Dict, Optional
import logging

logger = logging.getLogger(__name__)

# Calibri font paths (from Microsoft Office) by platform
CALIBRI_FONT_PATHS = {
    "darwin": "/Applications/Microsoft Word.app/Contents/Resources/DFonts/Calibri.ttf",  # macOS
    "win32": "C:/Windows/Fonts/calibri.ttf",  # Windows
}

# Fallback font if Calibri not found
FALLBACK_FONT = "helv"  # Helvetica, built into PyMuPDF

# Minimum acceptable bbox dimension (in points)
MIN_BBOX_DIMENSION = 0.1

# Baseline offset factor for text insertion positioning.
# This value is multiplied by font_size to calculate the vertical offset from
# the bottom of the bounding box to the text baseline. The default of 0.2 works
# well for Calibri and Helvetica, but may need adjustment for fonts with
# different ascender/descender ratios or unusual metrics.
BASELINE_OFFSET_FACTOR = 0.2

# Windows file replacement retry configuration.
# On Windows, os.replace() may fail if the target file is open by another process
# (e.g., a PDF viewer). We retry with exponential backoff to handle transient locks.
WINDOWS_REPLACE_MAX_RETRIES = 5
WINDOWS_REPLACE_INITIAL_DELAY = 0.1  # seconds
WINDOWS_REPLACE_BACKOFF_FACTOR = 2.0


def get_font_path() -> Optional[str]:
    """Get the font file path, with fallback.

    Returns the path to Calibri font if found for the current platform,
    or None to use the built-in Helvetica fallback.
    """
    # Get platform-specific font path
    platform = sys.platform
    font_path = CALIBRI_FONT_PATHS.get(platform)

    if font_path and os.path.exists(font_path):
        logger.info(f"Using Calibri font: {font_path}")
        return font_path

    # Log appropriate warning based on whether path was defined for platform
    if font_path:
        logger.warning(f"Calibri font not found at {font_path}, using Helvetica fallback")
    else:
        logger.warning(f"No Calibri font path defined for platform '{platform}', using Helvetica fallback")

    return None  # Will use built-in font


def format_new_price(new_value: float, has_hr_suffix: bool) -> str:
    """
    Format a new price value to match expected format.

    - Adds $ prefix
    - Adds commas for thousands
    - Preserves /hr suffix if original had it

    Raises:
        ValueError: If new_value is NaN, infinity, or negative
    """
    # Validate new_value is a finite, positive number
    if not isinstance(new_value, (int, float)):
        raise ValueError(f"new_value must be a number, got {type(new_value).__name__}")
    if math.isnan(new_value):
        raise ValueError("new_value cannot be NaN")
    if math.isinf(new_value):
        raise ValueError("new_value cannot be infinite")
    if new_value < 0:
        raise ValueError(f"new_value must be non-negative, got {new_value}")

    # Format with commas, no decimal places for whole numbers
    if new_value == int(new_value):
        formatted = f"${int(new_value):,}"
    else:
        formatted = f"${new_value:,.2f}"

    if has_hr_suffix:
        formatted += "/hr"

    return formatted


def _replace_with_retry(temp_path: str, output_path: str) -> None:
    """
    Atomically replace output_path with temp_path, with retry logic for Windows.

    On Windows, os.replace() may fail with PermissionError if the target file
    is open by another process (e.g., a PDF viewer). This function retries
    with exponential backoff to handle transient file locks.

    On non-Windows platforms, this is a simple os.replace() call.

    Args:
        temp_path: Path to the temporary file to move
        output_path: Target path to replace

    Raises:
        OSError: If the replacement fails after all retries (Windows)
                 or on first attempt (non-Windows)
    """
    if sys.platform != 'win32':
        # Non-Windows: single attempt, no retry
        os.replace(temp_path, output_path)
        return

    # Windows: retry with exponential backoff
    last_error = None
    delay = WINDOWS_REPLACE_INITIAL_DELAY

    for attempt in range(WINDOWS_REPLACE_MAX_RETRIES):
        try:
            os.replace(temp_path, output_path)
            if attempt > 0:
                logger.info(f"os.replace succeeded on attempt {attempt + 1}")
            return
        except PermissionError as e:
            last_error = e
            if attempt < WINDOWS_REPLACE_MAX_RETRIES - 1:
                logger.warning(
                    f"os.replace failed (attempt {attempt + 1}/{WINDOWS_REPLACE_MAX_RETRIES}): {e}. "
                    f"Retrying in {delay:.2f}s..."
                )
                time.sleep(delay)
                delay *= WINDOWS_REPLACE_BACKOFF_FACTOR
            else:
                logger.error(
                    f"os.replace failed after {WINDOWS_REPLACE_MAX_RETRIES} attempts: {e}"
                )
        except OSError:
            # Non-permission errors (e.g., disk full) should not be retried
            raise

    # All retries exhausted
    raise last_error


def update_prices(
    input_pdf_path: str,
    output_pdf_path: str,
    price_updates: List[Dict]
) -> Dict:
    """
    Update prices in a PDF using a hybrid approach:
    1. Use redaction with minimal footprint (small glyph heights)
    2. Preserve all graphics and images

    Args:
        input_pdf_path: Path to input PDF
        output_pdf_path: Path to save updated PDF
        price_updates: List of dicts with keys:
            - id: price ID
            - bbox: [x0, y0, x1, y1]
            - new_value: new numeric value
            - has_hr_suffix: bool
            - font_size: original font size
            - color: [r, g, b] tuple
            - page_num: page number (0-indexed)

    Returns:
        Dict with success status and details
    """
    # CRITICAL: Prevent overwriting the original PDF
    # Resolve paths to handle symlinks, relative paths, and normalize for comparison
    resolved_input = os.path.realpath(input_pdf_path)
    resolved_output = os.path.realpath(output_pdf_path)
    if resolved_input == resolved_output:
        error_msg = (
            f"Output path cannot be the same as input path: '{input_pdf_path}'. "
            "This would overwrite the original PDF and cause data loss."
        )
        logger.error(error_msg)
        return {
            'success': False,
            'updated': [],
            'errors': [error_msg]
        }

    # Validate input: check each update has required fields with correct types
    required_fields = ['bbox', 'new_value', 'page_num', 'font_size', 'color']
    for i, update in enumerate(price_updates):
        # Check for missing required fields
        for field in required_fields:
            if field not in update:
                return {
                    'success': False,
                    'updated': [],
                    'errors': [f"Update at index {i} missing required field '{field}'"]
                }

        # Validate bbox has exactly 4 elements
        bbox = update['bbox']
        price_id = update.get('id')
        id_str = f" (price #{price_id})" if price_id is not None else ""

        if not isinstance(bbox, (list, tuple)):
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'bbox' must be a list or tuple, got {type(bbox).__name__}"]
            }
        if len(bbox) != 4:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'bbox' must have exactly 4 elements (x0, y0, x1, y1), got {len(bbox)}"]
            }

        # Validate bbox coordinate values (non-page-bound checks)
        x0, y0, x1, y1 = bbox

        # Check for NaN or infinity values
        for coord_idx, coord in enumerate([x0, y0, x1, y1]):
            coord_names = ['x0', 'y0', 'x1', 'y1']
            if not isinstance(coord, (int, float)):
                return {
                    'success': False,
                    'updated': [],
                    'errors': [f"Update at index {i}{id_str}: bbox {coord_names[coord_idx]} must be a number, got {type(coord).__name__}"]
                }
            if math.isnan(coord):
                return {
                    'success': False,
                    'updated': [],
                    'errors': [f"Update at index {i}{id_str}: bbox {coord_names[coord_idx]} is NaN"]
                }
            if math.isinf(coord):
                return {
                    'success': False,
                    'updated': [],
                    'errors': [f"Update at index {i}{id_str}: bbox {coord_names[coord_idx]} is infinite"]
                }

        # Check for negative coordinates
        if x0 < 0 or y0 < 0 or x1 < 0 or y1 < 0:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: bbox contains negative coordinates [{x0}, {y0}, {x1}, {y1}]"]
            }

        # Check that x0 < x1 and y0 < y1 (valid rectangle with positive dimensions)
        if x0 >= x1:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: bbox x0 ({x0}) must be less than x1 ({x1})"]
            }
        if y0 >= y1:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: bbox y0 ({y0}) must be less than y1 ({y1})"]
            }

        # Check minimum dimensions
        width = x1 - x0
        height = y1 - y0
        if width < MIN_BBOX_DIMENSION:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: bbox width ({width}) is too small (minimum: {MIN_BBOX_DIMENSION})"]
            }
        if height < MIN_BBOX_DIMENSION:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: bbox height ({height}) is too small (minimum: {MIN_BBOX_DIMENSION})"]
            }

        # Validate font_size is a positive number
        font_size = update['font_size']
        if not isinstance(font_size, (int, float)):
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'font_size' must be a number, got {type(font_size).__name__}"]
            }
        if math.isnan(font_size) or math.isinf(font_size):
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'font_size' must be a finite number"]
            }
        if font_size <= 0:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'font_size' must be positive, got {font_size}"]
            }

        # Validate new_value is a positive finite number within reasonable range
        new_value = update['new_value']
        if not isinstance(new_value, (int, float)):
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'new_value' must be a number, got {type(new_value).__name__}"]
            }
        if math.isnan(new_value):
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'new_value' is NaN"]
            }
        if math.isinf(new_value):
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'new_value' is infinite"]
            }
        if new_value <= 0:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'new_value' must be positive, got {new_value}"]
            }
        # Cap at a reasonable maximum (10 million) to prevent formatting issues
        if new_value > 10_000_000:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'new_value' exceeds maximum allowed (10,000,000), got {new_value}"]
            }

        # Validate color has exactly 3 elements with valid RGB values
        color = update['color']
        if not isinstance(color, (list, tuple)):
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'color' must be a list or tuple, got {type(color).__name__}"]
            }
        if len(color) != 3:
            return {
                'success': False,
                'updated': [],
                'errors': [f"Update at index {i}{id_str}: 'color' must have exactly 3 elements (r, g, b), got {len(color)}"]
            }
        # Validate each RGB component is numeric and in valid range [0, 1]
        color_names = ['red', 'green', 'blue']
        for color_idx, component in enumerate(color):
            if not isinstance(component, (int, float)):
                return {
                    'success': False,
                    'updated': [],
                    'errors': [f"Update at index {i}{id_str}: color {color_names[color_idx]} must be a number, got {type(component).__name__}"]
                }
            if math.isnan(component) or math.isinf(component):
                return {
                    'success': False,
                    'updated': [],
                    'errors': [f"Update at index {i}{id_str}: color {color_names[color_idx]} must be a finite number"]
                }
            if component < 0 or component > 1:
                return {
                    'success': False,
                    'updated': [],
                    'errors': [f"Update at index {i}{id_str}: color {color_names[color_idx]} ({component}) must be in range [0, 1]"]
                }

    # CRITICAL: Set small glyph heights BEFORE any text operations
    # This makes text bboxes match font size exactly, preventing overlap
    fitz.TOOLS.set_small_glyph_heights(True)

    logger.info(f"Updating {len(price_updates)} prices in {input_pdf_path}")

    results = {
        'success': True,
        'updated': [],
        'errors': []
    }

    # Get font
    font_path = get_font_path()

    # Open PDF using context manager to ensure proper cleanup
    with fitz.open(input_pdf_path) as doc:
        # Group updates by page
        updates_by_page = {}
        for update in price_updates:
            page_num = update['page_num']
            if page_num not in updates_by_page:
                updates_by_page[page_num] = []
            updates_by_page[page_num].append(update)

        # Process each page
        for page_num, updates in updates_by_page.items():
            # Validate page_num is within valid range
            if not isinstance(page_num, int):
                error_msg = f"Invalid page_num type: expected int, got {type(page_num).__name__}"
                logger.error(error_msg)
                results['errors'].append(error_msg)
                results['success'] = False
                continue
            if page_num < 0 or page_num >= len(doc):
                error_msg = f"page_num {page_num} is out of range (PDF has {len(doc)} pages, valid range: 0-{len(doc) - 1})"
                logger.error(error_msg)
                results['errors'].append(error_msg)
                results['success'] = False
                continue

            page = doc[page_num]
            page_rect = page.rect
            page_width = page_rect.width
            page_height = page_rect.height
            logger.info(f"Processing page {page_num + 1} ({page_width}x{page_height}) with {len(updates)} updates")

            # Validate bbox coordinates are within page bounds before processing
            valid_updates = []
            for update in updates:
                bbox = update['bbox']
                x0, y0, x1, y1 = bbox
                price_id = update.get('id')
                id_str = f" (price #{price_id})" if price_id is not None else ""

                # Allow small tolerance for floating point edge cases
                tolerance = 1.0

                if x1 > page_width + tolerance:
                    error_msg = f"Page {page_num + 1}{id_str}: bbox x1 ({x1}) exceeds page width ({page_width})"
                    logger.error(error_msg)
                    results['errors'].append(error_msg)
                    results['success'] = False  # Surface partial failure to user
                    continue

                if y1 > page_height + tolerance:
                    error_msg = f"Page {page_num + 1}{id_str}: bbox y1 ({y1}) exceeds page height ({page_height})"
                    logger.error(error_msg)
                    results['errors'].append(error_msg)
                    results['success'] = False  # Surface partial failure to user
                    continue

                valid_updates.append(update)

            # For each price update, use a tighter bbox to minimize redaction area
            for update in valid_updates:
                try:
                    bbox = update['bbox']

                    # Create a slightly tighter rect (reduce height by 10% from top and bottom)
                    # This follows the GitHub recommendation to use smaller sub-bbox
                    x0, y0, x1, y1 = bbox
                    height = y1 - y0
                    margin = height * 0.1  # 10% margin reduction
                    tight_rect = fitz.Rect(x0, y0 + margin, x1, y1 - margin)

                    # Add redaction with no fill color
                    # fill=False should mean transparent, but we also set fill color explicitly
                    page.add_redact_annot(tight_rect, fill=False)
                    logger.debug(f"Added redaction for price #{update['id']} at {list(tight_rect)}")

                except (fitz.FileDataError, fitz.EmptyFileError) as e:
                    # PDF corruption errors - re-raise as these indicate document-level problems
                    error_msg = f"PDF corruption during redaction for price #{update['id']}: {type(e).__name__}: {e}"
                    logger.error(error_msg)
                    raise
                except ValueError as e:
                    # Invalid bbox coordinates or parameters
                    error_msg = f"Invalid parameters for redaction on price #{update['id']}: {type(e).__name__}: {e}"
                    logger.error(error_msg)
                    results['errors'].append(error_msg)
                    results['success'] = False  # Surface partial failure to user
                except (TypeError, AttributeError) as e:
                    # Type errors from malformed update data
                    error_msg = f"Malformed update data for price #{update['id']}: {type(e).__name__}: {e}"
                    logger.error(error_msg)
                    results['errors'].append(error_msg)
                    results['success'] = False  # Surface partial failure to user

            # Apply all redactions at once with options to preserve graphics
            # PDF_REDACT_IMAGE_NONE = keep images
            # PDF_REDACT_LINE_ART_NONE = keep vector graphics
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE
            )
            logger.debug("Applied redactions with graphics preservation")

            # Clean up the page contents to remove any residual artifacts
            page.clean_contents()

            # Now insert new text for each update (only valid ones)
            for update in valid_updates:
                try:
                    bbox = update['bbox']
                    new_value = update['new_value']
                    has_hr = update.get('has_hr_suffix', False)
                    font_size = update['font_size']
                    color = tuple(update['color'])

                    # Format the new price text
                    new_text = format_new_price(new_value, has_hr)

                    # Calculate insertion point (bottom-left, adjusted for baseline)
                    # The y-coordinate needs adjustment based on font size
                    baseline_offset = font_size * BASELINE_OFFSET_FACTOR
                    insert_point = (bbox[0], bbox[3] - baseline_offset)

                    # Insert new text
                    if font_path:
                        rc = page.insert_text(
                            insert_point,
                            new_text,
                            fontfile=font_path,
                            fontsize=font_size,
                            color=color
                        )
                    else:
                        # Use built-in Helvetica
                        rc = page.insert_text(
                            insert_point,
                            new_text,
                            fontname=FALLBACK_FONT,
                            fontsize=font_size,
                            color=color
                        )

                    # rc is the number of characters inserted, or negative on error
                    # rc=0 with non-empty text means failure (no characters inserted)
                    if rc > 0:
                        logger.info(f"Updated price #{update['id']}: -> {new_text}")
                        results['updated'].append({
                            'id': update['id'],
                            'new_text': new_text
                        })
                    elif rc == 0 and new_text:
                        error_msg = f"insert_text inserted 0 characters for price #{update['id']} (text: '{new_text}')"
                        logger.error(error_msg)
                        results['errors'].append(error_msg)
                        results['success'] = False
                    else:
                        error_msg = f"insert_text returned {rc} for price #{update['id']}"
                        logger.error(error_msg)
                        results['errors'].append(error_msg)
                        results['success'] = False

                except (fitz.FileDataError, fitz.EmptyFileError) as e:
                    # PDF corruption errors - re-raise as these indicate document-level problems
                    error_msg = f"PDF corruption during text insertion for price #{update['id']}: {type(e).__name__}: {e}"
                    logger.error(error_msg)
                    raise
                except ValueError as e:
                    # Invalid font, color, or coordinate values
                    error_msg = f"Invalid parameters for text insertion on price #{update['id']}: {type(e).__name__}: {e}"
                    logger.error(error_msg)
                    results['errors'].append(error_msg)
                    results['success'] = False
                except (TypeError, AttributeError) as e:
                    # Type errors from malformed update data
                    error_msg = f"Malformed update data for price #{update['id']}: {type(e).__name__}: {e}"
                    logger.error(error_msg)
                    results['errors'].append(error_msg)
                    results['success'] = False
                except OSError as e:
                    # Font file not found or I/O errors
                    error_msg = f"I/O error during text insertion for price #{update['id']}: {type(e).__name__}: {e}"
                    logger.error(error_msg)
                    results['errors'].append(error_msg)
                    results['success'] = False

        # Save the updated PDF with garbage collection to clean up unused objects
        # Use atomic write: save to temp file first, then rename to final path
        # This prevents corrupted output if a crash occurs during save
        # Use mkstemp for secure temp file creation (unpredictable name, exclusive access)
        output_dir = os.path.dirname(output_pdf_path) or '.'
        fd, temp_path = tempfile.mkstemp(suffix='.pdf', prefix='update_pdf_', dir=output_dir)
        os.close(fd)  # Close the file descriptor; doc.save() will open/write the file
        try:
            doc.save(temp_path, garbage=4, deflate=True)
            logger.debug(f"Saved to temporary file: {temp_path}")
        except (fitz.FileDataError, fitz.EmptyFileError) as e:
            # PDF corruption errors during save
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass  # Best effort cleanup
            error_msg = f"PDF corruption during save: {type(e).__name__}: {e}"
            logger.error(error_msg)
            raise  # Re-raise as these indicate document-level problems
        except OSError as e:
            # File system errors (disk full, permission denied, etc.)
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass  # Best effort cleanup
            error_msg = f"Failed to save PDF (I/O error): {e}"
            logger.error(error_msg)
            results['errors'].append(error_msg)
            results['success'] = False
            return results
        except (ValueError, RuntimeError) as e:
            # Invalid parameters or internal PyMuPDF errors
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass  # Best effort cleanup
            error_msg = f"Failed to save PDF: {type(e).__name__}: {e}"
            logger.error(error_msg)
            results['errors'].append(error_msg)
            results['success'] = False
            return results

    # Atomic rename outside the context manager (after doc is closed)
    # Use retry logic for Windows where file may be locked by PDF viewer
    try:
        _replace_with_retry(temp_path, output_pdf_path)
        logger.info(f"Saved updated PDF to {output_pdf_path}")
    except OSError as e:
        # Clean up temp file on rename failure
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass  # Best effort cleanup
        error_msg = f"Failed to finalize PDF (atomic rename failed): {e}"
        logger.error(error_msg)
        results['errors'].append(error_msg)
        results['success'] = False
        return results

    # Verify output file was written successfully
    if not os.path.exists(output_pdf_path):
        error_msg = f"Output file not found after save: {output_pdf_path}"
        logger.error(error_msg)
        results['errors'].append(error_msg)
        results['success'] = False
        return results

    output_size = os.path.getsize(output_pdf_path)
    if output_size == 0:
        error_msg = f"Output file is empty (0 bytes): {output_pdf_path}"
        logger.error(error_msg)
        results['errors'].append(error_msg)
        results['success'] = False
        return results

    logger.debug(f"Output file verified: {output_pdf_path} ({output_size} bytes)")

    return results


if __name__ == '__main__':
    # Test with a simple update
    import sys
    logging.basicConfig(level=logging.DEBUG)

    input_path = 'AV Inspire 2025 Price List.pdf'
    output_path = 'AV Inspire 2026 Price List.pdf'

    # Test: Update the first $600 (LCD Projector Package) to $650
    test_updates = [
        {
            'id': 1,
            'bbox': [174.80690002441406, 316.12164306640625, 190.57362365722656, 326.7988586425781],
            'new_value': 650,
            'has_hr_suffix': False,
            'font_size': 7.98,
            'color': [0.137, 0.122, 0.125],
            'page_num': 0
        }
    ]

    result = update_prices(input_path, output_path, test_updates)
    print(f"\nResult: {result}")
