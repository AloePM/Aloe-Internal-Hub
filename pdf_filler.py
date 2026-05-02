"""
pdf_filler.py — Coordinate-based overlay for non-fillable PDFs.
Uses reportlab to create a transparent overlay with text at specific coordinates,
then merges it with the original PDF.

Coordinate system: PDF points from bottom-left (reportlab default).
For 8.5x11 page: width=612, height=792 pts.
y=792 is top, y=0 is bottom.
"""

import os
import io
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

try:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    REPORTLAB = True
except ImportError:
    REPORTLAB = False
    logger.warning('reportlab not installed — coordinate overlay unavailable')

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ContentStream
except ImportError:
    try:
        from PyPDF2 import PdfReader, PdfWriter
    except ImportError:
        pass


# ── Font setup ────────────────────────────────────────────────────────────────

FONTS_DIR = os.path.join(os.path.dirname(__file__), 'fonts')
DANCING_SCRIPT_PATH = os.path.join(FONTS_DIR, 'DancingScript-Regular.ttf')
_fonts_registered = False

def ensure_fonts():
    global _fonts_registered
    if _fonts_registered or not REPORTLAB:
        return
    if os.path.exists(DANCING_SCRIPT_PATH):
        try:
            pdfmetrics.registerFont(TTFont('DancingScript', DANCING_SCRIPT_PATH))
            _fonts_registered = True
            logger.info('DancingScript font registered')
        except Exception as e:
            logger.warning(f'Font registration failed: {e}')


# ── Template coordinate maps ───────────────────────────────────────────────────
# Each key is a template_id, value is list of {field, x, y, size, font, page}
# y coords are from bottom of page (reportlab convention)
# To convert from top: y_bottom = 792 - y_from_top

TEMPLATE_COORDS = {
    'trestle_hoa': [
        # Page 1
        {'field': 'tenant_name',    'x': 72,  'y': 695, 'size': 10, 'page': 0},
        {'field': 'address',        'x': 72,  'y': 675, 'size': 10, 'page': 0},
        {'field': 'city_state_zip', 'x': 72,  'y': 655, 'size': 10, 'page': 0},
        {'field': 'community',      'x': 72,  'y': 635, 'size': 10, 'page': 0},
        {'field': 'phone',          'x': 72,  'y': 615, 'size': 10, 'page': 0},
        {'field': 'email',          'x': 72,  'y': 595, 'size': 10, 'page': 0},
        {'field': 'move_in',        'x': 72,  'y': 575, 'size': 10, 'page': 0},
        {'field': 'lease_end',      'x': 280, 'y': 575, 'size': 10, 'page': 0},
        # Vehicle 1
        {'field': 'v1_year',        'x': 72,  'y': 520, 'size': 10, 'page': 0},
        {'field': 'v1_make',        'x': 150, 'y': 520, 'size': 10, 'page': 0},
        {'field': 'v1_model',       'x': 260, 'y': 520, 'size': 10, 'page': 0},
        {'field': 'v1_color',       'x': 370, 'y': 520, 'size': 10, 'page': 0},
        {'field': 'v1_plate',       'x': 72,  'y': 500, 'size': 10, 'page': 0},
        {'field': 'v1_state',       'x': 220, 'y': 500, 'size': 10, 'page': 0},
        # Vehicle 2
        {'field': 'v2_year',        'x': 72,  'y': 460, 'size': 10, 'page': 0},
        {'field': 'v2_make',        'x': 150, 'y': 460, 'size': 10, 'page': 0},
        {'field': 'v2_model',       'x': 260, 'y': 460, 'size': 10, 'page': 0},
        {'field': 'v2_color',       'x': 370, 'y': 460, 'size': 10, 'page': 0},
        {'field': 'v2_plate',       'x': 72,  'y': 440, 'size': 10, 'page': 0},
        {'field': 'v2_state',       'x': 220, 'y': 440, 'size': 10, 'page': 0},
        # Management
        {'field': 'mgmt_company',   'x': 72,  'y': 72,  'size': 9,  'page': 0},
        {'field': 'mgmt_phone',     'x': 72,  'y': 75,  'size': 9,  'page': 0},
        {'field': 'mgmt_email',     'x': 72,  'y': 75,  'size': 9,  'page': 0},
        # Signature (uses DancingScript)
        {'field': 'signature',      'x': 72,  'y': 89.5, 'size': 16, 'font': 'DancingScript', 'page': 0},
        {'field': 'today',          'x': 350, 'y': 89.5, 'size': 10, 'page': 0},
    ],
    'custom': [
        # Generic fallback — just put name/address/date at top
        {'field': 'tenant_name',    'x': 72,  'y': 700, 'size': 10, 'page': 0},
        {'field': 'address',        'x': 72,  'y': 680, 'size': 10, 'page': 0},
        {'field': 'city_state_zip', 'x': 72,  'y': 660, 'size': 10, 'page': 0},
        {'field': 'phone',          'x': 72,  'y': 640, 'size': 10, 'page': 0},
        {'field': 'email',          'x': 72,  'y': 620, 'size': 10, 'page': 0},
        {'field': 'today',          'x': 350, 'y': 89.5, 'size': 10, 'page': 0},
        {'field': 'signature',      'x': 72,  'y': 89.5, 'size': 16, 'font': 'DancingScript', 'page': 0},
    ],
}


def fill_pdf_with_coordinates(pdf_bytes, lease_data, template_id='custom'):
    """
    Fill a non-fillable PDF using coordinate overlay.
    Returns: (filled_pdf_bytes, dict_of_fields_used)
    """
    if not REPORTLAB:
        raise ImportError('reportlab not installed')

    ensure_fonts()

    coords = TEMPLATE_COORDS.get(template_id, TEMPLATE_COORDS['custom'])
    field_values = build_field_values(lease_data)

    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()

    # Group coords by page
    pages_map = {}
    for coord in coords:
        p = coord.get('page', 0)
        if p not in pages_map:
            pages_map[p] = []
        pages_map[p].append(coord)

    fields_used = {}

    for page_num in range(len(reader.pages)):
        original_page = reader.pages[page_num]
        page_coords = pages_map.get(page_num, [])

        if not page_coords:
            writer.add_page(original_page)
            continue

        # Get page dimensions
        media_box = original_page.mediabox
        width = float(media_box.width)
        height = float(media_box.height)

        # Create overlay canvas
        overlay_buffer = io.BytesIO()
        c = rl_canvas.Canvas(overlay_buffer, pagesize=(width, height))
        c.setFillColorRGB(0, 0, 0)

        for coord in page_coords:
            field = coord['field']
            value = field_values.get(field, '')
            if not value:
                continue

            x = coord['x']
            y = coord['y']
            size = coord.get('size', 10)
            font = coord.get('font', 'Helvetica')

            # Check font availability
            if font == 'DancingScript' and not _fonts_registered:
                font = 'Helvetica-Oblique'

            try:
                c.setFont(font, size)
            except Exception:
                c.setFont('Helvetica', size)

            c.drawString(x, y, str(value))
            fields_used[field] = value
            logger.debug(f'  Placed "{field}" = "{value}" at ({x}, {y}) page {page_num}')

        c.save()
        overlay_buffer.seek(0)

        # Merge overlay onto original page
        overlay_reader = PdfReader(overlay_buffer)
        overlay_page = overlay_reader.pages[0]
        original_page.merge_page(overlay_page)
        writer.add_page(original_page)

    output = io.BytesIO()
    writer.write(output)
    output.seek(0)
    logger.info(f'Coordinate fill complete: {len(fields_used)} fields placed')
    return output.read(), fields_used


def add_signature_overlay(pdf_bytes, name):
    """Add a cursive signature overlay at the standard signature position."""
    if not REPORTLAB:
        return pdf_bytes

    ensure_fonts()

    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    writer.append(reader)

    # Add signature to last page (most HOA forms sign at the end)
    last_page_num = len(reader.pages) - 1
    last_page = reader.pages[last_page_num]
    media_box = last_page.mediabox
    width = float(media_box.width)
    height = float(media_box.height)

    overlay_buffer = io.BytesIO()
    c = rl_canvas.Canvas(overlay_buffer, pagesize=(width, height))
    c.setFillColorRGB(0, 0, 0.4)  # Dark blue signature ink

    font = 'DancingScript' if _fonts_registered else 'Helvetica-Oblique'
    try:
        c.setFont(font, 18)
    except Exception:
        c.setFont('Helvetica-Oblique', 16)

    # Standard signature line position
    c.drawString(72, 89.5, name)
    c.save()
    overlay_buffer.seek(0)

    overlay_reader = PdfReader(overlay_buffer)
    last_page.merge_page(overlay_reader.pages[0])

    output = io.BytesIO()
    writer.write(output)
    output.seek(0)
    return output.read()


def build_field_values(lease_data):
    """Build a complete dict of all possible field values from lease data."""
    tenant = lease_data.get('tenant', {})
    prop = lease_data.get('property', {})
    lease = lease_data.get('lease', {})
    vehicles = lease_data.get('vehicles', [])
    mgmt = lease_data.get('management', {})
    overrides = lease_data.get('overrides', {})

    v1 = vehicles[0] if vehicles else {}
    v2 = vehicles[1] if len(vehicles) > 1 else {}

    today = datetime.now().strftime('%m/%d/%Y')
    city_state_zip = f"{prop.get('city', '')}, {prop.get('state', 'AZ')} {prop.get('zip', '')}".strip(', ')

    values = {
        'tenant_name':   lease_data.get('all_tenants_str', tenant.get('name', '')),
        'address':       prop.get('address', ''),
        'city':          prop.get('city', ''),
        'state':         prop.get('state', 'AZ'),
        'zip':           prop.get('zip', ''),
        'city_state_zip': city_state_zip,
        'full_address':  prop.get('full_address', ''),
        'community':     lease_data.get('community_name', ''),
        'lease_start':   lease.get('startDate', ''),
        'lease_end':     lease.get('endDate', ''),
        'move_in':       lease.get('moveInDate', ''),
        'rent':          f"${float(lease.get('rent', 0)):,.2f}" if lease.get('rent') else '',
        'phone':         tenant.get('phone', ''),
        'email':         tenant.get('email', ''),
        'mgmt_company':  mgmt.get('company', 'Aloe Property Management'),
        'mgmt_phone':    mgmt.get('phone', ''),
        'mgmt_email':    mgmt.get('email', ''),
        'signature':     tenant.get('name', ''),
        'today':         today,
        # Vehicle 1
        'v1_make':   v1.get('make', ''),
        'v1_model':  v1.get('model', ''),
        'v1_year':   str(v1.get('year', '')),
        'v1_color':  v1.get('color', ''),
        'v1_plate':  v1.get('plate', ''),
        'v1_state':  v1.get('plate_state', ''),
        'v1_desc':   v1.get('description', ''),
        # Vehicle 2
        'v2_make':   v2.get('make', ''),
        'v2_model':  v2.get('model', ''),
        'v2_year':   str(v2.get('year', '')),
        'v2_color':  v2.get('color', ''),
        'v2_plate':  v2.get('plate', ''),
        'v2_state':  v2.get('plate_state', ''),
        'v2_desc':   v2.get('description', ''),
    }

    values.update(overrides)
    return values
