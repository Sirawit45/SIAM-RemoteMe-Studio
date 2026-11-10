import asyncio
import ctypes
import ctypes.wintypes as wintypes
import platform
import time
from collections import deque
from typing import Dict, Any, Optional

from backend.screen_engine import screen_engine
from backend.config import config

IS_WINDOWS = platform.system() == "Windows"

try:
    from pynput.mouse import Button, Controller as MouseController
    from pynput.keyboard import Key, KeyCode, Controller as KeyboardController
    _mouse = MouseController()
    _keyboard = KeyboardController()
    HAS_PYNPUT = True
except Exception:
    _mouse = None
    _keyboard = None
    HAS_PYNPUT = False


# Windows Virtual-Key Codes for instant low-level key injection
VK_MAP = {
    "Backspace": 0x08,
    "Tab": 0x09,
    "Enter": 0x0D,
    "Shift": 0x10,
    "ShiftLeft": 0xA0,
    "ShiftRight": 0xA1,
    "Control": 0x11,
    "ControlLeft": 0xA2,
    "ControlRight": 0xA3,
    "Alt": 0x12,
    "AltLeft": 0xA4,
    "AltRight": 0xA5,
    "Pause": 0x13,
    "CapsLock": 0x14,
    "Escape": 0x1B,
    " ": 0x20,
    "Space": 0x20,
    "PageUp": 0x21,
    "PageDown": 0x22,
    "End": 0x23,
    "Home": 0x24,
    "ArrowLeft": 0x25,
    "ArrowUp": 0x26,
    "ArrowRight": 0x27,
    "ArrowDown": 0x28,
    "Insert": 0x2D,
    "Delete": 0x2E,
    "Meta": 0x5B,
    "MetaLeft": 0x5B,
    "MetaRight": 0x5C,
    "ContextMenu": 0x5D,
    "F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73,
    "F5": 0x74, "F6": 0x75, "F7": 0x76, "F8": 0x77,
    "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,
    "NumLock": 0x90,
    "ScrollLock": 0x91,
    "Semicolon": 0xBA, ";": 0xBA,
    "Equal": 0xBB, "=": 0xBB,
    "Comma": 0xBC, ",": 0xBC,
    "Minus": 0xBD, "-": 0xBD,
    "Period": 0xBE, ".": 0xBE,
    "Slash": 0xBF, "/": 0xBF,
    "Backquote": 0xC0, "`": 0xC0,
    "BracketLeft": 0xDB, "[": 0xDB,
    "Backslash": 0xDC, "\\": 0xDC,
    "BracketRight": 0xDD, "]": 0xDD,
    "Quote": 0xDE, "'": 0xDE,
}

# Mouse / Keyboard Event Flags on Windows
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000

KEYEVENTF_KEYUP = 0x0002


if IS_WINDOWS:
    _ULONG_PTR = ctypes.c_uint64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_uint32

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", ctypes.c_long),
            ("dy", ctypes.c_long),
            ("mouseData", ctypes.c_ulong),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", _ULONG_PTR),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", ctypes.c_ushort),
            ("wScan", ctypes.c_ushort),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", _ULONG_PTR),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", ctypes.c_ulong),
            ("wParamL", ctypes.c_short),
            ("wParamH", ctypes.c_ushort),
        ]

    class _INPUT_UNION(ctypes.Union):
        _fields_ = [
            ("mi", MOUSEINPUT),
            ("ki", KEYBDINPUT),
            ("hi", HARDWAREINPUT),
        ]

    class INPUT(ctypes.Structure):
        _fields_ = [
            ("type", ctypes.c_ulong),
            ("u", _INPUT_UNION),
        ]

    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _user32.SendInput.argtypes = [ctypes.c_uint, ctypes.POINTER(INPUT), ctypes.c_int]
    _user32.SendInput.restype = ctypes.c_uint
    _user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    _user32.SetCursorPos.restype = wintypes.BOOL
    _user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    _user32.GetCursorPos.restype = wintypes.BOOL
    _user32.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, _ULONG_PTR]
    _user32.mouse_event.restype = None
    _user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, _ULONG_PTR]
    _user32.keybd_event.restype = None
    _user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    _user32.GetAsyncKeyState.restype = ctypes.c_short
    _user32.GetForegroundWindow.argtypes = []
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    _user32.SetForegroundWindow.restype = wintypes.BOOL
    _user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    _user32.FindWindowW.restype = wintypes.HWND
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.IsWindowVisible.restype = wintypes.BOOL
    _user32.WindowFromPoint.argtypes = [wintypes.POINT]
    _user32.WindowFromPoint.restype = wintypes.HWND
    _user32.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]
    _user32.GetAncestor.restype = wintypes.HWND
    _user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    _user32.GetSystemMetrics.restype = ctypes.c_int
else:
    _user32 = None


class InputController:
    """
    Ultra-low-latency cross-platform Mouse & Keyboard Input Controller
    using Win32 SendInput (hardware pointer injection) on Windows.
    """

    def __init__(self):
        self.active_mouse_buttons = set()
        self.active_keys = set()
        self.last_down_times = {}
        self.down_coords = {}
        self.is_dragging = False
        self.last_abs_pos = (0, 0)
        self.debug_log = deque(maxlen=120)

    def _resolve_coords(self, norm_x: float, norm_y: float, monitor_id: int = 1) -> tuple[int, int]:
        bounds = screen_engine.get_monitor_bounds(monitor_id)
        norm_x = max(0.0, min(1.0, float(norm_x)))
        norm_y = max(0.0, min(1.0, float(norm_y)))
        abs_x = int(bounds["left"] + norm_x * max(1, bounds["width"] - 1))
        abs_y = int(bounds["top"] + norm_y * max(1, bounds["height"] - 1))
        return abs_x, abs_y

    def _to_virtual_abs(self, x: int, y: int) -> tuple[int, int]:
        v_left = _user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
        v_top = _user32.GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
        v_w = _user32.GetSystemMetrics(78)     # SM_CXVIRTUALSCREEN
        v_h = _user32.GetSystemMetrics(79)     # SM_CYVIRTUALSCREEN
        if v_w <= 1:
            v_w = 1920
        if v_h <= 1:
            v_h = 1080
        dx = max(0, min(65535, int(round((x - v_left) * 65535.0 / max(1, v_w - 1)))))
        dy = max(0, min(65535, int(round((y - v_top) * 65535.0 / max(1, v_h - 1)))))
        return dx, dy

    def _win_send_mouse(
        self,
        flags: int,
        abs_x: Optional[int] = None,
        abs_y: Optional[int] = None,
        mouse_data: int = 0,
    ) -> tuple[int, int]:
        """Inject a genuine Win32 hardware mouse packet via SendInput (fallback to mouse_event)."""
        dx = 0
        dy = 0
        final_flags = flags
        if abs_x is not None and abs_y is not None:
            dx, dy = self._to_virtual_abs(abs_x, abs_y)
            final_flags |= MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK

        inp = INPUT()
        inp.type = INPUT_MOUSE
        inp.u.mi = MOUSEINPUT(
            dx=dx,
            dy=dy,
            mouseData=ctypes.c_ulong(mouse_data & 0xFFFFFFFF),
            dwFlags=final_flags,
            time=0,
            dwExtraInfo=0,
        )
        ctypes.set_last_error(0)
        sent = _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        err = ctypes.get_last_error()
        if sent == 0:
            # Fallback to legacy SetCursorPos + mouse_event if SendInput was rejected
            if abs_x is not None and abs_y is not None and (flags & MOUSEEVENTF_MOVE):
                _user32.SetCursorPos(abs_x, abs_y)
            if flags & ~MOUSEEVENTF_MOVE:
                _user32.mouse_event(flags & ~MOUSEEVENTF_MOVE, 0, 0, mouse_data & 0xFFFFFFFF, 0)
        return int(sent), int(err)

    def _win_send_key(self, vk: int, key_up: bool = False) -> tuple[int, int]:
        inp = INPUT()
        inp.type = INPUT_KEYBOARD
        inp.u.ki = KEYBDINPUT(
            wVk=vk & 0xFFFF,
            wScan=0,
            dwFlags=KEYEVENTF_KEYUP if key_up else 0,
            time=0,
            dwExtraInfo=0,
        )
        ctypes.set_last_error(0)
        sent = _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        err = ctypes.get_last_error()
        if sent == 0:
            _user32.keybd_event(vk & 0xFF, 0, KEYEVENTF_KEYUP if key_up else 0, 0)
        return int(sent), int(err)

    def _get_win_class(self, hwnd) -> str:
        if not hwnd:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(128)
            _user32.GetClassNameW(hwnd, buf, 128)
            return buf.value
        except Exception:
            return ""

    def _heal_stuck_buttons(self):
        """Ensure Windows OS does not think a mouse button is stuck down when client is idle."""
        if not IS_WINDOWS:
            return
        if "left" not in self.active_mouse_buttons and (_user32.GetAsyncKeyState(0x01) & 0x8000):
            self._win_send_mouse(MOUSEEVENTF_LEFTUP)
        if "right" not in self.active_mouse_buttons and (_user32.GetAsyncKeyState(0x02) & 0x8000):
            self._win_send_mouse(MOUSEEVENTF_RIGHTUP)
        if "middle" not in self.active_mouse_buttons and (_user32.GetAsyncKeyState(0x04) & 0x8000):
            self._win_send_mouse(MOUSEEVENTF_MIDDLEUP)

    def _recover_fg_from_hidden_overlay(self, abs_x: int, abs_y: int):
        """Recover foreground focus if a hidden driver/vendor overlay (e.g. ASUS ASHDRCONTROL) hijacked it."""
        if not IS_WINDOWS:
            return
        fg_hwnd = _user32.GetForegroundWindow()
        if not fg_hwnd:
            return
        fg_cls = self._get_win_class(fg_hwnd)
        if fg_cls in ("ASHDRCONTROL", "ASHOTPLUGCTRL", "AsMonitorControl") or not _user32.IsWindowVisible(fg_hwnd):
            pt_hwnd = _user32.WindowFromPoint(wintypes.POINT(abs_x, abs_y))
            if pt_hwnd:
                root_hwnd = _user32.GetAncestor(pt_hwnd, 2)  # GA_ROOT = 2
                if root_hwnd and root_hwnd != fg_hwnd:
                    _user32.SetForegroundWindow(root_hwnd)
                    return
            progman = _user32.FindWindowW("Progman", None)
            if progman:
                _user32.SetForegroundWindow(progman)

    def _log_event(self, event_name: str, norm_x: Optional[float], norm_y: Optional[float], abs_x: int, abs_y: int, sent: int = 1, err: int = 0, extra: str = ""):
        fg_hwnd = _user32.GetForegroundWindow() if IS_WINDOWS else 0
        pt_hwnd = _user32.WindowFromPoint(wintypes.POINT(abs_x, abs_y)) if IS_WINDOWS else 0
        lbtn = bool(_user32.GetAsyncKeyState(0x01) & 0x8000) if IS_WINDOWS else False
        self.debug_log.append({
            "ts": round(time.time(), 3),
            "event": event_name,
            "norm": [norm_x, norm_y],
            "px": [abs_x, abs_y],
            "sent": sent,
            "err": err,
            "fg": f"{fg_hwnd}:{self._get_win_class(fg_hwnd)}",
            "pt": f"{pt_hwnd}:{self._get_win_class(pt_hwnd)}",
            "os_lbtn": lbtn,
            "active_btns": list(self.active_mouse_buttons),
            "extra": extra,
        })

    def move_mouse(self, norm_x: float, norm_y: float, monitor_id: int = 1):
        if not config.allow_input_control:
            return

        # Trackpad Jitter Filter: When mouse button is held down (tap/click),
        # suppress micro-movements (< 12 pixels) so Windows never confuses clicks with drag-and-drop.
        if self.active_mouse_buttons:
            down_pos = self.down_coords.get("left")
            if down_pos and not self.is_dragging:
                dx = float(norm_x) - down_pos[0]
                dy = float(norm_y) - down_pos[1]
                if (dx * dx + dy * dy) < 0.0001:
                    return
                self.is_dragging = True

        x, y = self._resolve_coords(norm_x, norm_y, monitor_id)
        self.last_abs_pos = (x, y)
        if IS_WINDOWS:
            # Send hardware pointer move so DWM, Shell Desktop, and XAML update hover/hit-test
            self._win_send_mouse(MOUSEEVENTF_MOVE, x, y)
        elif HAS_PYNPUT:
            _mouse.position = (x, y)

    async def mouse_button(self, action: str, button: str = "left", norm_x: float = None, norm_y: float = None, monitor_id: int = 1):
        """action: 'down', 'up', 'click', 'dblclick' | button: 'left', 'middle', 'right'"""
        if not config.allow_input_control:
            return

        btn = (button or "left").lower()
        moved = False
        if norm_x is not None and norm_y is not None:
            self.move_mouse(norm_x, norm_y, monitor_id)
            moved = True

        abs_x, abs_y = self._resolve_coords(norm_x, norm_y, monitor_id) if (norm_x is not None and norm_y is not None) else self.last_abs_pos

        if IS_WINDOWS:
            btn_map = {
                "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            }
            down_flag, up_flag = btn_map.get(btn, btn_map["left"])

            if action in ("click", "dblclick", "down"):
                self._heal_stuck_buttons()
                self._recover_fg_from_hidden_overlay(abs_x, abs_y)
                if moved:
                    # Short settle yield after pointer move so freshly exposed/closed Shell controls register pointer position
                    await asyncio.sleep(0.004)

            if action == "down":
                if btn in self.active_mouse_buttons:
                    self._win_send_mouse(up_flag, abs_x, abs_y)
                if norm_x is not None and norm_y is not None:
                    self.down_coords[btn] = (float(norm_x), float(norm_y))
                self.is_dragging = False
                sent, err = self._win_send_mouse(down_flag, abs_x, abs_y)
                self.active_mouse_buttons.add(btn)
                self.last_down_times[btn] = time.perf_counter()
                self._log_event(f"down:{btn}", norm_x, norm_y, abs_x, abs_y, sent, err)

            elif action == "up":
                last_t = self.last_down_times.get(btn, 0.0)
                elapsed = time.perf_counter() - last_t
                if 0.0 < elapsed < 0.025:
                    await asyncio.sleep(0.025 - elapsed)
                sent, err = self._win_send_mouse(up_flag, abs_x, abs_y)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False
                self._log_event(f"up:{btn}", norm_x, norm_y, abs_x, abs_y, sent, err)

            elif action == "click":
                if btn in self.active_mouse_buttons:
                    self._win_send_mouse(up_flag, abs_x, abs_y)
                sent1, err1 = self._win_send_mouse(down_flag, abs_x, abs_y)
                await asyncio.sleep(0.035)
                sent2, err2 = self._win_send_mouse(up_flag, abs_x, abs_y)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False
                self._log_event(f"click:{btn}", norm_x, norm_y, abs_x, abs_y, sent1 & sent2, err1 or err2)

            elif action == "dblclick":
                if btn in self.active_mouse_buttons:
                    self._win_send_mouse(up_flag, abs_x, abs_y)
                sent1, err1 = self._win_send_mouse(down_flag, abs_x, abs_y)
                await asyncio.sleep(0.030)
                self._win_send_mouse(up_flag, abs_x, abs_y)
                await asyncio.sleep(0.080)
                sent2, err2 = self._win_send_mouse(down_flag, abs_x, abs_y)
                await asyncio.sleep(0.030)
                self._win_send_mouse(up_flag, abs_x, abs_y)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False
                self._log_event(f"dblclick:{btn}", norm_x, norm_y, abs_x, abs_y, sent1 & sent2, err1 or err2)

        elif HAS_PYNPUT:
            p_btn = {"left": Button.left, "right": Button.right, "middle": Button.middle}.get(btn, Button.left)
            if action == "down":
                _mouse.press(p_btn)
                self.active_mouse_buttons.add(btn)
            elif action == "up":
                _mouse.release(p_btn)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False
            elif action == "click":
                _mouse.press(p_btn)
                await asyncio.sleep(0.035)
                _mouse.release(p_btn)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False
            elif action == "dblclick":
                _mouse.press(p_btn)
                await asyncio.sleep(0.030)
                _mouse.release(p_btn)
                await asyncio.sleep(0.080)
                _mouse.press(p_btn)
                await asyncio.sleep(0.030)
                _mouse.release(p_btn)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False

    def scroll(self, delta_x: float = 0, delta_y: float = 0):
        if not config.allow_input_control:
            return
        if IS_WINDOWS:
            if delta_y != 0:
                # Browser wheel deltaY > 0 means scroll down -> Windows wheel negative
                wheel_amount = int(-delta_y * 1.2)
                if abs(wheel_amount) < 40:
                    wheel_amount = -120 if delta_y > 0 else 120
                self._win_send_mouse(MOUSEEVENTF_WHEEL, mouse_data=wheel_amount)
            if delta_x != 0:
                hwheel_amount = int(delta_x * 1.2)
                self._win_send_mouse(MOUSEEVENTF_HWHEEL, mouse_data=hwheel_amount)
        elif HAS_PYNPUT:
            dx = -1 if delta_x > 0 else (1 if delta_x < 0 else 0)
            dy = -1 if delta_y > 0 else (1 if delta_y < 0 else 0)
            _mouse.scroll(dx, dy)

    def _get_vk(self, key: str, code: str = "") -> int:
        if key in VK_MAP:
            return VK_MAP[key]
        if code in VK_MAP:
            return VK_MAP[code]
        if code.startswith("Key") and len(code) == 4:
            return ord(code[3].upper())
        if code.startswith("Digit") and len(code) == 6:
            return ord(code[5])
        if len(key) == 1 and ord(key) < 128:
            ch = key.upper()
            if "A" <= ch <= "Z" or "0" <= ch <= "9":
                return ord(ch)
        return 0

    def key_event(self, action: str, key: str, code: str = ""):
        """action: 'down', 'up', 'press'"""
        if not config.allow_input_control:
            return

        # Handle non-ASCII / Thai / Unicode characters on keydown via pynput unicode typing
        if len(key) == 1 and ord(key) >= 128:
            if action in ("down", "press") and HAS_PYNPUT:
                _keyboard.type(key)
            return

        if IS_WINDOWS:
            vk = self._get_vk(key, code)
            if vk:
                if action == "down":
                    self._win_send_key(vk, key_up=False)
                elif action == "up":
                    self._win_send_key(vk, key_up=True)
                elif action == "press":
                    self._win_send_key(vk, key_up=False)
                    self._win_send_key(vk, key_up=True)
                return

        if HAS_PYNPUT:
            pynput_key_map = {
                "Backspace": Key.backspace,
                "Tab": Key.tab,
                "Enter": Key.enter,
                "Shift": Key.shift,
                "Control": Key.ctrl,
                "Alt": Key.alt,
                "Escape": Key.esc,
                " ": Key.space,
                "Space": Key.space,
                "PageUp": Key.page_up,
                "PageDown": Key.page_down,
                "End": Key.end,
                "Home": Key.home,
                "ArrowLeft": Key.left,
                "ArrowUp": Key.up,
                "ArrowRight": Key.right,
                "ArrowDown": Key.down,
                "Delete": Key.delete,
                "Meta": Key.cmd,
            }
            k = pynput_key_map.get(key)
            if not k and len(key) == 1:
                k = KeyCode.from_char(key)
            if k:
                if action == "down":
                    _keyboard.press(k)
                elif action == "up":
                    _keyboard.release(k)
                elif action == "press":
                    _keyboard.press(k)
                    _keyboard.release(k)

    def type_text(self, text: str):
        """Type arbitrary text (including Thai, English, symbols, emojis) directly on Host."""
        if not config.allow_input_control or not text:
            return
        if HAS_PYNPUT:
            _keyboard.type(text)

    async def send_hotkey(self, combo_name: str):
        """Execute common remote desktop shortcuts."""
        if not config.allow_input_control:
            return
        combos = {
            "copy": ["Control", "KeyC"],
            "paste": ["Control", "KeyV"],
            "cut": ["Control", "KeyX"],
            "undo": ["Control", "KeyZ"],
            "select_all": ["Control", "KeyA"],
            "alt_tab": ["Alt", "Tab"],
            "show_desktop": ["Meta", "KeyD"],
            "task_manager": ["Control", "Shift", "Escape"],
            "close_window": ["Alt", "F4"],
            "lock_screen": ["Meta", "KeyL"],
            "explorer": ["Meta", "KeyE"],
            "run_dialog": ["Meta", "KeyR"],
        }
        keys = combos.get(combo_name)
        if not keys:
            return
        for k in keys:
            self.key_event("down", k, k)
        await asyncio.sleep(0.04)
        for k in reversed(keys):
            self.key_event("up", k, k)

    def release_all(self):
        """Safely release all active mouse buttons and modifier keys."""
        self.down_coords.clear()
        self.is_dragging = False
        if IS_WINDOWS:
            self._win_send_mouse(MOUSEEVENTF_LEFTUP)
            self._win_send_mouse(MOUSEEVENTF_RIGHTUP)
            self._win_send_mouse(MOUSEEVENTF_MIDDLEUP)
            self.active_mouse_buttons.clear()
            self.last_down_times.clear()

            for vk in (0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5):
                try:
                    self._win_send_key(vk, key_up=True)
                except Exception:
                    pass
            self.active_keys.clear()
        elif HAS_PYNPUT:
            try:
                for b in (Button.left, Button.right, Button.middle):
                    _mouse.release(b)
                self.active_mouse_buttons.clear()
                self.last_down_times.clear()
            except Exception:
                pass

    async def handle_packet(self, msg: Dict[str, Any]):
        """Dispatch incoming WebSocket / DataChannel input control packet safely."""
        try:
            t = msg.get("type")
            mon = int(msg.get("monitor", 1))
            if t == "mousemove":
                self.move_mouse(msg.get("x", 0), msg.get("y", 0), mon)
            elif t in ("mousedown", "mouseup", "click", "dblclick"):
                action = t.replace("mouse", "")
                await self.mouse_button(
                    action=action,
                    button=msg.get("button", "left"),
                    norm_x=msg.get("x"),
                    norm_y=msg.get("y"),
                    monitor_id=mon,
                )
            elif t == "wheel":
                self.scroll(msg.get("dx", 0), msg.get("dy", 0))
            elif t in ("keydown", "keyup", "keypress"):
                action = t.replace("key", "")
                self.key_event(action, msg.get("key", ""), msg.get("code", ""))
            elif t == "text":
                self.type_text(msg.get("text", ""))
            elif t == "hotkey":
                await self.send_hotkey(msg.get("combo", ""))
            elif t in ("release_all", "reset_input"):
                self.release_all()
        except Exception as e:
            self.debug_log.append({"ts": round(time.time(), 3), "event": "error", "err": str(e)})


input_controller = InputController()
