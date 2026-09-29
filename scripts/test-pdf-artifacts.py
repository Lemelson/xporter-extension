#!/usr/bin/env python3
"""Validate real PDFs produced by test-pdf-browser.mjs; render every page.
Requires the bundled QA Python pypdf/pdfplumber and Poppler, not runtime deps.
Visual inspection of the resulting PNGs is a separate required check.
"""
import argparse
import json
import logging
import re
import subprocess
from pathlib import Path
from unicodedata import normalize
from pypdf import PdfReader
import pdfplumber

logging.getLogger('pdfminer').setLevel(logging.ERROR)
parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--pdftoppm', default='pdftoppm')
args = parser.parse_args()
checks = {
    'en-short-archive': ['The best archive', 'Grace Hopper', 'Lin'],
    'ru-long-article-partial': ['14.', 'Архив', 'Артём', 'Саша'],
    'zh-long-alt-and-url': ['36.', 'END_OF_LONG_URL'],
    'ar-rtl-article-context': ['layla', 'omar', 'noor'],
}
results = []
for name, tokens in checks.items():
    path = args.directory / (name + '.pdf')
    reader = PdfReader(path)
    pages = [normalize('NFKC', page.extract_text() or '') for page in reader.pages]
    assert all(len(text.strip()) > 80 for text in pages), (name, 'empty/near-empty page', [len(t) for t in pages])
    text = '\n'.join(pages)
    for token in tokens:
        assert token in text, (name, 'missing final content', token)
    if name.startswith('ar-'):
        assert sum('\u0600' <= c <= '\u06ff' for c in text) > 300
    if name.startswith('zh-'):
        assert '日本語' in re.sub(r'\s+', '', text)
    for index, page in enumerate(pages, 1):
        assert f'{index}/{len(pages)}' in re.sub(r'\s+', '', page), (name, 'page footer reversed or absent', index)
    uris = [str(annotation.get_object().get('/A', {}).get('/URI', ''))
            for page in reader.pages for annotation in page.get('/Annots', [])]
    assert any(uri.startswith('https://x.com/') for uri in uris), (name, 'missing post link')
    if name.startswith('zh-'):
        assert any(uri.endswith('END_OF_LONG_URL') for uri in uris), 'long clickable URI was truncated'
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages, 1):
            clipped = [char for char in page.chars
                       if char['x0'] < -2 or char['x1'] > page.width + 2
                       or char['top'] < -2 or char['bottom'] > page.height + 2]
            assert not clipped, (name, index, 'characters outside page bounds', clipped[:3])
    path.with_suffix('.txt').write_text(text, encoding='utf-8')
    subprocess.run([args.pdftoppm, '-scale-to', '1200', '-png', str(path),
                    str(path.with_suffix('')) + '-page'], check=True)
    results.append({'file':path.name, 'pages':len(pages),
                    'page_text_chars':[len(page) for page in pages], 'link_annotations':len(uris),
                    'blank_pages':0, 'characters_outside_page':0, 'page_numbers_correct':True})
(args.directory / 'pdf-verification.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(results, ensure_ascii=False, indent=2))
