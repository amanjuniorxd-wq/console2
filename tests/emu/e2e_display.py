"""
Emulator display modes in Chromium: "Original Aspect Ratio" (default) vs "Stretch to Device Resolution", measured on the
real rendered pixels (screenshot bounding box of the game picture), at 1080p / 1440p / 4K / Retina (DPR 2) / ultrawide
external monitor / 4:3 monitor, across live resizes and fullscreen; the setting persists across reloads; the game's
canvas (internal resolution) never grows — scaling is the compositor's.
Prereq: npm run build && npm run preview.   Run: python3 tests/emu/e2e_display.py
"""
import asyncio, io, os, sys
from PIL import Image
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'http://localhost:4173')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
T = os.path.join(ROOT, 'emulators', 'p1', 'testgame', 'out')
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def bbox(png):
    """Picture extent (screenshot px) along the centre row and centre column — everything that is not the black
    letterbox (the game's own background is (8,0,16); bars are (0,0,0)). Centre lines avoid the corner menu button."""
    im = Image.open(io.BytesIO(png)).convert('RGB'); W, H = im.size
    lit = lambda x, y: max(im.getpixel((x, y))) >= 6
    xs = [x for x in range(W) if lit(x, H // 2)] or [0]; ys = [y for y in range(H) if lit(W // 2, y)] or [0]
    return (xs[0], ys[0], xs[-1] + 1, ys[-1] + 1), (W, H)


VIEWS = [('1920×1080 (16:9)', 1920, 1080, 1), ('2560×1440 (16:9)', 2560, 1440, 1), ('3840×2160 (4K)', 3840, 2160, 1),
         ('4:3 monitor 1024×768', 1024, 768, 1), ('ultrawide external monitor 2560×1080', 2560, 1080, 1),
         ('Retina 1440×900 @2x', 1440, 900, 2), ('Retina 1728×1117 @2x', 1728, 1117, 2)]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--enable-unsafe-webgpu'])
        for dpr in (1, 2):
            ctx = await browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=dpr)
            page = await ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))

            async def boot(h):
                await page.goto(BASE + '/' + h)
                await page.wait_for_selector('#boot', state='detached', timeout=15000)

            await boot('#/upload')
            await page.set_input_files('.dropzone input[type=file]', [os.path.join(T, 'saffron-pulse.cue'), os.path.join(T, 'saffron-pulse.bin')])
            await page.click('.emu-card .btn-play')
            await page.wait_for_url('**/#/game/**', timeout=30000)
            gid = page.url.split('#/game/')[1]

            async def launch():
                await boot(f'#/game/{gid}')
                await page.click('button.btn-play')
                await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=30000)
                await page.wait_for_timeout(1200)

            async def set_mode(label):
                await page.click('#player .ovl-btn'); await page.click('#player [data-p=res]')
                await page.click(f'#player button:has-text("{label}")')
                await page.keyboard.press('Escape'); await page.wait_for_timeout(300)

            async def measure():
                await page.wait_for_timeout(250)
                m = await page.evaluate("""() => { const c = document.querySelector('#player .game-surface'); const r = c.getBoundingClientRect();
                  return { fit: getComputedStyle(c).objectFit, cw: c.width, ch: c.height, rw: r.width, rh: r.height, iw: innerWidth, ih: innerHeight,
                           dpr: devicePixelRatio, fs: !!document.fullscreenElement, mode: document.querySelector('#player .surface, #player [data-display]')?.dataset.display }; }""")
                (l, t, r, b), (sw, sh) = bbox(await page.screenshot())
                k = sw / m['iw']                                   # screenshot px per CSS px
                m['box'] = (l / k, t / k, (r - l) / k, (b - t) / k)
                return m

            await launch()
            check(f'DPR {dpr}: default mode is Original Aspect Ratio', (await measure())['fit'] == 'contain')
            check(f'DPR {dpr}: fullscreen on Launch', (await measure())['fs'])
            base = None
            for mode, label in (('aspect', 'Original Aspect Ratio'), ('stretch', 'Stretch to Device Resolution')):
                await set_mode(label)
                for name, w, h, d in VIEWS:
                    if d != dpr: continue
                    await page.set_viewport_size({'width': w, 'height': h})       # live resize (no relaunch)
                    m = await measure()
                    base = base or (m['cw'], m['ch'])
                    x, y, bw, bh = m['box']
                    if mode == 'aspect':
                        k = min(w / 320, h / 240)
                        ok = m['fit'] == 'contain' and abs(bw - 320 * k) <= 3 and abs(bh - 240 * k) <= 3 and abs(x - (w - bw) / 2) <= 3 and abs(y - (h - bh) / 2) <= 3
                        what = f'picture {bw:.0f}×{bh:.0f} at {x:.0f},{y:.0f} (expected {320 * k:.0f}×{240 * k:.0f}, 4:3 centered)'
                    else:
                        ok = m['fit'] == 'fill' and abs(bw - w) <= 2 and abs(bh - h) <= 2 and x <= 1 and y <= 1
                        what = f'picture {bw:.0f}×{bh:.0f} fills {w}×{h}'
                    ok = ok and (m['cw'], m['ch']) == base and m['dpr'] == dpr
                    check(f'{mode} · {name}', ok, f"{what}; canvas {m['cw']}×{m['ch']} (unchanged), DPR {m['dpr']}, fullscreen {m['fs']}")
            # persisted across reload + relaunch
            await page.set_viewport_size({'width': 1280, 'height': 720})
            stored = await page.evaluate("JSON.parse(localStorage.getItem('mishrin.settings.v1')||'{}').emuDisplay")
            await launch()
            m = await measure()
            check(f'DPR {dpr}: Stretch persists across reload and relaunch', stored == 'stretch' and m['fit'] == 'fill' and abs(m['box'][2] - 1280) <= 2, f"stored={stored}, fit={m['fit']}")
            await set_mode('Original Aspect Ratio')
            m = await measure()
            check(f'DPR {dpr}: back to Original (pillarbox on 16:9)', m['fit'] == 'contain' and abs(m['box'][2] - 960) <= 3, f"{m['box'][2]:.0f}px wide")
            # Settings page exposes the same option
            await boot('#/settings/display')
            check(f'DPR {dpr}: Settings has "Emulator display" option', await page.wait_for_selector('text=/Emulator display/i', timeout=5000) is not None)
            check(f'DPR {dpr}: no page errors', not errors, '; '.join(errors[:3]))
            await ctx.close()
        await browser.close()
    passed = sum(ok for _, ok in results)
    print(f'\n{passed}/{len(results)} display checks passed')
    sys.exit(0 if passed == len(results) else 1)


asyncio.run(main())
