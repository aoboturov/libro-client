# Libro.fm CLI Tool

This is a simple command-line tool for interacting with your Libro.fm library. It allows you to:

- List all audiobooks in your library
- Download audiobooks to your computer
- Check for new audiobooks in your library
- Run as a background service

## Command-line interface

### Installation

Build the standalone CLI binary (requires [Bun](https://bun.sh)):

```bash
bun install
bun run build:cli   # outputs bin/libro
```

Then either run `bin/libro` directly or add `bin/` to your `PATH`:

```bash
./bin/libro
```

Settings, the session token and logs live in `data/`, and books in `downloads/`, both next to the project. The standalone binary remembers the directory it was built in and keeps using it while that directory exists; copied to another machine it falls back to `~/.local/share/libro` (or `$XDG_DATA_HOME/libro`). Set `LIBROFM_DATA_DIR` to keep the app data somewhere else, and `LIBROFM_DOWNLOAD_DIR` for the books.

### List audiobooks

To list all audiobooks in your library, run the following command:

```bash
libro list
```

This will print a list of audiobook titles to the console.

### Download audiobooks

To download a specific audiobook, run the following command:

```bash
libro get [...isbns]
```

To choose an audiobook from your library, run the following command:

```bash
libro get
```

Replace `[...isbns]` with the ISBN of the audiobook you want to download. You can find the ISBN by running the list command.

If you don't specify an ISBN, the tool will prompt you to select an audiobook from your library.

Books come as MP3 tracks, one file per chapter. To get a single `.m4b` file per book instead (one file with chapter markers, the usual format for audiobook players and Audiobookshelf), add `--m4b` or set `LIBROFM_M4B=true`; `--no-m4b` asks for MP3 tracks whatever `LIBROFM_M4B` says. The Docker image downloads m4b files unless told otherwise.

```bash
libro get --m4b 9780593135204
```

The m4b is the one Libro.fm packages itself, saved as `<title>.m4b` in the book's folder; nothing is converted on your machine. Libro.fm doesn't offer an m4b of every title: those books are downloaded as MP3 tracks, and the log says so. `--keep-zip` only applies to MP3 downloads. Books you already have stay as they are; downloading one again in the other format (`--overwrite`) adds the new files next to the old ones, so delete the book's folder first if you only want the new format.

With several ISBNs, up to 4 books are downloaded at a time (`LIBROFM_PARALLEL_DOWNLOADS`). Books you already have are asked about first, one at a time, unless `--overwrite` is given. One failed download doesn't stop the others; the command exits with status 1 if any book could not be downloaded.

A book only shows up in your download folder once it is complete. Its m4b, or its zip parts, are streamed to a hidden `.libro-partial` folder inside the download folder, unpacked there, and then moved into place, so a failed or interrupted download never leaves a partial book behind. If the tool is killed mid-download, the next attempt at that book clears what was left; you can also delete `.libro-partial` yourself while nothing is downloading.

Downloads go straight to disk and are never held in memory whole, so memory use stays at a few tens of MB however large the book is. While an MP3 book downloads, the download folder needs free space for about twice its size (the zip parts plus the unpacked files); an m4b needs only its own size.

### Check for new audiobooks

To check for new audiobooks in your library, run the following command:

```bash
libro check
```

This will print a list of new audiobooks to the console. You can also use the --json flag to output the data as JSON.

### Listening history

To see your listening history for each title, run:

```bash
libro history                                  # whole library, most recently played first
libro history 9780593135204                    # one or more ISBNs
libro history --format csv -o history.csv      # spreadsheet export
libro history --format json -o history.json    # full detail, including every bookmark
```

For each title it shows:

| Field | Meaning |
| --- | --- |
| `added_at` | When the title was added to your library |
| `last_played_at` | When the app last synced a listening position (Libro.fm's `last_touched_at`) |
| `finished` | Whether the app marked the title finished |
| `track`, `track_seconds` | Current position: track number (from 1) and seconds into it |
| `position_seconds`, `progress_percent` | Position from the start of the book; only for titles downloaded with this tool, since it needs the track lengths |
| `duration_seconds` | Length of the book |
| bookmarks | Count in text and CSV; the JSON has each bookmark's track, time, note and creation date |
| `tags` | Your library tags |

Libro.fm's API has no endpoint that returns individual listening sessions (the app uploads them but never reads them back), so the history is the latest state for each title, not a log of every session. Files written with `-o` are readable only by you. Use `-o` rather than `>` the first time you log in, so the login prompt doesn't end up in the file.

## Background service

The tool can also be run as a background service. This is useful if you want to automatically download new audiobooks as they become available in your library. It downloads up to 4 new books at a time (`LIBROFM_PARALLEL_DOWNLOADS`), as MP3 tracks or, with `LIBROFM_M4B=true` (the Docker image's default), as one m4b each, so the first run on a large library takes a while; checks that come due meanwhile are skipped.

To run the service, you can use Docker or another process manager.

Give the service `LIBROFM_USERNAME` and `LIBROFM_PASSWORD` (for Docker, in `.env`). When Libro.fm rejects the saved session token (it expired or was revoked), the service logs in again with these and retries at once. If Libro.fm is unreachable, rate-limits, or answers with a server error, the token is kept and the service tries again at the next check, also at startup. A request that gets no answer within 30 seconds, or a download that receives no data for 60 seconds, is given up and retried at the next check rather than holding the service forever.

If Libro.fm rejects the username or password, or there are none, the service stops checking for new books instead of retrying. The same credentials would fail every time, and repeated failed logins can get an account locked. It keeps running and repeats the error in its log every hour, rather than exiting: a restart policy (Docker, TrueNAS, Kubernetes) restarts a service that exits, whatever its exit status, and it would log in again about once a minute. Fix the credentials and restart it. `LIBROFM_USERNAME` overrides a username saved in `data/config/config.json` by an earlier interactive login, and switching accounts discards the saved session token.

The service stops on `SIGTERM` or `SIGINT` (`docker stop`, Ctrl-C). A download in progress is dropped: it never reaches the download folder half done, and the next start downloads the book again.

### Docker

Every release publishes an image for amd64 and arm64 to `ghcr.io/aoboturov/libro-client`, tagged with its version and `latest`. To build and run your own instead:

```bash
docker build -t libro .
docker run -d libro
```

Or use the provided `docker-compose.yml` file:

```bash
docker-compose up -d
```

The image downloads each book as one m4b file where Libro.fm has one (`LIBROFM_M4B=true`); set `LIBROFM_M4B=false` in its environment for MP3 tracks, one file per chapter.

The image runs as root unless told otherwise. It also runs as any other user (`--user`, or `user:` in Compose) that can write to the mounted folders; nothing else in the image needs to be writable.

### TrueNAS

On TrueNAS (24.10 or later), run the service as a custom app from the published image.

1. Create a dataset for the app data, for example `tank/apps/libro`, with the **Apps** preset. It holds the session token, so don't share it over SMB or NFS. Pick or create the dataset the books go to as well, for example `tank/media/audiobooks`; it can be an SMB share.
2. The app runs as the `apps` user (UID 568). In each dataset's permissions, give `apps` **Modify** access. Owning the datasets is not needed.
3. Go to **Apps → Discover Apps**, open the ⋮ menu, choose **Install via YAML**, name the app `libro` and paste:

   ```yaml
   services:
     libro:
       image: ghcr.io/aoboturov/libro-client:latest
       restart: unless-stopped
       user: "568:568"
       environment:
         LIBROFM_USERNAME: "you@example.com"
         LIBROFM_PASSWORD: "your-password"
         LIBROFM_DATA_DIR: /data
         LIBROFM_DOWNLOAD_DIR: /audiobooks
         LIBROFM_POLL_MINUTES: "60"
       volumes:
         - /mnt/tank/apps/libro:/data
         - /mnt/tank/media/audiobooks:/audiobooks
   ```

   Compose replaces `$NAME` in values, so write a `$` in the password as `$$`. Any setting from [Configuration](#configuration) can go under `environment`; add `LIBROFM_M4B: "false"` there to get MP3 tracks instead of one m4b per book.
4. Open the app's logs. It checks for new books when it starts, then every `LIBROFM_POLL_MINUTES`. If the log says the username or password was rejected, edit the app, fix them and save; saving restarts it.

To choose when to upgrade, use a version tag such as `:0.1.30` instead of `latest`, and change it in the app's YAML.


## Configuration

You can set the following environment variables:

```bash
DEBUG=true                          # enable debug-level logging (default: off)
LIBROFM_USERNAME=<your_username>    # Libro.fm account email
LIBROFM_PASSWORD=<your_password>    # Libro.fm account password
LIBROFM_POLL_MINUTES=15             # background service: minutes between library checks (default: 15)
LIBROFM_PARALLEL_DOWNLOADS=4        # books downloaded at the same time, by the service and by `get` (default: 4)
LIBROFM_M4B=true                    # one m4b file per book where Libro.fm has one, instead of MP3 tracks (default: false; true in the Docker image)
LIBROFM_DOWNLOAD_DIR=<path>         # where books go (default: ./downloads, or the folder chosen at the first interactive run)
LIBROFM_DATA_DIR=<path>             # where settings, the session token and logs live (default: ./data)
```

Environment variables take precedence over the values saved in `data/config/config.json`.

### Where your credentials go

- Your password is only sent to `https://libro.fm/oauth/token`. It is never written to disk: after
  the first login, only your username and the session token are kept in `data/config/config.json`,
  readable by your user only.
- Logs in `data/logs/` redact passwords, tokens and signed download links. They are kept across
  runs and rotated (at most 3 files of 10 MB per level), so the log of a crash survives the restart.
- The `metadata.json` saved next to each book, and `data/config/state.json`, keep the download
  manifest without its signed, expiring part URLs, so a shared download folder never holds a
  working download link.
- `config.json` and `state.json` are replaced in one step (written to a temp file, then renamed),
  so a crash mid-write can't leave them truncated.
- The Docker image never includes `data/`; mount it as a volume (see `docker-compose.yml`).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, build/test commands, and the PR workflow.

## Disclaimer

This tool is not affiliated with Libro.fm in any way. Use it at your own risk.
