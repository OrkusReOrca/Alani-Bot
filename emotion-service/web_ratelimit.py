"""Rate limits for the web dashboard, because this deployment's resources are small.

Three layers, all in memory (a restart resets them):

  * general   every dashboard request (page, API, media) counts against the visitor's
              requests-per-minute allowance, and against one global allowance shared by
              everybody, so one noisy client or a flood cannot starve the analysis that is
              running. /api/health is exempt (monitoring).
  * uploads   how many videos one visitor may upload per hour. (web_jobs.py additionally
              caps analyses per hour for the whole service, to protect the model budget.)
  * in flight how many uploads may be streaming to disk at the same moment.

A refused request gets HTTP 429 with a Retry-After header. Logins have their own, stricter
lock-out in web_auth.py. All numbers come from config.py (env vars, documented in the README).
"""

import threading
import time
from collections import deque

import config


class SlidingWindow:
    """At most `limit` hits per `window_s` seconds per key; memory is bounded by `max_keys`."""

    def __init__(self, limit, window_s=60.0, max_keys=10_000, clock=time.time):
        self.limit = limit
        self.window_s = window_s
        self.max_keys = max_keys
        self.clock = clock
        self._lock = threading.Lock()
        self._hits = {}

    def take(self, key):
        """Records a hit. Returns (allowed, retry_after_seconds)."""
        now = self.clock()
        cutoff = now - self.window_s
        with self._lock:
            times = self._hits.get(key)
            if times is None:
                if len(self._hits) >= self.max_keys:
                    self._prune(cutoff)
                if len(self._hits) >= self.max_keys:
                    # a flood of distinct addresses: refuse new ones instead of growing
                    return False, int(self.window_s)
                times = self._hits[key] = deque()
            while times and times[0] <= cutoff:
                times.popleft()
            if len(times) >= self.limit:
                return False, max(1, int(times[0] + self.window_s - now) + 1)
            times.append(now)
            return True, 0

    def _prune(self, cutoff):
        for key in [k for k, t in self._hits.items() if not t or t[-1] <= cutoff]:
            del self._hits[key]


class Limits:
    """The dashboard's limiters, rebuilt whenever the numbers in config change (tests do that)."""

    def __init__(self):
        self._snapshot = None
        self.general = self.everyone = self.uploads = None
        self.upload_slots = None

    def _current(self):
        return (config.WEB_RATE_PER_MIN, config.WEB_RATE_GLOBAL_PER_MIN, config.WEB_UPLOADS_PER_HOUR_PER_IP, config.WEB_MAX_CONCURRENT_UPLOADS)

    def refresh(self):
        snapshot = self._current()
        if snapshot != self._snapshot:
            per_minute, global_per_minute, uploads_per_hour, concurrent = snapshot
            self.general = SlidingWindow(per_minute, 60.0)
            self.everyone = SlidingWindow(global_per_minute, 60.0, max_keys=1)
            self.uploads = SlidingWindow(uploads_per_hour, 3600.0)
            self.upload_slots = threading.BoundedSemaphore(max(1, concurrent))
            self._snapshot = snapshot
        return self

    def check_request(self, ip):
        """General limits for one dashboard request. Returns (allowed, retry_after)."""
        self.refresh()
        allowed, retry = self.general.take(ip)  # the visitor first: a refused flood must not use up the global budget
        if not allowed:
            return False, retry
        return self.everyone.take("*")

    def check_upload(self, ip):
        self.refresh()
        return self.uploads.take(ip)


limits = Limits()


def reset():
    """Forget everything (tests)."""
    limits._snapshot = None
