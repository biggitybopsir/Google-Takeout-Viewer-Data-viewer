# Google Takeout Viewer

Google Takeout Viewer is a browser-based viewer for Google Takeout exports. Select the ZIP files Google gives you, and the app indexes the archive and turns supported services into searchable dashboards.

It is built for large multi-part Takeout exports: instead of unpacking everything at once, it reads the ZIP file list first and opens only the structured files needed for each section.

## Showcase

See the Google viewer live on DataUnpacker: [dataunpacker.com/google](https://www.dataunpacker.com/google)

## Features

- Multi-ZIP Google Takeout archive support
- Archive coverage summary by product, file type, and largest files
- My Activity dashboards for supported Google services
- Chrome History trends, devices, domains, and recent visits
- YouTube watch and search history summaries
- Gmail header analytics, including senders, domains, labels, timing, subscriptions, storage, and security-related messages
- Optional Gmail order-total scan, started manually from the Gmail tab
- Google Photos metadata from sidecar JSON files
- Google Drive storage breakdown from file names, sizes, folders, extensions, and modified dates
- Google Fit daily activity charts
- Google Play Store installs, purchases, subscriptions, devices, and Play Points
- Google Play Games profile, playtime, achievements, scores, XP, and streaks
- Gemini activity summaries
- Contacts, Calendar, Tasks, Saved, Google Pay, Google Chat, and contribution counts
- Privacy mode for hiding names, titles, message text, filenames, locations, and similar screen-visible details

## Privacy

Files are processed in your browser with Web Workers. The app reads supported structured files from the ZIPs you choose.

Some intentionally limited reads:

- Google Photos media files are not opened; only metadata sidecar JSON files are parsed.
- Google Drive file contents are not opened; Drive is summarized from the ZIP index.
- Gmail message text is not read during the normal header scan. The optional order-total scan reads only candidate order/receipt emails after you start it.

## Supported Export Format

Use the original `.zip` files from a Google Takeout export. If Google splits the export into several parts, select all ZIP parts from the same export together.

`.tgz` exports are not supported.

## Getting Started

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, then choose your Google Takeout ZIP files.

## Build

```bash
npm run build
npm run preview
```

## Notes

Google Takeout formats can change over time and may differ by account, region, language, or enabled Google products. Unsupported files are still indexed in the Coverage tab when possible.

This project is not affiliated with, endorsed by, or sponsored by Google.

## License

MIT. See [LICENSE](LICENSE).
