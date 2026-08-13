#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ghostmeet capture daemon — HTTP bridge (127.0.0.1:8899) so the Chrome extension can
start/stop a full capture (mic + system audio) without touching a terminal.

Endpoints:
  GET /start?session=YYYYMMDD-HHMMSS   → start capture (language is always es)
  GET /stop                            → stop capture and finish transcription
  GET /status                          → { running, session_id }

The capture reuses the same validated pipeline as ghostmeet-capture.py: ffmpeg
mixes the default microphone with the default sink monitor and streams webm/opus
to the ghostmeet backend WebSocket at 127.0.0.1:8877. The Chrome extension calls
this daemon from its Start/Stop buttons; the daemon must run in the user's
graphical session (where PipeWire/pulseaudio lives).

Install as a user service:
  mkdir -p ~/.config/systemd/user
  cp deploy/capture-daemon.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now capture-daemon
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BACKEND = "127.0.0.1:8877"
# El idioma de transcripción es siempre español (regla del Capitán, 13/08/2026)
LANG = "es"
CHUNK_BYTES = 64 * 1024
# Si no llega ningún ping/start/stop del navegador durante este tiempo mientras
# se está grabando, el daemon se autopara (seguridad: navegador cerrado o crasheado)
HEARTBEAT_TIMEOUT = 120.0
WATCHDOG_INTERVAL = 15.0


def log(msg: str) -> None:
    print(f"[capture-daemon] {msg}", flush=True)


def new_session_id(now: datetime | None = None) -> str:
    now = now or datetime.now()
    return now.strftime("%Y%m%d-%H%M%S")


def run_pactl(*args: str) -> str:
    try:
        p = subprocess.run(["pactl", *args], capture_output=True, text=True, timeout=10)
        return p.stdout.strip()
    except Exception:
        return ""


def detect_sources() -> tuple[str | None, str | None]:
    """Devuelve (micrófono, monitor del sink por defecto)."""
    sink = run_pactl("get-default-sink")
    source = run_pactl("get-default-source")
    monitor = f"{sink}.monitor" if sink and sink != "auto_null" else None
    if not source or source.endswith(".monitor"):
        source = None
    return source, monitor


def build_ffmpeg_cmd(mic: str, monitor: str | None) -> list[str]:
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-f", "pulse", "-i", mic,
    ]
    if monitor:
        cmd += ["-f", "pulse", "-i", monitor]
        cmd += ["-filter_complex",
                "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0"]
    else:
        cmd += ["-filter_complex", "[0:a]anull"]
    cmd += ["-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "2",
            "-f", "webm", "pipe:1"]
    return cmd


class CaptureDaemon:
    """Owns one capture at a time; safe to call from HTTP handler threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._session_id: str | None = None
        self._last_error: str | None = None
        self._last_complete: dict | None = None
        self._last_activity = time.monotonic()
        self._watchdog = threading.Thread(
            target=self._watchdog_loop, daemon=True, name="ghostmeet-watchdog"
        )
        self._watchdog.start()

    def _touch(self) -> None:
        self._last_activity = time.monotonic()

    def _watchdog_loop(self) -> None:
        """Auto-stop si el navegador deja de hacer ping durante la grabación."""
        while True:
            time.sleep(WATCHDOG_INTERVAL)
            with self._lock:
                running = self._thread is not None and self._thread.is_alive()
                idle = time.monotonic() - self._last_activity
            if running and idle > HEARTBEAT_TIMEOUT:
                log(f"watchdog: sin actividad {idle:.0f}s, autoparando sesión")
                self._stop.set()

    def status(self) -> dict:
        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            return {
                "running": running,
                "session_id": self._session_id,
                "error": self._last_error,
                "complete": self._last_complete,
            }

    def ping(self) -> dict:
        self._touch()
        return self.status()

    def start(self, session_id: str) -> dict:
        self._touch()
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return {"ok": False, "error": "already capturing",
                        "session_id": self._session_id}
            self._session_id = session_id
            self._stop.clear()
            self._last_error = None
            self._last_complete = None
            self._thread = threading.Thread(
                target=self._run_capture, args=(session_id,), daemon=True,
                name="ghostmeet-capture",
            )
            self._thread.start()
            return {"ok": True, "session_id": session_id}

    def stop(self, timeout: float = 90.0) -> dict:
        """Solicita la parada y espera a que el hilo termine.

        El handler HTTP lo llama desde un hilo del ThreadingHTTPServer, así que
        bloquear aquí no congela el resto de endpoints (status/ping siguen
        respondiendo).
        """
        self._touch()
        with self._lock:
            thread = self._thread
            session_id = self._session_id
            if thread is None or not thread.is_alive():
                return {"ok": False, "error": "not capturing",
                        "session_id": session_id}
        self._stop.set()
        thread.join(timeout=timeout)
        with self._lock:
            self._thread = None
            complete = self._last_complete
        return {"ok": True, "session_id": session_id,
                "error": self._last_error, "complete": complete}

    # --- capture pipeline (runs in its own thread) ---

    def _run_capture(self, session_id: str) -> None:
        try:
            asyncio.run(self._capture_async(session_id))
        except Exception as e:  # noqa: BLE001 - report and keep daemon alive
            log(f"capture error: {e}")
            with self._lock:
                self._last_error = str(e)

    async def _capture_async(self, session_id: str) -> None:
        import websockets  # local import: daemon still boots without it

        mic, monitor = detect_sources()
        if not mic:
            log("ERROR: no microphone found (pactl get-default-source)")
            with self._lock:
                self._last_error = "no microphone found"
            return
        if not monitor:
            log("AVISO: no active audio sink; system audio may be missing")

        cmd = build_ffmpeg_cmd(mic, monitor)
        log(f"starting capture session={session_id} mic={mic!r} monitor={monitor!r}")
        # start_new_session: terminal Ctrl+C / daemon shutdown never hits ffmpeg directly
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )

        try:
            url = f"ws://{BACKEND}/ws/audio?session={session_id}&lang={LANG}"
            async with websockets.connect(url, open_timeout=10) as ws:
                try:
                    await asyncio.wait_for(ws.recv(), timeout=10)  # hello
                except Exception:
                    log("AVISO: no hello from backend")
                log(f"session {session_id} streaming to {BACKEND}")

                loop = asyncio.get_running_loop()
                while not self._stop.is_set():
                    if proc.poll() is not None:
                        log("ffmpeg exited unexpectedly")
                        break
                    try:
                        data = await asyncio.to_thread(
                            os.read, proc.stdout.fileno(), CHUNK_BYTES)
                    except Exception:
                        break
                    if not data:
                        break
                    await ws.send(data)

                log("finalizing capture…")
                try:
                    await ws.send("stop")
                except Exception:
                    pass
                try:
                    complete = await asyncio.wait_for(ws.recv(), timeout=60)
                    log("backend: " + str(complete))
                    with self._lock:
                        self._last_complete = complete
                except Exception:
                    log("AVISO: no completion notice from backend")
        finally:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            for stream in (proc.stdout, proc.stderr):
                if stream:
                    try:
                        stream.close()
                    except Exception:
                        pass
        log(f"session {session_id} done")


class Handler(BaseHTTPRequestHandler):
    daemon: CaptureDaemon | None = None  # set in main()

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        d = Handler.daemon
        if d is None:
            self._json({"ok": False, "error": "daemon not initialised"}, 500)
            return

        if parsed.path == "/start":
            sid = (params.get("session") or [None])[0]
            if not sid:
                self._json({"ok": False, "error": "missing session param"}, 400)
                return
            self._json(d.start(sid))
        elif parsed.path == "/stop":
            self._json(d.stop())
        elif parsed.path == "/status":
            self._json({"ok": True, **d.status()})
        elif parsed.path == "/ping":
            self._json({"ok": True, **d.ping()})
        else:
            self._json({"ok": False, "error": "not found"}, 404)

    def _json(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:  # keep the console quiet
        pass


def main() -> None:
    port = int(os.environ.get("CAPTURE_DAEMON_PORT", "8899"))
    daemon = CaptureDaemon()
    Handler.daemon = daemon
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    log(f"listening on http://127.0.0.1:{port} (backend {BACKEND}, lang {LANG})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
