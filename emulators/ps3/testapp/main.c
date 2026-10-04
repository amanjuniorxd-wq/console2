/* MISHRIN PS3-class TEST PROGRAM — original homebrew written from scratch for automated emulator tests. It contains no
 * code or data from any console vendor and uses only the public LV2 calling conventions of the system libraries
 * (cellGcmSys, cellSysutil, sys_io, sys_fs, cellAudio), which the emulator provides (HLE) or loads from the user's own
 * firmware (LLE). Every frame it draws with RSX clear commands (scissored clears — no shaders needed):
 *   a box moved by the D-pad in the colour read from GAME.DAT on the game disc, 16 button indicators,
 *   two analog-stick markers, a score bar (cross), a frame counter, and status squares (disc data / save loaded / saved).
 * START writes the state to the user's save-data area (/dev_hdd0/home/00000001/savedata/MSHR00001-SAVE); restored on the next boot.
 * Sound: a 750 Hz square wave through cellAudio. */
#include <stdint.h>

typedef uint32_t u32; typedef int32_t s32; typedef uint16_t u16; typedef uint8_t u8; typedef uint64_t u64;
#define P(x) ((u32)(uintptr_t)(x))

typedef struct { u32 begin, end, current, callback; } GcmContext;
typedef struct { u32 localAddress, ioAddress, localSize, ioSize, memoryFrequency, coreFrequency; } GcmConfig;
typedef struct { u32 put, get, ref; } GcmControl;
typedef struct { s32 len; u16 button[64]; } PadData;
typedef struct { u8 resolutionId, format, aspect, reserved[9]; u32 pitch; } VideoOutConfig;
typedef struct { u64 nChannel, nBlock, attr; float level; } AudioPortParam;
typedef struct { u32 readIndexAddr, status; u64 nChannel, nBlock; u32 portSize, portAddr; } AudioPortConfig;

s32 _cellGcmInitBody(u32 ctx_pp, u32 cmdSize, u32 ioSize, u32 ioAddress);
s32 cellGcmGetConfiguration(u32 cfg);
s32 cellGcmAddressToOffset(u32 addr, u32 offset_p);
s32 cellGcmSetDisplayBuffer(u32 id, u32 offset, u32 pitch, u32 width, u32 height);
u32 cellGcmGetControlRegister(void);
void cellGcmSetFlipMode(u32 mode);
u32 cellGcmGetFlipStatus(void);
void cellGcmResetFlipStatus(void);
s32 cellGcmSetFlip(u32 ctx, u32 id);
s32 cellVideoOutConfigure(u32 out, u32 cfg, u32 opt, u32 wait);
s32 cellSysutilCheckCallback(void);
s32 cellPadInit(u32 max);
s32 cellPadGetData(u32 port, u32 data);
s32 cellFsOpen(u32 path, s32 flags, u32 fd_p, u32 arg, u64 size);
s32 cellFsRead(s32 fd, u32 buf, u64 n, u32 nread_p);
s32 cellFsWrite(s32 fd, u32 buf, u64 n, u32 nwrite_p);
s32 cellFsClose(s32 fd);
s32 cellFsMkdir(u32 path, s32 mode);
s32 cellAudioInit(void);
s32 cellAudioPortOpen(u32 param, u32 port_p);
s32 cellAudioPortStart(u32 port);
s32 cellAudioGetPortConfig(u32 port, u32 cfg);
void lv2_usleep(u64 us);

#define W 1280
#define H 720
#define PITCH (W * 4)
#define CELL_FS_O_RDONLY 0
#define CELL_FS_O_WRONLY 1
#define CELL_FS_O_CREAT 0x40
#define CELL_FS_O_TRUNC 0x200

static u8 iomem[0x100000] __attribute__((aligned(0x100000)));   /* RSX-visible main memory (command buffer) */
static u32 ctx_p;
static GcmConfig cfg;
static u32 fb_off[2], zb_off;
static volatile GcmControl *ctrl;
static PadData pad;
static u16 btn1, btn2, prev2, prev1;
static u8 ax[4] = {128, 128, 128, 128};               /* RX RY LX LY */
static s32 box_x = 592, box_y = 280, score;
static u32 colour = 0xFF808080, disc_state, load_state, save_state, frame;
static AudioPortConfig acfg;
static u32 aport;

static inline GcmContext *ctx(void) { return (GcmContext *)(uintptr_t)ctx_p; }
static inline void cmd(u32 method, u32 v) {
  u32 *c = (u32 *)(uintptr_t)ctx()->current;
  c[0] = (1u << 18) | method; c[1] = v;
  ctx()->current += 8;
}
static void rect(s32 x, s32 y, s32 w, s32 h, u32 argb) {
  if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
  if (w <= 0 || h <= 0) return;
  cmd(0x8c0, ((u32)w << 16) | (u32)x);       /* SCISSOR_HORIZONTAL */
  cmd(0x8c4, ((u32)h << 16) | (u32)y);       /* SCISSOR_VERTICAL */
  cmd(0x1d90, argb);                         /* COLOR_CLEAR_VALUE */
  cmd(0x1d94, 0xF0);                         /* CLEAR_SURFACE: R G B A */
}
static u32 offset_of(u32 addr) { u32 o = 0; cellGcmAddressToOffset(addr, P(&o)); return o; }

static void cpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; }

static void load_disc(void) {
  static u8 buf[64]; s32 fd; u64 n = 0;
  disc_state = 2;
  if (cellFsOpen(P("/dev_bdvd/PS3_GAME/USRDIR/GAME.DAT"), CELL_FS_O_RDONLY, P(&fd), 0, 0) != 0) return;
  if (cellFsRead(fd, P(buf), 48, P(&n)) == 0 && n >= 12 && buf[0] == 'M' && buf[1] == 'S' && buf[2] == 'H' && buf[3] == 'R' && buf[4] == 'G' && buf[7] == 'E') {
    colour = 0xFF000000u | ((u32)buf[8] << 16) | ((u32)buf[9] << 8) | buf[10];   /* R G B */
    disc_state = 1;
  }
  cellFsClose(fd);
}

static const char SAVE_DIR1[] = "/dev_hdd0/home/00000001/savedata", SAVE_DIR2[] = "/dev_hdd0/home/00000001/savedata/MSHR00001-SAVE",
                  SAVE[] = "/dev_hdd0/home/00000001/savedata/MSHR00001-SAVE/SAVE.DAT";
static void load_save(void) {
  static s32 d[4]; s32 fd; u64 n = 0;
  load_state = 2;
  if (cellFsOpen(P(SAVE), CELL_FS_O_RDONLY, P(&fd), 0, 0) != 0) return;
  if (cellFsRead(fd, P(d), 16, P(&n)) == 0 && n == 16 && d[0] == 0x4D534833) { box_x = d[1]; box_y = d[2]; score = d[3]; load_state = 1; }
  cellFsClose(fd);
}
static void write_save(void) {
  static s32 d[4]; s32 fd; u64 n = 0;
  d[0] = 0x4D534833; d[1] = box_x; d[2] = box_y; d[3] = score;     /* 'MSH3' */
  cellFsMkdir(P(SAVE_DIR1), 0777); cellFsMkdir(P(SAVE_DIR2), 0777);
  save_state = 1;
  if (cellFsOpen(P(SAVE), CELL_FS_O_WRONLY | CELL_FS_O_CREAT | CELL_FS_O_TRUNC, P(&fd), 0, 0) != 0) return;
  if (cellFsWrite(fd, P(d), 16, P(&n)) == 0 && n == 16) save_state = 2;
  cellFsClose(fd);
}

static void audio_init(void) {
  static AudioPortParam pp;
  if (cellAudioInit() != 0) return;
  pp.nChannel = 2; pp.nBlock = 8; pp.attr = 0; pp.level = 1.0f;
  if (cellAudioPortOpen(P(&pp), P(&aport)) != 0) return;
  cellAudioGetPortConfig(aport, P(&acfg));
  cellAudioPortStart(aport);
}
static void audio_fill(void) {               /* keep the blocks ahead of the reader filled: 750 Hz square wave */
  if (!acfg.portAddr) return;
  u64 idx = *(volatile u64 *)(uintptr_t)acfg.readIndexAddr;
  float *base = (float *)(uintptr_t)acfg.portAddr;
  for (u32 k = 1; k <= 4; k++) {
    float *b = base + ((idx + k) % 8) * 512;
    for (u32 i = 0; i < 256; i++) { float v = (i & 32) ? -0.25f : 0.25f; b[2 * i] = v; b[2 * i + 1] = v; }
  }
}

static void pad_read(void) {
  pad.len = 0;
  if (cellPadGetData(0, P(&pad)) == 0 && pad.len >= 8) {   /* len 0 = unchanged since the last call */
    btn1 = pad.button[2]; btn2 = pad.button[3];
    for (int i = 0; i < 4; i++) ax[i] = (u8)pad.button[4 + i];
  }
}

/* console full-pad order (up down left right cross circle square triangle l1 r1 l2 r2 select start l3 r3) → bit */
static const u8 order_word[16] = {1,1,1,1, 2,2,2,2, 2,2,2,2, 1,1,1,1};
static const u16 order_bit[16] = {0x10,0x40,0x80,0x20, 0x40,0x20,0x80,0x10, 0x04,0x08,0x01,0x02, 0x01,0x08,0x02,0x04};

static void draw(u32 id) {
  GcmContext *c = ctx();
  if (c->current - c->begin > 0x8000) {                     /* wrap: wait until the RSX is idle, jump to the start */
    while (ctrl->get != ctrl->put) lv2_usleep(200);
    *(u32 *)(uintptr_t)c->current = 0x20000000u | offset_of(c->begin);
    c->current = c->begin;
  }
  cmd(0x194, 0xFEED0000); cmd(0x198, 0xFEED0000);           /* context DMA: colour, zeta in local memory */
  cmd(0x208, 0x00000148);                                   /* SURFACE_FORMAT: A8R8G8B8, Z24S8, pitch layout */
  cmd(0x20c, PITCH); cmd(0x22c, PITCH);
  cmd(0x210, fb_off[id]); cmd(0x214, zb_off);
  cmd(0x220, 1);                                            /* colour target A */
  cmd(0x200, (W << 16)); cmd(0x204, (H << 16));             /* surface clip */
  cmd(0x2b8, 0);                                            /* window offset */
  cmd(0x324, 0x01010101);                                   /* colour mask */
  rect(0, 0, W, H, 0xFF100810);                             /* background */
  rect(box_x, box_y, 96, 96, colour);                       /* the box, in the disc's colour */
  for (int i = 0; i < 16; i++) {
    u16 w = order_word[i] == 1 ? btn1 : btn2;
    rect(80 * i + 8, 640, 64, 48, (w & order_bit[i]) ? 0xFF00FF00 : 0xFF303030);
  }
  rect(128 + ax[2] / 4, 500 + ax[3] / 4, 24, 24, 0xFFFFFFFF);  /* left stick */
  rect(928 + ax[0] / 4, 500 + ax[1] / 4, 24, 24, 0xFFC060FF);  /* right stick */
  rect(16, 16, 16 * score + 1, 24, 0xFFD4AF37);              /* score bar */
  rect(128 + (frame & 511), 0, 12, 12, 0xFFFFFFFF);          /* frame counter */
  rect(1120, 16, 32, 32, disc_state == 1 ? 0xFF00FF00 : 0xFFFF0000);
  rect(1168, 16, 32, 32, load_state == 1 ? 0xFF00FF00 : load_state == 2 ? 0xFF0000FF : 0xFFFF0000);
  rect(1216, 16, 32, 32, save_state == 2 ? 0xFF00FF00 : save_state == 1 ? 0xFFFF0000 : 0xFF303030);
  cellGcmSetFlip(ctx_p, id);
  __asm__ volatile("sync" ::: "memory");
  ctrl->put = offset_of(c->current);
}

int main(void) {
  static VideoOutConfig vc;
  vc.resolutionId = 2; vc.format = 0; vc.aspect = 0; vc.pitch = PITCH;    /* 1280x720, X8R8G8B8 */
  cellVideoOutConfigure(0, P(&vc), 0, 0);
  _cellGcmInitBody(P(&ctx_p), 0x10000, sizeof iomem, P(iomem));
  cellGcmGetConfiguration(P(&cfg));
  ctrl = (volatile GcmControl *)(uintptr_t)cellGcmGetControlRegister();
  fb_off[0] = offset_of(cfg.localAddress);
  fb_off[1] = offset_of(cfg.localAddress + PITCH * H);
  zb_off = offset_of(cfg.localAddress + 2 * PITCH * H);
  cellGcmSetDisplayBuffer(0, fb_off[0], PITCH, W, H);
  cellGcmSetDisplayBuffer(1, fb_off[1], PITCH, W, H);
  cellGcmSetFlipMode(2);                                     /* vsync */
  cellPadInit(1);
  audio_init();
  load_disc();
  load_save();
  u32 id = 0;
  for (;;) {
    cellSysutilCheckCallback();
    pad_read();
    if (btn1 & 0x10) box_y -= 6;
    if (btn1 & 0x40) box_y += 6;
    if (btn1 & 0x80) box_x -= 6;
    if (btn1 & 0x20) box_x += 6;
    if (box_x < 0) box_x = 0; if (box_x > W - 96) box_x = W - 96;
    if (box_y < 48) box_y = 48; if (box_y > 520) box_y = 520;
    if ((btn2 & 0x40) && !(prev2 & 0x40)) score++;
    if ((btn1 & 0x08) && !(prev1 & 0x08)) write_save();
    prev1 = btn1; prev2 = btn2;
    audio_fill();
    cellGcmResetFlipStatus();
    draw(id);
    for (int t = 0; cellGcmGetFlipStatus() != 0 && t < 100; t++) lv2_usleep(1000);
    id ^= 1; frame++;
  }
  return 0;
}
