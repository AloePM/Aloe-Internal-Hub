#!/usr/bin/env python3
"""
hoa_filler.py — Entry point for HOA PDF form filling.
Called by server.js via: python3 hoa_filler.py
Reads JSON from stdin, fills the PDF, returns base64 JSON to stdout.

Input JSON:
  {
    "leaseID": 485,
    "templateId": "Tenant_Tracking_Form_-_Fillable_(1)",
    "overrides": { "tenant_name": "John Smith", ... }  // optional
  }

Output JSON:
  { "pdf": "<base64 string>", "filename": "filled_form.pdf" }
  OR
  { "error": "message" }
"""

import sys
import json
import os
import base64
import traceback
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
TEMPLATES_DIR = Path(__file__).parent / "templates"
MGMT_COMPANY  = os.environ.get("MGMT_COMPANY_NAME", "Aloe Property Management")
MGMT_PHONE    = os.environ.get("MGMT_PHONE", "(602) 854-9884")
MGMT_EMAIL    = os.environ.get("MGMT_EMAIL", "info@aloepm.com")

RENTVINE_API_KEY    = os.environ.get("RENTVINE_API_KEY", "")
RENTVINE_API_SECRET = os.environ.get("RENTVINE_API_SECRET", "")
RENTVINE_ACCOUNT    = os.environ.get("RENTVINE_ACCOUNT", "aloepm")

# ── Rentvine data fetch ───────────────────────────────────────────────────────
def fetch_rentvine(path, params=None):
    import urllib.request, urllib.parse
    credentials = base64.b64encode(
        f"{RENTVINE_API_KEY}:{RENTVINE_API_SECRET}".encode()
    ).decode()
    base_url = f"https://{RENTVINE_ACCOUNT}.rentvine.com/api/manager{path}"
    if params:
        base_url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        base_url,
        headers={"Authorization": f"Basic {credentials}", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def get_lease_data(lease_id):
    """Fetch lease + tenant + property data from Rentvine."""
    data = {}
    try:
        # Get lease details
        leases = fetch_rentvine("/leases/export", {"pageSize": 200, "page": 1})
        if isinstance(leases, list):
            for item in leases:
if str(item.get("lease", {}).get("leaseID", "")) == str(lease_id):
              lease = item.get("lease", {})
                    unit  = item.get("unit", {})
                    prop  = item.get("property", {})
                    tenants = lease.get("tenants", [])
                    primary = tenants[0] if tenants else {}
                    all_names = " & ".join(t.get("name", "") for t in tenants if t.get("name"))

                    data["tenant_name"]   = all_names or primary.get("name", "")
                    data["tenant_email"]  = primary.get("email", "")
                    data["tenant_phone"]  = primary.get("phone", "") or primary.get("cellPhone", "")
                    data["lease_id"]      = str(lease_id)
                    data["lease_start"]   = lease.get("startDate", "")
                    data["lease_end"]     = lease.get("endDate", "")
                    data["rent_amount"]   = str(lease.get("rentAmount", {}).get("amount", "")) if isinstance(lease.get("rentAmount"), dict) else str(lease.get("rentAmount", ""))
                    data["address"]       = unit.get("address", "") or prop.get("address", "")
                    data["city"]          = unit.get("city", "") or prop.get("city", "")
                    data["state"]         = unit.get("state", "") or prop.get("state", "AZ")
                    data["zip"]           = unit.get("zip", "") or prop.get("zip", "")
                    data["full_address"]  = f"{data['address']}, {data['city']}, {data['state']} {data['zip']}".strip(", ")
                    # Community name from property groups
                    groups = prop.get("groups", [])
                    data["community"]     = groups[0].get("name", "") if groups else prop.get("name", "")
                    data["management_company"] = MGMT_COMPANY
                    data["management_phone"]   = MGMT_PHONE
                    data["management_email"]   = MGMT_EMAIL
                    break
    except Exception as e:
        sys.stderr.write(f"Rentvine fetch error: {e}\n")
    return data


# ── PDF detection ─────────────────────────────────────────────────────────────
def is_fillable_pdf(pdf_path):
    """Check if a PDF has AcroForm fields."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(pdf_path))
        fields = reader.get_fields()
        return bool(fields)
    except Exception:
        return False


# ── Fillable PDF filler ───────────────────────────────────────────────────────
def fill_fillable_pdf(pdf_path, data):
    """Fill a PDF with AcroForm fields using pypdf."""
    from pypdf import PdfReader, PdfWriter
    import io

    reader = PdfReader(str(pdf_path))
    writer = PdfWriter()
    writer.append(reader)

    fields = reader.get_fields() or {}

    # Build a flexible field mapping — try fuzzy matching
    field_map = build_field_map(data, list(fields.keys()))

    writer.update_page_form_field_values(
        writer.pages[0] if len(writer.pages) == 1 else None,
        field_map,
        auto_regenerate=False
    )
    # Apply to all pages
    for page in writer.pages:
        writer.update_page_form_field_values(page, field_map, auto_regenerate=False)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def build_field_map(data, field_names):
    """Map PDF field names to data values using keyword matching."""
    mapping = {}
    data_lower = {k.lower(): v for k, v in data.items()}

    # Direct keyword associations
    KEYWORDS = {
        "tenant": ["tenant_name", "tenant"],
        "name": ["tenant_name"],
        "resident": ["tenant_name"],
        "email": ["tenant_email"],
        "phone": ["tenant_phone"],
        "cell": ["tenant_phone"],
        "address": ["address"],
        "street": ["address"],
        "city": ["city"],
        "state": ["state"],
        "zip": ["zip"],
        "community": ["community"],
        "hoa": ["community"],
        "association": ["community"],
        "lease": ["lease_id"],
        "start": ["lease_start"],
        "begin": ["lease_start"],
        "end": ["lease_end"],
        "expir": ["lease_end"],
        "rent": ["rent_amount"],
        "amount": ["rent_amount"],
        "management": ["management_company"],
        "company": ["management_company"],
        "mgmt": ["management_company"],
        "agent": ["management_company"],
        "property": ["full_address", "address"],
        "unit": ["address"],
    }

    for field_name in field_names:
        fn_lower = field_name.lower().replace("_", " ").replace("-", " ")
        matched = False
        for keyword, data_keys in KEYWORDS.items():
            if keyword in fn_lower:
                for dk in data_keys:
                    if dk in data:
                        mapping[field_name] = data[dk]
                        matched = True
                        break
                if matched:
                    break
        # Direct match fallback
        if not matched:
            for dk, val in data.items():
                if dk.lower() in fn_lower or fn_lower in dk.lower():
                    mapping[field_name] = val
                    break

    return mapping


# ── Non-fillable overlay filler ───────────────────────────────────────────────
def fill_overlay_pdf(pdf_path, data):
    """Overlay text onto a non-fillable PDF using reportlab + pypdf."""
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import io

    reader = PdfReader(str(pdf_path))

    # Build a simple overlay for the first page with common fields
    # Since we don't know the exact coordinates, we write a summary block
    # at the top margin area. This is a best-effort fill for non-fillable PDFs.
    packet = io.BytesIO()
    c = rl_canvas.Canvas(packet, pagesize=letter)
    width, height = letter

    c.setFont("Helvetica", 9)
    y = height - 40  # Start near top

    # Write key fields as a compact info block
    lines = []
    if data.get("tenant_name"):
        lines.append(f"Tenant: {data['tenant_name']}")
    if data.get("full_address"):
        lines.append(f"Address: {data['full_address']}")
    if data.get("community"):
        lines.append(f"Community/HOA: {data['community']}")
    if data.get("tenant_phone"):
        lines.append(f"Phone: {data['tenant_phone']}")
    if data.get("tenant_email"):
        lines.append(f"Email: {data['tenant_email']}")
    if data.get("lease_start") and data.get("lease_end"):
        lines.append(f"Lease: {data['lease_start']} – {data['lease_end']}")
    if data.get("management_company"):
        lines.append(f"Managed by: {data['management_company']}  {data.get('management_phone', '')}  {data.get('management_email', '')}")

    # Draw a small header box
    if lines:
        box_height = len(lines) * 14 + 10
        c.setFillColorRGB(0.95, 0.97, 1.0)
        c.rect(30, height - box_height - 30, width - 60, box_height, fill=1, stroke=0)
        c.setFillColorRGB(0, 0, 0)
        for i, line in enumerate(lines):
            c.drawString(35, height - 40 - (i * 14), line)

    c.save()
    packet.seek(0)

    # Merge overlay onto each page of original
    overlay_reader = PdfReader(packet)
    overlay_page = overlay_reader.pages[0]

    writer = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i == 0:
            page.merge_page(overlay_page)
        writer.add_page(page)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({"error": "No input received"}))
            return

        inp = json.loads(raw)
        lease_id    = inp.get("leaseID") or inp.get("lease_id") or inp.get("leaseId")
        template_id = (inp.get("templateId") or inp.get("template_id") or 
                       inp.get("template") or inp.get("templateID") or "")
        overrides   = inp.get("overrides") or {}
        if isinstance(overrides, str):
            try:
                overrides = json.loads(overrides)
            except Exception:
                overrides = {}

        if not template_id:
            print(json.dumps({"error": "templateId is required"}))
            return

        # Find template PDF
        pdf_path = None
        for f in TEMPLATES_DIR.iterdir():
            if f.suffix.lower() == ".pdf" and f.stem == template_id:
                pdf_path = f
                break
        # Fuzzy fallback
        if not pdf_path:
            for f in TEMPLATES_DIR.iterdir():
                if f.suffix.lower() == ".pdf" and template_id.lower() in f.stem.lower():
                    pdf_path = f
                    break

        if not pdf_path or not pdf_path.exists():
            print(json.dumps({"error": f"Template not found: {template_id}"}))
            return

        # Fetch lease data if leaseID provided
        data = {}
        if lease_id:
            data = get_lease_data(lease_id)

        # Apply manual overrides
        data.update({k: v for k, v in overrides.items() if v})

        # Fill the PDF
        if is_fillable_pdf(pdf_path):
            pdf_bytes = fill_fillable_pdf(pdf_path, data)
        else:
            pdf_bytes = fill_overlay_pdf(pdf_path, data)

        # Return base64
        b64 = base64.b64encode(pdf_bytes).decode()
        filename = f"HOA_filled_{data.get('tenant_name', 'form').replace(' ', '_')}.pdf"
        print(json.dumps({"pdf": b64, "filename": filename}))

    except Exception as e:
        tb = traceback.format_exc()
        sys.stderr.write(tb)
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
