# tmíxʷ app icon — F3 "Reflection" (gold on night)

Mark: rooted-mirror cedar, root plane faded — gold #d4af37 on night #0f0c14→#1a1622.

## Contents
- `macos/` — PNGs on the Apple icon grid (824px squircle centered in 1024 canvas, 22.5% radius): 16, 32, 64, 128, 256, 512, 1024
- `windows/` — full-bleed 12%-rounded tiles: 16, 24, 32, 48, 64, 128, 256
- `icon-macos.svg` / `icon-windows.svg` — master vector sources

## Build .icns (macOS)
```
mkdir icon.iconset
cp macos/icon_16x16.png   icon.iconset/icon_16x16.png
cp macos/icon_32x32.png   icon.iconset/icon_16x16@2x.png
cp macos/icon_32x32.png   icon.iconset/icon_32x32.png
cp macos/icon_64x64.png   icon.iconset/icon_32x32@2x.png
cp macos/icon_128x128.png icon.iconset/icon_128x128.png
cp macos/icon_256x256.png icon.iconset/icon_128x128@2x.png
cp macos/icon_256x256.png icon.iconset/icon_256x256.png
cp macos/icon_512x512.png icon.iconset/icon_256x256@2x.png
cp macos/icon_512x512.png icon.iconset/icon_512x512.png
cp macos/icon_1024x1024.png icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o icon.icns
```

## Build .ico (Windows)
```
npx png-to-ico windows/icon_256x256.png windows/icon_128x128.png windows/icon_64x64.png windows/icon_48x48.png windows/icon_32x32.png windows/icon_24x24.png windows/icon_16x16.png > icon.ico
```

## Electron (electron-builder)
```
"mac": { "icon": "build/icon.icns" },
"win": { "icon": "build/icon.ico" }
```
