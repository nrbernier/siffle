# Renders icons-src/app-icon.svg to the PNGs in public/. Run: python3 icons-src/render.py
# Needs Python Playwright with a Chromium (any recent version).
import asyncio, pathlib
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SIZES = [(180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]

async def main():
    svg = (ROOT / 'icons-src/app-icon.svg').read_text()
    async with async_playwright() as p:
        b = await p.chromium.launch(**({'executable_path': __import__('os').environ['CHROME']} if 'CHROME' in __import__('os').environ else {}))
        for size, name in SIZES:
            page = await b.new_page(viewport={'width': size, 'height': size})
            sized = svg.replace('<svg ', f'<svg width="{size}" height="{size}" ', 1)
            await page.set_content(f"<body style='margin:0'>{sized}</body>")
            await page.screenshot(path=str(ROOT / 'public' / name))
        await b.close()

asyncio.run(main())
