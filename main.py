"""
HOA Form Filler — Aloe Property Management
Flask API that fills HOA registration PDFs with Rentvine data.
Deployed as a separate Python service on Render.
Called by the Aloe PM Internal Hub at /api/hoa/fill
"""

import os
import io
import base64
import logging
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

from rentvine_api import RentvinAPI
from pdf_filler import fill_pdf_with_coordinates
from fillable_filler import fill_fillable_pdf

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, origins=["https://aloe-pm-assistant.onrender.com", "http://localhost:3000", "*"])

rv = RentvinAPI()

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'hoa-form-filler'})

@app.route('/api/leases', methods=['GET'])
def get_leases():
    """Get active leases for property selector dropdown."""
    try:
        leases = rv.get_active_leases()
        return jsonify({'leases': leases, 'total': len(leases)})
    except Exception as e:
        logger.error(f'get_leases error: {e}')
        return jsonify({'error': str(e)}), 500

@app.route('/api/lease/<lease_id>', methods=['GET'])
def get_lease_detail(lease_id):
    """Get full lease + tenant + property + vehicle data for a lease."""
    try:
        data = rv.get_lease_detail(lease_id)
        return jsonify(data)
    except Exception as e:
        logger.error(f'get_lease_detail error: {e}')
        return jsonify({'error': str(e)}), 500

@app.route('/api/hoa/templates', methods=['GET'])
def list_templates():
    """List available HOA PDF templates."""
    templates_dir = os.path.join(os.path.dirname(__file__), 'templates')
    templates = []
    if os.path.exists(templates_dir):
        for fname in os.listdir(templates_dir):
            if fname.lower().endswith('.pdf'):
                templates.append({
                    'id': fname.replace('.pdf', ''),
                    'name': fname.replace('.pdf', '').replace('_', ' ').title(),
                    'filename': fname
                })
    return jsonify({'templates': templates})

@app.route('/api/hoa/fill', methods=['POST'])
def fill_form():
    """
    Fill an HOA form PDF with tenant data from Rentvine.
    
    Request body:
    {
        "lease_id": "1234",
        "template_id": "trestle_hoa",   // or upload base64 PDF
        "pdf_base64": "<base64>",         // if uploading custom PDF
        "overrides": {                     // optional manual overrides
            "tenant_name": "...",
            "move_in_date": "..."
        }
    }
    
    Returns: filled PDF as base64 + field mapping used
    """
    try:
        body = request.get_json()
        if not body:
            return jsonify({'error': 'JSON body required'}), 400

        lease_id = body.get('lease_id')
        template_id = body.get('template_id')
        pdf_base64 = body.get('pdf_base64')
        overrides = body.get('overrides', {})

        if not lease_id:
            return jsonify({'error': 'lease_id required'}), 400
        if not template_id and not pdf_base64:
            return jsonify({'error': 'template_id or pdf_base64 required'}), 400

        # 1. Fetch lease data from Rentvine
        logger.info(f'Fetching lease data for lease_id={lease_id}')
        lease_data = rv.get_lease_detail(lease_id)
        if 'error' in lease_data:
            return jsonify({'error': f'Rentvine error: {lease_data["error"]}'}), 502

        # 2. Apply manual overrides
        if overrides:
            lease_data['overrides'] = overrides

        # 3. Load PDF template
        if pdf_base64:
            pdf_bytes = base64.b64decode(pdf_base64)
        else:
            template_path = os.path.join(
                os.path.dirname(__file__), 'templates', f'{template_id}.pdf'
            )
            if not os.path.exists(template_path):
                return jsonify({'error': f'Template not found: {template_id}'}), 404
            with open(template_path, 'rb') as f:
                pdf_bytes = f.read()

        # 4. Detect PDF type and fill
        logger.info(f'Filling PDF for template={template_id or "custom"}, lease={lease_id}')
        
        # Try fillable first, fall back to coordinate overlay
        try:
            filled_bytes, fields_used = fill_fillable_pdf(pdf_bytes, lease_data)
            fill_method = 'fillable'
        except Exception as e:
            logger.warning(f'Fillable PDF failed ({e}), trying coordinate overlay')
            filled_bytes, fields_used = fill_pdf_with_coordinates(
                pdf_bytes, lease_data, template_id or 'custom'
            )
            fill_method = 'coordinate'

        # 5. Return filled PDF as base64
        filled_b64 = base64.b64encode(filled_bytes).decode('utf-8')
        
        # Build preview of data used
        tenant = lease_data.get('tenant', {})
        property_info = lease_data.get('property', {})
        
        return jsonify({
            'success': True,
            'pdf_base64': filled_b64,
            'filename': f"HOA_{property_info.get('address', 'form').replace(' ', '_')}.pdf",
            'fill_method': fill_method,
            'fields_used': fields_used,
            'data_summary': {
                'tenant': tenant.get('name', '—'),
                'address': property_info.get('address', '—'),
                'community': lease_data.get('community_name', '—'),
                'lease_start': lease_data.get('lease', {}).get('startDate', '—'),
                'lease_end': lease_data.get('lease', {}).get('endDate', '—'),
                'vehicles': len(lease_data.get('vehicles', [])),
            }
        })

    except Exception as e:
        logger.error(f'fill_form error: {e}', exc_info=True)
        return jsonify({'error': str(e)}), 500

@app.route('/api/hoa/download/<lease_id>/<template_id>', methods=['GET'])
def download_filled_form(lease_id, template_id):
    """Quick download endpoint — fills and streams PDF directly."""
    try:
        lease_data = rv.get_lease_detail(lease_id)
        if 'error' in lease_data:
            return f"Error: {lease_data['error']}", 502

        template_path = os.path.join(
            os.path.dirname(__file__), 'templates', f'{template_id}.pdf'
        )
        if not os.path.exists(template_path):
            return f"Template not found: {template_id}", 404

        with open(template_path, 'rb') as f:
            pdf_bytes = f.read()

        try:
            filled_bytes, _ = fill_fillable_pdf(pdf_bytes, lease_data)
        except Exception:
            filled_bytes, _ = fill_pdf_with_coordinates(pdf_bytes, lease_data, template_id)

        property_info = lease_data.get('property', {})
        filename = f"HOA_{property_info.get('address', 'form').replace(' ', '_')}.pdf"

        return send_file(
            io.BytesIO(filled_bytes),
            mimetype='application/pdf',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        return str(e), 500

@app.route('/api/hoa/preview-data/<lease_id>', methods=['GET'])
def preview_data(lease_id):
    """Preview what data will be used to fill the form — for QA before generating."""
    try:
        data = rv.get_lease_detail(lease_id)
        if 'error' in data:
            return jsonify({'error': data['error']}), 502

        # Return a clean structured preview
        tenant = data.get('tenant', {})
        property_info = data.get('property', {})
        lease = data.get('lease', {})
        vehicles = data.get('vehicles', [])

        return jsonify({
            'lease_id': lease_id,
            'tenant': {
                'name': tenant.get('name', ''),
                'email': tenant.get('email', ''),
                'phone': tenant.get('phone', ''),
                'all_tenants': data.get('all_tenants', []),
            },
            'property': {
                'address': property_info.get('address', ''),
                'city': property_info.get('city', ''),
                'state': property_info.get('state', 'AZ'),
                'zip': property_info.get('zip', ''),
                'community_name': data.get('community_name', ''),
            },
            'lease': {
                'start': lease.get('startDate', ''),
                'end': lease.get('endDate', ''),
                'move_in': lease.get('moveInDate', ''),
                'rent': lease.get('rent', ''),
            },
            'vehicles': vehicles,
            'management': {
                'company': os.getenv('MGMT_COMPANY_NAME', 'Aloe Property Management'),
                'phone': os.getenv('MGMT_PHONE', ''),
                'email': os.getenv('MGMT_EMAIL', 'info@aloepm.com'),
            }
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port, debug=False)
