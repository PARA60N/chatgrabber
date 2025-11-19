# SingleFile Saver (Chrome MV3)

Save a page as one self-contained HTML file for offline viewing. Images, stylesheets, fonts, icons, and most scripts are inlined.

## Install

1. Open Chrome → Extensions → Manage Extensions.
2. Enable Developer mode.
3. Click "Load unpacked" and select this folder: `D:\Projects\Programming\TheDecoyProject\App\chatgrabber`.

## Usage

- Open a page you want to save.
- Click the extension's toolbar icon.
- Choose where to save the generated `.html` file.

## Notes

- Some dynamic features (service workers, streaming media, WASM) may not work offline.
- Very large pages will produce large files and take time to save.
- Cross-origin resources are fetched by the background worker with credentials; some may fail silently.

## Files

- `manifest.json`: MV3 manifest
- `background.js`: privileged fetch and download
- `content.js`: DOM clone, inline, serialize
