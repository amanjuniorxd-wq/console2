"""WebRTC streaming of one session's display + audio with GStreamer webrtcbin (answerer to the console's offer).

Codec choice = best encoder this worker has, restricted to what the browser offered:
hardware H.264 / AV1 / VP9 first (NVENC, VA, VA-API, QSV, V4L2), then software (x264, OpenH264, VP8, VP9, SVT-AV1).
Audio is always Opus. Input/control arrive on the console-created data channels (`input`, `ctl`).
Live controls: bitrate, resolution and frame rate (driven by the console's AIMD loop), NACK/RTX + keyframes on loss.
"""
import re
import threading
import time

import gi

gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstSdp, GstWebRTC  # noqa: E402

Gst.init(None)

# encoder: (codec, hardware?, launch template, bitrate property, bitrate unit multiplier from kbps)
ENCODERS = {
    'nvh264enc':    ('H264', True,  'nvh264enc name=venc preset=low-latency-hq rc-mode=cbr zerolatency=true bitrate={kbps} gop-size={gop} ! h264parse config-interval=-1', 'bitrate', 1),
    'vah264lpenc':  ('H264', True,  'vah264lpenc name=venc rate-control=cbr bitrate={kbps} key-int-max={gop} b-frames=0 ! h264parse config-interval=-1', 'bitrate', 1),
    'vah264enc':    ('H264', True,  'vah264enc name=venc rate-control=cbr bitrate={kbps} key-int-max={gop} b-frames=0 ! h264parse config-interval=-1', 'bitrate', 1),
    'vaapih264enc': ('H264', True,  'vaapih264enc name=venc rate-control=cbr bitrate={kbps} keyframe-period={gop} ! h264parse config-interval=-1', 'bitrate', 1),
    'qsvh264enc':   ('H264', True,  'qsvh264enc name=venc rate-control=cbr low-latency=true bitrate={kbps} gop-size={gop} ! h264parse config-interval=-1', 'bitrate', 1),
    'v4l2h264enc':  ('H264', True,  'v4l2h264enc name=venc ! h264parse config-interval=-1', None, 1),
    'nvav1enc':     ('AV1',  True,  'nvav1enc name=venc bitrate={kbps} ! av1parse', 'bitrate', 1),
    'vaav1enc':     ('AV1',  True,  'vaav1enc name=venc bitrate={kbps} ! av1parse', 'bitrate', 1),
    'vavp9enc':     ('VP9',  True,  'vavp9enc name=venc bitrate={kbps}', 'bitrate', 1),
    'x264enc':      ('H264', False, 'x264enc name=venc tune=zerolatency speed-preset=ultrafast bitrate={kbps} key-int-max={gop} bframes=0 sliced-threads=true threads=2 ! video/x-h264,profile=constrained-baseline ! h264parse config-interval=-1', 'bitrate', 1),
    'openh264enc':  ('H264', False, 'openh264enc name=venc rate-control=bitrate complexity=low bitrate={bps} gop-size={gop} ! video/x-h264,profile=constrained-baseline ! h264parse config-interval=-1', 'bitrate', 1000),
    'vp8enc':       ('VP8',  False, 'vp8enc name=venc deadline=1 cpu-used=16 end-usage=cbr target-bitrate={bps} keyframe-max-dist={gop} lag-in-frames=0 error-resilient=partitions threads=2 buffer-size=300 buffer-initial-size=150 buffer-optimal-size=200', 'target-bitrate', 1000),
    'vp9enc':       ('VP9',  False, 'vp9enc name=venc deadline=1 cpu-used=8 end-usage=cbr target-bitrate={bps} keyframe-max-dist={gop} lag-in-frames=0 row-mt=true threads=2', 'target-bitrate', 1000),
    'svtav1enc':    ('AV1',  False, 'svtav1enc name=venc preset=12 target-bitrate={kbps} intra-period-length={gop} ! av1parse', 'target-bitrate', 1),
}
PAYLOADERS = {'H264': 'rtph264pay config-interval=-1 aggregate-mode=zero-latency', 'VP8': 'rtpvp8pay picture-id-mode=15-bit',
              'VP9': 'rtpvp9pay picture-id-mode=15-bit', 'AV1': 'rtpav1pay'}
PREFERENCE = ['nvh264enc', 'vah264lpenc', 'vah264enc', 'vaapih264enc', 'qsvh264enc', 'v4l2h264enc', 'nvav1enc', 'vaav1enc',
              'vavp9enc', 'x264enc', 'openh264enc', 'vp8enc', 'vp9enc', 'svtav1enc']

_usable = None


def usable_encoders():
    """Encoders that exist AND initialise on this machine (hardware plugins can exist without a device)."""
    global _usable
    if _usable is not None:
        return _usable
    out = []
    for name in PREFERENCE:
        codec = ENCODERS[name][0]
        pay = PAYLOADERS[codec].split()[0]
        if not Gst.ElementFactory.find(name) or not Gst.ElementFactory.find(pay):
            continue
        el = Gst.ElementFactory.make(name, None)
        if el is None:
            continue
        ok = el.set_state(Gst.State.READY) != Gst.StateChangeReturn.FAILURE
        el.set_state(Gst.State.NULL)
        if ok:
            out.append(name)
    _usable = out
    return out


def parse_offer(sdp):
    """{'video': [{'pt', 'codec', 'fmtp'}], 'audio': [...]} from the offer's m-sections."""
    media, cur = {'video': [], 'audio': []}, None
    fmtp = {}
    for line in sdp.splitlines():
        if line.startswith('m='):
            kind = line[2:].split()[0]
            cur = media.get(kind)
        elif cur is not None and line.startswith('a=rtpmap:'):
            m = re.match(r'a=rtpmap:(\d+) ([\w-]+)/(\d+)', line)
            if m:
                cur.append({'pt': int(m.group(1)), 'codec': m.group(2).upper(), 'fmtp': ''})
        elif cur is not None and line.startswith('a=fmtp:'):
            m = re.match(r'a=fmtp:(\d+) (.*)', line)
            if m:
                fmtp[int(m.group(1))] = m.group(2)
    for lst in media.values():
        for c in lst:
            c['fmtp'] = fmtp.get(c['pt'], '')
    return media


def choose_video(offer_video, encoders):
    for enc in encoders:
        codec = ENCODERS[enc][0]
        cands = [c for c in offer_video if c['codec'] == codec]
        if codec == 'H264':  # browsers decode constrained-baseline, packetization-mode=1 everywhere
            cands = [c for c in cands if 'packetization-mode=1' in c['fmtp']]
            cands.sort(key=lambda c: (0 if 'profile-level-id=42e01f' in c['fmtp'] else 1 if 'profile-level-id=42' in c['fmtp'] else 2))
        if cands:
            return enc, codec, cands[0]
    return None


class Stream:
    def __init__(self, display_num, screen_wh, offer_sdp, prefs, ice_servers, pulse_sock, on_input, on_ctl, on_state, log=print):
        self.log = log
        self.on_input, self.on_ctl, self.on_state = on_input, on_ctl, on_state
        self.screen_w, self.screen_h = screen_wh
        offer = parse_offer(offer_sdp)
        pick = choose_video(offer['video'], usable_encoders())
        if not pick:
            raise RuntimeError('no common video codec between this worker and the browser')
        self.encoder, self.codec, vc = pick
        self.hw = ENCODERS[self.encoder][1]
        opus = next((c for c in offer['audio'] if c['codec'] == 'OPUS'), None)
        self.fps = max(10, min(int(prefs.get('fps') or 60), 60))
        self.kbps = max(500, min(int(prefs.get('kbps') or 6000), 50000))
        self.height = self._fit_height(int(prefs.get('height') or self.screen_h))
        tmpl, self.br_prop, self.br_mul = ENCODERS[self.encoder][2], ENCODERS[self.encoder][3], ENCODERS[self.encoder][4]
        enc = tmpl.format(kbps=self.kbps, bps=self.kbps * 1000, gop=self.fps * 2)
        w, h = self._wh(self.height)
        video = (f'ximagesrc display-name=:{display_num} use-damage=false show-pointer=true ! video/x-raw,framerate={self.fps}/1 '
                 f'! queue max-size-buffers=1 leaky=downstream ! videoconvert n-threads=2 ! videoscale ! videorate drop-only=true '
                 f'! capsfilter name=vcaps caps=video/x-raw,format=I420,width={w},height={h},framerate={self.fps}/1 '
                 f'! {enc} ! {PAYLOADERS[self.codec]} pt={vc["pt"]} '
                 f'! capsfilter name=vrtp caps=application/x-rtp,media=video,encoding-name={self.codec},payload={vc["pt"]},clock-rate=90000 ! webrtc. ')
        if pulse_sock:
            asrc = f'pulsesrc server=unix:{pulse_sock} device=game.monitor do-timestamp=true buffer-time=40000 latency-time=10000 provide-clock=false'
        else:
            asrc = 'audiotestsrc is-live=true wave=silence'
        audio = ''
        if opus:
            audio = (f'{asrc} ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 '
                     f'! opusenc bitrate=96000 frame-size=10 inband-fec=true ! rtpopuspay pt={opus["pt"]} '
                     f'! capsfilter name=artp caps=application/x-rtp,media=audio,encoding-name=OPUS,payload={opus["pt"]},clock-rate=48000 ! webrtc. ')
        self.audio = bool(opus)
        self.pipe = Gst.parse_launch(f'webrtcbin name=webrtc bundle-policy=max-bundle latency=0 {video}{audio}')
        self.webrtc = self.pipe.get_by_name('webrtc')
        self.venc = self.pipe.get_by_name('venc')
        self.vcaps = self.pipe.get_by_name('vcaps')
        for s in ice_servers or []:
            for url in ([s.get('urls')] if isinstance(s.get('urls'), str) else s.get('urls') or []):
                if url.startswith('stun:'):
                    self.webrtc.set_property('stun-server', 'stun://' + url[5:])
                elif url.startswith(('turn:', 'turns:')) and s.get('username'):
                    scheme, rest = url.split(':', 1)
                    self.webrtc.emit('add-turn-server', f'{scheme}://{s["username"]}:{s.get("credential", "")}@{rest}')
        self.frames = 0
        self._fps_t, self._fps_n, self.measured_fps = time.time(), 0, 0
        self.venc.get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, self._count)
        self.webrtc.connect('on-data-channel', self._on_dc)
        self.webrtc.connect('notify::connection-state', self._on_conn)
        self.channels = {}
        self.ctl_queue = []
        self._stop = threading.Event()
        threading.Thread(target=self._bus_loop, daemon=True).start()
        self.pipe.set_state(Gst.State.PLAYING)
        self.answer = self._negotiate(offer_sdp)

    # ---------- negotiation (non-trickle, matching the console) ----------
    def _wait_rtp_caps(self, timeout=6.0):
        """The answer must carry each stream's real SSRC/msid, which webrtcbin takes from the negotiated RTP caps.
        Answering before the first encoded frame yields 'ssrc 0' and the browser cannot bind the track."""
        names = ['vrtp'] + (['artp'] if self.audio else [])
        deadline = time.time() + timeout
        while time.time() < deadline:
            caps = [self.pipe.get_by_name(n).get_static_pad('src').get_current_caps() for n in names]
            if all(c is not None and c.get_structure(0).has_field('ssrc') for c in caps):
                return True
            time.sleep(0.02)
        self.log('warning: RTP caps not ready before answer')
        return False

    def _negotiate(self, offer_sdp):
        self._wait_rtp_caps()
        ok, msg = GstSdp.SDPMessage.new_from_text(offer_sdp)
        if ok != GstSdp.SDPResult.OK:
            raise RuntimeError('invalid SDP offer')
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, msg)
        p = Gst.Promise.new()
        self.webrtc.emit('set-remote-description', offer, p)
        p.wait()
        r = p.get_reply()
        if r is not None and r.has_field('error'):
            raise RuntimeError(f'offer rejected: {r.get_value("error")}'[:300])
        for i in range(8):
            t = self.webrtc.emit('get-transceiver', i)
            if t is None:
                break
            t.set_property('direction', GstWebRTC.WebRTCRTPTransceiverDirection.SENDONLY)
            t.set_property('do-nack', True)  # retransmission on loss
        p = Gst.Promise.new()
        self.webrtc.emit('create-answer', None, p)
        p.wait()
        reply = p.get_reply()
        answer = reply.get_value('answer') if reply else None
        if answer is None:
            raise RuntimeError(f'WebRTC negotiation failed: {reply.to_string() if reply else "no reply"}'[:300])
        p = Gst.Promise.new()
        self.webrtc.emit('set-local-description', answer, p)
        p.wait()
        deadline = time.time() + 4
        while time.time() < deadline and self.webrtc.get_property('ice-gathering-state') != GstWebRTC.WebRTCICEGatheringState.COMPLETE:
            time.sleep(0.05)
        return self.webrtc.get_property('local-description').sdp.as_text()

    # ---------- data channels ----------
    def _on_dc(self, _webrtc, ch):
        label = ch.get_property('label')
        self.channels[label] = ch
        if label == 'input':
            ch.connect('on-message-data', lambda _c, b: self.on_input(b.get_data() if b else b''))
            ch.connect('on-message-string', lambda _c, s: self.on_input(s or ''))
        elif label == 'ctl':
            ch.connect('on-message-string', lambda _c, s: self.on_ctl(s or ''))
            ch.connect('on-open', lambda _c: self._flush_ctl())
            if ch.get_property('ready-state') == GstWebRTC.WebRTCDataChannelState.OPEN:
                self._flush_ctl()

    def send_ctl(self, text):
        ch = self.channels.get('ctl')
        if ch is not None and ch.get_property('ready-state') == GstWebRTC.WebRTCDataChannelState.OPEN:
            ch.emit('send-string', text)
        else:
            self.ctl_queue.append(text)

    def _flush_ctl(self):
        q, self.ctl_queue = self.ctl_queue, []
        for t in q:
            self.send_ctl(t)

    def _on_conn(self, *_):
        st = self.webrtc.get_property('connection-state').value_nick
        self.on_state(st)

    # ---------- live quality control ----------
    def _fit_height(self, h):
        return max(180, min(h, self.screen_h)) // 2 * 2

    def _wh(self, h):
        return max(2, round(h * self.screen_w / self.screen_h / 2) * 2), h

    def set_quality(self, height=None, fps=None, kbps=None):
        if kbps and self.br_prop:
            self.kbps = max(500, min(int(kbps), 50000))
            self.venc.set_property(self.br_prop, int(self.kbps * self.br_mul))
        changed = False
        if height and self._fit_height(int(height)) != self.height:
            self.height, changed = self._fit_height(int(height)), True
        if fps and max(10, min(int(fps), 60)) != self.fps:
            self.fps, changed = max(10, min(int(fps), 60)), True
        if changed:  # adaptive resolution / frame rate: renegotiates the encoder in place
            w, h = self._wh(self.height)
            self.vcaps.set_property('caps', Gst.Caps.from_string(f'video/x-raw,format=I420,width={w},height={h},framerate={self.fps}/1'))

    def _count(self, _pad, _info):
        self.frames += 1
        self._fps_n += 1
        now = time.time()
        if now - self._fps_t >= 1:
            self.measured_fps, self._fps_n, self._fps_t = round(self._fps_n / (now - self._fps_t)), 0, now
        return Gst.PadProbeReturn.OK

    def stats(self):
        w, h = self._wh(self.height)
        return {'codec': self.codec, 'encoder': self.encoder, 'hardwareEncoder': self.hw, 'fps': self.measured_fps,
                'targetFps': self.fps, 'kbps': self.kbps, 'width': w, 'height': h, 'framesEncoded': self.frames, 'audio': self.audio,
                'connection': self.webrtc.get_property('connection-state').value_nick}

    def _bus_loop(self):
        bus = self.pipe.get_bus()
        while not self._stop.is_set():
            m = bus.timed_pop_filtered(300 * Gst.MSECOND, Gst.MessageType.ERROR | Gst.MessageType.EOS)
            if m is None:
                continue
            if m.type == Gst.MessageType.ERROR:
                err, dbg = m.parse_error()
                self.log(f'stream error: {err.message}')
                self.on_state('failed')
            else:
                self.on_state('closed')

    def close(self):
        self._stop.set()
        try:
            self.pipe.set_state(Gst.State.NULL)
        except Exception:
            pass
