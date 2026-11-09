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
        x, y = self._resolve_coords(norm_x, norm_y, monitor_id)
        if IS_WINDOWS:
            ctypes.windll.user32.SetCursorPos(x, y)
        elif HAS_PYNPUT:
            _mouse.position = (x, y)

    def mouse_button(self, action: str, button: str = "left", norm_x: float = None, norm_y: float = None, monitor_id: int = 1):
        """action: 'down', 'up', 'click', 'dblclick' | button: 'left', 'middle', 'right'"""
        if not config.allow_input_control:
            return
        if norm_x is not None and norm_y is not None:
            self.move_mouse(norm_x, norm_y, monitor_id)

        if IS_WINDOWS:
            user32 = ctypes.windll.user32
            btn_map = {
                "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            }
            down_flag, up_flag = btn_map.get(button, btn_map["left"])
            if action == "down":
                user32.mouse_event(down_flag, 0, 0, 0, 0)
            elif action == "up":
                user32.mouse_event(up_flag, 0, 0, 0, 0)
            elif action == "click":
                user32.mouse_event(down_flag, 0, 0, 0, 0)
                time.sleep(0.02)
                user32.mouse_event(up_flag, 0, 0, 0, 0)
            elif action == "dblclick":
                user32.mouse_event(down_flag, 0, 0, 0, 0)
                user32.mouse_event(up_flag, 0, 0, 0, 0)
                time.sleep(0.03)
                user32.mouse_event(down_flag, 0, 0, 0, 0)
                user32.mouse_event(up_flag, 0, 0, 0, 0)
        elif HAS_PYNPUT:
            p_btn = {"left": Button.left, "right": Button.right, "middle": Button.middle}.get(button, Button.left)
            if action == "down":
                _mouse.press(p_btn)
            elif action == "up":
                _mouse.release(p_btn)
            elif action == "click":
                _mouse.click(p_btn, 1)
            elif action == "dblclick":
                _mouse.click(p_btn, 2)

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

    def send_hotkey(self, combo_name: str):
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
        time.sleep(0.04)
        for k in reversed(keys):
            self.key_event("up", k, k)

    def handle_packet(self, msg: Dict[str, Any]):
        """Dispatch incoming WebSocket / DataChannel input control packet."""
        t = msg.get("type")
        mon = int(msg.get("monitor", 1))
        if t == "mousemove":
            self.move_mouse(msg.get("x", 0), msg.get("y", 0), mon)
        elif t in ("mousedown", "mouseup", "click", "dblclick"):
            action = t.replace("mouse", "")
            self.mouse_button(
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
            self.send_hotkey(msg.get("combo", ""))


input_controller = InputController()
