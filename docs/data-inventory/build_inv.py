"""Builds docs/data-inventory/*.csv. Provenance is looked up from the endpoint
index rather than typed, so a route that moves cannot leave a stale line."""
import csv, json, pathlib, sys

SC = pathlib.Path('/private/tmp/claude-501/-Users-willneedlman-finance-dashboard/da8aaddc-9cd3-4ba5-a5f6-9f332088522e/scratchpad')
OUT = pathlib.Path('/Users/willneedlman/finance_dashboard/docs/data-inventory')
EP = json.loads((SC/'endpoints.json').read_text())
TOOLS = {t['title']: t for t in json.loads((SC/'tools.json').read_text())}

COLS = ['id','kind','hub','name','definition','formula','source','provenance',
        'cadence','surfaced_in','interpretation','limits']

def prov(endpoint: str, extra: str = '') -> str:
    e = EP.get(endpoint)
    base = f"{e['file']}:{e['line']} {e['fn']}() -> {endpoint}" if e else endpoint
    return f"{base}; {extra}" if extra else base

def where(*titles) -> str:
    out = []
    for t in titles:
        tool = TOOLS.get(t)
        out.append(f"{t} ({tool['route']}, frontend/src/{tool['page']}.tsx)" if tool else t)
    return '; '.join(out)

def hub_of(title): return TOOLS[title]['hub'] if title in TOOLS else ''

ROWS = []
def row(id, kind, tool, name, definition, formula, source, provenance, cadence,
        interpretation, limits, also=()):
    ROWS.append({'id': id, 'kind': kind, 'hub': hub_of(tool), 'name': name,
                 'definition': definition, 'formula': formula, 'source': source,
                 'provenance': provenance, 'cadence': cadence,
                 'surfaced_in': where(tool, *also),
                 'interpretation': interpretation, 'limits': limits})

def write(rows, path, cols=COLS):
    order = {h: i for i, h in enumerate(
        ['Research','Options','Macro & Rates','Charting & Markets',
         'Trading / Portfolio','Valuation','Geo-Logistics',''])}
    kind_order = {k: i for i, k in enumerate(
        ['feed_field','derived_metric','model','bundled_dataset','user_input'])}
    rows = sorted(rows, key=lambda r: (kind_order.get(r.get('kind',''), 9),
                                       order.get(r.get('hub',''), 9), r.get('name','')))
    with open(path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, quoting=csv.QUOTE_ALL)
        w.writeheader(); w.writerows(rows)
    return len(rows)
