exec(open('gen.py').read().split('\nFULL_W, FULL_H')[0])
import json, pathlib
OUT = pathlib.Path('.')
FW, FH = 1500, 940

# ── native SwiftUI vocabulary (differs from the web build) ───────────────────
SF_SIDEBAR = 'rgba(255,255,255,0.045)'   # NSVisualEffectView sidebar material
SYS_BLUE   = '#0a84ff'                    # macOS system accent (dark)

def sfsym(c=SEC, s=15):
    return (f'<span style="width:{s}px;height:{s}px;display:inline-block;position:relative;flex:none">'
            f'<span style="position:absolute;inset:1px;border:1.6px solid {c};border-radius:3.5px"></span>'
            f'<span style="position:absolute;left:4px;right:4px;top:6px;height:1.6px;background:{c}"></span></span>')

def native_toolbar(title, sub):
    lights = ''.join(f'<span style="width:12px;height:12px;border-radius:50%;background:{c}"></span>'
                     for c in ('#ff5f57','#febc2e','#28c840'))
    btns = ''.join(f'<span style="height:22px;min-width:28px;border-radius:6px;background:rgba(255,255,255,0.08);'
                   f'display:inline-flex;align-items:center;justify-content:center">{sfsym(TXT,13)}</span>' for _ in range(3))
    return (f'<div style="height:52px;flex:none;display:flex;align-items:center;gap:9px;padding:0 14px;'
            f'background:rgba(255,255,255,0.05);border-bottom:1px solid rgba(255,255,255,0.09);backdrop-filter:blur(20px)">'
            f'<div style="display:flex;gap:8px;align-items:center">{lights}</div>'
            f'<div style="margin-left:14px;display:flex;flex-direction:column;line-height:1.15">'
            f'<span style="font-family:{UI};font-size:13px;font-weight:600;color:{TXT}">{title}</span>'
            f'<span style="font-family:{UI};font-size:10.5px;color:{SEC}">{sub}</span></div>'
            f'<div style="margin-left:auto;display:flex;gap:7px;align-items:center">{btns}</div></div>')

def native_sidebar():
    groups = [('Workspaces', ['Home','My Dashboard','Portfolio Manager']),
              ('Hubs', ['Markets','Companies','Options','Macro & Rates','Portfolio'])]
    out = ''
    for gname, items in groups:
        out += (f'<div style="padding:11px 14px 4px;font-family:{UI};font-size:11px;font-weight:600;'
                f'color:{SEC}">{gname}</div>')
        for it in items:
            sel = it == 'Portfolio'
            out += (f'<div style="margin:1px 8px;padding:5px 8px;border-radius:6px;display:flex;align-items:center;gap:8px;'
                    f'{"background:"+SYS_BLUE if sel else ""}">'
                    f'{sfsym("#ffffff" if sel else SEC,15)}'
                    f'<span style="font-family:{UI};font-size:13px;color:{"#ffffff" if sel else TXT}">{it}</span></div>')
    return (f'<div style="width:216px;flex:none;background:{SF_SIDEBAR};border-right:1px solid rgba(255,255,255,0.07);'
            f'backdrop-filter:blur(24px);padding-top:6px">{out}</div>')

def native_kpi(cells):
    out = ''.join(
        f'<div style="flex:1;background:rgba(255,255,255,0.045);border-radius:9px;padding:11px 13px">'
        f'<div style="font-family:{UI};font-size:11px;color:{SEC}">{l}</div>'
        f'<div style="font-family:{UI};font-size:23px;font-weight:600;color:{c};letter-spacing:-0.01em;'
        f'font-variant-numeric:tabular-nums;margin-top:2px">{v}</div>'
        f'<div style="font-family:{UI};font-size:10.5px;color:{SEC}">{s}</div></div>'
        for l, v, s, c in cells)
    return f'<div style="display:flex;gap:9px">{out}</div>'

def native_card(title, body, h=None):
    hs = f'height:{h}px;' if h else ''
    return (f'<div style="{hs}background:rgba(255,255,255,0.045);border-radius:10px;padding:13px 14px;'
            f'display:flex;flex-direction:column;overflow:hidden">'
            f'<div style="font-family:{UI};font-size:12.5px;font-weight:600;color:{TXT};margin-bottom:9px">{title}</div>'
            f'<div style="flex:1;min-height:0">{body}</div></div>')

def native_table(cols, rows):
    head = ''.join(f'<th style="text-align:{"left" if i==0 else "right"};padding:5px 10px;font-family:{UI};'
                   f'font-size:11px;font-weight:500;color:{SEC};border-bottom:1px solid rgba(255,255,255,0.08)">{c}</th>'
                   for i, c in enumerate(cols))
    body = ''
    for j, r in enumerate(rows):
        bg = 'rgba(255,255,255,0.028)' if j % 2 else 'transparent'
        tds = ''
        for i, cell in enumerate(r):
            col = TXT
            if isinstance(cell, str) and cell.startswith('+'): col = POS
            elif isinstance(cell, str) and cell.startswith('-'): col = NEG
            tds += (f'<td style="text-align:{"left" if i==0 else "right"};padding:6px 10px;font-family:{UI};'
                    f'font-size:12.5px;color:{col};font-variant-numeric:tabular-nums;'
                    f'font-weight:{500 if i==0 else 400}">{cell}</td>')
        body += f'<tr style="background:{bg}">{tds}</tr>'
    return (f'<div style="border-radius:8px;overflow:hidden;background:rgba(255,255,255,0.02)">'
            f'<table style="width:100%;border-collapse:collapse"><thead><tr>{head}</tr></thead>'
            f'<tbody>{body}</tbody></table></div>')

# ── shell chrome per option ──────────────────────────────────────────────────
def web_shell(surface_fn, title, engine_note, frameless):
    """Tauri and Electron render the SAME web build. Only the window frame and
    the engine underneath differ, so the difference is drawn in the chrome."""
    lights = ''.join(f'<span style="width:12px;height:12px;border-radius:50%;background:{c}"></span>'
                     for c in ('#ff5f57','#febc2e','#28c840'))
    if frameless:
        bar = (f'<div style="height:36px;flex:none;display:flex;align-items:center;gap:9px;padding:0 13px;'
               f'background:{SURF};border-bottom:1px solid {LINE}">'
               f'<div style="display:flex;gap:8px">{lights}</div>'
               f'<span style="margin-left:13px;font-family:{SERIF};font-size:12px;letter-spacing:0.16em;color:{GOLD}">ALPHATAPE</span>'
               f'<span style="margin-left:auto;font-family:{MONO};font-size:10px;color:{SEC}">{engine_note}</span></div>')
    else:
        bar = (f'<div style="height:28px;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;'
               f'background:rgba(255,255,255,0.07);border-bottom:1px solid {LINE}">'
               f'<div style="display:flex;gap:8px">{lights}</div>'
               f'<span style="margin:0 auto;font-family:{UI};font-size:12px;font-weight:600;color:{TXT}">{title}</span>'
               f'<span style="font-family:{MONO};font-size:9.5px;color:{SEC}">{engine_note}</span></div>')
    return (f'{bar}<div style="flex:1;min-height:0;display:flex">{sidebar(204)}'
            f'<div style="flex:1;min-width:0;background:{BG};overflow:hidden">{surface_fn(FW, FH, True)}</div></div>')

def native_cockpit():
    k = [('Alpha','+11.6%','Factor adjusted',POS),('Beta','1.60','vs SPY',TXT),
         ('CAGR','+35.3%','+22.3% active',POS),('Max drawdown','-38.2%','Calmar 0.92',NEG)]
    donut = (f'<svg viewBox="0 0 42 42" style="height:110px"><circle cx="21" cy="21" r="15.9" fill="none" '
             f'stroke="{SYS_BLUE}" stroke-width="7" stroke-dasharray="70 30" transform="rotate(-90 21 21)"/>'
             f'<circle cx="21" cy="21" r="15.9" fill="none" stroke="#5e5ce6" stroke-width="7" '
             f'stroke-dasharray="30 70" stroke-dashoffset="-70" transform="rotate(-90 21 21)"/></svg>')
    leg = ''.join(f'<div style="display:flex;align-items:center;gap:8px;padding:3px 0">'
                  f'<span style="width:8px;height:8px;border-radius:2px;background:{c}"></span>'
                  f'<span style="font-family:{UI};font-size:12px;color:{TXT};flex:1">{n}</span>'
                  f'<span style="font-family:{UI};font-size:12px;color:{SEC};font-variant-numeric:tabular-nums">{v}</span></div>'
                  for n, v, c in [('Technology','70.7%',SYS_BLUE),('Semiconductors','29.3%','#5e5ce6')])
    seg = ''.join(f'<span style="flex:1;text-align:center;padding:3px 0;border-radius:6px;font-family:{UI};font-size:11.5px;'
                  f'{"background:rgba(255,255,255,0.14);color:"+TXT if t=="5Y" else "color:"+SEC}">{t}</span>'
                  for t in ['1M','6M','1Y','5Y','Max'])
    return (f'<div style="padding:16px 18px;display:flex;flex-direction:column;gap:11px;height:100%;box-sizing:border-box">'
            f'<div style="display:flex;align-items:center;gap:12px">'
            f'<span style="font-family:{UI};font-size:19px;font-weight:600;color:{TXT}">Portfolio Analysis</span>'
            f'<span style="margin-left:auto;display:flex;gap:2px;background:rgba(255,255,255,0.06);'
            f'border-radius:8px;padding:2px;width:230px">{seg}</span></div>'
            f'{native_kpi(k)}'
            f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;flex:1;min-height:0">'
            f'{native_card("Sector allocation", f"<div style=\'display:flex;align-items:center;gap:16px;height:100%\'><div style=\'flex:none\'>{donut}</div><div style=\'flex:1\'>{leg}</div></div>")}'
            f'{native_card("Return path", area(c=SYS_BLUE, seed=1))}'
            f'{native_card("Downside path", area(c=NEG, seed=4))}'
            f'{native_card("Monte Carlo range", area(c="#5e5ce6", seed=6))}</div></div>')

def native_scanner():
    rows = [('NVDA','219.07','+2.19%','5.31T','48.2'),('AAPL','316.94','+2.23%','4.71T','36.1'),
            ('MSFT','484.42','-0.41%','3.60T','33.8'),('AMZN','241.18','+1.02%','2.51T','41.6'),
            ('GOOGL','208.55','-0.18%','2.49T','26.4'),('META','712.30','+0.94%','1.81T','29.0'),
            ('AVGO','388.11','+3.41%','1.79T','52.7'),('TSLA','402.66','-1.87%','1.28T','88.3'),
            ('BRK-B','512.04','+0.31%','1.11T','14.2'),('LLY','944.77','+1.16%','0.89T','61.5')]
    pills = ''.join(f'<span style="padding:4px 11px;border-radius:14px;background:rgba(255,255,255,0.07);'
                    f'font-family:{UI};font-size:11.5px;color:{TXT}">{t}</span>'
                    for t in ['Market cap > $10B','P/E < 60','US'])
    search = (f'<div style="height:28px;border-radius:7px;background:rgba(255,255,255,0.07);display:flex;'
              f'align-items:center;gap:7px;padding:0 9px;width:220px">{sfsym(SEC,13)}'
              f'<span style="font-family:{UI};font-size:12.5px;color:{SEC}">Filter</span></div>')
    return (f'<div style="padding:16px 18px;display:flex;flex-direction:column;gap:11px;height:100%;box-sizing:border-box">'
            f'<div style="display:flex;align-items:center;gap:12px">'
            f'<span style="font-family:{UI};font-size:19px;font-weight:600;color:{TXT}">Stock Screener</span>'
            f'<span style="font-family:{UI};font-size:12px;color:{SEC}">249 matches</span>'
            f'<span style="margin-left:auto">{search}</span></div>'
            f'<div style="display:flex;gap:7px">{pills}</div>'
            f'<div style="flex:1;min-height:0;overflow:hidden">'
            f'{native_table(["Ticker","Price","Change","Market cap","P/E"], rows)}</div></div>')

def native_shell(body_fn, sub):
    return (f'{native_toolbar("Portfolio", sub)}'
            f'<div style="flex:1;min-height:0;display:flex">{native_sidebar()}'
            f'<div style="flex:1;min-width:0;background:{BG};overflow:hidden">{body_fn()}</div></div>')

def wrap2(inner, w, h):
    return f'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body {{ margin: 0; background: #06080d; }}
    a {{ color: {GOLD}; }} a:hover {{ color: #e0c169; }}
    * {{ box-sizing: border-box; }}
  </style>
</helmet>
<div style="width:{w}px;height:{h}px;background:{BG};color:{TXT};overflow:hidden;display:flex;flex-direction:column;font-family:{UI};border-radius:10px">
{inner}
</div>
</x-dc>
<script data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{ renderVals() {{ return {{}}; }} }}
</script>
</body>
</html>
'''

files = {}
files['TauriCockpit.dc.html']    = wrap2(web_shell(s_cockpit, 'AlphaTape Terminal', 'WKWebView', True), FW, FH)
files['TauriScanner.dc.html']    = wrap2(web_shell(s_table,   'AlphaTape Terminal', 'WKWebView', True), FW, FH)
files['ElectronCockpit.dc.html'] = wrap2(web_shell(s_cockpit, 'AlphaTape Terminal', 'Chromium 126', False), FW, FH)
files['ElectronScanner.dc.html'] = wrap2(web_shell(s_table,   'AlphaTape Terminal', 'Chromium 126', False), FW, FH)
files['NativeCockpit.dc.html']   = wrap2(native_shell(native_cockpit, 'Main · 2 equities'), FW, FH)
files['NativeScanner.dc.html']   = wrap2(native_shell(native_scanner, 'US equities · live'), FW, FH)

def col(title, sub, bullets, verdict, vc):
    lis = ''.join(f'<li style="margin-bottom:7px;font-family:{UI};font-size:12.5px;color:{SEC};line-height:1.5">{b}</li>'
                  for b in bullets)
    return (f'<div style="flex:1;border:1px solid {LINE};background:{BG};padding:16px 17px;display:flex;flex-direction:column">'
            f'<div style="font-family:{UI};font-size:15px;font-weight:600;color:{TXT}">{title}</div>'
            f'<div style="font-family:{MONO};font-size:11px;color:{GOLD};margin-top:3px">{sub}</div>'
            f'<ul style="margin:13px 0 0;padding-left:16px">{lis}</ul>'
            f'<div style="margin-top:auto;padding-top:13px;border-top:1px solid {HAIR};'
            f'font-family:{UI};font-size:12.5px;color:{vc};line-height:1.45">{verdict}</div></div>')

index = f'''<div style="padding:38px 44px;font-family:{UI}">
  <div style="font-family:{SERIF};font-size:27px;letter-spacing:0.2em;color:{GOLD}">ALPHATAPE</div>
  <div style="margin-top:8px;font-family:{UI};font-size:17px;color:{TXT}">Three ways to ship a Mac app</div>
  <div style="margin-top:11px;font-family:{UI};font-size:13px;color:{SEC};max-width:900px;line-height:1.6">
    The same two surfaces are drawn in each shell &mdash; the Portfolio Analysis cockpit and the Stock
    Screener. Tauri and Electron are deliberately near-identical pictures, because they ship the same
    web build; only the frame and the engine under it change. The native column is the one that looks
    like a different product, because it is one.
  </div>
  <div style="display:flex;gap:13px;margin-top:26px">
    {col('Tauri', '2-5 days &middot; ~12 MB', [
       'Ships the existing web build inside WKWebView.',
       'Needs the Rust toolchain, not installed here.',
       'Safari engine: the 57 tools have only been verified in Chrome, so canvas charts, Leaflet and color-mix() need re-testing.',
       'Real Mac window, menu bar, dock icon, ⌘ shortcuts.'],
       'Cheapest real app. The engine switch is the risk you are taking.', TXT)}
    {col('Electron', '2-5 days &middot; ~180 MB', [
       'Ships the same web build inside its own Chromium.',
       'Needs nothing new installed.',
       'Renders exactly as tested. No engine risk at all.',
       'Heavier on disk and memory, which matters little on a desktop.'],
       'Same app, same pixels, in a Mac window. The safe version of the cheap option.', POS)}
    {col('Native SwiftUI', '12-18 months &middot; ~25 MB', [
       'A second client written from scratch against the same 289 endpoints.',
       'Real sidebar material, SF Symbols, system accent, native tables and toolbars.',
       'Swift Charts replaces Recharts in 54 files; the candlestick engine has no equivalent and must be written.',
       'The web app added 164k lines in the last 90 days. A port of this length never catches up unless you freeze it.'],
       'The only option that actually looks native. Only worth it scoped to a handful of daily tools.', GOLD)}
  </div>
  <div style="margin-top:22px;font-family:{UI};font-size:11.5px;color:{SEC};max-width:900px;line-height:1.6">
    Type is a system stack throughout: the canvas cannot load Sora or Cinzel. Everything else &mdash;
    palette, densities, rail widths, control heights &mdash; is lifted from the running app.
  </div>
</div>'''
files['Main.dc.html'] = wrap2(index, 1500, 620)

for n, s in files.items():
    OUT.joinpath(n).write_text(s)

GX, GY = 90, 96
ab = [{'file': 'Main.dc.html', 'x': 0, 'y': 0, 'w': 1500, 'h': 620, 'title': 'Three ways to ship'}]
y = 620 + GY
for label_, keys in [('Portfolio Analysis cockpit', ['TauriCockpit','ElectronCockpit','NativeCockpit']),
                     ('Stock Screener',             ['TauriScanner','ElectronScanner','NativeScanner'])]:
    for i, k in enumerate(keys):
        opt = ['Tauri (WKWebView)','Electron (Chromium)','Native SwiftUI'][i]
        ab.append({'file': f'{k}.dc.html', 'x': i * (FW + GX), 'y': y, 'w': FW, 'h': FH,
                   'title': f'{opt} — {label_}'})
    y += FH + GY
OUT.joinpath('canvas-shells.json').write_text(json.dumps({'artboards': ab, 'launch': {'view': 'canvas'}}, indent=2))
print(f'wrote {len(files)} artboards + canvas-shells.json')
