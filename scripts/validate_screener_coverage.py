"""Validate the bundled screener coverage contract without network access."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from routers import screener


def main() -> int:
    errors: list[str] = []
    coverage = screener._COVERAGE_CONTRACT.get("universes", {})
    for key, entry in coverage.items():
        actual = len(screener._INDEX_SETS.get(key, ()))
        if actual != entry.get("available"):
            errors.append(f"{key}: contract says {entry.get('available')}, seed has {actual}")
        expected = entry.get("expected")
        if entry.get("status") == "partial" and expected is not None and actual >= expected:
            errors.append(f"{key}: partial status conflicts with {actual}/{expected}")
        if entry.get("status") in {"count_complete_unvalidated", "validated_complete"} and expected is not None and actual != expected:
            errors.append(f"{key}: complete status conflicts with {actual}/{expected}")
    for ticker in screener._ALL_INTL:
        if ticker not in screener._INTL_TICKER_METADATA:
            errors.append(f"{ticker}: missing deterministic listing metadata")
    if errors:
        print("Screener coverage validation failed:")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("Screener coverage contract is valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
