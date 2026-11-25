# dsh-file-browser

Browses the filesystem of the host that runs DSH (Linux, macOS or WSL) and
downloads files. There is no preview: the page lists directories and hands files
to the browser's download.

## Install

A DSH bundle, no runtime dependencies and no build step. Under
**Plugins → Add plugin** enter:

```
github:hililiwei/dsh-file-browser
```

Pin a commit with `github:hililiwei/dsh-file-browser#<40-char SHA>`. The bundle
installs enabled; refresh the page and the **Files** entry appears in the left
sidebar. Turning the bundle off under **Plugins** removes both the routes and the
sidebar entry, without a restart.

Tested on `dsh 0.2.2-rc.5`.

## Where to find it

Left sidebar → **Files** (文件浏览). The sidebar button opens the panel in the
main column; click a session in the sidebar to return to the conversation.

## Using the page

- **Path bar**: type any absolute path and press Enter; `~` expands to your home
  directory.
- **Breadcrumbs** and **Places** jump to the current root, home, the server's
  working directory and the active Session's directory.
- **Sort** by name, size or modified time; **filter** the loaded entries of the
  current directory; **show hidden files** with the checkbox in the header.
- **Download** a file from its row, or click the file name. Directories open
  when clicked.
- Downloads show their progress in the notice line. Files larger than 128 MiB
  are handed to the browser's own download instead of being buffered in the page.
- The page remembers its last directory, filter, sort and hidden-file state while
  the tab stays open, so switching to the conversation and back resumes browsing.

Browsing is read-only: no upload, rename, delete, preview or write route exists,
and file contents never enter the page (only their names, sizes and times).

## Configuration

The row in `cordis.patch.yml` takes these values:

| Key | Default | Meaning |
| --- | --- | --- |
| `roots` | `['/']` | Absolute directories the panel may read. A request outside every root is refused. |
| `maxEntries` | `2000` | Listing cap per directory (clamped to 50–20000). |
| `followSymlinks` | `true` | Resolve links, re-checking that the real path stays inside a root. |
| `showHidden` | `false` | Initial value of the page's hidden-file toggle. |
| `home` | OS home | Directory that `~` expands to. |

To lock the browser into one subtree, narrow `roots`, for example:

```yaml
- id: file-browser
  name: '@local/dsh-file-browser'
  config:
    roots:
      - /home/you/projects
```

## Routes

Three authenticated same-origin routes, reachable only by the owner's browser
peer (the DSH session cookie is required):

- `GET /api/file-browser/places` — home, server cwd and allowed roots.
- `GET /api/file-browser/list?path=/x&hidden=0|1` — one directory page.
- `GET /api/file-browser/download?path=/x` — the file as an attachment.

## Security and limits

- Access is limited to what the DSH process user can read. Narrow `roots` to
  reduce what an authenticated session can reach.
- Every request is canonicalized and re-checked against the roots, so a symlink
  planted inside a root cannot escape it.
- Only regular files download; sockets, devices and FIFOs are refused.
- Downloads have no range/resume support, and directories are not zipped.
