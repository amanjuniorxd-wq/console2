/* EMBER DRIFT — original demo game for the MPC Framebuffer ABI v1.
 * Freestanding C, no libc, no imports: the module can only touch its own memory.
 *
 * ABI v1 exports:
 *   mpc_init(seed)            -> void
 *   mpc_width() / mpc_height()-> int
 *   mpc_frame(dt_ms)          -> ptr to RGBA8 framebuffer (w*h*4 bytes)
 *   mpc_input(button, down)   buttons: 0 up 1 down 2 left 3 right 4 A 5 B 6 start
 *   mpc_state_ptr() / mpc_state_size() -> contiguous save-state region
 */
#define W 320
#define H 180
#define MAXM 14
#define ORBS 3

typedef unsigned int u32;
typedef unsigned char u8;

typedef struct { float x, y, vx, vy, r; int live; } Body;

typedef struct {
  u32 rng;
  float px, py, pvx, pvy;
  int btn[7];
  int prevA;
  Body m[MAXM];
  Body o[ORBS];
  int score, best, lives, over, paused;
  float t, spawn, inv;
  float tx, ty; int pbtn; /* mouse: steer toward (tx,ty) while a button is held */
} State;

static State S;
static u32 fb[W * H];
static u32 bg[W * H];

static u32 rnd(void) { S.rng ^= S.rng << 13; S.rng ^= S.rng >> 17; S.rng ^= S.rng << 5; return S.rng; }
static float frand(void) { return (rnd() & 0xffffff) / 16777216.0f; }
static u32 rgb(int r, int g, int b) { return 0xff000000u | ((u32)b << 16) | ((u32)g << 8) | (u32)r; }

static void build_bg(void) {
  u32 seed = 0x9e3779b9u;
  for (int y = 0; y < H; y++) {
    float k = (float)y / H;
    u32 c = rgb((int)(10 + 30 * k), (int)(5 + 10 * k), (int)(8 + 4 * k));
    for (int x = 0; x < W; x++) bg[y * W + x] = c;
  }
  for (int i = 0; i < 140; i++) {
    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
    int x = seed % W, y = (seed >> 9) % H, v = 90 + (seed >> 20) % 140;
    bg[y * W + x] = rgb(v, v * 9 / 10, v * 7 / 10);
  }
}

static void disc(float cx, float cy, float r, u32 col) {
  int x0 = (int)(cx - r), x1 = (int)(cx + r) + 1, y0 = (int)(cy - r), y1 = (int)(cy + r) + 1;
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > W) x1 = W; if (y1 > H) y1 = H;
  float r2 = r * r;
  for (int y = y0; y < y1; y++)
    for (int x = x0; x < x1; x++) {
      float dx = x + 0.5f - cx, dy = y + 0.5f - cy;
      if (dx * dx + dy * dy <= r2) fb[y * W + x] = col;
    }
}

/* 3x5 font: digits + the letters we need */
static const char *GLYPHS = "0123456789ABCDEGIMNOPRSTV";
static const unsigned short FONT[] = {
  0x7B6F,0x2C97,0x73E7,0x72CF,0x5BC9,0x79CF,0x79EF,0x7292,0x7BEF,0x7BCF,0x2BED,0x6BAE,0x7927,0x6B6E,0x79A7,0x796F,0x7497,0x5FED,0x6B6D,0x7B6F,0x7BE4,0x6BAD,0x79CF,0x7492,0x5B6A
};
static void glyph(int gx, int gy, char ch, u32 col, int s) {
  int idx = -1;
  for (int i = 0; GLYPHS[i]; i++) if (GLYPHS[i] == ch) { idx = i; break; }
  if (idx < 0) return;
  unsigned short g = FONT[idx];
  for (int r = 0; r < 5; r++)
    for (int c = 0; c < 3; c++)
      if (g & (1 << (14 - (r * 3 + c))))
        for (int yy = 0; yy < s; yy++)
          for (int xx = 0; xx < s; xx++) {
            int X = gx + c * s + xx, Y = gy + r * s + yy;
            if (X >= 0 && X < W && Y >= 0 && Y < H) fb[Y * W + X] = col;
          }
}
static void text(int x, int y, const char *s, u32 col, int sc) { for (; *s; s++, x += 4 * sc) if (*s != ' ') glyph(x, y, *s, col, sc); }
static int textw(const char *s, int sc) { int n = 0; while (s[n]) n++; return n * 4 * sc - sc; }
static void num(int x, int y, int v, u32 col, int sc) {
  char b[12]; int n = 0;
  if (v == 0) b[n++] = '0';
  while (v > 0 && n < 11) { b[n++] = '0' + v % 10; v /= 10; }
  for (int i = n - 1; i >= 0; i--, x += 4 * sc) glyph(x, y, b[i], col, sc);
}

static void place_orb(Body *o) { o->x = 20 + frand() * (W - 40); o->y = 24 + frand() * (H - 44); o->r = 3.5f; o->live = 1; }

static void reset(void) {
  S.px = W / 2; S.py = H / 2; S.pvx = S.pvy = 0;
  for (int i = 0; i < MAXM; i++) S.m[i].live = 0;
  for (int i = 0; i < ORBS; i++) place_orb(&S.o[i]);
  S.score = 0; S.lives = 3; S.over = 0; S.t = 0; S.spawn = 0; S.inv = 1500;
}

__attribute__((export_name("mpc_init"))) void mpc_init(int seed) { S.rng = (u32)seed | 1u; S.best = 0; build_bg(); reset(); }
__attribute__((export_name("mpc_width"))) int mpc_width(void) { return W; }
__attribute__((export_name("mpc_height"))) int mpc_height(void) { return H; }
__attribute__((export_name("mpc_state_ptr"))) void *mpc_state_ptr(void) { return &S; }
__attribute__((export_name("mpc_state_size"))) int mpc_state_size(void) { return sizeof(State); }
__attribute__((export_name("mpc_input"))) void mpc_input(int b, int down) { if (b >= 0 && b < 7) S.btn[b] = down; }
/* Optional ABI v1 extension: pointer in framebuffer pixels + DOM buttons bitmask (1 = primary). */
__attribute__((export_name("mpc_pointer"))) void mpc_pointer(int x, int y, int buttons) { S.tx = (float)x; S.ty = (float)y; S.pbtn = buttons; }

static void spawn_meteor(void) {
  for (int i = 0; i < MAXM; i++) if (!S.m[i].live) {
    Body *m = &S.m[i];
    int edge = rnd() % 4;
    float sp = 0.02f + frand() * 0.03f + S.t * 0.0000006f;
    m->r = 4 + frand() * 7;
    if (edge == 0) { m->x = -m->r; m->y = frand() * H; m->vx = sp; m->vy = (frand() - .5f) * sp; }
    else if (edge == 1) { m->x = W + m->r; m->y = frand() * H; m->vx = -sp; m->vy = (frand() - .5f) * sp; }
    else if (edge == 2) { m->y = -m->r; m->x = frand() * W; m->vy = sp; m->vx = (frand() - .5f) * sp; }
    else { m->y = H + m->r; m->x = frand() * W; m->vy = -sp; m->vx = (frand() - .5f) * sp; }
    m->live = 1; return;
  }
}

static void step(float dt) {
  int a = S.btn[4] || S.btn[6] || (S.pbtn & 1);
  if (S.over) { if (a && !S.prevA) reset(); S.prevA = a; return; }
  S.prevA = a;
  float acc = 0.0009f;
  if (S.btn[0]) S.pvy -= acc * dt; if (S.btn[1]) S.pvy += acc * dt;
  if (S.btn[2]) S.pvx -= acc * dt; if (S.btn[3]) S.pvx += acc * dt;
  if (S.pbtn & 1) { /* mouse: thrust toward the cursor, proportional to distance (capped) */
    float dx = S.tx - S.px, dy = S.ty - S.py, d2 = dx * dx + dy * dy;
    if (d2 > 4) { float k = acc * dt / (d2 > 400 ? __builtin_sqrtf(d2) : 20.0f); S.pvx += dx * k; S.pvy += dy * k; }
  }
  float f = 1.0f - 0.0025f * dt; if (f < 0) f = 0;
  S.pvx *= f; S.pvy *= f;
  S.px += S.pvx * dt; S.py += S.pvy * dt;
  if (S.px < 5) { S.px = 5; S.pvx = -S.pvx * .5f; } if (S.px > W - 5) { S.px = W - 5; S.pvx = -S.pvx * .5f; }
  if (S.py < 14) { S.py = 14; S.pvy = -S.pvy * .5f; } if (S.py > H - 5) { S.py = H - 5; S.pvy = -S.pvy * .5f; }
  S.t += dt; S.spawn -= dt; if (S.inv > 0) S.inv -= dt;
  if (S.spawn <= 0) { spawn_meteor(); float iv = 900 - S.t * 0.01f; S.spawn = iv < 220 ? 220 : iv; }
  for (int i = 0; i < MAXM; i++) {
    Body *m = &S.m[i]; if (!m->live) continue;
    m->x += m->vx * dt; m->y += m->vy * dt;
    if (m->x < -20 || m->x > W + 20 || m->y < -20 || m->y > H + 20) { m->live = 0; continue; }
    float dx = m->x - S.px, dy = m->y - S.py, rr = m->r + 4;
    if (S.inv <= 0 && dx * dx + dy * dy < rr * rr) {
      m->live = 0; S.lives--; S.inv = 1500;
      if (S.lives <= 0) { S.over = 1; if (S.score > S.best) S.best = S.score; }
    }
  }
  for (int i = 0; i < ORBS; i++) {
    Body *o = &S.o[i]; float dx = o->x - S.px, dy = o->y - S.py, rr = o->r + 5;
    if (dx * dx + dy * dy < rr * rr) { S.score++; place_orb(o); }
  }
}

__attribute__((export_name("mpc_frame"))) void *mpc_frame(float dt) {
  if (dt > 50) dt = 50; if (dt < 0) dt = 0;
  step(dt);
  for (int i = 0; i < W * H; i++) fb[i] = bg[i];
  for (int i = 0; i < ORBS; i++) { disc(S.o[i].x, S.o[i].y, S.o[i].r + 2, rgb(90, 50, 0)); disc(S.o[i].x, S.o[i].y, S.o[i].r, rgb(255, 196, 64)); }
  for (int i = 0; i < MAXM; i++) if (S.m[i].live) { disc(S.m[i].x, S.m[i].y, S.m[i].r, rgb(70, 60, 64)); disc(S.m[i].x - 1, S.m[i].y - 1, S.m[i].r * .6f, rgb(110, 96, 100)); }
  if (!S.over && (S.inv <= 0 || ((int)(S.inv / 100)) % 2 == 0)) {
    disc(S.px - S.pvx * 40, S.py - S.pvy * 40, 3, rgb(255, 90, 0));
    disc(S.px, S.py, 5, rgb(255, 138, 0)); disc(S.px, S.py, 2.5f, rgb(255, 240, 210));
  }
  for (int x = 0; x < W; x++) for (int y = 0; y < 11; y++) fb[y * W + x] = rgb(8, 6, 6);
  text(4, 3, "SCORE", rgb(212, 175, 55), 1); num(26, 3, S.score, rgb(255, 255, 255), 1);
  text(W - 60, 3, "BEST", rgb(212, 175, 55), 1); num(W - 42, 3, S.best, rgb(255, 255, 255), 1);
  for (int i = 0; i < S.lives; i++) disc(W / 2 - 8 + i * 8, 5.5f, 2.5f, rgb(255, 138, 0));
  if (S.over) {
    text((W - textw("GAME OVER", 3)) / 2, 66, "GAME OVER", rgb(255, 138, 0), 3);
    text((W - textw("PRESS A", 1)) / 2, 96, "PRESS A", rgb(255, 255, 255), 1);
  }
  return fb;
}
