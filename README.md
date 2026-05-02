# HOA Form Filler — Aloe Property Management

Python/Flask microservice that fills HOA registration PDFs with tenant data pulled from Rentvine.

## Architecture

```
Aloe PM Internal Hub (server.js on Render)
  └── calls /api/hoa/* 
         └── aloe-hoa-form-filler (this service, Python on Render)
               ├── Rentvine API → tenant, lease, vehicle data
               └── PDF filling → pypdf (fillable) + reportlab (overlay)
```

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/leases` | All active leases for dropdown |
| GET | `/api/lease/:id` | Full lease detail (tenant, vehicles, property) |
| GET | `/api/hoa/templates` | List available HOA PDF templates |
| POST | `/api/hoa/fill` | Fill a form — returns base64 PDF |
| GET | `/api/hoa/download/:lease_id/:template_id` | Stream filled PDF |
| GET | `/api/hoa/preview-data/:lease_id` | Preview what data will be used |

## Setup

### 1. Create GitHub repo: `AloePM/hoa-form-filler`

```bash
git init
git remote add origin https://github.com/AloePM/hoa-form-filler.git
git add .
git commit -m "Initial HOA form filler migration from Replit"
git push -u origin main
```

### 2. Create Render service

- New Web Service → connect `AloePM/hoa-form-filler`
- Runtime: Python
- Build command: `pip install -r requirements.txt && python setup_fonts.py`
- Start command: `gunicorn main:app --workers 2 --timeout 120 --bind 0.0.0.0:$PORT`
- Plan: Free (or Starter for always-on)

### 3. Set environment variables in Render

```
RENTVINE_API_KEY=your_key
RENTVINE_API_SECRET=your_secret
RENTVINE_ACCOUNT=aloepm
MGMT_COMPANY_NAME=Aloe Property Management
MGMT_PHONE=(602) 854-9884
MGMT_EMAIL=info@aloepm.com
```

### 4. Add HOA PDF templates

Upload your HOA PDF forms to the `/templates/` directory.
Name them as: `{community_name_slug}.pdf` (e.g., `trestle_hoa.pdf`)

### 5. Add HOA_FILLER_URL to server.js env

In your main Aloe PM server Render environment:
```
HOA_FILLER_URL=https://aloe-hoa-form-filler.onrender.com
```

## Adding a new HOA template

1. Upload the PDF to `/templates/`
2. If it's a **fillable PDF**: the auto-mapper handles it automatically
3. If it's a **non-fillable PDF**: add coordinate mapping in `pdf_filler.py`:

```python
TEMPLATE_COORDS['your_hoa_name'] = [
    {'field': 'tenant_name', 'x': 72, 'y': 695, 'size': 10, 'page': 0},
    # ... more fields
]
```

Use the coordinate calibration tool at `/calibrate` to find exact positions.

## File structure

```
hoa-form-filler/
├── main.py              # Flask routes
├── rentvine_api.py      # Rentvine data fetcher
├── fillable_filler.py   # Fillable PDF (AcroForm) handler
├── pdf_filler.py        # Coordinate overlay for non-fillable PDFs
├── setup_fonts.py       # Downloads Dancing Script font at build time
├── requirements.txt
├── render.yaml
├── fonts/               # Auto-populated at build time
│   └── DancingScript-Regular.ttf
└── templates/           # HOA PDF forms — add yours here
    └── trestle_hoa.pdf
```
