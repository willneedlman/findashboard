import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_download
from validation import validate_tickers, validate_date

router = APIRouter()


class CorrRequest(BaseModel):
    tickers: list[str] = Field(min_length=2, max_length=20)
    start: str = "2020-01-01"
    end: str = "2024-12-31"
    window: int = Field(default=60, ge=5, le=252)

    @model_validator(mode='after')
    def _validate(self):
        self.tickers = validate_tickers(self.tickers)
        validate_date(self.start); validate_date(self.end)
        return self


@router.post("/matrix")
def correlation_matrix(req: CorrRequest):
    if len(req.tickers) < 2:
        raise HTTPException(400, "Need at least 2 tickers")
    try:
        raw = get_download(tuple(sorted(req.tickers)), req.start, req.end)
        if raw.empty:
            raise HTTPException(404, "No data returned")
        # get_download returns multi-level columns when multiple tickers
        if isinstance(raw.columns, pd.MultiIndex):
            raw = raw["Close"] if "Close" in raw.columns.get_level_values(0) else raw.iloc[:, :len(req.tickers)]
        if isinstance(raw, pd.Series):
            raw = raw.to_frame(req.tickers[0])
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    raw = raw.dropna()
    returns = raw.pct_change().dropna()
    corr = returns.corr()

    tickers = list(corr.columns)
    matrix = []
    for t1 in tickers:
        for t2 in tickers:
            matrix.append({"row": t1, "col": t2, "value": round(float(corr.loc[t1, t2]), 4)})

    return {"tickers": tickers, "matrix": matrix}
