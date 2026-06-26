import math
import os
import sys

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import leaderboard

router = APIRouter()


class ScoreSubmit(BaseModel):
    name: str = Field(default="Anonymous", max_length=leaderboard.MAX_NAME)
    score: float


@router.get("/{game}")
def get_board(game: str, limit: int = 10):
    if game not in leaderboard.GAMES:
        raise HTTPException(404, "Unknown game")
    return {"game": game, "top": leaderboard.top(game, max(1, min(limit, 50)))}


@router.post("/{game}")
def post_score(game: str, body: ScoreSubmit):
    if game not in leaderboard.GAMES:
        raise HTTPException(404, "Unknown game")
    if not math.isfinite(body.score) or abs(body.score) > 1e9:
        raise HTTPException(400, "Invalid score")
    return {"game": game, **leaderboard.submit(game, body.name, body.score)}
