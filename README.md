# Inside youssefdb

An interactive site that shows how a NoSQL database works inside. It runs the real [youssefdb](https://www.npmjs.com/package/youssefdb) package in the browser and animates every step: your code, the documents in memory, the BSON bytes, and the files on disk.

## What you can see

- **The flow:** Your code → Memory → Encoder → Disk, played step by step with Back / Play / Next.
- **Memory:** each document as a tile; new, changed, deleted and returned documents are marked.
- **The `_id`:** every ObjectId split into its time, random and counter bytes.
- **Bytes:** the real BSON file, colour-coded into lengths, types, field names, values and end markers; point at any byte to see what it means.
- **Disk:** the `data/` folder, one file per collection, plus index files.
- **Nine lessons:** a document, the _id key, no fixed shape, how a value is saved, reading, updating, deleting, indexes, collections.

## How it works

`site/build.sh` bundles the published youssefdb (and its `bson` dependency) for the browser with esbuild. Browsers have no file system, so three small stand-ins are bundled with it:

- `site/shims/fs.js`: an in-memory disk that records every read, write, rename and delete, which drives the animation
- `site/shims/crypto.js`: SHA-1 and random bytes
- `path-browserify`

The page logic is in `site/app.js`, styles in `site/app.css`, markup in `site/body.html`. The build writes everything into one self-contained file, `docs/index.html`.

## Build

```bash
bash site/build.sh
```

Requires Node 18+. It installs the latest youssefdb from npm, so rebuild after each youssefdb release.

## Status

Live at https://youssefseyam212.github.io/inside-youssefdb/ (GitHub Pages, served from `docs/`). See `PROJECT_NOTES.md` for the full project notes and to-do list.
