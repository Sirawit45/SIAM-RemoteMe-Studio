import json
import os
import platform
import random
import sys
import uuid
from pathlib import Path
from typing import Dict, Any

# BUNDLE_DIR points to bundled assets (static/, bin/) even inside a single-file PyInstaller .exe
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
# BASE_DIR points to the writable directory next to the .exe (or project root in dev)
BASE_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else BUNDLE_DIR

CONFIG_FILE = BASE_DIR / "remoteme_config.json"
TEMP_UPLOAD_DIR = BASE_DIR / ".temp_uploads"
TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def generate_device_id() -> str:
    """Generate a deterministic yet friendly 9-digit Device ID based on machine node."""
    node = uuid.getnode()
    random.seed(node)
    digits = "".join(str(random.randint(0, 9)) for _ in range(9))
    random.seed()  # reset seed
    return f"{digits[:3]}-{digits[3:6]}-{digits[6:]}"


def generate_pin() -> str:
    return "".join(str(random.randint(0, 9)) for _ in range(6))


class AppConfig:
    def __init__(self):
        self.device_id: str = generate_device_id()
        self.device_name: str = platform.node() or "RemoteMe-PC"
        self.pin_code: str = "123456"
        self.require_pin: bool = False
        self.port: int = 8765
        self.default_fps: int = 60
        self.default_quality: int = 75
        self.default_scale: float = 1.0
        self.allow_file_delete: bool = True
        self.allow_input_control: bool = True
        self.default_upload_dir: str = str(Path.home() / "Downloads")
        self.load()

    def load(self):
        if CONFIG_FILE.exists():
            try:
                data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                self.device_id = data.get("device_id", self.device_id)
                self.device_name = data.get("device_name", self.device_name)
                self.pin_code = data.get("pin_code", self.pin_code)
                self.require_pin = data.get("require_pin", self.require_pin)
                self.port = data.get("port", self.port)
                self.default_fps = data.get("default_fps", self.default_fps)
                self.default_quality = data.get("default_quality", self.default_quality)
                self.default_scale = data.get("default_scale", self.default_scale)
                self.allow_file_delete = data.get("allow_file_delete", self.allow_file_delete)
                self.allow_input_control = data.get("allow_input_control", self.allow_input_control)
                self.default_upload_dir = data.get("default_upload_dir", self.default_upload_dir)
            except Exception:
                pass
        else:
            self.pin_code = generate_pin()
            self.save()

    def save(self):
        data = self.to_dict()
        try:
            CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def update(self, updates: Dict[str, Any]):
        for k, v in updates.items():
            if hasattr(self, k):
                setattr(self, k, v)
        self.save()

    def regenerate_pin(self) -> str:
        self.pin_code = generate_pin()
        self.save()
        return self.pin_code

    def to_dict(self) -> Dict[str, Any]:
        return {
            "device_id": self.device_id,
            "device_name": self.device_name,
            "pin_code": self.pin_code,
            "require_pin": self.require_pin,
            "port": self.port,
            "default_fps": self.default_fps,
            "default_quality": self.default_quality,
            "default_scale": self.default_scale,
            "allow_file_delete": self.allow_file_delete,
            "allow_input_control": self.allow_input_control,
            "default_upload_dir": self.default_upload_dir,
        }


config = AppConfig()
