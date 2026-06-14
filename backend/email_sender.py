"""
Pluggable transactional email sender.

Backend is chosen at call time from the environment, in priority order:
  1. RESEND_API_KEY        -> Resend HTTP API
  2. SMTP_HOST (+ creds)   -> stdlib smtplib over STARTTLS
  3. neither               -> log the message to the server console (dev default)

The console fallback means the whole forgot-password flow works end-to-end in
development with no third-party account: the reset link is printed to the log.
Set one of the providers in production to send real mail.

Env:
  RESEND_API_KEY     Resend API key (https://resend.com)
  EMAIL_FROM         From address, e.g. "Alphatape <no-reply@yourdomain.com>"
  SMTP_HOST          SMTP server hostname
  SMTP_PORT          SMTP port (default 587)
  SMTP_USER          SMTP username
  SMTP_PASS          SMTP password
"""
import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)

_DEFAULT_FROM = "Alphatape Terminal <no-reply@alphatape.local>"


def _from_addr() -> str:
    return os.getenv("EMAIL_FROM", _DEFAULT_FROM)


def _send_resend(to: str, subject: str, text: str, html: str | None) -> bool:
    import httpx

    payload = {
        "from": _from_addr(),
        "to": [to],
        "subject": subject,
        "text": text,
    }
    if html:
        payload["html"] = html
    try:
        resp = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {os.environ['RESEND_API_KEY']}"},
            json=payload,
            timeout=15,
        )
        if resp.status_code >= 400:
            logger.error("Resend send failed (%s): %s", resp.status_code, resp.text[:300])
            return False
        return True
    except Exception as e:
        logger.error("Resend send error: %s", e)
        return False


def _send_smtp(to: str, subject: str, text: str, html: str | None) -> bool:
    msg = EmailMessage()
    msg["From"] = _from_addr()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    try:
        host = os.environ["SMTP_HOST"]
        port = int(os.getenv("SMTP_PORT", "587"))
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.starttls()
            user, pw = os.getenv("SMTP_USER"), os.getenv("SMTP_PASS")
            if user and pw:
                s.login(user, pw)
            s.send_message(msg)
        return True
    except Exception as e:
        logger.error("SMTP send error: %s", e)
        return False


def _send_console(to: str, subject: str, text: str, html: str | None) -> bool:
    logger.warning(
        "[email:console] no email provider configured — message logged, not sent\n"
        "  to:      %s\n  subject: %s\n  body:\n%s",
        to, subject, text,
    )
    return True


def send_email(to: str, subject: str, text: str, html: str | None = None) -> bool:
    """Send an email via the configured backend. Returns True on success.

    Never raises: failures are logged and reported as False so callers can keep
    the response generic (e.g. forgot-password must not leak send failures).
    """
    if os.getenv("RESEND_API_KEY"):
        return _send_resend(to, subject, text, html)
    if os.getenv("SMTP_HOST"):
        return _send_smtp(to, subject, text, html)
    return _send_console(to, subject, text, html)


def send_password_reset(to: str, reset_url: str) -> bool:
    """Compose and send the password-reset email."""
    subject = "Reset your Alphatape Terminal password"
    text = (
        "You requested a password reset for your Alphatape Terminal account.\n\n"
        f"Open this link to set a new password (valid for 1 hour):\n{reset_url}\n\n"
        "If you did not request this, you can ignore this email. Your password "
        "stays unchanged."
    )
    html = (
        '<div style="font-family:sans-serif;font-size:14px;color:#1a2233;line-height:1.5">'
        "<p>You requested a password reset for your Alphatape Terminal account.</p>"
        f'<p><a href="{reset_url}" style="color:#0d6efd">Set a new password</a> '
        "(valid for 1 hour).</p>"
        "<p style=\"color:#667085\">If you did not request this, you can ignore this "
        "email. Your password stays unchanged.</p>"
        "</div>"
    )
    return send_email(to, subject, text, html)
