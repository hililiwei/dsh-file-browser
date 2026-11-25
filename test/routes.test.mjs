import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ROUTES, apply } from '../index.js';

/**
 * Mount the Host half against a fake Cordis context and collect its routes.
 *
 * @param {Record<string, unknown>} config plugin config
 * @returns {Map<string, { path: string, methods: string[], fetch: (request: Request) => Promise<Response> }>}
 */
function mount(config) {
    /** @type {Map<string, any>} */
    const routes = new Map();
    const ctx = {
        logger: { warn() {} },
        inject(names, callback) {
            assert.deepEqual(names, ['connection']);
            const scope = {
                connection: {
                    fetch: {
                        register(definition) {
                            routes.set(definition.path, definition);
                            return () => routes.delete(definition.path);
                        },
                    },
                },
                effect(install) {
                    return install();
                },
            };
            callback(scope);
        },
    };
    apply(ctx, config);
    return routes;
}

/** @param {string} path @param {string} [query] */
function requestFor(path, query = '') {
    return new Request(`http://localhost${path}${query === '' ? '' : `?${query}`}`);
}

test('the Host half registers exactly three authenticated GET routes', async () => {
    const routes = mount({ roots: ['/'] });
    assert.deepEqual([...routes.keys()].sort(), [ROUTES.download, ROUTES.list, ROUTES.places].sort());
    for (const route of routes.values()) {
        assert.deepEqual(route.methods, ['GET']);
        assert.equal(typeof route.fetch, 'function');
    }
});

test('places answers JSON with home, cwd and roots', async () => {
    const routes = mount({ roots: ['/'] });
    const response = await routes.get(ROUTES.places).fetch(requestFor(ROUTES.places));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.value.home, 'string');
    assert.equal(payload.value.cwd, process.cwd());
    assert.deepEqual(payload.value.roots, ['/']);
});

test('list answers a directory page and its breadcrumbs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-fb-routes-'));
    try {
        await mkdirp(join(base, 'sub'));
        await writeFile(join(base, 'one.txt'), 'one');
        const routes = mount({ roots: [base], home: base });

        const response = await routes.get(ROUTES.list).fetch(requestFor(
            ROUTES.list,
            `path=${encodeURIComponent(base)}`,
        ));
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.ok, true);
        assert.equal(payload.value.path, base);
        assert.deepEqual(payload.value.entries.map((entry) => entry.name), ['sub', 'one.txt']);
        assert.deepEqual(payload.value.breadcrumbs.at(-1), { name: base.split('/').at(-1), path: base });
        assert.equal(payload.value.places.home, base);

        const hidden = await routes.get(ROUTES.list).fetch(requestFor(
            ROUTES.list,
            `path=${encodeURIComponent(base)}&hidden=1`,
        ));
        assert.equal(hidden.status, 200);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('list refuses paths outside the configured roots and missing parameters', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-fb-routes-'));
    try {
        const routes = mount({ roots: [base] });
        const outside = await routes.get(ROUTES.list).fetch(requestFor(
            ROUTES.list,
            'path=%2Fetc',
        ));
        assert.equal(outside.status, 403);
        const refusal = await outside.json();
        assert.equal(refusal.ok, false);
        assert.equal(refusal.error.code, 'outside-root');

        const missing = await routes.get(ROUTES.list).fetch(requestFor(ROUTES.list));
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).error.code, 'missing-path');
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('download answers an attachment with its bytes and headers', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-fb-routes-'));
    try {
        await writeFile(join(base, 'hello.txt'), 'hello world');
        const routes = mount({ roots: [base] });

        const response = await routes.get(ROUTES.download).fetch(requestFor(
            ROUTES.download,
            `path=${encodeURIComponent(join(base, 'hello.txt'))}`,
        ));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/octet-stream');
        assert.equal(response.headers.get('content-length'), '11');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-disposition'), /^attachment; filename="hello\.txt"; filename\*=UTF-8''hello\.txt$/);
        assert.equal(await response.text(), 'hello world');
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('download turns a directory and a missing file into JSON errors', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-fb-routes-'));
    try {
        const routes = mount({ roots: [base] });
        const directory = await routes.get(ROUTES.download).fetch(requestFor(
            ROUTES.download,
            `path=${encodeURIComponent(base)}`,
        ));
        assert.equal(directory.status, 400);
        assert.equal((await directory.json()).error.code, 'not-a-file');

        const missing = await routes.get(ROUTES.download).fetch(requestFor(
            ROUTES.download,
            `path=${encodeURIComponent(join(base, 'nope.bin'))}`,
        ));
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).error.code, 'not-found');
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

/** @param {string} path */
async function mkdirp(path) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path, { recursive: true });
}
