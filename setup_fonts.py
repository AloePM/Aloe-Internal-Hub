"""
setup_fonts.py — Download Dancing Script font at Render build time.
Run once during build: python setup_fonts.py
"""

import os
import urllib.request

FONTS_DIR = os.path.join(os.path.dirname(__file__), 'fonts')
os.makedirs(FONTS_DIR, exist_ok=True)

FONT_URL = (
    'https://github.com/google/fonts/raw/main/ofl/dancingscript/'
    'DancingScript%5Bwght%5D.ttf'
)
FONT_PATH = os.path.join(FONTS_DIR, 'DancingScript-Regular.ttf')

if os.path.exists(FONT_PATH):
    print(f'Font already exists: {FONT_PATH}')
else:
    print(f'Downloading Dancing Script font...')
    try:
        urllib.request.urlretrieve(FONT_URL, FONT_PATH)
        print(f'Font downloaded: {FONT_PATH} ({os.path.getsize(FONT_PATH):,} bytes)')
    except Exception as e:
        print(f'Warning: Could not download font: {e}')
        print('Signature will use Helvetica-Oblique as fallback.')

print('Font setup complete.')
