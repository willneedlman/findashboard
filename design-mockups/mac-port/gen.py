import json, pathlib
OUT = pathlib.Path('.')

BG, SURF, GOLD = '#101c2e', '#0d1826', '#c9a84c'
TXT, SEC, BLUE = '#d7e3fc', '#8099b0', '#60a5fa'
POS, NEG = '#3fb37f', '#e5484d'
LINE = 'rgba(255,255,255,0.08)'
HAIR = 'rgba(255,255,255,0.05)'
UI  = "-apple-system, 'Helvetica Neue', sans-serif"
MONO= "ui-monospace, 'SF Mono', Menlo, monospace"
SERIF="'Iowan Old Style', Georgia, serif"

def label(t, sz=9, c=SEC, ls='0.16em'):
    return (f'<span style="font-family:{UI};font-size:{sz}px;font-weight:700;letter-spacing:{ls};'
            f'text-transform:uppercase;color:{c}">{t}</span>')

def num(t, sz=15, c=TXT, w=700):
    return f'<span style="font-family:{MONO};font-size:{sz}px;font-weight:{w};color:{c}">{t}</span>'

def menubar(w):
    items = ['AlphaTape','File','Edit','View','Tools','Portfolio','Window','Help']
    cells = ''.join(
        f'<span style="font-family:{UI};font-size:12px;color:{TXT if i==0 else SEC};'
        f'font-weight:{600 if i==0 else 400}">{m}</span>' for i, m in enumerate(items))
    right = (f'<div style="display:flex;gap:14px;align-items:center;margin-left:auto">'
             f'<span style="font-family:{MONO};font-size:11px;color:{SEC}">SPY 766.48</span>'
             f'<span style="font-family:{MONO};font-size:11px;color:{SEC}">Thu 09:41</span></div>')
    return (f'<div style="height:24px;display:flex;align-items:center;gap:18px;padding:0 14px;'
            f'background:rgba(255,255,255,0.06);border-bottom:1px solid {LINE}">{cells}{right}</div>')

def titlebar(title, w):
    lights = ''.join(f'<span style="width:11px;height:11px;border-radius:50%;background:{c}"></span>'
                     for c in ('#ff5f57', '#febc2e', '#28c840'))
    return (f'<div style="height:38px;display:flex;align-items:center;gap:8px;padding:0 13px;'
            f'background:{SURF};border-bottom:1px solid {LINE}">'
            f'<div style="display:flex;gap:8px;align-items:center">{lights}</div>'
            f'<span style="margin-left:12px;font-family:{UI};font-size:12px;font-weight:600;color:{TXT}">{title}</span>'
            f'<div style="margin-left:auto;display:flex;gap:7px">'
            f'{ico()}{ico()}{ico(GOLD)}</div></div>')

def ico(c=SEC):
    return (f'<span style="width:22px;height:22px;border:1px solid {LINE};border-radius:5px;'
            f'display:inline-block;position:relative">'
            f'<span style="position:absolute;inset:6px;border:1.5px solid {c};border-radius:2px"></span></span>')

def sidebar(w=204, collapsed=False):
    hubs = ['Markets','Companies','Options','Macro & Rates','Charts & Stats',
            'Valuation','Portfolio','Trading Desk','Trade Routes']
    if collapsed:
        rows = ''.join(f'<div style="height:30px;display:flex;align-items:center;justify-content:center">'
                       f'<span style="width:15px;height:15px;border:1.5px solid {GOLD if i==6 else SEC};'
                       f'border-radius:3px;opacity:{1 if i==6 else .5}"></span></div>' for i in range(9))
        return (f'<div style="width:52px;flex:none;background:{SURF};border-right:1px solid {LINE};'
                f'padding:10px 0;display:flex;flex-direction:column;gap:3px">{rows}</div>')
    rows = ''.join(
        f'<div style="display:flex;align-items:center;gap:9px;padding:6px 12px;'
        f'{"border-left:2px solid "+GOLD+";background:rgba(201,168,76,0.07)" if h=="Portfolio" else "border-left:2px solid transparent"}">'
        f'<span style="width:13px;height:13px;border:1.5px solid {GOLD if h=="Portfolio" else SEC};border-radius:3px;flex:none"></span>'
        f'<span style="font-family:{UI};font-size:12.5px;color:{GOLD if h=="Portfolio" else TXT}">{h}</span></div>'
        for h in hubs)
    return (f'<div style="width:{w}px;flex:none;background:{SURF};border-right:1px solid {LINE};'
            f'display:flex;flex-direction:column">'
            f'<div style="padding:13px 14px 9px;display:flex;align-items:center;gap:8px">'
            f'<span style="font-family:{SERIF};font-size:14px;letter-spacing:0.1em;color:{GOLD}">ALPHATAPE</span></div>'
            f'<div style="margin:0 12px 10px;height:28px;border:1px solid {LINE};border-radius:5px;'
            f'display:flex;align-items:center;padding:0 9px;gap:7px">'
            f'<span style="width:11px;height:11px;border:1.5px solid {SEC};border-radius:50%"></span>'
            f'<span style="font-family:{UI};font-size:11.5px;color:{SEC}">Search</span>'
            f'<span style="margin-left:auto;font-family:{UI};font-size:10px;color:{SEC}">⌘K</span></div>'
            f'<div style="padding:0 0 6px">{label("Hubs")}</div>{rows}</div>')

def panel(title, body, meta='', h=None, span=''):
    hs = f'height:{h}px;' if h else ''
    return (f'<div style="position:relative;border:1px solid {LINE};background:{BG};{hs}{span}'
            f'display:flex;flex-direction:column;overflow:hidden">'
            f'<div style="position:absolute;top:0;left:0;background:{SURF};padding:4px 9px;'
            f'border-right:1px solid {LINE};border-bottom:1px solid {LINE};z-index:2">{label(title,9.5,TXT,"0.14em")}</div>'
            + (f'<div style="position:absolute;top:6px;right:11px;font-family:{MONO};font-size:8.5px;color:{SEC}">{meta}</div>' if meta else '')
            + f'<div style="padding:30px 12px 12px;flex:1;min-height:0">{body}</div></div>')

def kpi(cells, dense=True):
    pad = '9px 13px' if dense else '10px 14px'
    out = []
    for i, (l, v, s, c) in enumerate(cells):
        out.append(f'<div style="flex:1;padding:{pad};box-sizing:border-box;'
                   f'{"border-left:1px solid "+HAIR if i else ""}">'
                   f'<div>{label(l,9,SEC,"0.14em")}</div>'
                   f'<div style="margin-top:3px">{num(v,16,c)}</div>'
                   f'<div style="font-family:{MONO};font-size:9px;color:{SEC};margin-top:2px">{s}</div></div>')
    return (f'<div style="display:flex;background:{SURF};border:1px solid {LINE}">' + ''.join(out) + '</div>')

def spark(w=100, h=34, c=GOLD, seed=3):
    import math
    pts = ' '.join(f'{i*w/28:.0f},{h - (h*0.5 + math.sin(i/3.1+seed)*h*0.3 + (i%5)*1.1):.0f}' for i in range(29))
    return (f'<svg viewBox="0 0 {w} {h}" style="width:100%;height:{h}px;display:block">'
            f'<polyline points="{pts}" fill="none" stroke="{c}" stroke-width="1.5"/></svg>')

def area(w=100, h=60, c=BLUE, seed=1):
    import math
    pts = [(i*w/32, h - (h*0.45 + math.sin(i/4.0+seed)*h*0.28 + (i%4)*1.4)) for i in range(33)]
    line = ' '.join(f'{x:.0f},{y:.0f}' for x, y in pts)
    poly = f'0,{h} ' + line + f' {w},{h}'
    return (f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" style="width:100%;height:100%;display:block">'
            f'<polygon points="{poly}" fill="{c}" opacity="0.14"/>'
            f'<polyline points="{line}" fill="none" stroke="{c}" stroke-width="1.5"/></svg>')

def candles(n=34, h=100):
    import math
    out = []
    for i in range(n):
        base = 50 + math.sin(i/4.2)*22
        o, c = base + (i % 3) * 3 - 3, base + (i % 5) * 2.6 - 5
        up = c >= o
        col = POS if up else NEG
        top, bot = min(o, c), max(o, c)
        out.append(f'<line x1="{i*3+1.5}" y1="{top-5:.0f}" x2="{i*3+1.5}" y2="{bot+5:.0f}" stroke="{col}" stroke-width="0.6"/>'
                   f'<rect x="{i*3:.0f}" y="{top:.0f}" width="3" height="{max(bot-top,1.5):.0f}" fill="{col}"/>')
    return (f'<svg viewBox="0 0 {n*3} {h}" preserveAspectRatio="none" style="width:100%;height:100%;display:block">'
            + ''.join(out) + '</svg>')

def table(cols, rows, dense=True):
    fs = 10.5 if dense else 11
    head = ''.join(f'<th style="text-align:{"left" if i==0 else "right"};padding:5px 9px;'
                   f'font-family:{UI};font-size:8.5px;font-weight:700;letter-spacing:0.12em;'
                   f'text-transform:uppercase;color:{SEC};border-bottom:1px solid {LINE};white-space:nowrap">{c}</th>'
                   for i, c in enumerate(cols))
    body = ''
    for r in rows:
        tds = ''
        for i, cell in enumerate(r):
            col = TXT
            if isinstance(cell, str) and cell.startswith('+'): col = POS
            elif isinstance(cell, str) and cell.startswith('-'): col = NEG
            elif i == 0: col = GOLD
            tds += (f'<td style="text-align:{"left" if i==0 else "right"};padding:4px 9px;'
                    f'font-family:{MONO};font-size:{fs}px;color:{col};border-bottom:1px solid {HAIR};'
                    f'white-space:nowrap">{cell}</td>')
        body += f'<tr>{tds}</tr>'
    return f'<table style="width:100%;border-collapse:collapse">{head and "<thead><tr>"+head+"</tr></thead>"}<tbody>{body}</tbody></table>'

# ── the seven surfaces ────────────────────────────────────────────────────────
def s_home(w, h, wide):
    tiles = ['Markets','Companies','Options','Macro & Rates','Charts & Stats','Valuation','Portfolio','Trading Desk','Trade Routes']
    cols = 3 if wide else 2
    cards = ''.join(
        f'<div style="border:1px solid {LINE};background:{BG};padding:11px 13px">'
        f'<div style="display:flex;align-items:center;gap:8px">'
        f'<span style="width:13px;height:13px;border:1.5px solid {GOLD};border-radius:3px"></span>'
        f'<span style="font-family:{UI};font-size:13px;color:{TXT}">{t}</span>'
        f'<span style="margin-left:auto;font-family:{MONO};font-size:10px;color:{SEC}">{n}</span></div>'
        f'<div style="font-family:{UI};font-size:10.5px;color:{SEC};margin-top:5px">What is moving right now, and why.</div></div>'
        for t, n in zip(tiles, [7,6,6,10,5,6,8,5,4]))
    return (f'<div style="padding:{"34px 40px" if wide else "20px 18px"};display:flex;flex-direction:column;gap:{22 if wide else 14}px">'
            f'<div style="text-align:center">'
            f'<div style="font-family:{SERIF};font-size:{40 if wide else 27}px;letter-spacing:0.24em;color:{GOLD}">ALPHATAPE</div>'
            f'<div style="margin-top:7px">{label("Thu, Aug 20 · Market open",9.5)}</div></div>'
            f'<div style="max-width:{620 if wide else 420}px;width:100%;margin:0 auto;border-bottom:1px solid {GOLD}66;'
            f'display:flex;align-items:center;gap:10px;padding:9px 3px">'
            f'<span style="width:14px;height:14px;border:1.5px solid {GOLD};border-radius:50%"></span>'
            f'<span style="font-family:{UI};font-size:{15 if wide else 13}px;color:{SEC}">Search tickers or tools</span>'
            f'<span style="margin-left:auto;font-family:{UI};font-size:10px;color:{SEC};border:1px solid {LINE};padding:1px 6px">⌘K</span></div>'
            f'<div>{label("Hubs · 57 tools")}'
            f'<div style="display:grid;grid-template-columns:repeat({cols}, minmax(0,1fr));gap:9px;margin-top:9px">{cards}</div></div></div>')

def s_cockpit(w, h, wide):
    k1 = [('Alpha','+11.6%','Factor adjusted',POS),('Beta','1.60','vs SPY',TXT),('CAGR','+35.3%','+22.3% active',POS),
          ('Max DD','-38.2%','Calmar 0.92',NEG),('Sharpe','0.95','Sortino 1.46',TXT),('Vol','33.9%','Annualized',TXT)]
    k2 = [('VaR 95%','-28.6%','5th percentile',NEG),('CVaR 95%','-42.7%','worst 5%',NEG),
          ('Median','+61.5%','terminal',POS),('95th','+321%','upside',POS),('Liquidation','0.0%','0 paths',POS)]
    if not wide:
        k1, k2 = k1[:3], k2[:3]
    donut = (f'<svg viewBox="0 0 42 42" style="height:100%;max-height:150px"><circle cx="21" cy="21" r="15.9" fill="none" '
             f'stroke="{GOLD}" stroke-width="7" stroke-dasharray="70 30" transform="rotate(-90 21 21)"/>'
             f'<circle cx="21" cy="21" r="15.9" fill="none" stroke="{BLUE}" stroke-width="7" '
             f'stroke-dasharray="30 70" stroke-dashoffset="-70" transform="rotate(-90 21 21)"/></svg>')
    leg = ''.join(f'<div style="display:flex;align-items:center;gap:7px;padding:3px 0">'
                  f'<span style="width:7px;height:7px;background:{c}"></span>'
                  f'<span style="font-family:{MONO};font-size:10px;color:{SEC}">{n}</span>'
                  f'<span style="margin-left:auto;font-family:{MONO};font-size:10px;color:{TXT}">{v}</span></div>'
                  for n, v, c in [('Technology','70.7%',GOLD),('Semiconductors','29.3%',BLUE)])
    sector = (f'<div style="display:flex;height:100%;align-items:center;gap:14px">'
              f'<div style="flex:1;display:flex;justify-content:center">{donut}</div>'
              f'<div style="flex:1;max-width:210px">{leg}</div></div>')
    grid = 'repeat(2, minmax(0,1fr))' if wide else '1fr'
    ph = 200 if wide else 132
    return (f'<div style="padding:{"14px 18px" if wide else "11px 12px"};display:flex;flex-direction:column;gap:9px;height:100%;box-sizing:border-box">'
            f'{kpi(k1)}{kpi(k2)}'
            f'<div style="display:grid;grid-template-columns:{grid};gap:9px;flex:1;min-height:0">'
            f'{panel("Sector allocation", sector, "Current value", ph)}'
            f'{panel("Return path", area(seed=1), "Growth of $100 vs SPY", ph)}'
            f'{panel("Downside path", area(c=NEG, seed=4), "Peak-to-trough", ph)}'
            f'{panel("Monte Carlo range", area(c=BLUE, seed=6), "500 paths", ph)}</div>'
            f'{panel("Downtrend watch", f"<span style=\'font-family:{UI};font-size:11.5px;color:{SEC}\'>No modeled holding has a negative return over the five-year window.</span>", "Select a holding", 58)}</div>')

def s_rail(w, h, wide):
    fields = [('Benchmark','SPY'),('Start','2021-08-20'),('End','2026-08-20'),('Leverage','1.0x'),('Rebalance','None')]
    rows = ''.join(f'<div style="margin-bottom:9px">{label(l,8.5)}'
                   f'<div style="margin-top:3px;height:26px;border:1px solid {LINE};background:{BG};'
                   f'display:flex;align-items:center;padding:0 8px;font-family:{MONO};font-size:11px;color:{TXT}">{v}</div></div>'
                   for l, v in fields)
    holds = ''.join(f'<div style="display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid {LINE};margin-bottom:5px">'
                    f'<span style="font-family:{MONO};font-size:11px;color:{GOLD};flex:1">{t}</span>'
                    f'<span style="font-family:{MONO};font-size:11px;color:{TXT}">{p}</span></div>'
                    for t, p in [('MSFT','40'),('AAPL','30'),('GOOGL','20'),('AMZN','10')])
    rail = (f'<div style="width:{220 if wide else 62}px;flex:none;background:{SURF};border-right:1px solid {LINE};'
            f'padding:{"12px 13px" if wide else "12px 8px"};overflow:hidden">'
            + (f'{label("Parameters")}<div style="margin-top:10px">{rows}</div>'
               f'<div style="margin-top:12px">{label("Holdings")}<div style="margin-top:8px">{holds}</div></div>'
               f'<div style="margin-top:12px;height:30px;background:{GOLD};display:flex;align-items:center;justify-content:center">'
               f'<span style="font-family:{UI};font-size:10px;font-weight:700;letter-spacing:0.14em;color:{BG}">RUN BACKTEST</span></div>'
               if wide else
               ''.join(f'<div style="height:26px;display:flex;align-items:center;justify-content:center;margin-bottom:6px">'
                       f'<span style="width:14px;height:14px;border:1.5px solid {GOLD if i==0 else SEC};border-radius:3px"></span></div>'
                       for i in range(5)))
            + '</div>')
    ph = 176 if wide else 118
    body = (f'<div style="flex:1;min-width:0;padding:{"14px 16px" if wide else "10px 11px"};display:flex;flex-direction:column;gap:9px">'
            f'{kpi([("Total return","+184.2%","vs +96.1% SPY",POS),("CAGR","+23.4%","5y",POS),("Sharpe","1.19","Sortino 1.76",TXT)] + ([("Max DD","-21.6%","Calmar 1.39",NEG)] if wide else []))}'
            f'{panel("Equity curve", area(seed=2), "Growth of $100", ph)}'
            + (f'<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">'
               f'{panel("Drawdown", area(c=NEG,seed=5), "", 132)}{panel("Rolling beta", spark(c=BLUE,h=90), "60d", 132)}</div>'
               if wide else panel("Drawdown", area(c=NEG,seed=5), "", 110))
            + '</div>')
    return f'<div style="display:flex;height:100%">{rail}{body}</div>'

def s_table(w, h, wide):
    cols = ['Ticker','Price','Chg %','Mkt Cap','P/E','Vol'] if wide else ['Ticker','Price','Chg %']
    data = [('NVDA','219.07','+2.19','5.31T','48.2','182M'),('AAPL','316.94','+2.23','4.71T','36.1','94M'),
            ('MSFT','484.42','-0.41','3.60T','33.8','61M'),('AMZN','241.18','+1.02','2.51T','41.6','77M'),
            ('GOOGL','208.55','-0.18','2.49T','26.4','58M'),('META','712.30','+0.94','1.81T','29.0','33M'),
            ('AVGO','388.11','+3.41','1.79T','52.7','40M'),('TSLA','402.66','-1.87','1.28T','88.3','129M'),
            ('BRK-B','512.04','+0.31','1.11T','14.2','9M'),('LLY','944.77','+1.16','0.89T','61.5','7M')]
    rows = [r if wide else r[:3] for r in data]
    rows = [tuple(list(r)[:2] + [('+' if r[2].startswith('+') else '') + r[2] + '%'] + list(r)[3:]) for r in rows]
    filt = ''.join(f'<div style="margin-bottom:8px">{label(l,8.5)}'
                   f'<div style="margin-top:3px;height:25px;border:1px solid {LINE};display:flex;align-items:center;'
                   f'padding:0 8px;font-family:{MONO};font-size:10.5px;color:{TXT}">{v}</div></div>'
                   for l, v in [('Market cap','> $10B'),('Sector','All'),('P/E','< 60'),('Region','US')])
    rail = (f'<div style="width:{200 if wide else 54}px;flex:none;background:{SURF};border-right:1px solid {LINE};padding:12px 12px;overflow:hidden">'
            + (f'{label("Filters")}<div style="margin-top:10px">{filt}</div>' if wide else
               ''.join(f'<div style="height:25px;display:flex;align-items:center;justify-content:center;margin-bottom:6px">'
                       f'<span style="width:13px;height:13px;border:1.5px solid {SEC};border-radius:3px"></span></div>' for _ in range(4)))
            + '</div>')
    return (f'<div style="display:flex;height:100%">{rail}'
            f'<div style="flex:1;min-width:0;display:flex;flex-direction:column">'
            f'<div style="display:flex;align-items:center;gap:12px;padding:11px 15px;border-bottom:1px solid {GOLD}33">'
            f'{label("Stock Screener",13,GOLD,"0.2em")}'
            f'<span style="margin-left:auto;font-family:{MONO};font-size:10px;color:{SEC}">249 MATCHES · 09:41 ET</span></div>'
            f'<div style="flex:1;overflow:hidden;padding:0 3px">{table(cols, rows)}</div></div></div>')

def s_chart(w, h, wide):
    layers = ['Price','Volume','RSI','MACD','US 10Y','VIX','CPI YoY']
    rail = (f'<div style="width:{164 if wide else 50}px;flex:none;background:{SURF};border-right:1px solid {LINE};padding:11px 10px;overflow:hidden">'
            + (f'{label("Layers")}' + ''.join(
                f'<div style="display:flex;align-items:center;gap:8px;padding:5px 4px;margin-top:3px;'
                f'{"background:rgba(201,168,76,0.08)" if i<2 else ""}">'
                f'<span style="width:9px;height:9px;border:1.5px solid {GOLD if i<2 else SEC};border-radius:2px"></span>'
                f'<span style="font-family:{UI};font-size:11px;color:{TXT if i<2 else SEC}">{l}</span></div>' for i, l in enumerate(layers))
               if wide else ''.join(f'<div style="height:24px;display:flex;align-items:center;justify-content:center;margin-bottom:5px">'
                                    f'<span style="width:12px;height:12px;border:1.5px solid {GOLD if i<2 else SEC};border-radius:2px"></span></div>'
                                    for i in range(7)))
            + '</div>')
    lanes = ['Volume','RSI'] if wide else ['Volume']
    lane_h = 62 if wide else 48
    lane_html = ''.join(f'<div style="border-top:1px solid {LINE};height:{lane_h}px;padding:5px 10px;box-sizing:border-box;position:relative">'
                        f'<span style="position:absolute;top:4px;left:10px;z-index:2">{label(l,8)}</span>'
                        f'{spark(c=BLUE if l=="RSI" else SEC, h=lane_h-16, seed=i*3)}</div>' for i, l in enumerate(lanes))
    return (f'<div style="display:flex;height:100%">{rail}'
            f'<div style="flex:1;min-width:0;display:flex;flex-direction:column">'
            f'<div style="display:flex;align-items:center;gap:12px;padding:9px 14px;border-bottom:1px solid {LINE}">'
            f'{label("Chart Studio",11.5,GOLD,"0.2em")}'
            f'<span style="font-family:{MONO};font-size:11px;color:{TXT}">SPY</span>'
            f'<div style="display:flex;gap:2px;margin-left:6px">'
            + ''.join(f'<span style="font-family:{MONO};font-size:9.5px;padding:2px 7px;'
                      f'color:{GOLD if t=="1D" else SEC};border-bottom:2px solid {GOLD if t=="1D" else "transparent"}">{t}</span>'
                      for t in (['1m','5m','1h','1D','1W'] if wide else ['1h','1D','1W']))
            + f'</div><span style="margin-left:auto;font-family:{MONO};font-size:10px;color:{POS}">766.48 +2.19%</span></div>'
            f'<div style="flex:1;min-height:0;padding:8px 10px">{candles(46 if wide else 28)}</div>'
            f'{lane_html}</div></div>')

def s_map(w, h, wide):
    dots = ''
    import math
    for i in range(46):
        x = 6 + (i * 37) % 88
        y = 16 + ((i * 23) % 62)
        r = 1.5 if i % 7 else 3.2
        c = GOLD if i % 11 == 0 else (BLUE if i % 5 == 0 else SEC)
        op = 0.9 if i % 11 == 0 else 0.32
        dots += f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}" opacity="{op}"/>'
    lanes = ''.join(f'<path d="M{8+i*14},{72-i*7} Q{40+i*8},{30+i*5} {88-i*6},{58-i*6}" fill="none" '
                    f'stroke="{BLUE}" stroke-width="0.5" opacity="0.35" stroke-dasharray="2 2"/>' for i in range(4))
    mp = (f'<svg viewBox="0 0 100 84" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">'
          f'<rect width="100" height="84" fill="{SURF}"/>{lanes}{dots}</svg>')
    chip = (f'<div style="position:absolute;top:12px;left:12px;background:{BG}f2;border:1px solid {LINE};'
            f'padding:7px 12px;display:flex;align-items:center;gap:11px;z-index:3">'
            f'{label("Freight Map",11,GOLD,"0.18em")}'
            f'<span style="font-family:{MONO};font-size:9.5px;color:{POS}">LIVE · 812 ships</span></div>')
    rows = ''.join(f'<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid {HAIR}">'
                   f'<span style="font-family:{MONO};font-size:10px;color:{TXT};flex:1">{n}</span>'
                   f'<span style="font-family:{MONO};font-size:10px;color:{c}">{v}</span></div>'
                   for n, v, c in [('Hormuz','-19.4%',NEG),('Suez','0.0%',SEC),('Malacca','-1.3%',NEG),
                                   ('Panama','-1.0%',NEG),('Taiwan','+29.6%',POS),('Bab el-Mandeb','+16.5%',POS)])
    rail = (f'<div style="position:absolute;top:12px;right:12px;bottom:12px;width:{232 if wide else 150}px;'
            f'background:{BG}f2;border:1px solid {LINE};padding:11px 12px;z-index:3;overflow:hidden">'
            f'{label("Chokepoints")}<div style="margin-top:9px">{rows}</div></div>')
    legend = (f'<div style="position:absolute;left:12px;bottom:12px;display:flex;gap:14px;z-index:3;'
              f'background:{BG}e6;border:1px solid {LINE};padding:6px 11px">'
              + ''.join(f'<span style="display:flex;align-items:center;gap:5px;font-family:{MONO};font-size:8.5px;color:{SEC}">'
                        f'<span style="width:6px;height:6px;background:{c}"></span>{t}</span>'
                        for t, c in [('congested',NEG),('watch',GOLD),('normal',SEC)]) + '</div>')
    return f'<div style="position:relative;height:100%;overflow:hidden">{mp}{chip}{rail}{legend}</div>'

def s_mm(w, h, wide):
    chips = [('Delta','+1.2k',TXT),('Gamma','-84',NEG),('Vega','+2.9k',POS),('Theta','-410',NEG)]
    if not wide: chips = chips[:2]
    chip_html = ''.join(f'<div style="border:1px solid {LINE};background:{BG};padding:3px 9px">'
                        f'<div>{label(l,8,SEC,"0.14em")}</div><div>{num(v,12,c)}</div></div>' for l, v, c in chips)
    bar = (f'<div style="height:46px;box-sizing:border-box;display:flex;align-items:center;gap:9px;padding:0 10px;'
           f'background:{SURF};border:1px solid {LINE};border-top:2px solid {POS}">'
           f'<div style="display:flex;align-items:baseline;gap:10px;min-width:176px">'
           f'{label("RUNNING",9,POS,"0.16em")}{num("09:41:22",14,TXT,600)}</div>'
           f'<div style="display:flex;gap:6px">'
           + ''.join(f'<span style="border:1px solid {LINE};padding:3px 9px;font-family:{MONO};font-size:9.5px;'
                     f'color:{GOLD if t=="PAUSE" else SEC}">{t}</span>' for t in ['PAUSE','5x','RESET'])
           + f'</div><div style="margin-left:auto;display:flex;align-items:center;gap:11px">'
           f'<div><div>{label("Total P&L",8.5)}</div><div>{num("+$18,402",19,POS)}</div></div>{chip_html}'
           f'<span style="border:1px solid {NEG};background:rgba(229,72,77,0.14);padding:4px 13px;'
           f'font-family:{MONO};font-size:10px;font-weight:700;color:{NEG}">KILL</span></div></div>')
    chain = table(['Strike','Bid','Ask','IV','Pos'] if wide else ['Strike','Bid','Ask'],
                  [(s, b, a, iv, p) if wide else (s, b, a) for s, b, a, iv, p in
                   [('760','4.15','4.35','18.2','+12'),('765','2.90','3.05','17.9','-4'),('770','1.85','1.98','17.6','0'),
                    ('775','1.10','1.22','17.4','+8'),('780','0.62','0.71','17.3','0'),('785','0.34','0.41','17.5','-6')]])
    grid = '1.15fr 0.85fr' if wide else '1fr'
    right = (panel("Position ladder", table(['Exp','Net','P&L'], [('Aug 21','+12','+$1,204'),('Aug 28','-4','-$318'),('Sep 18','+8','+$942')]), "", 150)
             if wide else '')
    return (f'<div style="padding:6px;display:flex;flex-direction:column;gap:6px;height:100%;box-sizing:border-box">{bar}'
            f'<div style="display:grid;grid-template-columns:{grid};gap:6px;flex:1;min-height:0">'
            f'{panel("Chain · quoting", chain, "SPY 0DTE")}'
            + (f'<div style="display:flex;flex-direction:column;gap:6px;min-height:0">'
               f'{panel("Inventory", area(c=GOLD, seed=7), "net position")}{right}</div>' if wide else '')
            + '</div></div>')

SURFACES = [
    ('Home',     'Home command surface',   s_home,    'Home'),
    ('Cockpit',  'KPI cockpit board',      s_cockpit, 'Portfolio Analysis · 8 tools'),
    ('Rail',     'Sidebar rail + results', s_rail,    'Backtester · 21 tools'),
    ('Scanner',  'Dense table scanner',    s_table,   'Stock Screener · 33 tools'),
    ('ChartDeck','Full-bleed chart deck',  s_chart,   'Chart Studio · 2 tools'),
    ('MapDeck',  'Map cockpit',            s_map,     'Freight Map · 2 tools'),
    ('Terminal', 'MM simulator terminal',  s_mm,      'Options MM · 2 tools'),
]

FULL_W, FULL_H = 1728, 1080
WIN_W,  WIN_H  = 1100, 760

def wrap(name, inner, w, h):
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
    table {{ border-collapse: collapse; }}
  </style>
</helmet>
<div style="width:{w}px;height:{h}px;background:{BG};color:{TXT};overflow:hidden;display:flex;flex-direction:column;font-family:{UI}">
{inner}
</div>
</x-dc>
<script data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''

def build(key, title, fn, wide):
    w, h = (FULL_W, FULL_H) if wide else (WIN_W, WIN_H)
    chrome = menubar(w) if wide else titlebar(f'AlphaTape Terminal — {title}', w)
    sb = sidebar(204, collapsed=not wide)
    inner_h = h - (24 if wide else 38)
    body = fn(w, h, wide)
    shell = (f'{chrome}'
             f'<div style="flex:1;min-height:0;display:flex">{sb}'
             f'<div style="flex:1;min-width:0;background:{BG};overflow:hidden">{body}</div></div>')
    return wrap(key, shell, w, h)

files = {}
for key, title, fn, _ in SURFACES:
    files[f'{key}Full.dc.html'] = build(key, title, fn, True)
    files[f'{key}Window.dc.html'] = build(key, title, fn, False)

# index artboard
rows = ''.join(
    f'<tr><td style="padding:7px 12px;border-bottom:1px solid {HAIR};font-family:{UI};font-size:13px;color:{TXT}">{t}</td>'
    f'<td style="padding:7px 12px;border-bottom:1px solid {HAIR};font-family:{MONO};font-size:11.5px;color:{SEC}">{cov}</td></tr>'
    for _, t, _, cov in SURFACES)
main_inner = f'''<div style="padding:44px 52px;font-family:{UI}">
  <div style="font-family:{SERIF};font-size:31px;letter-spacing:0.2em;color:{GOLD}">ALPHATAPE</div>
  <div style="margin-top:9px;font-family:{UI};font-size:16px;color:{TXT}">Mac app layout studies</div>
  <div style="margin-top:12px;font-family:{UI};font-size:13px;color:{SEC};max-width:620px;line-height:1.6">
    Seven surfaces cover all 57 tools. Each is drawn twice: full screen at 1728&times;1080 with the
    native menu bar, and windowed at 1100&times;760 with traffic lights. The windowed pairs show the
    reflow &mdash; hub rail collapses to icons, inputs rails collapse, panel grids drop to one column,
    KPI strips shed cells.
  </div>
  <table style="margin-top:26px;width:100%;max-width:620px;border-collapse:collapse">
    <tr><th style="text-align:left;padding:6px 12px;border-bottom:1px solid {LINE};font-family:{UI};font-size:8.5px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:{SEC}">Surface</th>
    <th style="text-align:left;padding:6px 12px;border-bottom:1px solid {LINE};font-family:{UI};font-size:8.5px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:{SEC}">Covers</th></tr>
    {rows}
  </table>
  <div style="margin-top:26px;font-family:{UI};font-size:11.5px;color:{SEC};max-width:620px;line-height:1.6">
    Type is system-stack here: the canvas cannot load Sora or Cinzel, so weights and proportions
    stand in for them. Colors, densities, rail widths and control heights are lifted from the
    running app.
  </div>
</div>'''
files['Main.dc.html'] = wrap('Main', main_inner, 760, 700)

for name, src in files.items():
    OUT.joinpath(name).write_text(src)

# canvas layout: index top-left, then one row per surface (full | windowed)
GAP_X, GAP_Y = 120, 110
abs_ = [{'file': 'Main.dc.html', 'x': 0, 'y': 0, 'w': 760, 'h': 700, 'title': 'Overview'}]
y = 700 + GAP_Y
for key, title, _, _ in SURFACES:
    abs_.append({'file': f'{key}Full.dc.html',   'x': 0, 'y': y, 'w': FULL_W, 'h': FULL_H, 'title': f'{title} — full screen'})
    abs_.append({'file': f'{key}Window.dc.html', 'x': FULL_W + GAP_X, 'y': y, 'w': WIN_W, 'h': WIN_H, 'title': f'{title} — windowed'})
    y += FULL_H + GAP_Y

canvas = {'artboards': abs_, 'launch': {'view': 'canvas'}}
OUT.joinpath('canvas.json').write_text(json.dumps(canvas, indent=2))
print(f'wrote {len(files)} artboards + canvas.json')
