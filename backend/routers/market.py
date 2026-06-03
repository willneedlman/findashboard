import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history as _cached_history, get_news as _cached_news
from validation import validate_ticker, validate_date

router = APIRouter()


def _get_history(ticker: str) -> pd.DataFrame:
    df = _cached_history(ticker, period="5y")
    if df.empty:
        return pd.DataFrame()
    df = df.rename(columns={"Close": "close"})
    return df[["close"]].dropna()


@router.get("/history")
def get_history(ticker: str, start: str | None = None, end: str | None = None):
    ticker = validate_ticker(ticker)
    if start: validate_date(start)
    if end:   validate_date(end)
    df = _get_history(ticker)
    if df.empty:
        raise HTTPException(404, "No data found for ticker")
    if start:
        df = df[df.index >= pd.to_datetime(start)]
    if end:
        df = df[df.index <= pd.to_datetime(end)]
    if df.empty:
        raise HTTPException(404, "No data in date range")

    prices = df["close"]
    returns = np.log(prices / prices.shift(1)).dropna()
    rolling_vol = returns.rolling(30).std() * np.sqrt(252)
    wealth_idx = (1 + prices.pct_change().fillna(0)).cumprod()
    drawdown = (wealth_idx - wealth_idx.cummax()) / wealth_idx.cummax()

    total_return = (prices.iloc[-1] / prices.iloc[0] - 1) * 100
    max_dd = float(drawdown.min()) * 100
    ann_vol = float(returns.std() * np.sqrt(252)) * 100
    current_price = float(prices.iloc[-1])

    return {
        "ticker": ticker.upper(),
        "metrics": {
            "total_return": round(total_return, 2),
            "max_drawdown": round(max_dd, 2),
            "ann_volatility": round(ann_vol, 2),
            "current_price": round(current_price, 2),
        },
        "price": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in prices.items()],
        "volatility": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in rolling_vol.dropna().items()],
        "drawdown": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in drawdown.items()],
    }


@router.get("/news")
def get_news(ticker: str):
    return {"news": _cached_news(ticker)[:10]}
