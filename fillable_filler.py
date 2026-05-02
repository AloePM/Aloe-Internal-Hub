"""
fillable_filler.py — Fill AcroForm (fillable) PDFs using pypdf / pdfrw.
Falls back to coordinate overlay if the PDF has no fillable fields.
Includes cursive signature overlay using Dancing Script font.
"""

import os
import io
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

# Try pypdf first (newer), fall back to PyPDF2
try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, ArrayObject, NumberObject, TextStringObject
    PYPDF = 'pypdf'
except ImportError:
    try:
        from PyPDF2 import PdfReader, PdfWriter
        from PyPDF2.generic import NameObject, ArrayObject, NumberObject, TextStringObject
        PYPDF = 'PyPDF2'
    except ImportError:
        PYPDF = None

logger.info(f'PDF library: {PYPDF}')


def fill_fillable_pdf(pdf_bytes, lease_data, signature_name=None):
    """
    Fill a fillable PDF form with lease data.
    
    Returns: (filled_pdf_bytes, dict_of_fields_used)
    Raises: Exception if PDF has no fillable fields (triggers coordinate fallback)
    """
    if not PYPDF:
        raise ImportError('pypdf not installed')

    reader = PdfReader(io.BytesIO(pdf_bytes))
    
    # Check if PDF has fillable fields
    fields = reader.get_fields()
    if not fields:
        raise ValueError('PDF has no fillable fields — use coordinate overlay instead')

    logger.info(f'Found {len(fields)} fillable fields: {list(fields.keys())[:10]}')

    # Build the field value map from lease data
    field_map = build_field_map(lease_data, fields)

    writer = PdfWriter()
    writer.append(reader)
    
    fields_used = {}

    # Fill each page's fields
    for page_num in range(len(reader.pages)):
        page_fields = {}
        for field_name, field_obj in fields.items():
            if field_name in field_map:
                page_fields[field_name] = field_map[field_name]
                fields_used[field_name] = field_map[field_name]

        if page_fields:
            try:
                writer.update_page_form_field_values(
                    writer.pages[page_num],
                    page_fields,
                    auto_regenerate=False
                )
            except TypeError:
                # Older pypdf/PyPDF2 signature
                writer.updatePageFormFieldValues(writer.pages[page_num], page_fields)

    # Add signature overlay if name provided
    sig_name = signature_name or lease_data.get('tenant', {}).get('name', '')
    if sig_name:
        try:
            filled_bytes = io.BytesIO()
            writer.write(filled_bytes)
            filled_bytes.seek(0)
            from pdf_filler import add_signature_overlay
            final_bytes = add_signature_overlay(filled_bytes.read(), sig_name)
            return final_bytes, fields_used
        except Exception as e:
            logger.warning(f'Signature overlay failed: {e}')

    output = io.BytesIO()
    writer.write(output)
    output.seek(0)
    return output.read(), fields_used


def build_field_map(lease_data, pdf_fields):
    """
    Map lease data to PDF field names using fuzzy matching.
    Handles common HOA form field name patterns.
    """
    tenant = lease_data.get('tenant', {})
    prop = lease_data.get('property', {})
    lease = lease_data.get('lease', {})
    vehicles = lease_data.get('vehicles', [])
    mgmt = lease_data.get('management', {})
    overrides = lease_data.get('overrides', {})

    v1 = vehicles[0] if len(vehicles) > 0 else {}
    v2 = vehicles[1] if len(vehicles) > 1 else {}

    today = datetime.now().strftime('%m/%d/%Y')
    all_tenants = lease_data.get('all_tenants_str', tenant.get('name', ''))

    # Canonical data values
    data = {
        'tenant_name': tenant.get('name', ''),
        'all_tenants': all_tenants,
        'address': prop.get('address', ''),
        'city': prop.get('city', ''),
        'state': prop.get('state', 'AZ'),
        'zip': prop.get('zip', ''),
        'full_address': prop.get('full_address', ''),
        'community': lease_data.get('community_name', ''),
        'lease_start': lease.get('startDate', ''),
        'lease_end': lease.get('endDate', ''),
        'move_in': lease.get('moveInDate', ''),
        'rent': lease.get('rent', ''),
        'phone': tenant.get('phone', ''),
        'email': tenant.get('email', ''),
        'mgmt_company': mgmt.get('company', 'Aloe Property Management'),
        'mgmt_phone': mgmt.get('phone', ''),
        'mgmt_email': mgmt.get('email', ''),
        'today': today,
        # Vehicle 1
        'v1_make': v1.get('make', ''),
        'v1_model': v1.get('model', ''),
        'v1_year': str(v1.get('year', '')),
        'v1_color': v1.get('color', ''),
        'v1_plate': v1.get('plate', ''),
        'v1_state': v1.get('plate_state', ''),
        'v1_desc': v1.get('description', ''),
        # Vehicle 2
        'v2_make': v2.get('make', ''),
        'v2_model': v2.get('model', ''),
        'v2_year': str(v2.get('year', '')),
        'v2_color': v2.get('color', ''),
        'v2_plate': v2.get('plate', ''),
        'v2_state': v2.get('plate_state', ''),
        'v2_desc': v2.get('description', ''),
    }

    # Apply manual overrides
    data.update(overrides)

    # Field name pattern matching — covers common HOA form naming conventions
    patterns = {
        # Tenant name variants
        r'(resident|tenant|owner|lessee|occupant|name)': data['all_tenants'],
        r'(full.?name|your.?name|print.?name)': data['all_tenants'],
        # Address variants
        r'(property.?address|unit.?address|home.?address|address)': data['address'],
        r'(city)': data['city'],
        r'(state)': data['state'],
        r'(zip|postal)': data['zip'],
        # Community
        r'(community|hoa|association|subdivision|neighborhood)': data['community'],
        # Lease dates
        r'(lease.?start|start.?date|from.?date|begin)': data['lease_start'],
        r'(lease.?end|end.?date|to.?date|expir)': data['lease_end'],
        r'(move.?in|move.?date)': data['move_in'],
        # Contact
        r'(phone|tel|cell|mobile|contact)': data['phone'],
        r'(email|e.?mail)': data['email'],
        # Management company
        r'(management.?company|property.?mgmt|mgmt.?company)': data['mgmt_company'],
        r'(management.?phone|mgmt.?phone)': data['mgmt_phone'],
        r'(management.?email|mgmt.?email)': data['mgmt_email'],
        # Date
        r'(today|date|sign.?date)': data['today'],
        # Vehicle 1
        r'(vehicle.?1?.?make|make.?1|car.?1.?make)': data['v1_make'],
        r'(vehicle.?1?.?model|model.?1)': data['v1_model'],
        r'(vehicle.?1?.?year|year.?1)': data['v1_year'],
        r'(vehicle.?1?.?color|color.?1)': data['v1_color'],
        r'(vehicle.?1?.?plate|plate.?1|license.?1)': data['v1_plate'],
        r'(vehicle.?1?.?state|state.?1.?plate)': data['v1_state'],
        # Vehicle 2
        r'(vehicle.?2.?make|make.?2|car.?2.?make)': data['v2_make'],
        r'(vehicle.?2.?model|model.?2)': data['v2_model'],
        r'(vehicle.?2.?year|year.?2)': data['v2_year'],
        r'(vehicle.?2.?color|color.?2)': data['v2_color'],
        r'(vehicle.?2.?plate|plate.?2|license.?2)': data['v2_plate'],
        r'(vehicle.?2.?state|state.?2.?plate)': data['v2_state'],
    }

    import re
    field_map = {}
    for field_name in pdf_fields.keys():
        field_lower = field_name.lower().replace('_', ' ').replace('-', ' ')
        for pattern, value in patterns.items():
            if re.search(pattern, field_lower, re.IGNORECASE) and value:
                field_map[field_name] = str(value)
                break

    logger.info(f'Mapped {len(field_map)}/{len(pdf_fields)} fields')
    return field_map
