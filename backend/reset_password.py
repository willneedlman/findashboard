#!/usr/bin/env python3
"""Local password reset — the missing self-service path.

There is intentionally no HTTP "forgot password" endpoint (that would let anyone
reset any account by username). This local CLI resets a user's password directly
in the canonical users database, using the same hashing the server uses.

Usage:
    cd backend && python3 reset_password.py <username> <new_password>
    cd backend && python3 reset_password.py --list        # show accounts
"""
import sys
import sqlite3
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # make `routers` importable
from routers import users as u                              # exact hashing + DB path


def _accounts():
    with sqlite3.connect(str(u._DB_PATH)) as c:
        return [r[0] for r in c.execute("SELECT username FROM users ORDER BY username")]


def main() -> int:
    args = sys.argv[1:]
    print(f"users db: {u._DB_PATH}")
    if args == ["--list"]:
        print("accounts:", ", ".join(_accounts()) or "(none)")
        return 0
    if len(args) != 2:
        print(__doc__)
        return 1

    username, new_pw = args[0].strip().lower(), args[1]
    if len(new_pw) < 8:
        print("Password must be at least 8 characters.")
        return 1

    with sqlite3.connect(str(u._DB_PATH)) as c:
        row = c.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            print(f"No account '{username}'. Existing: {', '.join(_accounts()) or '(none)'}")
            return 1
        c.execute("UPDATE users SET pin_hash = ?, password_set = 1 WHERE username = ?",
                  (u._hash_credential(new_pw), username))
        c.commit()
    print(f"Password reset for '{username}'. You can sign in now.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
