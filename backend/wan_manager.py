import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Dict, Any, Optional

from backend.config import BASE_DIR, BUNDLE_DIR, config

BIN_DIR = BASE_DIR / "bin"
BIN_DIR.mkdir(parents=True, exist_ok=True)
BUNDLED_BIN_DIR = BUNDLE_DIR / "bin"


def get_cloudflared_download_url() -> tuple[str, str]:
    """Return (download_url, binary_filename) for current OS & CPU architecture."""
    sys_name = platform.system().lower()
    machine = platform.machine().lower()
    is_arm = "arm" in machine or "aarch64" in machine

    if sys_name == "windows":
        arch = "arm64" if is_arm else "amd64"
        return (
            f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-{arch}.exe",
            "cloudflared.exe",
        )
    elif sys_name == "darwin":
        arch = "arm64" if is_arm else "amd64"
        return (
            f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-{arch}.tgz",
            "cloudflared",
        )
    else:
        arch = "arm64" if is_arm else "amd64"
        return (
            f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}",
            "cloudflared",
        )


def _get_registry_topic(device_id: str) -> str:
    clean_id = re.sub(r"[^0-9]", "", device_id)
    digest = hashlib.sha256(f"siam_remoteme_v2_{clean_id}".encode("utf-8")).hexdigest()[:16]
    return f"siam_rm_{clean_id}_{digest}"


class WanManager:
    """
    Global Internet Access Engine (WAN / Anywhere Control):
    1. Manages automatic Cloudflare Edge HTTPS/WSS Tunnel (or SSH localhost.run fallback).
    2. Publishes Device ID -> Public Tunnel URL to Global Rendezvous Registry so users
       can connect from anywhere in the world using either:
       - 9-digit Device ID (e.g. 123 456 789)
       - Public HTTPS URL (https://xxxx.trycloudflare.com)
       - QR Code scan on 4G/5G Mobile
    """

    def __init__(self):
        self.process: Optional[subprocess.Popen] = None
        self.public_url: Optional[str] = None
        self.status: str = "stopped"  # 'stopped' | 'downloading' | 'starting' | 'online' | 'error'
        self.provider: str = "cloudflare"
        self.error_msg: Optional[str] = None
        self.started_at: Optional[int] = None
        self._lock = threading.Lock()

    def get_binary_path(self) -> Path:
        _, fname = get_cloudflared_download_url()
        bundled = BUNDLED_BIN_DIR / fname
        if bundled.exists() and bundled.stat().st_size > 5_000_000:
            return bundled
        local_bin = BIN_DIR / fname
        if local_bin.exists() and local_bin.stat().st_size > 5_000_000:
            return local_bin
        sys_bin = shutil.which("cloudflared")
        if sys_bin:
            return Path(sys_bin)
        return local_bin

    def ensure_binary(self) -> Path:
        bin_path = self.get_binary_path()
        if bin_path.exists() and bin_path.stat().st_size > 5_000_000:
            return bin_path

        self.status = "downloading"
        url, _ = get_cloudflared_download_url()
        if url.endswith(".tgz"):
            import tarfile
            tgz_path = BIN_DIR / "cloudflared.tgz"
            urllib.request.urlretrieve(url, str(tgz_path))
            with tarfile.open(tgz_path, "r:gz") as tar:
                tar.extractall(path=str(BIN_DIR))
            tgz_path.unlink(missing_ok=True)
        else:
            urllib.request.urlretrieve(url, str(bin_path))

        if platform.system().lower() != "windows":
            os.chmod(bin_path, 0o755)
        return bin_path

    def start_tunnel(self, port: int = 8765, provider: str = "cloudflare"):
        with self._lock:
            if self.status in ("starting", "downloading", "online") and self.process and self.process.poll() is None:
                return
            self.stop_tunnel_internal()
            self.provider = provider
            self.status = "starting"
            self.error_msg = None
            t = threading.Thread(target=self._tunnel_worker, args=(port, provider), daemon=True)
            t.start()

    def _tunnel_worker(self, port: int, provider: str):
        try:
            if provider == "ssh":
                self._run_ssh_tunnel(port)
            else:
                self._run_cloudflare_tunnel(port)
        except Exception as e:
            self.status = "error"
            self.error_msg = str(e)

    def _run_cloudflare_tunnel(self, port: int):
        try:
            bin_path = self.ensure_binary()
        except Exception as e:
            # Fallback to SSH tunnel if cloudflared download fails
            self._run_ssh_tunnel(port)
            return

        self.status = "starting"
        cmd = [
            str(bin_path),
            "tunnel",
            "--url",
            f"http://127.0.0.1:{port}",
            "--no-autoupdate",
        ]

        creationflags = subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0
        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )

        url_pattern = re.compile(r"(https://[a-zA-Z0-9\-]+\.trycloudflare\.com)")
        for line in self.process.stdout:
            match = url_pattern.search(line)
            if match:
                self.public_url = match.group(1)
                self.status = "online"
                self.started_at = int(time.time() * 1000)
                self.publish_device_directory()
                break

        # Wait until process exits
        if self.process:
            self.process.wait()
        if self.status != "stopped":
            self.status = "stopped"
            self.public_url = None

    def _run_ssh_tunnel(self, port: int):
        self.provider = "ssh"
        self.status = "starting"
        cmd = [
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=30",
            "-R", f"80:127.0.0.1:{port}",
            "nokey@localhost.run",
        ]
        creationflags = subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0
        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
        url_pattern = re.compile(r"(https://[a-zA-Z0-9\-]+\.lhr\.life)")
        for line in self.process.stdout:
            match = url_pattern.search(line)
            if match:
                self.public_url = match.group(1)
                self.status = "online"
                self.started_at = int(time.time() * 1000)
                self.publish_device_directory()
                break

        if self.process:
            self.process.wait()
        if self.status != "stopped":
            self.status = "stopped"
            self.public_url = None

    def stop_tunnel_internal(self):
        self.status = "stopped"
        self.public_url = None
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=3)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None

    def stop_tunnel(self):
        with self._lock:
            self.stop_tunnel_internal()

    def publish_device_directory(self):
        """
        Publish {device_id -> public_url} to Global Rendezvous channel so remote peers
        can connect from anywhere by entering only the 9-digit Device ID!
        """
        if not self.public_url:
            return

        def _pub():
            try:
                topic = _get_registry_topic(config.device_id)
                payload = json.dumps({
                    "device_id": config.device_id,
                    "device_name": config.device_name,
                    "public_url": self.public_url,
                    "ts": int(time.time()),
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"https://ntfy.sh/{topic}",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=8) as _:
                    pass
            except Exception:
                pass

        threading.Thread(target=_pub, daemon=True).start()

    def resolve_remote_device_id(self, target_device_id: str) -> Optional[Dict[str, Any]]:
        """
        Resolve a 9-digit Device ID (e.g. '123-456-789' or '123 456 789') to its active Global HTTPS URL.
        """
        clean_id = re.sub(r"[^0-9]", "", target_device_id)
        if len(clean_id) != 9:
            return None

        # If resolving our own Device ID
        my_clean = re.sub(r"[^0-9]", "", config.device_id)
        if clean_id == my_clean and self.public_url:
            return {
                "device_id": config.device_id,
                "device_name": config.device_name,
                "public_url": self.public_url,
            }

        topic = _get_registry_topic(clean_id)
        try:
            url = f"https://ntfy.sh/{topic}/json?poll=1&since=24h"
            req = urllib.request.Request(url, headers={"User-Agent": "SIAM-RemoteMe/2.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                lines = resp.read().decode("utf-8", errors="replace").strip().splitlines()
                latest_record = None
                for line in reversed(lines):
                    try:
                        event = json.loads(line)
                        if event.get("event") == "message" and event.get("message"):
                            data = json.loads(event["message"])
                            if data.get("public_url"):
                                latest_record = data
                                break
                    except Exception:
                        continue
                return latest_record
        except Exception:
            return None

    def get_state(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "provider": self.provider,
            "public_url": self.public_url,
            "error_msg": self.error_msg,
            "started_at": self.started_at,
        }


wan_manager = WanManager()
