/*
 * Mishrin compatibility test game — original, built with MinGW for the controlled compatibility targets:
 *   GDI   (simple Win32)      -DRENDER_GDI     → wintest64.exe / wintest32.exe
 *   D3D11 (DXVK → Vulkan)     -DRENDER_D3D11   → d3d11test64.exe
 *   D3D9  (DXVK → Vulkan)     -DRENDER_D3D9    → d3d9test32.exe
 * Arrow keys move the saffron box, Enter/Space scores; left click moves the box to the cursor, right click scores. Progress is saved to %APPDATA%\MishrinTest\save.txt
 * and restored on start. The window title exposes state so automated tests can observe the game:
 *   "MISHRIN-TEST <api> x=<x> y=<y> score=<n> loaded=<0|1> bits=<32|64> gpu=<adapter>"
 * F12 deliberately crashes (used only to test crash recovery).
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#ifdef RENDER_D3D11
#include <initguid.h>
#include <d3d11_1.h>
#include <dxgi.h>
#endif
#ifdef RENDER_D3D9
#include <d3d9.h>
#endif

#define W 640
#define H 360
static int px = 300, py = 160, score = 0, loaded = 0;
static char api[16], gpu[128] = "none";
static char savePath[MAX_PATH];
static HWND hwnd;

static void save_game(void) {
  FILE *f = fopen(savePath, "w");
  if (f) { fprintf(f, "%d %d %d\n", px, py, score); fclose(f); }
}
static void load_game(void) {
  char dir[MAX_PATH];
  if (SHGetFolderPathA(NULL, CSIDL_APPDATA | CSIDL_FLAG_CREATE, NULL, 0, dir) != S_OK) strcpy(dir, ".");
  strcat(dir, "\\MishrinTest");
  CreateDirectoryA(dir, NULL);
  snprintf(savePath, sizeof savePath, "%s\\save.txt", dir);
  FILE *f = fopen(savePath, "r");
  if (f) { if (fscanf(f, "%d %d %d", &px, &py, &score) == 3) loaded = 1; fclose(f); }
}
static void update_title(void) {
  char t[256];
  snprintf(t, sizeof t, "MISHRIN-TEST %s x=%d y=%d score=%d loaded=%d bits=%d gpu=%s", api, px, py, score, loaded, (int)(sizeof(void *) * 8), gpu);
  SetWindowTextA(hwnd, t);
}

#ifdef RENDER_D3D11
static ID3D11Device *dev; static ID3D11DeviceContext *ctx; static ID3D11DeviceContext1 *ctx1;
static IDXGISwapChain *sc; static ID3D11RenderTargetView *rtv;
static int gfx_init(void) {
  DXGI_SWAP_CHAIN_DESC d = {0};
  d.BufferCount = 2; d.BufferDesc.Width = W; d.BufferDesc.Height = H; d.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  d.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; d.OutputWindow = hwnd; d.SampleDesc.Count = 1; d.Windowed = TRUE;
  d.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
  if (FAILED(D3D11CreateDeviceAndSwapChain(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, &fl, 1, D3D11_SDK_VERSION, &d, &sc, &dev, NULL, &ctx))) return 0;
  if (FAILED(ID3D11DeviceContext_QueryInterface(ctx, &IID_ID3D11DeviceContext1, (void **)&ctx1))) return 0;
  ID3D11Texture2D *bb; IDXGISwapChain_GetBuffer(sc, 0, &IID_ID3D11Texture2D, (void **)&bb);
  ID3D11Device_CreateRenderTargetView(dev, (ID3D11Resource *)bb, NULL, &rtv); ID3D11Texture2D_Release(bb);
  IDXGIDevice *xd; IDXGIAdapter *ad; DXGI_ADAPTER_DESC ds;
  if (SUCCEEDED(ID3D11Device_QueryInterface(dev, &IID_IDXGIDevice, (void **)&xd)) && SUCCEEDED(IDXGIDevice_GetAdapter(xd, &ad)) && SUCCEEDED(IDXGIAdapter_GetDesc(ad, &ds)))
    WideCharToMultiByte(CP_UTF8, 0, ds.Description, -1, gpu, sizeof gpu, NULL, NULL);
  for (char *c = gpu; *c; c++) if (*c == ' ') *c = '_';
  return 1;
}
static void gfx_frame(void) {
  float bg[4] = {0.02f, 0.01f, 0.05f, 1}, fg[4] = {1.0f, 0.54f, 0.0f, 1}, gold[4] = {0.83f, 0.69f, 0.22f, 1};
  ID3D11DeviceContext1_ClearView(ctx1, (ID3D11View *)rtv, bg, NULL, 0);
  D3D11_RECT r = {px, py, px + 40, py + 40}; ID3D11DeviceContext1_ClearView(ctx1, (ID3D11View *)rtv, fg, &r, 1);
  D3D11_RECT s = {10, 10, 10 + (score % 60) * 10, 20}; if (score) ID3D11DeviceContext1_ClearView(ctx1, (ID3D11View *)rtv, gold, &s, 1);
  IDXGISwapChain_Present(sc, 1, 0);
}
#elif defined(RENDER_D3D9)
static IDirect3DDevice9 *dev;
static int gfx_init(void) {
  IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION); if (!d3d) return 0;
  D3DADAPTER_IDENTIFIER9 id; if (SUCCEEDED(IDirect3D9_GetAdapterIdentifier(d3d, 0, 0, &id))) { strncpy(gpu, id.Description, sizeof gpu - 1); for (char *c = gpu; *c; c++) if (*c == ' ') *c = '_'; }
  D3DPRESENT_PARAMETERS pp = {0}; pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.BackBufferWidth = W; pp.BackBufferHeight = H;
  pp.BackBufferFormat = D3DFMT_X8R8G8B8; pp.hDeviceWindow = hwnd; pp.PresentationInterval = D3DPRESENT_INTERVAL_ONE;
  return SUCCEEDED(IDirect3D9_CreateDevice(d3d, 0, D3DDEVTYPE_HAL, hwnd, D3DCREATE_HARDWARE_VERTEXPROCESSING, &pp, &dev));
}
static void gfx_frame(void) {
  IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET, D3DCOLOR_XRGB(5, 3, 13), 1, 0);
  D3DRECT r = {px, py, px + 40, py + 40}; IDirect3DDevice9_Clear(dev, 1, &r, D3DCLEAR_TARGET, D3DCOLOR_XRGB(255, 138, 0), 1, 0);
  if (score) { D3DRECT s = {10, 10, 10 + (score % 60) * 10, 20}; IDirect3DDevice9_Clear(dev, 1, &s, D3DCLEAR_TARGET, D3DCOLOR_XRGB(212, 175, 55), 1, 0); }
  IDirect3DDevice9_Present(dev, NULL, NULL, NULL, NULL);
}
#else
static int gfx_init(void) { return 1; }
static void gfx_frame(void) {
  HDC dc = GetDC(hwnd);
  HBRUSH bg = CreateSolidBrush(RGB(5, 3, 13)), fg = CreateSolidBrush(RGB(255, 138, 0)), gd = CreateSolidBrush(RGB(212, 175, 55));
  RECT a = {0, 0, W, H}; FillRect(dc, &a, bg);
  RECT r = {px, py, px + 40, py + 40}; FillRect(dc, &r, fg);
  if (score) { RECT s = {10, 10, 10 + (score % 60) * 10, 20}; FillRect(dc, &s, gd); }
  DeleteObject(bg); DeleteObject(fg); DeleteObject(gd); ReleaseDC(hwnd, dc);
  Sleep(16);
}
#endif

static LRESULT CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_KEYDOWN) {
    int moved = 1;
    switch (w) {
      case VK_LEFT: px -= 20; break; case VK_RIGHT: px += 20; break;
      case VK_UP: py -= 20; break; case VK_DOWN: py += 20; break;
      case VK_RETURN: case VK_SPACE: score++; break;
      case VK_F12: *(volatile int *)0 = 0; break; /* deliberate crash for recovery tests */
      default: moved = 0;
    }
    if (px < 0) px = 0; if (py < 0) py = 0; if (px > W - 40) px = W - 40; if (py > H - 40) py = H - 40;
    if (moved) { save_game(); update_title(); }
    return 0;
  }
  if (m == WM_LBUTTONDOWN || m == WM_RBUTTONDOWN) { /* mouse: left click moves the box to the cursor, right click scores */
    if (m == WM_LBUTTONDOWN) { px = (short)LOWORD(l) - 20; py = (short)HIWORD(l) - 20; } else score++;
    if (px < 0) px = 0; if (py < 0) py = 0; if (px > W - 40) px = W - 40; if (py > H - 40) py = H - 40;
    save_game(); update_title();
    return 0;
  }
  if (m == WM_MOUSEWHEEL) { /* wheel: each notch towards the user moves the box down 10 px */
    py -= GET_WHEEL_DELTA_WPARAM(w) / WHEEL_DELTA * 10;
    if (py < 0) py = 0; if (py > H - 40) py = H - 40;
    save_game(); update_title();
    return 0;
  }
  if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(h, m, w, l);
}

int WINAPI WinMain(HINSTANCE hi, HINSTANCE hp, LPSTR cmd, int show) {
  (void)hp; (void)cmd;
#ifdef RENDER_D3D11
  strcpy(api, "d3d11");
#elif defined(RENDER_D3D9)
  strcpy(api, "d3d9");
#else
  strcpy(api, "gdi");
#endif
  load_game();
  WNDCLASSA wc = {0}; wc.lpfnWndProc = proc; wc.hInstance = hi; wc.lpszClassName = "MishrinTest"; wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  RegisterClassA(&wc);
  RECT r = {0, 0, W, H}; AdjustWindowRect(&r, WS_POPUP, FALSE);
  hwnd = CreateWindowA("MishrinTest", "MISHRIN-TEST", WS_POPUP | WS_VISIBLE, 0, 0, r.right - r.left, r.bottom - r.top, NULL, NULL, hi, NULL);
  if (!gfx_init()) { MessageBoxA(NULL, "Graphics init failed", "Mishrin Test", MB_OK); return 2; }
  update_title(); ShowWindow(hwnd, show); SetForegroundWindow(hwnd); SetFocus(hwnd);
  MSG msg;
  for (;;) {
    while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) { if (msg.message == WM_QUIT) return 0; TranslateMessage(&msg); DispatchMessageA(&msg); }
    gfx_frame();
  }
}
