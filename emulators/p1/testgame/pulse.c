/* Saffron Pulse — original PS1 test program for Mishrin P1 (MIT-0). No SDK, no BIOS calls:
 * talks to the GPU, controller port and memory card through hardware registers, so it runs
 * identically on the open HLE BIOS and on a user-supplied BIOS.
 *   D-pad: move the saffron square (16 px per press)   Cross: score +1 (gold bar)
 *   Start: save x/y/score to memory card sector 1023     Boot: restore from the card if present (green marker)
 *   PS1 Mouse on port 1: the square follows mouse movement; left button scores (gold bar) */
typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8;
#define R32(a) (*(volatile u32 *)(a))
#define R16(a) (*(volatile u16 *)(a))
#define R8(a)  (*(volatile u8 *)(a))
#define GP0 R32(0x1F801810)
#define GP1 R32(0x1F801814)
#define I_STAT R32(0x1F801070)
#define I_MASK R32(0x1F801074)
#define JOY_DATA R8(0x1F801040)
#define JOY_STAT R32(0x1F801044)
#define JOY_MODE R16(0x1F801048)
#define JOY_CTRL R16(0x1F80104A)
#define JOY_BAUD R16(0x1F80104E)

static void delay(int n) { for (volatile int i = 0; i < n; i++); }
static void gpu_wait(void) { while (!(GP1 & (1u << 26))); }
static void fill(int x, int y, int w, int h, u32 bgr) {
  gpu_wait(); GP0 = 0x02000000 | bgr; GP0 = ((u32)y << 16) | (u32)x; GP0 = ((u32)h << 16) | (u32)w;
}
static void vsync(void) { while (!(I_STAT & 1)); I_STAT = ~1u; }

static int xfer(u8 b) {
  int t = 4000;
  while (!(JOY_STAT & 1) && --t);
  JOY_DATA = b;
  t = 4000;
  while (!(JOY_STAT & 2) && --t);
  if (!t) return -1;
  int r = JOY_DATA;
  delay(80); /* inter-byte ACK spacing */
  return r;
}
static void sel(int on) { JOY_CTRL = on ? 0x1003 : 0; delay(on ? 300 : 100); }

static int mdx, mdy, is_mouse; /* PS1 Mouse (device ID 0x12): signed X/Y movement since the last poll */
static u16 read_pad(void) {
  sel(1);
  xfer(0x01); int id = xfer(0x42); xfer(0);
  int lo = xfer(0), hi = xfer(0);
  mdx = mdy = 0; is_mouse = (id == 0x12);
  if (is_mouse) { mdx = (signed char)xfer(0); mdy = (signed char)xfer(0); }
  sel(0);
  if (lo < 0 || hi < 0) return 0;
  return (u16)~(lo | (hi << 8));
}

typedef struct { u32 magic; int x, y, score; u32 saves; } save_t;
#define MAGIC 0x5248534Du /* "MSHR" */
static u8 sector[128];

static int card_write(int lba) {
  u8 chk = (u8)(lba >> 8) ^ (u8)lba;
  for (int i = 0; i < 128; i++) chk ^= sector[i];
  sel(1);
  xfer(0x81); xfer('W'); xfer(0); xfer(0);
  xfer(lba >> 8); xfer(lba & 0xff);
  for (int i = 0; i < 128; i++) xfer(sector[i]);
  xfer(chk);
  int a = xfer(0), b = xfer(0), e = xfer(0);
  sel(0);
  return a == 0x5C && b == 0x5D && e == 'G';
}
static int card_read(int lba) {
  sel(1);
  xfer(0x81); xfer('R'); xfer(0); xfer(0);
  xfer(lba >> 8); xfer(lba & 0xff);
  xfer(0); xfer(0); xfer(0); xfer(0); /* ack, ack, echoed address */
  for (int i = 0; i < 128; i++) sector[i] = (u8)xfer(0);
  xfer(0); int e = xfer(0);
  sel(0);
  return e == 'G';
}

int main(void) {
  I_MASK = 0; I_STAT = 0;
  GP1 = 0x00000000;                         /* reset GPU */
  GP1 = 0x08000001;                         /* 320x240, NTSC, 15-bit */
  GP1 = 0x05000000;                         /* display start 0,0 */
  GP1 = 0x06000000 | 0x260 | (0xC60 << 12); /* horizontal range */
  GP1 = 0x07000000 | 16 | (256 << 10);      /* vertical range */
  GP1 = 0x03000000;                         /* display on */
  gpu_wait(); GP0 = 0xE1000400;             /* draw mode: drawing to display area allowed */
  JOY_MODE = 0x000D; JOY_BAUD = 0x0088; JOY_CTRL = 0;

  int x = 144, y = 96, score = 0, loaded = 0; u32 saves = 0, frame = 0;
  save_t *s = (save_t *)sector;
  if (card_read(1023) && s->magic == MAGIC && s->x >= 0 && s->x <= 288 && s->y >= 0 && s->y <= 208) {
    x = s->x; y = s->y; score = s->score; saves = s->saves; loaded = 1;
  }
  u16 prev = 0;
  for (;;) {
    vsync();
    u16 b = read_pad(), pressed = b & ~prev; prev = b;
    if (pressed & 0x0010) y -= 16;          /* up */
    if (pressed & 0x0040) y += 16;          /* down */
    if (pressed & 0x0080) x -= 16;          /* left */
    if (pressed & 0x0020) x += 16;          /* right */
    if (is_mouse) {                          /* mouse: move with the pointer, left button scores */
      x += mdx; y += mdy;
      if (pressed & 0x0800) score++;
    } else if (pressed & 0x4000) score++;   /* cross */
    if (x < 0) x = 0; if (x > 288) x = 288; if (y < 0) y = 0; if (y > 208) y = 208;
    if (pressed & 0x0008) {                 /* start: save to memory card */
      saves++;
      s->magic = MAGIC; s->x = x; s->y = y; s->score = score; s->saves = saves;
      for (int i = sizeof(save_t); i < 128; i++) sector[i] = 0;
      card_write(1023);
    }
    fill(0, 0, 320, 240, 0x100508);                          /* background */
    fill(x, y, 32, 32, 0x008AFF);                            /* saffron square */
    if (score) fill(16, 224, (score % 18) * 16 + 16, 8, 0x37AFD4); /* gold score bar */
    if (loaded) fill(0, 0, 16, 16, 0x00FF00);                /* restored-from-card marker */
    fill(304, 0, 16, 16, (frame & 32) ? 0xFFFFFF : 0x404040); /* heartbeat (proves frames advance) */
    frame++;
  }
}
