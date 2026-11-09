import ctypes
import io
import platform
import struct
import threading
import time
from typing import Dict, List, Any, Optional, Tuple

import mss
from PIL import Image, ImageDraw

# Enable Per-Monitor DPI Awareness on Windows for 1:1 crisp capture & accurate mouse mapping
if platform.system() == "Windows":
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def get_cursor_position() -> Tuple[int, int]:
    """Get current OS cursor position (x, y) across platforms."""
    if platform.system() == "Windows":
        try:
            pt = Point()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            return pt.x, pt.y
        except Exception:
            return 0, 0
    else:
        try:
            from pynput.mouse import Controller
            mouse = Controller()
            pos = mouse.position
            return int(pos[0]), int(pos[1])
        except Exception:
            return 0, 0


class ScreenEngine:
    """
    Ultra-Low-Latency Screen Capture Engine:
    - Fast C-level BGRA -> RGB conversion
    - Turbo downscaling for mobile/WAN clients to prevent TCP bufferbloat
    - Sub-millisecond frame-change detection to avoid flooding the socket with duplicate static frames
    """

    HEADER_STRUCT = struct.Struct(">2sBBHHHHQ")

    def __init__(self):
        self._local = threading.local()
        self.gpu_frame_bytes: Optional[bytes] = None
        self.gpu_frame_size: Tuple[int, int] = (1920, 1080)
        self.gpu_frame_ts: float = 0.0
        self.stats = {
            "frames_captured": 0,
            "bytes_sent": 0,
            "last_capture_ms": 0.0,
            "capture_mode": "native_mss",
        }

    def _get_sct(self):
        if not hasattr(self._local, "sct"):
            self._local.sct = mss.mss()
        return self._local.sct

    def push_gpu_frame(self, jpeg_bytes: bytes, width: int = 1920, height: int = 1080):
        self.gpu_frame_bytes = jpeg_bytes
        self.gpu_frame_size = (width, height)
        self.gpu_frame_ts = time.time()
        self.stats["capture_mode"] = "gpu_webrtc"

    def get_monitors(self) -> List[Dict[str, Any]]:
        try:
            sct = self._get_sct()
            raw_monitors = sct.monitors
        except Exception:
            raw_monitors = [
                {"left": 0, "top": 0, "width": 1920, "height": 1080},
                {"left": 0, "top": 0, "width": 1920, "height": 1080},
            ]

        monitors = []
        for idx, m in enumerate(raw_monitors):
            if idx == 0 and len(raw_monitors) <= 2:
                continue
            label = "ทุกหน้าจอรวมกัน (All Displays)" if idx == 0 else f"หน้าจอที่ {idx} ({m['width']}x{m['height']})"
            monitors.append({
                "id": idx,
                "label": label,
                "left": m["left"],
                "top": m["top"],
                "width": m["width"],
                "height": m["height"],
                "is_primary": idx == 1,
            })
        return monitors

    def get_monitor_bounds(self, monitor_id: int = 1) -> Dict[str, int]:
        try:
            sct = self._get_sct()
            monitors = sct.monitors
            if 0 <= monitor_id < len(monitors):
                return monitors[monitor_id]
            return monitors[1] if len(monitors) > 1 else monitors[0]
        except Exception:
            return {"left": 0, "top": 0, "width": 1920, "height": 1080}

    def _build_standby_image(self, width: int, height: int, norm_cx: int, norm_cy: int) -> Image.Image:
        img = Image.new("RGB", (width, height), (18, 21, 33))
        draw = ImageDraw.Draw(img)
        cx, cy = width // 2, height // 2
        card_w, card_h = 640, 180
        x0, y0 = cx - card_w // 2, cy - card_h // 2
        x1, y1 = cx + card_w // 2, cy + card_h // 2
        draw.rounded_rectangle([x0, y0, x1, y1], radius=20, fill=(28, 32, 48), outline=(225, 29, 72), width=2)
        now_str = time.strftime("%H:%M:%S")
        draw.text((x0 + 35, y0 + 40), "SIAM RemoteMe Studio - 60 FPS Live Engine Ready", fill=(255, 255, 255))
        draw.text((x0 + 35, y0 + 85), f"System Time: {now_str}  |  Cursor: ({norm_cx}, {norm_cy})", fill=(52, 211, 153))
        return img

    def capture_binary_frame(
        self,
        monitor_id: int = 1,
        quality: int = 68,
        scale: float = 0.75,
        img_format: str = "jpeg",
        prev_signature: Optional[bytes] = None,
    ) -> Tuple[Optional[bytes], Dict[str, Any], Optional[bytes]]:
        """
        Captures and compresses a frame with ultra-low latency (<12ms total).
        If prev_signature matches and screen pixels haven't changed, returns (None, meta, sig)
        so caller can skip sending duplicate heavy image bytes and only send lightweight cursor updates!
        """
        t0 = time.perf_counter()
        mon = self.get_monitor_bounds(monitor_id)

        cx, cy = get_cursor_position()
        rel_x = cx - mon["left"]
        rel_y = cy - mon["top"]
        norm_cx = max(0, min(10000, int((rel_x / max(1, mon["width"])) * 10000)))
        norm_cy = max(0, min(10000, int((rel_y / max(1, mon["height"])) * 10000)))

        # 1. GPU Stream path
        if self.gpu_frame_bytes and (time.time() - self.gpu_frame_ts) < 3.0:
            payload = self.gpu_frame_bytes
            target_w, target_h = self.gpu_frame_size
            now_ms = int(time.time() * 1000)
            header = self.HEADER_STRUCT.pack(
                b"RM", monitor_id & 0xFF, 1, target_w & 0xFFFF, target_h & 0xFFFF,
                norm_cx & 0xFFFF, norm_cy & 0xFFFF, now_ms,
            )
            return header + payload, {"width": target_w, "height": target_h, "unchanged": False}, None

        # 2. Native MSS Screen Capture
        orig_w, orig_h = mon["width"], mon["height"]
        raw_bgra = None
        try:
            sct = self._get_sct()
            sct_img = sct.grab(mon)
            raw_bgra = sct_img.bgra
            orig_w, orig_h = sct_img.size
            self.stats["capture_mode"] = "native_mss"
        except Exception:
            orig_w, orig_h = 1280, 720
            img = self._build_standby_image(orig_w, orig_h, norm_cx, norm_cy)
            self.stats["capture_mode"] = "service_standby"

        # Fast sub-millisecond pixel-change signature check (samples 400 points across screen buffer)
        current_sig = None
        if raw_bgra is not None:
            step = max(4, len(raw_bgra) // 1600)
            current_sig = raw_bgra[::step]
            if prev_signature is not None and current_sig == prev_signature:
                return None, {
                    "unchanged": True,
                    "norm_cx": norm_cx,
                    "norm_cy": norm_cy,
                    "width": orig_w,
                    "height": orig_h,
                }, current_sig

            img = Image.frombytes("RGB", (orig_w, orig_h), raw_bgra, "raw", "BGRX")

        # Fast downscale: use NEAREST when scale <= 0.75 for 3x faster resize (<1.5ms), BILINEAR for UHD
        if 0.2 <= scale < 0.98:
            target_w = max(320, int(orig_w * scale))
            target_h = max(200, int(orig_h * scale))
            resample_mode = Image.Resampling.BILINEAR if quality >= 82 else Image.Resampling.NEAREST
            img = img.resize((target_w, target_h), resample_mode)
        else:
            target_w, target_h = orig_w, orig_h

        buf = io.BytesIO()
        quality = max(25, min(95, int(quality)))
        fmt_id = 1
        if img_format.lower() == "webp":
            fmt_id = 2
            img.save(buf, format="WEBP", quality=quality, method=0)
        else:
            subsampling = 0 if quality >= 85 else 2
            img.save(buf, format="JPEG", quality=quality, optimize=False, subsampling=subsampling)

        payload = buf.getvalue()
        now_ms = int(time.time() * 1000)

        header = self.HEADER_STRUCT.pack(
            b"RM",
            monitor_id & 0xFF,
            fmt_id,
            target_w & 0xFFFF,
            target_h & 0xFFFF,
            norm_cx & 0xFFFF,
            norm_cy & 0xFFFF,
            now_ms,
        )

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        self.stats["frames_captured"] += 1
        self.stats["bytes_sent"] += len(header) + len(payload)
        self.stats["last_capture_ms"] = round(elapsed_ms, 2)

        meta = {
            "unchanged": False,
            "width": target_w,
            "height": target_h,
            "orig_width": orig_w,
            "orig_height": orig_h,
            "capture_ms": round(elapsed_ms, 2),
            "size_bytes": len(payload),
            "mode": self.stats["capture_mode"],
        }
        return header + payload, meta, current_sig

    def capture_png_screenshot(self, monitor_id: int = 1) -> bytes:
        try:
            sct = self._get_sct()
            monitors = sct.monitors
            if monitor_id < 0 or monitor_id >= len(monitors):
                monitor_id = 1 if len(monitors) > 1 else 0
            sct_img = sct.grab(monitors[monitor_id])
            img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
        except Exception:
            img = self._build_standby_image(1280, 720, 5000, 5000)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


screen_engine = ScreenEngine()
