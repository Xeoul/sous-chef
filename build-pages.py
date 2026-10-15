#!/usr/bin/env python3
"""Builds index.html (the GitHub Pages site) from artifact/sous-chef.html.

The artifact source is written for claude.ai, which wraps it in a document shell when it's
published. This wraps it the same way, adds the site icons, and loads demo-seed.js just before
the app starts so a first visit opens with sample recipes. Run it after changing the artifact:

    python3 build-pages.py
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent
app = (root / 'artifact' / 'sous-chef.html').read_text(encoding='utf-8')

head = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    '<link rel="icon" href="icon.svg" type="image/svg+xml">'
    '<link rel="icon" href="favicon-32.png" type="image/png" sizes="32x32">'
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">'
    '<link rel="manifest" href="manifest.webmanifest">'
    '<meta name="theme-color" content="#1F6F54">'
    '<meta name="apple-mobile-web-app-title" content="Sous Chef">'
    '<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}'
    'body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}'
    'img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n'
)

marker = '\n<script>\n(function () {'
if app.count(marker) != 1:
    raise SystemExit('Could not find the app script in artifact/sous-chef.html')
app = app.replace(marker, '\n<script src="demo-seed.js"></script>' + marker)

(root / 'index.html').write_text(head + app.rstrip('\n') + '\n</body></html>\n', encoding='utf-8')
print('Wrote index.html')
