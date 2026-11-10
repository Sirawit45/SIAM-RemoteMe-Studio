import asyncio
import ctypes
import platform
import time
from typing import Dict, Any

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

# Mouse Event Flags on Windows
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x01000
KEYEVENTF_KEYUP = 0x0002


class InputController:
    """
    Ultra-low-latency cross-platform Mouse & Keyboard Input Controller.
    """

    def __init__(self):
        self.active_mouse_buttons = set()
        self.active_keys = set()
        self.last_down_times = {}
        self.down_coords = {}
        self.is_dragging = False

    def _resolve_coords(self, norm_x: float, norm_y: float, monitor_id: int = 1) -> tuple[int, int]:
        bounds = screen_engine.get_monitor_bounds(monitor_id)
        norm_x = max(0.0, min(1.0, float(norm_x)))
        norm_y = max(0.0, min(1.0, float(norm_y)))
        abs_x = int(bounds["left"] + norm_x * max(1, bounds["width"] - 1))
        abs_y = int(bounds["top"] + norm_y * max(1, bounds["height"] - 1))
        return abs_x, abs_y

    def move_mouse(self, norm_x: float, norm_y: float, monitor_id: int = 1):
        if not config.allow_input_control:
            return

        # Trackpad Jitter Filter: When mouse button is held down (tap/click),
        # suppress micro-movements (< 12 pixels) so Windows never confuses clicks with drag-and-drop!
        if self.active_mouse_buttons:
            down_pos = self.down_coords.get("left")
            if down_pos and not self.is_dragging:
                dx = float(norm_x) - down_pos[0]
                dy = float(norm_y) - down_pos[1]
                if (dx * dx + dy * dy) < 0.0001:
                    return
                self.is_dragging = True

        x, y = self._resolve_coords(norm_x, norm_y, monitor_id)
        if IS_WINDOWS:
            ctypes.windll.user32.SetCursorPos(x, y)
        elif HAS_PYNPUT:
            _mouse.position = (x, y)

    async def mouse_button(self, action: str, button: str = "left", norm_x: float = None, norm_y: float = None, monitor_id: int = 1):
        """action: 'down', 'up', 'click', 'dblclick' | button: 'left', 'middle', 'right'"""
        if not config.allow_input_control:
            return

        btn = (button or "left").lower()
        if norm_x is not None and norm_y is not None:
            self.move_mouse(norm_x, norm_y, monitor_id)

        if IS_WINDOWS:
            user32 = ctypes.windll.user32
            btn_map = {
                "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            }
            down_flag, up_flag = btn_map.get(btn, btn_map["left"])

            # Ensure desktop window receives focus if previous window was destroyed
            if user32.GetForegroundWindow() == 0:
                desk = user32.GetDesktopWindow()
                if desk:
                    try:
                        user32.SetForegroundWindow(desk)
                    except Exception:
                        pass

            if action == "down":
                if btn in self.active_mouse_buttons:
                    user32.mouse_event(up_flag, 0, 0, 0, 0)
                if norm_x is not None and norm_y is not None:
                    self.down_coords[btn] = (float(norm_x), float(norm_y))
                self.is_dragging = False
                user32.mouse_event(down_flag, 0, 0, 0, 0)
                self.active_mouse_buttons.add(btn)
                self.last_down_times[btn] = time.perf_counter()

            elif action == "up":
                last_t = self.last_down_times.get(btn, 0.0)
                elapsed = time.perf_counter() - last_t
                # Guaranteed minimum hold duration without blocking the asyncio loop!
                if 0.0 < elapsed < 0.025:
                    await asyncio.sleep(0.025 - elapsed)
                user32.mouse_event(up_flag, 0, 0, 0, 0)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False

            elif action == "click":
                if btn in self.active_mouse_buttons:
                    user32.mouse_event(up_flag, 0, 0, 0, 0)
                user32.mouse_event(down_flag, 0, 0, 0, 0)
                await asyncio.sleep(0.025)
                user32.mouse_event(up_flag, 0, 0, 0, 0)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False

            elif action == "dblclick":
                if btn in self.active_mouse_buttons:
                    user32.mouse_event(up_flag, 0, 0, 0, 0)
                # First click (down -> 25ms -> up)
                user32.mouse_event(down_flag, 0, 0, 0, 0)
                await asyncio.sleep(0.025)
                user32.mouse_event(up_flag, 0, 0, 0, 0)
                # Inter-click delay
                await asyncio.sleep(0.035)
                # Second click (down -> 25ms -> up)
                user32.mouse_event(down_flag, 0, 0, 0, 0)
                await asyncio.sleep(0.025)
                user32.mouse_event(up_flag, 0, 0, 0, 0)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False

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
                _mouse.click(p_btn, 1)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False
            elif action == "dblclick":
                _mouse.click(p_btn, 2)
                self.active_mouse_buttons.discard(btn)
                self.down_coords.pop(btn, None)
                self.is_dragging = False

    def scroll(self, delta_x: float = 0, delta_y: float = 0):
        if not config.allow_input_control:
            return
        if IS_WINDOWS:
            user32 = ctypes.windll.user32
            if delta_y != 0:
                # Browser wheel deltaY > 0 means scroll down -> Windows wheel negative
                wheel_amount = int(-delta_y * 1.2)
                if abs(wheel_amount) < 40:
                    wheel_amount = -120 if delta_y > 0 else 120
                user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, wheel_amount, 0)
            if delta_x != 0:
                hwheel_amount = int(delta_x * 1.2)
                user32.mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, hwheel_amount, 0)
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
                user32 = ctypes.windll.user32
                if action == "down":
                    user32.keybd_event(vk, 0, 0, 0)
                elif action == "up":
                    user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
                elif action == "press":
                    user32.keybd_event(vk, 0, 0, 0)
                    user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
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
            user32 = ctypes.windll.user32
            # Explicitly release left, right, middle
            user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
            user32.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
            user32.mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0)
            self.active_mouse_buttons.clear()
            self.last_down_times.clear()

            # Release common modifiers (Shift, Ctrl, Alt, Win)
            for vk in (0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5):
                try:
                    user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
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
        except Exception:
            pass


input_controller = InputController()
