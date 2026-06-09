"""Shared Groq utility used by ai.py and any router that needs LLM fallback."""
import os, json, re, logging
from fastapi import HTTPException

logger = logging.getLogger(__name__)
_GROQ_KEY = os.getenv("GROQ_API_KEY", "")


def groq_complete(prompt: str, max_tokens: int = 512) -> str:
    if not _GROQ_KEY:
        raise HTTPException(503, "GROQ_API_KEY not configured")
    from groq import Groq
    client = Groq(api_key=_GROQ_KEY)
    msg = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.choices[0].message.content.strip()


def parse_json(raw: str):
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r'[\[{].*[\]}]', raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except Exception:
                pass
        raise HTTPException(500, "AI returned malformed JSON")
