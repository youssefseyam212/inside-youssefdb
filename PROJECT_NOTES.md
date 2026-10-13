# youssefdb: project notes

Written so that anyone (including a new Claude conversation) can pick the project up without the chat history. Paste this file into a new chat to continue.

## Where everything is

| What | Where |
| --- | --- |
| Source code | https://github.com/youssefseyam212/youssefdb (branch `main`) |
| npm package | https://www.npmjs.com/package/youssefdb, version **2.0.0** (published October 2026) |
| CI | GitHub Actions `tests` workflow, runs `npm test` on Node 18, 20 and 22 |
| Learning site source | https://github.com/youssefseyam212/inside-youssefdb (`site/`) |
| Learning site build | `bash site/build.sh` writes `docs/index.html` |
| Brand | logo = three stacked documents with key/value fields; colours deep teal `#1D5C63`, fold teal `#4F9EA3`, amber `#F0A03C`, field light `#E9F2F1`, night `#0F1C1F`; wordmark JetBrains Mono Bold, lowercase, "db" in amber |

## The package (v2.0.0)

- A database is a folder (default `./data`). Each collection is `<name>.bson` holding `{ data: [ ...documents ] }`, the same layout as 1.x.
- Every call reads the whole file, works in memory, and for writes saves the whole file atomically (temp file, then rename).
- Indexes live in `<name>.index.bson`: `{ version: 1, sourceHash, fields, entries }`, positions into the data array. They are rebuilt on every write and whenever the SHA-1 of the collection file changes.
- Structure: `src/operations/` has one file per method; `src/query/` (compileQuery, compileUpdate), `src/indexes/`, `src/storage/` (bsonFile, CollectionStore), `src/utils/` (equals, types, validate), `src/errors.js`. The root `DB.js` only re-exports `src/` for 1.x compatibility.
- Methods: insertOne, insertMany (all or nothing), find, findOne (null if none), countDocuments, updateOne/updateMany (`$set` only, MongoDB-style counts), deleteOne/deleteMany (filter required, `{}` = all), createIndex, dropIndex, listIndexes, drop; `db.collection`, `db.listCollections`.
- Queries: AND of exact, type-strict matches on top-level fields; `null` matches missing; a single value matches array elements; `_id` accepts an ObjectId or its hex string. Operators, regex and dotted paths throw `UnsupportedOperationError`.
- Errors: `ValidationError`, `UnsupportedOperationError`, `DuplicateKeyError`, `CorruptFileError`, `IndexNotFoundError`, all extending `YoussefDBError`.
- Tests: 106, Node's built-in runner, including a 2,000-operation randomised test comparing indexed and unindexed collections.
- Known limits (documented): one writing process at a time; whole-file reads and writes, so small and medium data only.

## Publishing a new version

1. Change the code and add tests; `npm test` must pass.
2. Bump `version` in `package.json` and add a CHANGELOG entry.
3. Push to GitHub and check the Actions run is green.
4. In a terminal: `npm publish --otp=<6-digit code from the authenticator app>`. npm requires 2FA; do not create 2FA-bypass tokens.
5. Rebuild the site (`bash site/build.sh`) so it uses the new version.

## The learning site ("Inside youssefdb")

- Runs the real published youssefdb in the browser. `site/build.sh` bundles it with esbuild, plus three stand-ins: `shims/fs.js` (in-memory disk that records every read, write, rename and delete), `shims/crypto.js` (SHA-1 and random bytes), and `path-browserify`.
- Page parts: animated flow (Your code → Memory → Encoder → Disk, with direction-aware pipes and step playback), lessons, code editor, "What just happened" step list, and detail panels for disk files, memory documents with the ObjectId breakdown, and a colour-coded BSON byte view.
- Files: `app.js` (all page logic), `app.css` (styles, light and dark), `body.html` (markup), `entry.js` (what gets bundled).
- Nine lessons: a document, the _id key, no fixed shape, how a value is saved, reading, updating, deleting, indexes, collections.

## Still to do

- [ ] Turn on GitHub Pages (Settings → Pages → `main`, `/docs`) when the repo is made public.
- [ ] Add the site link to the youssefdb README and the GitHub profile "Live projects" table.
- [ ] Optional: a lesson comparing the same data as a SQL table and as NoSQL documents.
- [ ] Optional: remember the visitor's data between visits (browser storage).
- [ ] Optional: GitHub Action that rebuilds the site on each release, and npm trusted publishing instead of manual `--otp`.
- [ ] Test the site on a real phone and in Safari.
