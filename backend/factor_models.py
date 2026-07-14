"""Shared factor-model regression engine — CAPM, Fama-French 3/4-factor,
Scholes-Williams beta, IVOL/TVOL.

Factor returns come from Ken French's Data Library (Dartmouth, free and
public — https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html),
not WRDS. Methodology mirrors the WRDS Beta Suite documentation, which itself
points to this same public source for its underlying factor data.

Public API:
  get_factors(frequency)                  -> DataFrame[mktrf, smb, hml, umd, rf]
  stock_returns(ticker, start, end, freq)  -> Series of raw simple returns
  capm(returns, factors)                   -> dict
  ff3(returns, factors)                    -> dict
  ff4(returns, factors)                    -> dict
  scholes_williams_beta(returns, factors)  -> dict (daily only)
  ivol_tvol(returns, factors, model)       -> dict
  compute_beta_suite(returns, frequency, model) -> dict (one-stop, all of the above)
"""
from __future__ import annotations
import io
import logging
import zipfile

import numpy as np
import pandas as pd
import requests

logger = logging.getLogger(__name__)

try:
    from disk_cache import disk_get, disk_set
except ImportError:                                       # pragma: no cover
    def disk_get(_k): return None                         # type: ignore
    def disk_set(_k, _v, ttl=0): pass                      # type: ignore

_TIMEOUT = 20
_DAY = 86_400
_MIN_OBS = 20                                              # minimum overlapping observations to fit anything

_KEN_FRENCH_BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"
_FF3_URL = {
    "daily":   f"{_KEN_FRENCH_BASE}/F-F_Research_Data_Factors_daily_CSV.zip",
    "monthly": f"{_KEN_FRENCH_BASE}/F-F_Research_Data_Factors_CSV.zip",
}
_MOM_URL = {
    "daily":   f"{_KEN_FRENCH_BASE}/F-F_Momentum_Factor_daily_CSV.zip",
    "monthly": f"{_KEN_FRENCH_BASE}/F-F_Momentum_Factor_CSV.zip",
}
_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}


# ── Ken French CSV parsing ────────────────────────────────────────────────
# These files wrap a data table in a preamble/footer whose exact wording
# drifts year to year, and the monthly files carry a second "annual factors"
# table after the monthly one. Rather than trust fixed line offsets, key off
# "first field is an all-digit token of the expected date length" to find
# the first data block and stop at the first line that breaks the pattern.

def _download_zip_csv(url: str) -> str:
    resp = requests.get(url, timeout=_TIMEOUT, headers=_UA)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        return zf.read(name).decode("latin-1")


def _parse_data_block(text: str, date_len: int, ncols: int) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < ncols + 1:
            if rows:
                break
            continue
        token = parts[0]
        if token.lstrip("-").isdigit() and len(token) == date_len:
            rows.append(parts[: ncols + 1])
        elif rows:
            break                                          # first non-matching line after data started
    if not rows:
        raise ValueError(f"no {date_len}-digit-dated rows found in Ken French CSV")
    return rows


def _fetch_ff3_raw(frequency: str) -> list[list[str]]:
    text = _download_zip_csv(_FF3_URL[frequency])
    date_len = 8 if frequency == "daily" else 6
    return _parse_data_block(text, date_len, 4)             # Mkt-RF, SMB, HML, RF


def _fetch_mom_raw(frequency: str) -> list[list[str]]:
    text = _download_zip_csv(_MOM_URL[frequency])
    date_len = 8 if frequency == "daily" else 6
    return _parse_data_block(text, date_len, 1)              # Mom


def _date_index(tokens: list[str], frequency: str) -> pd.DatetimeIndex:
    fmt = "%Y%m%d" if frequency == "daily" else "%Y%m"
    return pd.to_datetime(tokens, format=fmt)


def _fetch_factors_uncached(frequency: str) -> pd.DataFrame:
    ff3_rows = _fetch_ff3_raw(frequency)
    ff3 = pd.DataFrame(ff3_rows, columns=["date", "mktrf", "smb", "hml", "rf"])
    for c in ("mktrf", "smb", "hml", "rf"):
        ff3[c] = pd.to_numeric(ff3[c], errors="coerce") / 100.0
    ff3.index = _date_index(ff3["date"], frequency)
    ff3 = ff3.drop(columns="date")

    try:
        mom_rows = _fetch_mom_raw(frequency)
        mom = pd.DataFrame(mom_rows, columns=["date", "umd"])
        mom["umd"] = pd.to_numeric(mom["umd"], errors="coerce") / 100.0
        mom.index = _date_index(mom["date"], frequency)
        mom = mom.drop(columns="date")
        merged = ff3.join(mom, how="left")
    except Exception:
        logger.warning("Ken French momentum factor unavailable, FF4/UMD will be missing", exc_info=True)
        merged = ff3.assign(umd=np.nan)

    return merged.sort_index()


def get_factors(frequency: str = "daily") -> pd.DataFrame:
    """Ken French mktrf/smb/hml/umd/rf, indexed by date. Cached for a day —
    this is a slow-moving public file, no need to refetch per request."""
    if frequency not in ("daily", "monthly"):
        raise ValueError("frequency must be 'daily' or 'monthly'")
    cache_key = f"factor_models:ff_factors:{frequency}"
    cached = disk_get(cache_key)
    if cached is not None:
        df = pd.DataFrame(cached["rows"], columns=cached["cols"]).set_index("date")
        df.index = pd.to_datetime(df.index)
        for c in df.columns:
            df[c] = pd.to_numeric(df[c])
        return df

    df = _fetch_factors_uncached(frequency)
    payload = {
        "cols": ["date"] + list(df.columns),
        "rows": [[str(idx.date())] + [None if pd.isna(v) else float(v) for v in row]
                 for idx, row in zip(df.index, df.to_numpy())],
    }
    disk_set(cache_key, payload, ttl=_DAY)
    return df


def stock_returns(ticker: str, start: str, end: str, frequency: str = "daily") -> pd.Series:
    """Raw simple returns for a ticker over [start, end], from the shared price cache."""
    from cache import get_download
    dl = get_download((ticker,), start, end)
    if dl.empty:
        return pd.Series(dtype=float)
    close = dl["Close"][ticker] if isinstance(dl.columns, pd.MultiIndex) else dl["Close"]
    close = close.dropna()
    if close.index.tz is not None:
        close.index = close.index.tz_convert(None)
    if frequency == "monthly":
        close = close.resample("ME").last()
    return close.pct_change().dropna()


# ── Regression core ───────────────────────────────────────────────────────

def _align(returns: pd.Series, factors: pd.DataFrame) -> pd.DataFrame:
    frame = factors.join(returns.rename("ri"), how="inner").dropna(subset=["ri", "mktrf", "rf"])
    frame["ri_rf"] = frame["ri"] - frame["rf"]
    return frame


def _ols(frame: pd.DataFrame, factor_names: list[str]) -> dict:
    n = len(frame)
    if n < _MIN_OBS:
        return {"available": False, "reason": "insufficient overlapping history", "observations": n}
    y = frame["ri_rf"].to_numpy()
    X = frame[factor_names].to_numpy()
    k = X.shape[1]
    Xa = np.column_stack([np.ones(n), X])
    coef, *_ = np.linalg.lstsq(Xa, y, rcond=None)
    resid = y - Xa @ coef
    sse = float(resid @ resid)
    sst = float(((y - y.mean()) ** 2).sum())
    r2 = 1.0 - sse / sst if sst > 0 else 0.0
    dof = max(n - k - 1, 1)
    mse = sse / dof
    try:
        se = np.sqrt(np.diag(mse * np.linalg.inv(Xa.T @ Xa)))
    except np.linalg.LinAlgError:
        se = np.full(k + 1, np.nan)

    betas, t_stats = {}, {}
    for i, name in enumerate(factor_names):
        b = float(coef[i + 1])
        betas[name] = round(b, 4)
        se_i = se[i + 1]
        t_stats[name] = round(b / se_i, 2) if se_i and not np.isnan(se_i) else None

    return {
        "available": True,
        "betas": betas,
        "t_stats": t_stats,
        "alpha": round(float(coef[0]), 5),
        "r_squared": round(r2, 3),
        "residual_std": float(np.std(resid, ddof=1)),
        "observations": n,
        "start": str(frame.index[0].date()),
        "end": str(frame.index[-1].date()),
    }


def capm(returns: pd.Series, factors: pd.DataFrame) -> dict:
    """ri - rf = alpha + beta*(mktrf) + eps."""
    return _ols(_align(returns, factors), ["mktrf"])


def ff3(returns: pd.Series, factors: pd.DataFrame) -> dict:
    """Adds smb (size) and hml (value) as partial exposures alongside mktrf."""
    return _ols(_align(returns, factors), ["mktrf", "smb", "hml"])


def ff4(returns: pd.Series, factors: pd.DataFrame) -> dict:
    """Carhart 4-factor: adds umd (momentum)."""
    frame = _align(returns, factors).dropna(subset=["umd"])
    return _ols(frame, ["mktrf", "smb", "hml", "umd"])


def scholes_williams_beta(returns: pd.Series, factors: pd.DataFrame) -> dict:
    """Corrects for non-synchronous/thin trading using lead-lag market
    returns (Scholes & Williams, 1977):

      beta_SW = Cov(ln(1+r_i), mr3) / Cov(ln(1+mkt), mr3)
      mr3_t   = ln(1+mkt_{t-1}) + ln(1+mkt_t) + ln(1+mkt_{t+1})

    Daily only — the lead-lag correction is meaningless at lower frequency.
    Matters most for small/illiquid names, where naive OLS beta biases
    toward 1 because thin trading desynchronizes the stock's return from
    the same-day market move."""
    frame = factors.join(returns.rename("ri"), how="inner").dropna(subset=["ri", "mktrf", "rf"])
    if len(frame) < _MIN_OBS + 2:
        return {"available": False, "reason": "insufficient overlapping history"}
    mkt = frame["mktrf"] + frame["rf"]                     # raw value-weighted market return
    ln_ri = np.log1p(frame["ri"].clip(lower=-0.99))
    ln_mkt = np.log1p(mkt.clip(lower=-0.99))
    mr3 = ln_mkt.shift(1) + ln_mkt + ln_mkt.shift(-1)
    valid = mr3.notna() & ln_ri.notna()
    ln_ri_v = ln_ri[valid].to_numpy()
    ln_mkt_v = ln_mkt[valid].to_numpy()
    mr3_v = mr3[valid].to_numpy()
    if len(ln_ri_v) < _MIN_OBS:
        return {"available": False, "reason": "insufficient overlapping history"}
    cov_num = np.cov(ln_ri_v, mr3_v, ddof=1)[0, 1]
    cov_den = np.cov(ln_mkt_v, mr3_v, ddof=1)[0, 1]
    if not cov_den:
        return {"available": False, "reason": "degenerate market variance"}
    return {
        "available": True,
        "beta": round(float(cov_num / cov_den), 4),
        "observations": int(len(ln_ri_v)),
    }


def ivol_tvol(returns: pd.Series, factors: pd.DataFrame, model: str = "ff3") -> dict:
    """Idiosyncratic volatility (Ang et al. 2006): stdev of residuals from
    the chosen risk model. Total volatility: stdev of raw realized returns."""
    frame = _align(returns, factors)
    if len(frame) < _MIN_OBS:
        return {"available": False, "reason": "insufficient overlapping history"}
    model_fn = {"capm": capm, "ff3": ff3, "ff4": ff4}.get(model)
    if model_fn is None:
        raise ValueError("model must be one of: capm, ff3, ff4")
    fit = model_fn(returns, factors)
    if not fit.get("available"):
        return {"available": False, "reason": fit.get("reason", "model fit failed")}
    tvol = float(np.std(frame["ri"], ddof=1))
    ivol = fit["residual_std"]
    annualize = 252 ** 0.5 if frame.index.to_series().diff().median() <= pd.Timedelta(days=3) else 12 ** 0.5
    return {
        "available": True,
        "ivol": round(ivol, 5),
        "tvol": round(tvol, 5),
        "ivol_annualized_pct": round(ivol * annualize * 100, 2),
        "tvol_annualized_pct": round(tvol * annualize * 100, 2),
        "idiosyncratic_pct": round((1 - fit["r_squared"]) * 100, 1),
        "model": model,
    }


def compute_beta_suite(returns: pd.Series, frequency: str = "daily", model: str = "ff3") -> dict:
    """One-stop: CAPM + Scholes-Williams (daily only) + FF3/FF4 + IVOL/TVOL
    for a single security, all against the same Ken French factor frame."""
    factors = get_factors(frequency)
    result = {
        "frequency": frequency,
        "capm": capm(returns, factors),
        "scholes_williams": (
            scholes_williams_beta(returns, factors) if frequency == "daily"
            else {"available": False, "reason": "Scholes-Williams beta is daily-only"}
        ),
        "ivol_tvol": ivol_tvol(returns, factors, model=model),
    }
    result["ff4" if model == "ff4" else "ff3"] = (ff4 if model == "ff4" else ff3)(returns, factors)
    return result
