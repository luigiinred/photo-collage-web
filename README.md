# Collage Maker

A free, single-page web app for making print-ready photo collages. Everything runs in your browser — photos are never uploaded anywhere.

**Live site:** https://luigiinred.github.io/photo-collage-web/

## Flow

1. **Pick a print size** — 4×6, 6×4, 5×7, 7×5, 8×10, 10×8, 8×8, 11×14, 14×11, 16×20, 20×16, or any custom size.
2. **Choose a layout** — 15 premade layouts that adapt to the size.
3. **Add photos** — pick from your photo library or drag them in; they auto-fill the layout.
4. **Adjust** — drag photos to reposition, scroll or pinch to zoom, drag the gaps to resize cells, swap cells with the grip handle, split or delete cells, add text boxes with fonts and a full color picker.
5. **Download** — PNG or JPEG up to 1200 DPI (limited by your browser's canvas size). The DPI is embedded in the file so print shops get the right physical size.

Collages are saved automatically in your browser (IndexedDB) so you can come back to **My collages**, reopen them, and download again.

## Development

No build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Notes

- Saved collages live in your browser's storage; clearing site data deletes them. Download the final image to keep it.
- iOS Safari limits canvas size to about 16 MP, so very large exports are reduced automatically on iPhone and iPad.
