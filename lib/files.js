/**
 * @local/dsh-file-browser — filesystem core.
 *
 * <p>Pure-async library behind the plugin's three authenticated Fetch routes.
 * It owns path admission (absolute paths, allowed roots, symlink escapes),
 * directory listing, and download handles; `index.js` owns HTTP shaping.</p>
 *
 * <p>Security model: the browser is an authenticated owner peer, so this module
 * is the only gate between the page and the host filesystem. Every request is
 * resolved to a canonical path and re-checked against the configured roots
 * after symlink resolution, so a link planted inside a root cannot escape it.</p>
 */

import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Stable plugin label used for log lines. */
export const PLUGIN_LABEL = '@local/dsh-file-browser';

/** Roots used when the configuration names none. */
const DEFAULT_ROOTS = ['/'];

/** Default cap on entries read from one directory. */
const DEFAULT_MAX_ENTRIES = 2000;

/** Smallest and largest accepted `maxEntries` values. */
const MIN_MAX_ENTRIES = 50;
const MAX_MAX_ENTRIES = 20000;

/** Parallel `lstat` calls per directory page. */
const STAT_CONCURRENCY = 32;

/** Case-insensitive, numeric-aware name order shared by listing and sorting. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * One refused filesystem request, carrying the HTTP status the route answers.
 */
export class FileRequestError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code stable machine code for the browser
     * @param {string} message bilingual, user-visible sentence
     */
    constructor(status, code, message) {
        super(message);
        this.name = 'FileRequestError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Resolve plugin config into executable options, failing loudly on a bad root
 * rather than silently widening access to `/`.
 *
 * @param {Record<string, unknown> | undefined} raw plugin config
 * @returns {{
 *   roots: string[],
 *   home: string,
 *   maxEntries: number,
 *   followSymlinks: boolean,
 *   showHidden: boolean,
 * }}
 */
export function resolveConfig(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    return {
        roots: normalizeRoots(source.roots),
        home: stringOr(source.home) ?? homedir(),
        maxEntries: clampInteger(source.maxEntries, MIN_MAX_ENTRIES, MAX_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
        followSymlinks: source.followSymlinks !== false,
        showHidden: source.showHidden === true,
    };
}

/**
 * @param {unknown} value configured roots (array, single string, or absent)
 * @returns {string[]} absolute, de-duplicated roots
 */
function normalizeRoots(value) {
    const configured = typeof value === 'string'
        ? [value]
        : Array.isArray(value)
            ? value
            : DEFAULT_ROOTS;
    const roots = [];
    for (const item of configured) {
        const valueText = stringOr(item);
        if (valueText === null) continue;
        if (!isAbsolute(valueText)) {
            throw new Error(
                `file-browser: 配置项 roots 必须是绝对路径，收到「${valueText}」。`
                + ` The "roots" config entries must be absolute paths.`,
            );
        }
        const absolute = resolve(valueText);
        if (!roots.includes(absolute)) roots.push(absolute);
    }
    if (roots.length === 0) {
        throw new Error(
            'file-browser: 配置项 roots 不能为空，至少需要一个绝对路径。'
            + ' The "roots" config must name at least one absolute directory.',
        );
    }
    return roots;
}

/**
 * Build the filesystem accessor for one plugin instance.
 *
 * @param {Record<string, unknown> | undefined} raw plugin config
 * @returns {{
 *   config: ReturnType<typeof resolveConfig>,
 *   places: () => { home: string, cwd: string, roots: string[], maxEntries: number },
 *   list: (path: string, options?: { hidden?: boolean }) => Promise<object>,
 *   download: (path: string, options?: { signal?: AbortSignal }) => Promise<object>,
 * }}
 */
export function createFileAccess(raw) {
    const config = resolveConfig(raw);
    /** @type {Promise<string[]> | null} canonical roots, resolved once and reused. */
    let canonicalRoots = null;

    /** @returns {Promise<string[]>} each root through `realpath`, falling back to itself */
    const realRoots = () => {
        if (canonicalRoots === null) {
            canonicalRoots = Promise.all(config.roots.map((root) => realpath(root).catch(() => root)));
        }
        return canonicalRoots;
    };

    /**
     * Canonical roots plus the configured ones: a path inside a configured root
     * stays admitted even when the root itself is reached through a link.
     *
     * @returns {Promise<string[]>}
     */
    const admittedRoots = async () => {
        const roots = await realRoots();
        const all = config.roots.slice();
        for (const root of roots) {
            if (!all.includes(root)) all.push(root);
        }
        return all;
    };

    /**
     * Turn one request path into an admitted canonical path and the configured
     * root that admits it, so the page can stop breadcrumbs at that boundary.
     *
     * @param {string} rawPath browser-supplied path
     * @returns {Promise<{ path: string, root: string, roots: string[] }>} canonical path and its admitting root
     */
    const admit = async (rawPath) => {
        const requested = resolveRequestPath(config, rawPath);
        const roots = await admittedRoots();
        assertInside(roots, requested, 'outside-root', requested);
        let canonical;
        try {
            canonical = await realpath(requested);
        } catch (error) {
            throw fsError(error, requested, '解析路径失败 (cannot resolve path)');
        }
        if (!config.followSymlinks && canonical !== requested) {
            throw new FileRequestError(
                403,
                'symlink-blocked',
                `符号链接被配置禁止 (symbolic links are disabled by the plugin config): ${requested}`,
            );
        }
        assertInside(roots, canonical, 'outside-root', requested);
        return { path: canonical, root: containingRoot(roots, canonical), roots };
    };

    /** @returns {{ home: string, cwd: string, roots: string[], maxEntries: number, showHidden: boolean }} */
    const places = () => ({
        // Home and the server directory only travel when they are actually
        // reachable; a narrowed `roots` must not offer dead-end shortcuts.
        home: isInside(config.roots, config.home) ? config.home : '',
        cwd: isInside(config.roots, process.cwd()) ? process.cwd() : '',
        roots: config.roots.slice(),
        maxEntries: config.maxEntries,
        showHidden: config.showHidden,
    });

    return {
        config,
        places,

        /**
         * Read one directory page.
         *
         * @param {string} rawPath requested directory
         * @param {{ hidden?: boolean }} [options] listing options
         * @returns {Promise<object>} listing payload
         */
        async list(rawPath, options = {}) {
            const hidden = options.hidden === true;
            const admitted = await admit(rawPath);
            const target = admitted.path;
            const info = await statOrThrow(target);
            if (!info.isDirectory()) {
                throw new FileRequestError(
                    400,
                    'not-a-directory',
                    `目标不是目录 (not a directory): ${target}`,
                );
            }
            let dirents;
            try {
                dirents = await readdir(target, { withFileTypes: true });
            } catch (error) {
                throw fsError(error, target, '读取目录失败 (cannot read directory)');
            }
            const visible = dirents
                .filter((dirent) => hidden || !dirent.name.startsWith('.'))
                .sort((a, b) => COLLATOR.compare(a.name, b.name));
            const total = visible.length;
            const hiddenCount = dirents.length - total;
            const page = visible.slice(0, config.maxEntries);
            const entries = await mapLimit(page, STAT_CONCURRENCY, (dirent) => describeEntry(config, join(target, dirent.name), dirent.name));
            entries.sort(compareEntries);
            const parent = parentOf(target);
            return {
                path: target,
                root: admitted.root,
                parent: parent !== null && isInside(admitted.roots, parent) ? parent : null,
                breadcrumbs: breadcrumbsOf(target, admitted.root),
                entries,
                total,
                hiddenCount,
                count: entries.length,
                truncated: total > config.maxEntries,
                maxEntries: config.maxEntries,
                hidden,
                places: places(),
            };
        },

        /**
         * Open one regular file for download.
         *
         * @param {string} rawPath requested file
         * @param {{ signal?: AbortSignal }} [options] cancellation for the read stream
         * @returns {Promise<{ path: string, name: string, size: number, mtimeMs: number, open: () => import('node:fs').ReadStream }>}
         */
        async download(rawPath, options = {}) {
            const { path: target } = await admit(rawPath);
            const info = await statOrThrow(target);
            if (!info.isFile()) {
                throw new FileRequestError(
                    400,
                    'not-a-file',
                    `只能下载普通文件 (only regular files can be downloaded): ${target}`,
                );
            }
            return {
                path: target,
                name: basename(target),
                size: info.size,
                mtimeMs: info.mtimeMs,
                open: () => createReadStream(target, options.signal === undefined ? {} : { signal: options.signal }),
            };
        },
    };
}

// -------------------------------------------------------------------------
// Paths
// -------------------------------------------------------------------------

/**
 * Validate and normalize one requested path. `~` expands to the configured
 * home directory; relative paths are refused so the page never guesses.
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {unknown} rawPath
 * @returns {string} absolute, normalized path
 */
export function resolveRequestPath(config, rawPath) {
    const text = stringOr(rawPath);
    if (text === null) {
        throw new FileRequestError(400, 'missing-path', '缺少 path 参数 (missing "path" query parameter).');
    }
    if (text.includes('\u0000')) {
        throw new FileRequestError(400, 'bad-path', '路径包含非法字符 (the path contains a NUL character).');
    }
    let expanded = text;
    if (expanded === '~') {
        expanded = config.home;
    } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
        expanded = join(config.home, expanded.slice(2));
    }
    if (!isAbsolute(expanded)) {
        throw new FileRequestError(
            400,
            'relative-path',
            `只接受绝对路径 (expected an absolute path): ${text}`,
        );
    }
    return resolve(expanded);
}

/**
 * Throw unless `target` equals or sits inside one of `roots`.
 *
 * @param {string[]} roots allowed roots
 * @param {string} target candidate path
 * @param {string} code machine code for the refusal
 * @param {string} requested path as the caller wrote it
 */
export function assertInside(roots, target, code, requested) {
    if (isInside(roots, target)) return;
    throw new FileRequestError(
        403,
        code,
        `路径不在允许浏览的目录内 (path outside the allowed roots): ${requested}`,
    );
}

/**
 * @param {string[]} roots allowed roots
 * @param {string} target candidate path
 * @returns {boolean} whether `target` equals or sits inside one root
 */
export function isInside(roots, target) {
    for (const root of roots) {
        if (target === root) return true;
        const prefix = root.endsWith(sep) ? root : root + sep;
        if (target.startsWith(prefix)) return true;
    }
    return false;
}

/**
 * @param {string[]} roots admitted roots
 * @param {string} target admitted path
 * @returns {string} the deepest root containing `target`
 */
export function containingRoot(roots, target) {
    let best = roots.length > 0 ? roots[0] : sep;
    for (const root of roots) {
        if (isInside([root], target) && root.length > best.length) best = root;
    }
    return best;
}

/**
 * @param {string} target absolute directory
 * @returns {string | null} parent directory, or null at a filesystem root
 */
export function parentOf(target) {
    const parent = dirname(target);
    return parent === target ? null : parent;
}

/**
 * Build clickable breadcrumbs for one absolute directory, starting at the
 * configured root that admits it so no crumb can navigate outside that root.
 *
 * @param {string} target absolute directory
 * @param {string} [root] deepest admitting root; defaults to the filesystem root
 * @returns {Array<{ name: string, path: string }>}
 */
export function breadcrumbsOf(target, root) {
    // POSIX is the only shape this plugin promises; other separators degrade to
    // one crumb that still navigates correctly.
    if (sep !== '/') return [{ name: target, path: target }];
    const boundary = typeof root === 'string' && root !== '' ? root : '/';
    const crumbs = [{
        name: boundary === '/' ? '/' : (basename(boundary) || boundary),
        path: boundary,
    }];
    const relative = boundary === '/' ? target : target.slice(boundary.length);
    let current = boundary === '/' ? '' : boundary;
    for (const part of relative.split('/')) {
        if (part === '') continue;
        current = current === '' ? `/${part}` : `${current}/${part}`;
        crumbs.push({ name: part, path: current });
    }
    return crumbs;
}

/**
 * Describe one directory entry. Symbolic links are resolved when the config
 * allows it, so a link to a directory browses and a link to a file downloads.
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {string} fullPath absolute entry path
 * @param {string} name basename
 * @returns {Promise<object>} entry payload
 */
async function describeEntry(config, fullPath, name) {
    const base = { name, path: fullPath };
    let info;
    try {
        info = await lstat(fullPath);
    } catch {
        return { ...base, kind: 'unreadable', size: null, mtimeMs: null, symlink: false, linkTo: null };
    }
    const symlink = info.isSymbolicLink();
    let linkTo = null;
    if (symlink) {
        try {
            linkTo = await readlink(fullPath);
        } catch {
            linkTo = null;
        }
        if (!config.followSymlinks) {
            return { ...base, kind: 'symlink', size: null, mtimeMs: info.mtimeMs ?? null, symlink, linkTo };
        }
    }
    let effective = info;
    if (symlink) {
        try {
            effective = await stat(fullPath);
        } catch {
            return { ...base, kind: 'broken', size: null, mtimeMs: info.mtimeMs ?? null, symlink, linkTo };
        }
    }
    const kind = effective.isDirectory() ? 'dir' : effective.isFile() ? 'file' : 'other';
    return {
        ...base,
        kind,
        size: effective.isFile() ? effective.size : null,
        mtimeMs: effective.mtimeMs ?? null,
        symlink,
        linkTo,
        mode: effective.mode,
    };
}

/**
 * Directories before files, then case-insensitive numeric name order.
 *
 * @param {{ kind: string, name: string }} a
 * @param {{ kind: string, name: string }} b
 * @returns {number}
 */
export function compareEntries(a, b) {
    const rankA = a.kind === 'dir' ? 0 : 1;
    const rankB = b.kind === 'dir' ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return COLLATOR.compare(a.name, b.name);
}

// -------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------

/**
 * Build an `attachment` Content-Disposition header that survives non-ASCII
 * names: an ASCII fallback plus RFC 5987 `filename*`.
 *
 * @param {string} name file basename
 * @returns {string}
 */
export function contentDisposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/**
 * @param {string} value UTF-8 text
 * @returns {string} percent-encoded as RFC 5987 demands
 */
export function encodeRfc5987(value) {
    return encodeURIComponent(value).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Map one thrown filesystem error onto the route's HTTP shape.
 *
 * @param {unknown} error thrown value
 * @param {string} target path being read
 * @param {string} prefix bilingual context sentence
 * @returns {FileRequestError}
 */
export function fsError(error, target, prefix) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
    switch (code) {
        case 'ENOENT':
        case 'ENOTDIR':
            return new FileRequestError(404, 'not-found', `${prefix}: 不存在 (no such file or directory) ${target}`);
        case 'EACCES':
        case 'EPERM':
            return new FileRequestError(403, 'permission-denied', `${prefix}: 没有权限 (permission denied) ${target}`);
        case 'ELOOP':
            return new FileRequestError(400, 'loop', `${prefix}: 符号链接循环 (too many symbolic links) ${target}`);
        case 'ENAMETOOLONG':
            return new FileRequestError(400, 'name-too-long', `${prefix}: 路径过长 (path too long) ${target}`);
        case 'EISDIR':
            return new FileRequestError(400, 'is-a-directory', `${prefix}: 目标是一个目录 (target is a directory) ${target}`);
        default:
            return new FileRequestError(
                502,
                'io-error',
                `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
            );
    }
}

// -------------------------------------------------------------------------
// Small utilities
// -------------------------------------------------------------------------

/**
 * @param {string} target path to stat
 * @returns {Promise<import('node:fs').Stats>}
 */
async function statOrThrow(target) {
    try {
        return await stat(target);
    } catch (error) {
        throw fsError(error, target, '读取路径失败 (cannot read path)');
    }
}

/**
 * Run `worker` over `items` with a bounded number of concurrent calls.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit concurrent calls
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>} results in input order
 */
export async function mapLimit(items, limit, worker) {
    /** @type {R[]} */
    const results = new Array(items.length);
    let cursor = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * @param {unknown} value
 * @returns {string | null} trimmed non-empty string, or null
 */
function stringOr(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * @param {unknown} value candidate number
 * @param {number} min inclusive lower bound
 * @param {number} max inclusive upper bound
 * @param {number} fallback used when absent, non-finite, or out of range
 * @returns {number}
 */
function clampInteger(value, min, max, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}
