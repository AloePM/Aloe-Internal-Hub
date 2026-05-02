#!/usr/bin/env python3
"""
hoa_filler.py — HOA PDF form filler for Aloe Property Management.
Called by server.js via: python3 hoa_filler.py
Reads JSON from stdin, fills the PDF, returns base64 JSON to stdout.
"""

import sys, json, os, base64, traceback, urllib.request, urllib.parse, io
from pathlib import Path
from datetime import date

TEMPLATES_DIR       = Path(__file__).parent / "templates"
MGMT_COMPANY        = os.environ.get("MGMT_COMPANY_NAME", "Aloe Property Management")
MGMT_PHONE          = os.environ.get("MGMT_PHONE", "(602) 854-9884")
MGMT_EMAIL          = os.environ.get("MGMT_EMAIL", "info@aloepm.com")
MGMT_ADDRESS        = os.environ.get("MGMT_ADDRESS", "Phoenix, AZ")
RENTVINE_API_KEY    = os.environ.get("RENTVINE_API_KEY", "")
RENTVINE_API_SECRET = os.environ.get("RENTVINE_API_SECRET", "")
RENTVINE_ACCOUNT    = os.environ.get("RENTVINE_ACCOUNT", "aloepm")
TODAY               = date.today().strftime("%-m/%-d/%Y")


def fetch_rentvine(path, params=None):
    creds = base64.b64encode(f"{RENTVINE_API_KEY}:{RENTVINE_API_SECRET}".encode()).decode()
    url   = f"https://{RENTVINE_ACCOUNT}.rentvine.com/api/manager{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {creds}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def get_lease_data(lease_id):
    data = {}
    try:
        page = 1
        while page <= 20:
            leases = fetch_rentvine("/leases/export", {"pageSize": 200, "page": page})
            if not isinstance(leases, list) or not leases:
                break
            for item in leases:
                if str(item.get("lease", {}).get("leaseID", "")) == str(lease_id):
                    lease   = item.get("lease", {})
                    unit    = item.get("unit", {})
                    prop    = item.get("property", {})
                    owner   = item.get("owner", {}) or {}
                    tenants = lease.get("tenants", [])
                    primary = tenants[0] if tenants else {}
                    t = lambda i: tenants[i] if len(tenants) > i else {}
                    rent = lease.get("rentAmount", {})
                    addr    = unit.get("address","") or prop.get("address","")
                    city    = unit.get("city","") or prop.get("city","")
                    state_  = unit.get("state","") or prop.get("state","AZ")
                    zipcode = unit.get("zip","") or prop.get("zip","")
                    groups  = prop.get("groups",[])
                    community = groups[0].get("name","") if groups else prop.get("name","")
                    data = {
                        "tenant_name":  " & ".join(x.get("name","") for x in tenants if x.get("name")),
                        "tenant1":      t(0).get("name",""),
                        "tenant2":      t(1).get("name",""),
                        "tenant3":      t(2).get("name",""),
                        "tenant_phone": primary.get("phone","") or primary.get("cellPhone",""),
                        "tenant_email": primary.get("email",""),
                        "tenant2_phone": t(1).get("phone","") or t(1).get("cellPhone",""),
                        "tenant2_email": t(1).get("email",""),
                        "tenant3_phone": t(2).get("phone","") or t(2).get("cellPhone",""),
                        "tenant3_email": t(2).get("email",""),
                        "owner_name":   owner.get("name",""),
                        "owner_phone":  owner.get("phone","") or owner.get("cellPhone",""),
                        "owner_email":  owner.get("email",""),
                        "lease_start":  lease.get("startDate",""),
                        "lease_end":    lease.get("endDate",""),
                        "rent_amount":  str(rent.get("amount","")) if isinstance(rent,dict) else str(rent or ""),
                        "address":      addr,
                        "city":         city,
                        "state":        state_,
                        "zip":          zipcode,
                        "full_address": f"{addr}, {city}, {state_} {zipcode}".strip(", "),
                        "community":    community,
                        "mgmt_company": MGMT_COMPANY,
                        "mgmt_phone":   MGMT_PHONE,
                        "mgmt_email":   MGMT_EMAIL,
                        "mgmt_address": MGMT_ADDRESS,
                        "today":        TODAY,
                    }
                    try:
                        vehicles = fetch_rentvine(f"/leases/{lease_id}/vehicles")
                        if isinstance(vehicles, list):
                            for i, v in enumerate(vehicles[:4], 1):
                                data[f"vehicle{i}_make"]  = v.get("make","")
                                data[f"vehicle{i}_model"] = v.get("model","")
                                data[f"vehicle{i}_color"] = v.get("color","")
                                data[f"vehicle{i}_plate"] = v.get("plateNumber","")
                                data[f"vehicle{i}_state"] = v.get("plateState","")
                    except Exception as ve:
                        sys.stderr.write(f"Vehicle fetch error: {ve}\n")
                    return data
            if len(leases) < 200:
                break
            page += 1
    except Exception as e:
        sys.stderr.write(f"Rentvine fetch error: {e}\n")
    return data


# ── Per-template coordinate maps ──────────────────────────────────────────────
# Each entry: (field_key, x, y_from_bottom, max_width, font_size)
# y_from_bottom = PDF points from bottom of page
TEMPLATE_COORDS = {

    "maricopameadowsTenantRegistrationFormBlank": [
        ("owner_name",      95, 687, 300, 9),
        ("owner_phone",     18, 594, 120, 9),
        ("owner_email",    255, 594, 270, 9),
        ("address",         18, 568, 330, 9),
        ("city",           170, 557, 130, 9),
        ("state",          280, 557,  60, 9),
        ("zip",            380, 557,  80, 9),
        ("tenant1",         18, 392, 170, 9),
        ("tenant_phone",   196, 392, 110, 9),
        ("tenant_email",   310, 392, 220, 9),
        ("tenant2",         18, 376, 170, 9),
        ("tenant2_phone",  196, 376, 110, 9),
        ("tenant2_email",  310, 376, 220, 9),
        ("vehicle1_make",   20, 248, 120, 9),
        ("vehicle1_model", 144, 248, 125, 9),
        ("vehicle1_state", 335, 248,  60, 9),
        ("vehicle1_plate", 409, 248, 120, 9),
        ("lease_start",     80, 141, 190, 9),
        ("lease_end",      320, 141, 200, 9),
        ("owner_name",      80, 109, 300, 9),
        ("today",          450, 109,  80, 9),
    ],

    "focus_hoa": [
        # First Name underscore: x0=96 y=574.7 | Last Name: x0=271 | Phone: x0=465
        # (Focus has First/Last separate - use owner_name for first, rest for last)
        ("owner_name",     208, 521.1, 190, 9),  # mgmt company underscore
        ("mgmt_phone",     459, 521.1, 120, 9),
        ("mgmt_email",     187, 496.2, 178, 9),
        ("mgmt_address",   412, 496.2, 165, 9),  # contact
        ("full_address",   234, 471.4, 228, 9),  # property address line
        # Owner mailing
        ("owner_name",     321, 401.3, 262, 9),  # owner mailing underscore
        # Lease
        ("lease_start",    122, 339.7,  82, 9),
        ("lease_end",      290, 337.0,  76, 9),
        # Tenants name | phone | email
        ("tenant1",         68, 288.6, 155, 9),
        ("tenant_phone",   269, 290.5,  95, 9),
        ("tenant_email",   448, 288.0, 134, 9),
        ("tenant2",         67, 264.1, 155, 9),
        ("tenant2_phone",  265, 266.0, 102, 9),
        ("tenant2_email",  445, 263.5, 134, 9),
        ("tenant3",         67, 239.9, 155, 9),
        ("tenant3_phone",  265, 241.9, 102, 9),
        ("tenant3_email",  445, 239.4, 134, 9),
        # Vehicles
        ("vehicle1_make",   67, 166.3, 155, 9),
        ("vehicle1_model", 267, 168.2,  96, 9),
        ("vehicle1_plate", 445, 165.7, 134, 9),
        # Signature
        ("owner_name",     163,  40.8, 222, 9),
    ],

    "FSR_Property_Release_and_Information_Form_FILLABLE_2017_(1)_(10)": [
        ("full_address",    23, 648, 580, 9),
        ("owner_name",      23, 630, 580, 9),
        ("address",         23, 612, 580, 9),
        ("city",            23, 594, 210, 9),
        ("state",          238, 594, 170, 9),
        ("zip",            413, 594, 180, 9),
        ("owner_phone",     23, 575, 305, 9),
        ("owner_email",     23, 557, 305, 9),
        ("mgmt_company",    93, 520, 510, 9),
        ("mgmt_address",    93, 501, 510, 9),
        ("mgmt_phone",     308, 465, 130, 9),
        ("mgmt_email",     335, 447, 260, 9),
        ("tenant_name",     93, 390, 210, 9),
        ("lease_start",    335, 390, 105, 9),
        ("lease_end",      444, 390, 148, 9),
        ("tenant_phone",    23, 371, 280, 9),
        ("tenant_email",   308, 371, 295, 9),
        ("tenant2",         71, 352, 235, 9),
        ("tenant3",         71, 334, 235, 9),
        ("owner_name",      74,  50, 400, 9),
        ("today",          455,  50, 130, 9),
    ],

    "Tenant_Tracking_Form_-_Fillable_(1)": [
        ("community",      172, 558, 380, 9),
        ("owner_name",     138, 531, 415, 9),
        ("full_address",   114, 504, 430, 9),
        ("owner_phone",    138, 477, 145, 9),
        ("owner_email",    318, 477, 235, 9),
        ("tenant1",         72, 389, 213, 9),
        ("tenant_phone",   288, 389,  63, 9),
        ("tenant_email",   360, 389, 185, 9),
        ("tenant2",         72, 362, 213, 9),
        ("tenant2_phone",  288, 362,  63, 9),
        ("tenant2_email",  360, 362, 185, 9),
        ("tenant3",         72, 335, 213, 9),
        ("tenant3_phone",  288, 335,  63, 9),
        ("tenant3_email",  360, 335, 185, 9),
        ("lease_start",     72, 303, 175, 9),
        ("lease_end",      285, 303, 220, 9),
        ("vehicle1_make",   72, 200, 540, 9),
    ],

    "Owner_Information__Agent_Authorization_-_Fillable": [
        ("community",      172, 572, 380, 9),
        ("owner_name",     138, 545, 430, 9),
        ("full_address",   114, 518, 430, 9),
        ("address",        146, 491, 420, 9),
        ("owner_phone",    138, 465, 200, 9),
        ("owner_phone",    345, 465, 200, 9),
        ("owner_email",     72, 438, 480, 9),
        ("mgmt_company",   218, 304, 380, 9),
        ("mgmt_address",   138, 277, 435, 9),
        ("mgmt_phone",     102, 250, 237, 9),
        ("mgmt_email",     102, 223, 480, 9),
    ],

    "Senita_Tenant_Registration": [
        ("owner_name",      65, 562, 540, 9),
        ("full_address",    75, 535, 540, 9),
        ("address",         70, 511, 540, 9),
        ("owner_phone",     65, 488, 200, 9),
        ("owner_email",    272, 487, 325, 9),
        ("lease_start",     96, 321, 200, 9),
        ("lease_end",      428, 319, 170, 9),
        ("owner_name",     142, 260, 280, 9),
        ("today",          432, 258, 160, 9),
    ],

    "AAM_Tenant_Registration_Form_-_Copy": [
        # Association: underscore x0=97 y=690.4 | Property Address: x0=127 y=674.0
        ("community",       97, 690.4, 457, 9),
        ("full_address",   127, 674.0, 429, 9),
        # City: x0=61 y=657.6 | Zip: x0=461 y=657.6
        ("city",            61, 657.6, 322, 9),
        ("zip",            461, 657.6,  96, 9),
        # Owner Name: x0=121 y=641.1 | Mailing: x0=190 y=624.8
        ("owner_name",     121, 641.1, 434, 9),
        ("address",        190, 624.8, 366, 9),
        # City x0=61 y=608.3 | State x0=388 | Zip x0=462
        ("city",            61, 608.3, 289, 9),
        ("state",          388, 608.3,  39, 9),
        ("zip",            462, 608.3,  97, 9),
        # Owner Email x0=100 y=591.9 | Phone x0=452 y=591.9
        ("owner_email",    100, 591.9, 280, 9),
        ("owner_phone",    452, 591.9, 107, 9),
        # Tenant 1: name x0=63 y=509.9 | MI x0=293 | Last x0=365
        ("tenant1",         63, 509.9, 205, 9),
        # Vehicle year/make/model on same line
        ("vehicle1_make",  244, 493.5, 136, 9),
        ("vehicle1_model", 421, 493.5, 142, 9),
        ("vehicle1_plate", 112, 477.1, 148, 9),
        # Tenant 2
        ("tenant2",         63, 460.7, 205, 9),
        ("vehicle2_make",  244, 444.3, 136, 9),
        ("vehicle2_model", 421, 444.3, 142, 9),
        ("vehicle2_plate", 112, 427.8, 148, 9),
        # Tenant 3
        ("tenant3",         63, 411.5, 205, 9),
        ("vehicle3_make",  244, 395.0, 136, 9),
        ("vehicle3_model", 421, 395.0, 142, 9),
        ("vehicle3_plate", 112, 378.6, 148, 9),
        # Tenant contact address: x0=183 y=302.1
        ("address",        183, 302.1, 377, 9),
        # City x0=61 y=285.6 | State x0=394 | Zip x0=475
        ("city",            61, 285.6, 293, 9),
        ("state",          394, 285.6,  39, 9),
        ("zip",            475, 285.6,  96, 9),
        # Phone x0=153 y=269.3 | Email x0=150 y=252.9
        ("tenant_phone",   153, 269.3, 206, 9),
        ("tenant_email",   150, 252.9, 412, 9),
        # Lease dates: x0=96 y=225.5 | x0=249 y=225.5
        ("lease_start",     96, 225.5, 127, 9),
        ("lease_end",      249, 225.5, 128, 9),
        # Signature: x0=36 y=127.1
        ("owner_name",      36, 127.1, 509, 9),
        ("today",          163,  48.5,  27, 9),
    ],

    "Tortosa_-_Reg_Form": [
        # Today's Date underscore: x0=131 y=644.2
        ("today",          131, 644.2,  88, 9),
        # Address (property): x0=110 y=597.7
        ("full_address",   110, 597.7, 393, 9),
        # Lease duration: start x0=139 y=574.6 | end x0=302 y=574.6
        ("lease_start",    139, 574.6, 148, 9),
        ("lease_end",      302, 574.6, 168, 9),
        # Owner Name: no underscore — use label position from words
        ("owner_name",     142, 620.9, 455, 9),
        # Mailing address: x0=72 y=502.4
        ("address",         72, 502.4, 432, 9),
        # Mgmt company: x0=72 y=148.7
        ("mgmt_company",    72, 148.7, 462, 9),
        # Tenant table — x col positions from form visual (table cells)
        # Resident 1 name, mobile, work, email cols
        ("tenant1",        230, 419.4, 185, 9),   # col 2 (Resident 1)
        ("tenant_phone",   230, 394.4, 185, 9),   # mobile phone row
        ("tenant2",        415, 419.4, 160, 9),   # col 3 (Resident 2)
        ("tenant2_phone",  415, 394.4, 160, 9),
        ("tenant_email",   230, 344.6, 185, 9),
        ("tenant2_email",  415, 344.6, 160, 9),
        # Signature: three underscores x0=72, x0=252, x0=432 y=91.8
        ("owner_name",      72,  91.8, 168, 9),
        ("owner_name",     252,  91.8, 173, 9),
        ("today",          432,  91.8,  92, 9),
    ],

    "vision community": [
        # Owner Name(s) underscore: x0=119 y_bottom=573.5 | Phone underscore: x0=435 y_bottom=573.5
        ("owner_name",     119, 573.5, 274, 9),
        ("owner_phone",    435, 573.5, 136, 9),
        # Property Address underscore: x0=126 y_bottom=545.9 | Email: x0=374 y_bottom=545.9
        ("address",        126, 545.9, 208, 9),
        ("owner_email",    374, 545.9, 196, 9),
        # Tenant 1: name x0=56 y=462.5 | Phone x0=267 | Email starts after "Email:" at ~400
        ("tenant1",         56, 462.5, 168, 9),
        ("tenant_phone",   267, 462.5,  83, 9),
        ("tenant_email",   400, 462.5, 174, 9),
        # Tenant 2
        ("tenant2",         56, 437.3, 168, 9),
        ("tenant2_phone",  267, 437.3,  83, 9),
        ("tenant2_email",  400, 437.3, 174, 9),
        # Tenant 3
        ("tenant3",         56, 410.0, 168, 9),
        ("tenant3_phone",  267, 410.0,  83, 9),
        ("tenant3_email",  400, 410.0, 174, 9),
        # Lease dates: Start Date underscore x0=91 y=327.3 | End Date underscore x0=270 y=327.3
        ("lease_start",     91, 327.3,  94, 9),
        ("lease_end",      270, 327.3, 100, 9),
        # Vehicle 1: Make x0=102 | Model x0=245 | Color x0=401 | Plate x0=497 — y=267.5
        ("vehicle1_make",  102, 267.5, 100, 9),
        ("vehicle1_model", 245, 267.5, 118, 9),
        ("vehicle1_color", 401, 267.5,  64, 9),
        ("vehicle1_plate", 497, 267.5,  76, 9),
        # Vehicle 2 — y=239.9
        ("vehicle2_make",  102, 239.9, 100, 9),
        ("vehicle2_model", 245, 239.9, 118, 9),
        ("vehicle2_color", 401, 239.9,  64, 9),
        ("vehicle2_plate", 497, 239.9,  76, 9),
        # Vehicle 3 — y=212.3
        ("vehicle3_make",  102, 212.3, 100, 9),
        ("vehicle3_model", 245, 212.3, 118, 9),
        ("vehicle3_color", 401, 212.3,  64, 9),
        ("vehicle3_plate", 497, 212.3,  76, 9),
        # Vehicle 4 — y=182.5
        ("vehicle4_make",  102, 182.5, 100, 9),
        ("vehicle4_model", 245, 182.5, 118, 9),
        ("vehicle4_color", 401, 182.5,  64, 9),
        ("vehicle4_plate", 497, 182.5,  76, 9),
    ],
}


def find_template_file(template_id):
    if not TEMPLATES_DIR.exists():
        return None
    norm_id = template_id.lower().replace(" ","_").replace("(","").replace(")","").replace("-","_")
    for f in TEMPLATES_DIR.iterdir():
        if f.suffix.lower() != ".pdf":
            continue
        if f.stem == template_id:
            return f
        norm_stem = f.stem.lower().replace(" ","_").replace("(","").replace(")","").replace("-","_")
        if norm_stem == norm_id or norm_id in norm_stem or norm_stem in norm_id:
            return f
    return None


def find_coord_key(template_id):
    if template_id in TEMPLATE_COORDS:
        return template_id
    norm = template_id.lower().replace(" ","_").replace("(","_").replace(")","_").replace("-","_")
    for key in TEMPLATE_COORDS:
        knorm = key.lower().replace(" ","_").replace("(","_").replace(")","_").replace("-","_")
        if norm == knorm or norm in knorm or knorm in norm:
            return key
    return None


def fill_pdf_overlay(pdf_path, data, coord_key):
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas as rl_canvas

    coords  = TEMPLATE_COORDS.get(coord_key, [])
    reader  = PdfReader(str(pdf_path))
    page0   = reader.pages[0]
    page_w  = float(page0.mediabox.width)
    page_h  = float(page0.mediabox.height)

    packet = io.BytesIO()
    c = rl_canvas.Canvas(packet, pagesize=(page_w, page_h))
    c.setFillColorRGB(0, 0, 0)

    placed = set()
    for entry in coords:
        if len(entry) != 5:
            continue
        field_key, x, y, max_w, font_size = entry
        if not field_key:
            continue
        val = str(data.get(field_key, "") or "")
        if not val:
            continue
        c.setFont("Helvetica", font_size)
        while c.stringWidth(val, "Helvetica", font_size) > max_w and len(val) > 1:
            val = val[:-1]
        key = (round(x), round(y))
        if key in placed:
            continue
        placed.add(key)
        c.drawString(x, y, val)

    c.save()
    packet.seek(0)

    from pypdf import PdfReader as PR2
    overlay = PR2(packet).pages[0]
    writer  = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i == 0:
            page.merge_page(overlay)
        writer.add_page(page)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def fill_fillable_pdf(pdf_path, data):
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(str(pdf_path))
    fields = reader.get_fields() or {}
    if not fields:
        return None
    KEYWORD_MAP = {
        "tenant": "tenant_name", "resident": "tenant_name",
        "owner": "owner_name", "landlord": "owner_name",
        "property": "full_address", "address": "full_address",
        "phone": "tenant_phone", "cell": "tenant_phone",
        "email": "tenant_email",
        "community": "community", "association": "community",
        "start": "lease_start", "end": "lease_end",
        "city": "city", "state": "state", "zip": "zip",
        "make": "vehicle1_make", "model": "vehicle1_model", "plate": "vehicle1_plate",
        "management": "mgmt_company", "agent": "mgmt_company",
    }
    field_vals = {}
    for fn in fields:
        fl = fn.lower().replace("_"," ")
        for kw, dk in KEYWORD_MAP.items():
            if kw in fl and data.get(dk):
                field_vals[fn] = data[dk]
                break
    writer = PdfWriter()
    writer.append(reader)
    for page in writer.pages:
        writer.update_page_form_field_values(page, field_vals, auto_regenerate=False)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def fill_generic_overlay(pdf_path, data):
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas as rl_canvas
    reader = PdfReader(str(pdf_path))
    page0  = reader.pages[0]
    pw, ph = float(page0.mediabox.width), float(page0.mediabox.height)
    packet = io.BytesIO()
    c = rl_canvas.Canvas(packet, pagesize=(pw, ph))
    c.setFont("Helvetica", 8)
    lines = [
        f"Tenant: {data.get('tenant_name','')}",
        f"Property: {data.get('full_address','')}",
        f"Community: {data.get('community','')}",
        f"Phone: {data.get('tenant_phone','')}  Email: {data.get('tenant_email','')}",
        f"Lease: {data.get('lease_start','')} to {data.get('lease_end','')}",
        f"Owner: {data.get('owner_name','')}  {data.get('owner_phone','')}",
        f"Managed by: {data.get('mgmt_company','')}  {data.get('mgmt_phone','')}",
    ]
    lines = [l for l in lines if l.split(":",1)[-1].strip()]
    y = ph - 25
    bh = len(lines) * 11 + 8
    c.setFillColorRGB(0.95, 0.97, 1.0)
    c.rect(20, y - bh + 4, pw - 40, bh, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    for line in lines:
        c.drawString(24, y, line)
        y -= 11
    c.save()
    packet.seek(0)
    from pypdf import PdfReader as PR2
    overlay = PR2(packet).pages[0]
    writer  = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i == 0:
            page.merge_page(overlay)
        writer.add_page(page)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def main():
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            print(json.dumps({"error": "No input received"}))
            return

        inp = json.loads(raw)
        lease_id    = inp.get("leaseID") or inp.get("lease_id") or inp.get("leaseId")
        template_id = (inp.get("templateId") or inp.get("template_id") or
                       inp.get("template") or inp.get("templateID") or "")
        overrides   = inp.get("overrides") or {}
        if isinstance(overrides, str):
            try: overrides = json.loads(overrides)
            except: overrides = {}

        if not template_id:
            print(json.dumps({"error": "templateId is required"}))
            return

        pdf_path = find_template_file(template_id)
        if not pdf_path:
            print(json.dumps({"error": f"Template not found: {template_id}"}))
            return

        data = {}
        if lease_id:
            data = get_lease_data(lease_id)
            sys.stderr.write(f"Tenant: {data.get('tenant_name')} | Addr: {data.get('full_address')}\n")

        data.update({k: v for k, v in overrides.items() if v})

        # Try coordinate map first
        coord_key = find_coord_key(template_id) or find_coord_key(pdf_path.stem)
        pdf_bytes = None

        if coord_key:
            sys.stderr.write(f"Using coord map: {coord_key}\n")
            pdf_bytes = fill_pdf_overlay(pdf_path, data, coord_key)

        if not pdf_bytes:
            pdf_bytes = fill_fillable_pdf(pdf_path, data)

        if not pdf_bytes:
            pdf_bytes = fill_generic_overlay(pdf_path, data)

        b64      = base64.b64encode(pdf_bytes).decode()
        tenant   = data.get("tenant_name","form").replace(" ","_").replace("&","and")
        filename = f"HOA_{pdf_path.stem}_{tenant}.pdf"
        print(json.dumps({"pdf": b64, "filename": filename}))

    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
