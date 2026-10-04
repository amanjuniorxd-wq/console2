/* MISHRIN PSP TEST PROGRAM — original homebrew written from scratch for automated emulator tests. No vendor code or
 * data; it calls the public PSP system library functions by NID (sceDisplay, sceCtrl, IoFileMgrForUser, sceAudio,
 * ThreadManForUser), which the emulator provides. Every frame it draws straight into VRAM (480x272, 32-bit):
 *   a box moved by the D-pad in the colour read from GAME.DAT (disc0:/PSP_GAME/USRDIR or next to EBOOT.PBP),
 *   12 button indicators, an analog-stick marker, a score bar (cross), a frame counter and status squares
 *   (game data loaded / save loaded / saved). START saves to ms0:/PSP/SAVEDATA/MSHR00001/SAVE.DAT.
 * Sound: a 750 Hz square wave on its own audio thread. */
typedef unsigned int u32; typedef int s32; typedef unsigned short u16; typedef unsigned char u8;

typedef struct { u32 TimeStamp, Buttons; u8 Lx, Ly, Rsrv[6]; } SceCtrlData;
s32 sceDisplaySetMode(s32 mode, s32 w, s32 h);
s32 sceDisplaySetFrameBuf(void *top, s32 stride, s32 fmt, s32 sync);
s32 sceDisplayWaitVblankStart(void);
s32 sceCtrlSetSamplingCycle(s32 c);
s32 sceCtrlSetSamplingMode(s32 m);
s32 sceCtrlReadBufferPositive(SceCtrlData *d, s32 n);
s32 sceIoOpen(const char *p, s32 flags, s32 mode);
s32 sceIoRead(s32 fd, void *b, u32 n);
s32 sceIoWrite(s32 fd, const void *b, u32 n);
s32 sceIoClose(s32 fd);
s32 sceIoMkdir(const char *p, s32 mode);
s32 sceAudioChReserve(s32 ch, s32 samples, s32 fmt);
s32 sceAudioOutputPannedBlocking(s32 ch, s32 l, s32 r, void *buf);
s32 create_thread(const char *name, s32 (*fn)(u32, void *), s32 prio, s32 stack);   /* start.S: EABI wrapper */
s32 sceKernelStartThread(s32 th, u32 len, void *argp);
s32 sceKernelDelayThread(u32 us);

#define W 480
#define H 272
#define STRIDE 512
#define VRAM ((u32 *)0x44000000)
#define O_RDONLY 1
#define O_WRONLY 2
#define O_CREAT 0x200
#define O_TRUNC 0x400

static u32 colour = 0xFF808080, disc_state, load_state, save_state, frame;
static s32 bx = 224, by = 120, score;
static SceCtrlData pad;
static short wave[1024 * 2];
static char game_dir[128];

static void rect(u32 *fb, s32 x, s32 y, s32 w, s32 h, u32 c) {
  if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
  if (x + w > W) w = W - x; if (y + h > H) h = H - y;
  for (s32 j = 0; j < h; j++) { u32 *p = fb + (y + j) * STRIDE + x; for (s32 i = 0; i < w; i++) p[i] = c; }
}
static u32 abgr(u8 r, u8 g, u8 b) { return 0xFF000000u | ((u32)b << 16) | ((u32)g << 8) | r; }

static void load_game_data(void) {
  static u8 b[64];
  s32 fd = sceIoOpen("disc0:/PSP_GAME/USRDIR/GAME.DAT", O_RDONLY, 0);
  if (fd < 0 && game_dir[0]) {
    char p[160]; int n = 0;
    for (const char *s = game_dir; *s && n < 140; ) p[n++] = *s++;
    const char *t = "/GAME.DAT"; while (*t) p[n++] = *t++;
    p[n] = 0;
    fd = sceIoOpen(p, O_RDONLY, 0);
  }
  disc_state = 2;
  if (fd < 0) return;
  if (sceIoRead(fd, b, 48) >= 12 && b[0] == 'M' && b[1] == 'S' && b[2] == 'H' && b[3] == 'R' && b[4] == 'G' && b[7] == 'E') {
    colour = abgr(b[8], b[9], b[10]); disc_state = 1;
  }
  sceIoClose(fd);
}

#define SAVE "ms0:/PSP/SAVEDATA/MSHR00001/SAVE.DAT"
static void load_save(void) {
  static s32 d[4];
  load_state = 2;
  s32 fd = sceIoOpen(SAVE, O_RDONLY, 0);
  if (fd < 0) return;
  if (sceIoRead(fd, d, 16) == 16 && d[0] == 0x50485350) { bx = d[1]; by = d[2]; score = d[3]; load_state = 1; }
  sceIoClose(fd);
}
static void write_save(void) {
  static s32 d[4];
  d[0] = 0x50485350; d[1] = bx; d[2] = by; d[3] = score;          /* 'PSHP' */
  sceIoMkdir("ms0:/PSP", 0777); sceIoMkdir("ms0:/PSP/SAVEDATA", 0777); sceIoMkdir("ms0:/PSP/SAVEDATA/MSHR00001", 0777);
  save_state = 1;
  s32 fd = sceIoOpen(SAVE, O_WRONLY | O_CREAT | O_TRUNC, 0777);
  if (fd < 0) return;
  if (sceIoWrite(fd, d, 16) == 16) save_state = 2;
  sceIoClose(fd);
}

static s32 audio_thread(u32 len, void *argp) {
  (void)len; (void)argp;
  for (int i = 0; i < 1024; i++) { short v = (i & 32) ? -8000 : 8000; wave[2 * i] = v; wave[2 * i + 1] = v; }
  s32 ch = sceAudioChReserve(-1, 1024, 0);
  if (ch < 0) return 0;
  for (;;) sceAudioOutputPannedBlocking(ch, 0x8000, 0x8000, wave);
  return 0;
}

/* console order: up down left right cross circle square triangle L R select start */
static const u32 order[12] = {0x10, 0x40, 0x80, 0x20, 0x4000, 0x2000, 0x8000, 0x1000, 0x100, 0x200, 0x1, 0x8};

int main(u32 args, char *argp) {
  if (args && argp) {                                 /* argv[0] = path of the EBOOT: its directory holds GAME.DAT */
    int n = 0, slash = -1;
    for (; argp[n] && n < 127; n++) { game_dir[n] = argp[n]; if (argp[n] == '/') slash = n; }
    game_dir[slash > 0 ? slash : 0] = 0;
  }
  sceDisplaySetMode(0, W, H);
  sceCtrlSetSamplingCycle(0);
  sceCtrlSetSamplingMode(1);                          /* analog */
  load_game_data();
  load_save();
  s32 th = create_thread("audio", audio_thread, 0x12, 0x4000);
  if (th >= 0) sceKernelStartThread(th, 0, 0);
  u32 prev = 0, buf = 0;
  for (;;) {
    sceCtrlReadBufferPositive(&pad, 1);
    u32 b = pad.Buttons;
    if (b & 0x10) by -= 2;
    if (b & 0x40) by += 2;
    if (b & 0x80) bx -= 2;
    if (b & 0x20) bx += 2;
    if (bx < 0) bx = 0; if (bx > W - 32) bx = W - 32;
    if (by < 24) by = 24; if (by > 168) by = 168;
    if ((b & 0x4000) && !(prev & 0x4000)) score++;
    if ((b & 0x8) && !(prev & 0x8)) write_save();
    prev = b;
    u32 *fb = VRAM + buf * STRIDE * H;
    rect(fb, 0, 0, W, H, abgr(0x10, 0x08, 0x10));
    rect(fb, bx, by, 32, 32, colour);
    for (int i = 0; i < 12; i++) rect(fb, 40 * i + 2, 240, 36, 24, (b & order[i]) ? abgr(0, 255, 0) : abgr(0x30, 0x30, 0x30));
    rect(fb, 40 + pad.Lx / 8, 180 + pad.Ly / 8, 12, 12, abgr(255, 255, 255));
    rect(fb, 8, 8, 6 * score + 1, 8, abgr(0xD4, 0xAF, 0x37));
    rect(fb, 80 + (frame & 255), 0, 4, 4, abgr(255, 255, 255));
    rect(fb, 400, 6, 16, 16, disc_state == 1 ? abgr(0, 255, 0) : abgr(255, 0, 0));
    rect(fb, 424, 6, 16, 16, load_state == 1 ? abgr(0, 255, 0) : load_state == 2 ? abgr(0, 0, 255) : abgr(255, 0, 0));
    rect(fb, 448, 6, 16, 16, save_state == 2 ? abgr(0, 255, 0) : save_state == 1 ? abgr(255, 0, 0) : abgr(0x30, 0x30, 0x30));
    sceDisplayWaitVblankStart();
    sceDisplaySetFrameBuf(fb, STRIDE, 3, 1);
    buf ^= 1; frame++;
  }
  return 0;
}
