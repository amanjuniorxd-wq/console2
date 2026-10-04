"""Input injection into the session's own X display via XTEST.

Only a fixed vocabulary is accepted: KeyboardEvent.code values from an allow-list, normalized pointer
coordinates/buttons, and logical controller buttons mapped through the manifest's controllerMap.
Wire format = existing `input` data channel (server/PROTOCOL.md):
  [1, btn, down]            logical button derived from the keyboard → ignored here (raw keys carry it)
  [2, buttons, x:u16, y:u16] pointer
  [4, steps:i8]              mouse wheel notches (+ down)
  [3, btn, down]            controller / touch button → mapped to keys by controllerMap
  [5, mask:u16, lx, ly, rx, ry]  full controller state: 16 buttons (FULL_PAD bit order) + optional analog sticks (int8,
                             -127..127) → keys by controllerMap; each stick direction past half deflection = its key
  text "k1<code>" / "k0<code>" raw key
"""
import re
import struct
import threading
import time

from Xlib import X, XK, display as xdisplay
from Xlib.ext import xtest

BTN_NAMES = ['up', 'down', 'left', 'right', 'a', 'b', 'start']
FULL_PAD = ['up', 'down', 'left', 'right', 'cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3']
STICKS = ['lup', 'ldown', 'lleft', 'lright', 'rup', 'rdown', 'rleft', 'rright']
LOGICAL_ALIAS = {'a': 'cross', 'b': 'circle'}  # logical A/B on a full-pad (emulator) map

CODE_TO_KEYSYM = {
    **{f'Key{c}': c.lower() for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'},
    **{f'Digit{d}': str(d) for d in range(10)},
    **{f'F{i}': f'F{i}' for i in range(1, 13)},
    **{f'Numpad{d}': f'KP_{d}' for d in range(10)},
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Enter': 'Return', 'NumpadEnter': 'KP_Enter', 'Space': 'space', 'Escape': 'Escape', 'Tab': 'Tab', 'Backspace': 'BackSpace',
    'ShiftLeft': 'Shift_L', 'ShiftRight': 'Shift_R', 'ControlLeft': 'Control_L', 'ControlRight': 'Control_R',
    'AltLeft': 'Alt_L', 'AltRight': 'Alt_R', 'CapsLock': 'Caps_Lock', 'Insert': 'Insert', 'Delete': 'Delete',
    'Home': 'Home', 'End': 'End', 'PageUp': 'Prior', 'PageDown': 'Next', 'Minus': 'minus', 'Equal': 'equal',
    'BracketLeft': 'bracketleft', 'BracketRight': 'bracketright', 'Backslash': 'backslash', 'Semicolon': 'semicolon',
    'Quote': 'apostrophe', 'Comma': 'comma', 'Period': 'period', 'Slash': 'slash', 'Backquote': 'grave',
}


class Injector:
    def __init__(self, display_num, controller_map, focus_title=None, autorepeat=True):
        # XAUTHORITY points at the worker-wide cookie file (each session display has its own cookie).
        self.d = xdisplay.Display(f':{display_num}')
        self.root = self.d.screen().root
        self.w, self.h = self.d.screen().width_in_pixels, self.d.screen().height_in_pixels
        self.pad = controller_map
        self.lock = threading.Lock()
        self.down_keys = set()
        self.buttons = 0
        self.mask = 0
        self.events = 0
        self._focus_checked = 0.0
        self.focus_re = re.compile(focus_title) if focus_title else None   # emulators with several windows
        if not autorepeat:   # a held pad button is one press: X autorepeat's synthetic release/press pairs confuse pad plugins
            self.d.change_keyboard_control(auto_repeat_mode=X.AutoRepeatModeOff)
            self.d.flush()

    def _keycode(self, keysym_name):
        ks = XK.string_to_keysym(keysym_name)
        return self.d.keysym_to_keycode(ks) if ks else 0

    def _ensure_focus(self):
        """There is no window manager: X focus defaults to PointerRoot, so keys would go to whatever is under the
        pointer (often nothing when the game window is smaller than the display). Focus the game's top-level window."""
        now = time.monotonic()
        if now - self._focus_checked < 1.0:
            return
        self._focus_checked = now
        try:
            wins = [w for w in reversed(self.root.query_tree().children)   # stacking order: last = topmost
                    if w.get_attributes().map_state == X.IsViewable and w.get_wm_name()]
            if self.focus_re:
                wins = sorted(wins, key=lambda w: not self.focus_re.search(str(w.get_wm_name())))
            if wins and self.d.get_input_focus().focus != wins[0]:
                wins[0].set_input_focus(X.RevertToParent, X.CurrentTime)
        except Exception:
            pass

    def key(self, keysym_name, down):
        kc = self._keycode(keysym_name)
        if not kc:
            return False
        with self.lock:
            if down:
                self._ensure_focus()
            xtest.fake_input(self.d, X.KeyPress if down else X.KeyRelease, kc)
            self.d.flush()
            (self.down_keys.add if down else self.down_keys.discard)(kc)
            self.events += 1
        return True

    def pointer(self, buttons, nx, ny):
        x, y = int(nx * (self.w - 1)), int(ny * (self.h - 1))
        with self.lock:
            xtest.fake_input(self.d, X.MotionNotify, x=x, y=y)
            for bit, xb in ((1, 1), (2, 3), (4, 2)):  # DOM buttons bitmask → X buttons (left, right, middle)
                was, now = self.buttons & bit, buttons & bit
                if was != now:
                    xtest.fake_input(self.d, X.ButtonPress if now else X.ButtonRelease, xb)
            self.buttons = buttons
            self.d.flush()
            self.events += 1

    def wheel(self, steps):
        """Wheel notches: X button 4 (up) / 5 (down), one click per notch, bounded per message."""
        xb = 5 if steps > 0 else 4
        with self.lock:
            for _ in range(min(abs(steps), 8)):
                xtest.fake_input(self.d, X.ButtonPress, xb)
                xtest.fake_input(self.d, X.ButtonRelease, xb)
            self.d.flush()
            self.events += 1

    def handle(self, data):
        """Decode one data-channel message. Malformed or unknown input is dropped silently."""
        if isinstance(data, str):
            if len(data) < 3 or data[0] != 'k' or data[1] not in '01':
                return
            ks = CODE_TO_KEYSYM.get(data[2:])
            if ks:
                self.key(ks, data[1] == '1')
            return
        if not data:
            return
        t = data[0]
        if t == 3 and len(data) >= 3 and data[1] < len(BTN_NAMES):
            name = BTN_NAMES[data[1]]
            ks = self.pad.get(name) or self.pad.get(LOGICAL_ALIAS.get(name, ''))
            if ks:
                self.key(ks, bool(data[2]))
        elif t == 5 and len(data) >= 3:
            mask = (data[1] << 8) | data[2]
            if len(data) >= 7:   # sticks → 8 virtual direction buttons (bits 16..23)
                lx, ly, rx, ry = struct.unpack('>bbbb', bytes(data[3:7]))
                for bit, on in enumerate((ly < -64, ly > 64, lx < -64, lx > 64, ry < -64, ry > 64, rx < -64, rx > 64)):
                    if on:
                        mask |= 1 << (16 + bit)
            changed, self.mask = mask ^ self.mask, mask
            for i, name in enumerate(FULL_PAD + STICKS):
                if changed & (1 << i) and self.pad.get(name):
                    self.key(self.pad[name], bool(mask & (1 << i)))
        elif t == 2 and len(data) >= 6:
            buttons, x, y = struct.unpack('>BHH', bytes(data[1:6]))
            self.pointer(buttons, x / 65535, y / 65535)
        elif t == 4 and len(data) >= 2:
            steps = struct.unpack('>b', bytes(data[1:2]))[0]
            if steps:
                self.wheel(steps)

    def release_all(self):
        with self.lock:
            for kc in list(self.down_keys):
                xtest.fake_input(self.d, X.KeyRelease, kc)
            self.down_keys.clear()
            self.mask = 0
            self.d.flush()

    def windows(self):
        """Top-level window titles (for status/health checks)."""
        out = []
        with self.lock:
            try:
                for w in self.root.query_tree().children:
                    attrs = w.get_attributes()
                    if attrs.map_state != X.IsViewable:
                        continue
                    name = w.get_wm_name()
                    if name:
                        out.append(name if isinstance(name, str) else name.decode('utf-8', 'replace'))
            except Exception:
                pass
        return out

    def close(self):
        try:
            self.release_all()
            self.d.close()
        except Exception:
            pass
