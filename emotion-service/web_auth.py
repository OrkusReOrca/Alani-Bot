"""Login for the web dashboard: one shared demo password, a signed session
cookie, and a lock-out for repeated wrong guesses.

No sessions are stored on the server — the cookie is `<payload>.<signature>`
where payload = base64url(JSON {iat, exp}) and signature = HMAC-SHA256 of the
payload. Restarting the service therefore does not log anyone out, and
changing the password (or the shared secret the key is derived from) logs
everyone out at once.

The dashboard is served over the host's HTTPS proxy, so the cookie is flagged
Secure whenever the request arrived over HTTPS (X-Forwarded-Proto), and is
always HttpOnly + SameSite=Strict. Browsers on plain http (local dev) still work.

Cross-site request forgery: SameSite=Strict keeps the cookie off cross-site
requests, and every state-changing route additionally requires the custom
header `X-Requested-With: alani-web`, which a cross-site page cannot send
without a CORS preflight this server never approves.
"""

import base64
import hashlib
import hmac
import ipaddress
import json
import threading
import time

import config

COOKIE_NAME = "emo_session"
CSRF_HEADER = "X-Requested-With"
CSRF_VALUE = "alani-web"

FAILURE_LIMIT = 5
FAILURE_WINDOW_S = 60
LOCKOUT_S = 60


def enabled():
    return bool(config.DEMO_PASSWORD)


def _key():
    if config.WEB_SESSION_KEY:
        return config.WEB_SESSION_KEY.encode("utf-8")
    return hashlib.sha256(f"{config.DEMO_PASSWORD}\0{config.SHARED_SECRET or ''}".encode("utf-8")).digest()


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload_b64):
    return _b64(hmac.new(_key(), payload_b64.encode("ascii"), hashlib.sha256).digest())


def make_session(now=None):
    now = int(now if now is not None else time.time())
    payload = _b64(json.dumps({"iat": now, "exp": now + int(config.WEB_SESSION_HOURS * 3600)}).encode("utf-8"))
    return f"{payload}.{_sign(payload)}"


def verify_session(token, now=None):
    """True for an untampered, unexpired cookie value."""
    if not token or "." not in token:
        return False
    payload, _, signature = token.partition(".")
    if not hmac.compare_digest(signature, _sign(payload)):
        return False
    try:
        data = json.loads(_unb64(payload))
        return int(data["exp"]) > (now if now is not None else time.time())
    except Exception:
        return False


def check_password(candidate):
    if not config.DEMO_PASSWORD or not isinstance(candidate, str):
        return False
    return hmac.compare_digest(candidate.encode("utf-8"), config.DEMO_PASSWORD.encode("utf-8"))


def cookie_header(token, secure):
    parts = [f"{COOKIE_NAME}={token}", "HttpOnly", "SameSite=Strict", "Path=/", f"Max-Age={int(config.WEB_SESSION_HOURS * 3600)}"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header(secure):
    parts = [f"{COOKIE_NAME}=", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def token_from_cookie_header(header):
    for part in (header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE_NAME:
            return value
    return ""


def client_ip(peer, forwarded_for):
    """The address to rate-limit. The host's proxy sits in front of us, so the
    socket peer is the proxy; the real client is the entry the proxy appended
    (the last one in X-Forwarded-For). Only trusted when the peer itself is a
    private/loopback address — otherwise the header is client-controlled."""
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return peer
    if (peer_ip.is_private or peer_ip.is_loopback) and forwarded_for:
        last = forwarded_for.split(",")[-1].strip()
        try:
            return str(ipaddress.ip_address(last))
        except ValueError:
            return peer
    return peer


class LoginLimiter:
    """5 wrong passwords within 60 s locks that address out for 60 s."""

    def __init__(self, clock=time.time):
        self._clock = clock
        self._lock = threading.Lock()
        self._failures = {}  # ip -> [timestamps]
        self._locked_until = {}

    def retry_after(self, ip):
        """Seconds still to wait, or 0 if the address may try."""
        with self._lock:
            remaining = self._locked_until.get(ip, 0) - self._clock()
            return max(0, int(remaining) + (1 if remaining > 0 else 0))

    def record_failure(self, ip):
        with self._lock:
            now = self._clock()
            recent = [t for t in self._failures.get(ip, []) if now - t < FAILURE_WINDOW_S]
            recent.append(now)
            self._failures[ip] = recent
            if len(recent) >= FAILURE_LIMIT:
                self._locked_until[ip] = now + LOCKOUT_S
                self._failures[ip] = []

    def record_success(self, ip):
        with self._lock:
            self._failures.pop(ip, None)
            self._locked_until.pop(ip, None)


limiter = LoginLimiter()
