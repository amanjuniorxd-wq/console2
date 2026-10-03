/*
 * Mishrin P1 host — a minimal libretro frontend compiled *into* the WebAssembly core module.
 * It turns PCSX-ReARMed (GPLv2, see emulators/p1/LICENSE-NOTICE.md) into a flat ABI the Mishrin
 * Emulator API worker can drive. No Emscripten runtime: the only imports are WASI calls, which the
 * worker implements over the user's local File objects (read-only) — nothing is uploaded.
 *
 *   p1_init() → p1_set_option(k,v)* → p1_load(path) → [p1_set_port_device(port, 1|2)]
 *   → loop { p1_set_input(port,mask) | p1_add_mouse(port,dx,dy,buttons); p1_run(); read fb + audio }
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libretro.h"

#define EXPORT(n) __attribute__((export_name(#n)))
#define MAX_W 1024
#define MAX_H 512
#ifndef RETRO_ENVIRONMENT_SET_SAVE_STATE_DISABLE_UNDO
#define RETRO_ENVIRONMENT_SET_SAVE_STATE_DISABLE_UNDO 0x800005 /* core-private extension */
#endif
#define AUDIO_MAX 8192 /* stereo frames per run; a PS1 frame produces ~735 */
#define MAX_OPTS 160

static uint32_t fb[MAX_W * MAX_H];
static int fb_w, fb_h, fb_dirty;
static int16_t audio[AUDIO_MAX * 2];
static int audio_frames;
static enum retro_pixel_format pixfmt = RETRO_PIXEL_FORMAT_RGB565;
static uint16_t pad[2];
static int16_t analog[2][4];
static int mouse_dx[2], mouse_dy[2], mouse_btn[2]; /* PS1 Mouse peripheral: deltas accumulate between frames */
static struct { char key[64]; char val[64]; } opts[MAX_OPTS];
static int nopts, opts_dirty;
static char last_msg[256];
static struct retro_system_av_info av;

/* ---------- options: defaults come from the core, overrides from the console ---------- */
static int opt_find(const char *k) { for (int i = 0; i < nopts; i++) if (!strcmp(opts[i].key, k)) return i; return -1; }
static void opt_set(const char *k, const char *v, int override) {
  int i = opt_find(k);
  if (i < 0) { if (nopts >= MAX_OPTS) return; i = nopts++; snprintf(opts[i].key, sizeof opts[i].key, "%s", k); }
  else if (!override) return;
  snprintf(opts[i].val, sizeof opts[i].val, "%s", v ? v : "");
}

static void core_log(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_WARN) return;
  va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap);
}

static bool env(unsigned cmd, void *data) {
  switch (cmd) {
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: ((struct retro_log_callback *)data)->log = core_log; return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
      enum retro_pixel_format f = *(enum retro_pixel_format *)data;
      if (f != RETRO_PIXEL_FORMAT_RGB565 && f != RETRO_PIXEL_FORMAT_XRGB8888) return false;
      pixfmt = f; return true;
    }
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: *(const char **)data = "/bios"; return true;   /* user-supplied BIOS only */
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: *(const char **)data = "/save"; return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION: *(unsigned *)data = 2; return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: {
      const struct retro_core_options_v2 *o = data;
      if (o && o->definitions) for (const struct retro_core_option_v2_definition *d = o->definitions; d->key; d++) opt_set(d->key, d->default_value, 0);
      return true;
    }
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: {
      const struct retro_core_options_v2_intl *o = data;
      return o && o->us ? env(RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2, o->us) : false;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *v = data; int i = opt_find(v->key);
      v->value = i >= 0 ? opts[i].val : NULL; return i >= 0;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: *(bool *)data = opts_dirty; opts_dirty = 0; return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS: return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE: *(bool *)data = true; return true;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: av = *(const struct retro_system_av_info *)data; return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY: av.geometry = *(const struct retro_game_geometry *)data; return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE: snprintf(last_msg, sizeof last_msg, "%s", ((const struct retro_message *)data)->msg); return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE_EXT: snprintf(last_msg, sizeof last_msg, "%s", ((const struct retro_message_ext *)data)->msg); return true;
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS: case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL: case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY: case RETRO_ENVIRONMENT_SET_SAVE_STATE_DISABLE_UNDO:
      return true;
    default: return false; /* no VFS, no rumble, no disk-control UI, no network */
  }
}

/* ---------- video: convert to RGBA8 once per presented frame ---------- */
static void video(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (!data || w == 0 || h == 0) return; /* dupe: keep last frame */
  if (w > MAX_W) w = MAX_W; if (h > MAX_H) h = MAX_H;
  fb_w = w; fb_h = h; fb_dirty = 1;
  if (pixfmt == RETRO_PIXEL_FORMAT_XRGB8888) {
    for (unsigned y = 0; y < h; y++) {
      const uint32_t *s = (const uint32_t *)((const uint8_t *)data + y * pitch); uint32_t *d = fb + y * w;
      for (unsigned x = 0; x < w; x++) { uint32_t p = s[x]; d[x] = 0xff000000u | ((p & 0xff) << 16) | (p & 0xff00) | ((p >> 16) & 0xff); }
    }
  } else {
    for (unsigned y = 0; y < h; y++) {
      const uint16_t *s = (const uint16_t *)((const uint8_t *)data + y * pitch); uint32_t *d = fb + y * w;
      for (unsigned x = 0; x < w; x++) {
        uint16_t p = s[x]; uint32_t r = (p >> 11) & 31, g = (p >> 5) & 63, b = p & 31;
        d[x] = 0xff000000u | (((b << 3) | (b >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((r << 3) | (r >> 2));
      }
    }
  }
}

static size_t audio_batch(const int16_t *data, size_t frames) {
  size_t room = AUDIO_MAX - audio_frames; if (frames > room) frames = room;
  memcpy(audio + audio_frames * 2, data, frames * 4); audio_frames += frames; return frames;
}
static void audio_sample(int16_t l, int16_t r) { int16_t s[2] = {l, r}; audio_batch(s, 1); }
static void input_poll(void) {}
static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port > 1) return 0;
  if (device == RETRO_DEVICE_JOYPAD) return id == RETRO_DEVICE_ID_JOYPAD_MASK ? pad[port] : (pad[port] >> id) & 1;
  if (device == RETRO_DEVICE_ANALOG && index < 2 && id < 2) return analog[port][index * 2 + id];
  if (device == RETRO_DEVICE_MOUSE) {
    int clamp = 0;
    switch (id) {
      case RETRO_DEVICE_ID_MOUSE_X: clamp = mouse_dx[port]; break;
      case RETRO_DEVICE_ID_MOUSE_Y: clamp = mouse_dy[port]; break;
      case RETRO_DEVICE_ID_MOUSE_LEFT: return (mouse_btn[port] & 1) != 0;
      case RETRO_DEVICE_ID_MOUSE_RIGHT: return (mouse_btn[port] & 2) != 0;
      default: return 0;
    }
    return (int16_t)(clamp > 127 ? 127 : clamp < -128 ? -128 : clamp);
  }
  return 0;
}

/* ---------- exported ABI (Mishrin Emulator API, P1 backend) ---------- */
EXPORT(p1_init) int p1_init(void) {
  retro_set_environment(env); retro_set_video_refresh(video); retro_set_audio_sample(audio_sample);
  retro_set_audio_sample_batch(audio_batch); retro_set_input_poll(input_poll); retro_set_input_state(input_state);
  retro_init(); return retro_api_version();
}
EXPORT(p1_buf) void *p1_buf(int n) { return malloc(n > 0 ? n : 1); }
EXPORT(p1_free) void p1_free(void *p) { free(p); }
EXPORT(p1_set_option) void p1_set_option(const char *k, const char *v) { opt_set(k, v, 1); opts_dirty = 1; }
EXPORT(p1_load) int p1_load(const char *path) {
  struct retro_game_info gi = { .path = path };
  if (!retro_load_game(&gi)) return 0;
  retro_get_system_av_info(&av);
  for (int p = 0; p < 2; p++) retro_set_controller_port_device(p, RETRO_DEVICE_JOYPAD);
  return 1;
}
EXPORT(p1_run) int p1_run(void) {
  audio_frames = 0; fb_dirty = 0; retro_run();
  for (int p = 0; p < 2; p++) mouse_dx[p] = mouse_dy[p] = 0; /* deltas consumed by this frame */
  return fb_dirty;
}
/* Port devices: 1 = digital pad (RETRO_DEVICE_JOYPAD), 2 = PS1 Mouse (RETRO_DEVICE_SUBCLASS(MOUSE, 0)). */
EXPORT(p1_set_port_device) void p1_set_port_device(int port, int kind) {
  if (port < 0 || port > 1) return;
  retro_set_controller_port_device(port, kind == 2 ? RETRO_DEVICE_SUBCLASS(RETRO_DEVICE_MOUSE, 0) : RETRO_DEVICE_JOYPAD);
}
EXPORT(p1_add_mouse) void p1_add_mouse(int port, int dx, int dy, int buttons) {
  if (port < 0 || port > 1) return;
  mouse_dx[port] += dx; mouse_dy[port] += dy; mouse_btn[port] = buttons;
}
EXPORT(p1_reset) void p1_reset(void) { retro_reset(); }
EXPORT(p1_unload) void p1_unload(void) { retro_unload_game(); }
EXPORT(p1_set_input) void p1_set_input(int port, int mask) { if (port >= 0 && port < 2) pad[port] = (uint16_t)mask; }
EXPORT(p1_set_analog) void p1_set_analog(int port, int stick, int x, int y) { if (port >= 0 && port < 2 && stick >= 0 && stick < 2) { analog[port][stick * 2] = x; analog[port][stick * 2 + 1] = y; } }
EXPORT(p1_fb) void *p1_fb(void) { return fb; }
EXPORT(p1_fb_w) int p1_fb_w(void) { return fb_w; }
EXPORT(p1_fb_h) int p1_fb_h(void) { return fb_h; }
EXPORT(p1_audio) void *p1_audio(void) { return audio; }
EXPORT(p1_audio_frames) int p1_audio_frames(void) { return audio_frames; }
EXPORT(p1_fps_x1000) int p1_fps_x1000(void) { return (int)(av.timing.fps * 1000 + 0.5); }
EXPORT(p1_sample_rate) int p1_sample_rate(void) { return (int)(av.timing.sample_rate + 0.5); }
EXPORT(p1_aspect_x1000) int p1_aspect_x1000(void) { return (int)(av.geometry.aspect_ratio * 1000 + 0.5); }
EXPORT(p1_state_size) int p1_state_size(void) { return (int)retro_serialize_size(); }
EXPORT(p1_state_save) int p1_state_save(void *p, int n) { return retro_serialize(p, n); }
EXPORT(p1_state_load) int p1_state_load(const void *p, int n) { return retro_unserialize(p, n); }
EXPORT(p1_sram) void *p1_sram(void) { return retro_get_memory_data(RETRO_MEMORY_SAVE_RAM); }
EXPORT(p1_sram_size) int p1_sram_size(void) { return (int)retro_get_memory_size(RETRO_MEMORY_SAVE_RAM); }
EXPORT(p1_message) const char *p1_message(void) { return last_msg; }
EXPORT(p1_option) const char *p1_option(const char *k) { int i = opt_find(k); return i >= 0 ? opts[i].val : ""; }
