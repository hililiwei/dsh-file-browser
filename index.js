/**
 * @local/dsh-file-browser — Host half.
 *
 * <p>Adds three authenticated, same-origin Fetch routes used by the plugin's
 * left-sidebar panel:</p>
 *
 * <ul>
 *   <li>{@code GET /api/file-browser/places} - home, process cwd, allowed roots</li>
 *   <li>{@code GET /api/file-browser/list?path=/x&hidden=0|1} - one directory page</li>
 *   <li>{@code GET /api/file-browser/download?path=/x} - the file as an attachment</li>
 * </ul>
 *
 * <p>Routes are exact Fetch routes registered on the DSH {@code connection}
 * service, so only authenticated owner browser peers reach them; the browser's
 * same-origin {@code fetch()} carries the DSH session cookie automatically.
 * Path admission, symlink containment, listing and download handles live in
 * {@link module:./lib/files}; this module owns HTTP request parsing, response
 * shaping, and plugin lifetime only.</p>
 *
 * <p>No package dependencies: only {@code node:} builtins and this plugin's own
 * modules are imported. Every failure becomes a JSON error response and a route
 * handler never throws.</p>
 */

import { Readable } from 'node:stream';

import {
    FileRequestError,
    PLUGIN_LABEL,
    contentDisposition,
    createFileAccess,
    fsError,
} from './lib/files.js';

/** Routes owned by this plugin. */
export const ROUTES = Object.freeze({
    places: '/api/file-browser/places',
    list: '/api/file-browser/list',
    download: '/api/file-browser/download',
});

/**
 * Cordis Host plugin entry point.
 *
 * @param {import('cordis').Context} ctx host context
 * @param {Record<string, unknown>} [rawConfig] plugin config
 */
export function apply(ctx, rawConfig) {
    const access = createFileAccess(rawConfig);
    const logger = hostLogger(ctx);

    /**
     * @param {number} status HTTP status
     * @param {unknown} body JSON-serializable payload
     * @returns {Response}
     */
    const json = (status, body) => {
        let text;
        try {
            text = JSON.stringify(body);
        } catch (error) {
            text = JSON.stringify({
                ok: false,
                error: { code: 'serialize', message: `响应序列化失败 (response serialization failed): ${describeError(error)}` },
            });
        }
        return new Response(text, {
            status,
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
            },
        });
    };

    /**
     * Wrap a handler so no exception can escape a Fetch route.
     *
     * @param {string} action short description for logs
     * @param {(request: Request) => Promise<Response>} handler
     * @returns {(request: Request) => Promise<Response>}
     */
    const guarded = (action, handler) => async (request) => {
        try {
            return await handler(request);
        } catch (error) {
            const failure = asRequestError(error);
            const status = failure.status >= 400 && failure.status <= 599 ? failure.status : 502;
            logger.warn(`${action} failed [${failure.code}]: ${failure.message}`);
            return json(status, { ok: false, error: { code: failure.code, message: failure.message } });
        }
    };

    // The browser half is served by the Client-module loader; the Host half only
    // needs `connection` for its routes and stays inert in profiles without it.
    ctx.inject(['connection'], (scope) => {
        scope.effect(
            () => scope.connection.fetch.register({
                path: ROUTES.places,
                methods: ['GET'],
                requestBody: 'buffered',
                fetch: guarded('read places', async () => json(200, { ok: true, value: access.places() })),
            }),
            `${PLUGIN_LABEL}: GET ${ROUTES.places}`,
        );

        scope.effect(
            () => scope.connection.fetch.register({
                path: ROUTES.list,
                methods: ['GET'],
                requestBody: 'buffered',
                fetch: guarded('list directory', async (request) => {
                    const params = new URL(request.url).searchParams;
                    const listing = await access.list(params.get('path'), {
                        hidden: readFlag(params.get('hidden')),
                    });
                    return json(200, { ok: true, value: listing });
                }),
            }),
            `${PLUGIN_LABEL}: GET ${ROUTES.list}`,
        );

        scope.effect(
            () => scope.connection.fetch.register({
                path: ROUTES.download,
                methods: ['GET'],
                requestBody: 'buffered',
                fetch: guarded('download file', async (request) => {
                    const params = new URL(request.url).searchParams;
                    const file = await access.download(params.get('path'), {
                        signal: request.signal ?? undefined,
                    });
                    return new Response(Readable.toWeb(file.open()), {
                        status: 200,
                        headers: {
                            'content-type': 'application/octet-stream',
                            'content-length': String(file.size),
                            'content-disposition': contentDisposition(file.name),
                            'last-modified': new Date(file.mtimeMs).toUTCString(),
                            'cache-control': 'no-store',
                            'x-content-type-options': 'nosniff',
                        },
                    });
                }),
            }),
            `${PLUGIN_LABEL}: GET ${ROUTES.download}`,
        );
    });
}

/**
 * @param {string | null} raw query flag
 * @returns {boolean}
 */
function readFlag(raw) {
    return raw === '1' || raw === 'true';
}

/**
 * @param {unknown} error thrown value
 * @returns {FileRequestError} an error carrying an HTTP status and machine code
 */
function asRequestError(error) {
    if (error instanceof FileRequestError) return error;
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
    if (code !== '' && /^E[A-Z]+$/.test(code)) {
        return fsError(error, '', '文件系统错误 (filesystem error)');
    }
    return new FileRequestError(502, 'internal', `内部错误 (internal error): ${describeError(error)}`);
}

/** @param {unknown} error @returns {string} */
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Logging is best effort: a misbehaving logger must never break a request.
 *
 * @param {import('cordis').Context} ctx host context
 * @returns {{ warn: (message: string) => void }}
 */
function hostLogger(ctx) {
    return {
        warn(message) {
            try {
                const logger = ctx?.logger;
                const write = logger?.warn;
                if (typeof write === 'function') write.call(logger, `[file-browser] ${message}`);
            } catch {
                // Ignore logging failures.
            }
        },
    };
}
