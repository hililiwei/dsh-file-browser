import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    FileRequestError,
    contentDisposition,
    createFileAccess,
    encodeRfc5987,
    resolveConfig,
    resolveRequestPath,
} from '../lib/files.js';

/**
 * Build one throwaway tree:
 *
 *   <root>/alpha.txt, Beta.md, zeta.log, .hidden
 *   <root>/nested/inner.txt
 *   <root>/linked-file -> alpha.txt
 *   <root>/escape -> <outside>
 */
async function makeTree() {
    const base = await mkdtemp(join(tmpdir(), 'dsh-fb-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    await mkdir(join(root, 'nested'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, 'alpha.txt'), 'alpha');
    await writeFile(join(root, 'Beta.md'), '# beta');
    await writeFile(join(root, 'zeta.log'), 'zeta');
    await writeFile(join(root, '.hidden'), 'hidden');
    await writeFile(join(root, 'nested', 'inner.txt'), 'inner');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(root, 'alpha.txt'), join(root, 'linked-file'));
    await symlink(outside, join(root, 'escape'));
    return {
        base,
        root,
        outside,
        cleanup: () => rm(base, { recursive: true, force: true }),
    };
}

test('resolveConfig defaults and refusal of a relative root', () => {
    const config = resolveConfig(undefined);
    assert.deepEqual(config.roots, ['/']);
    assert.equal(config.maxEntries, 2000);
    assert.equal(config.followSymlinks, true);
    assert.equal(config.showHidden, false);

    assert.throws(() => createFileAccess({ roots: ['relative/dir'] }), /绝对路径/);
    assert.throws(() => createFileAccess({ roots: [] }), /不能为空/);
    // Out-of-range caps fall back instead of widening the page.
    assert.equal(resolveConfig({ maxEntries: 1 }).maxEntries, 50);
    assert.equal(resolveConfig({ maxEntries: 999999 }).maxEntries, 20000);
});

test('resolveRequestPath expands ~ and refuses relative paths', () => {
    const config = resolveConfig({ home: '/home/example' });
    assert.equal(resolveRequestPath(config, '~'), '/home/example');
    assert.equal(resolveRequestPath(config, '~/docs/'), '/home/example/docs');
    assert.equal(resolveRequestPath(config, '/var/log/../log'), '/var/log');

    assert.throws(() => resolveRequestPath(config, 'relative'), (error) => {
        assert.ok(error instanceof FileRequestError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'relative-path');
        return true;
    });
    assert.throws(() => resolveRequestPath(config, ''), (error) => error.code === 'missing-path');
});

test('list sorts directories first, filters dotfiles, and resolves links', async () => {
    const tree = await makeTree();
    try {
        const access = createFileAccess({ roots: [tree.root], home: tree.root });
        const listing = await access.list(tree.root);

        assert.equal(listing.path, tree.root);
        assert.deepEqual(listing.entries.map((entry) => entry.name), [
            'escape',
            'nested',
            'alpha.txt',
            'Beta.md',
            'linked-file',
            'zeta.log',
        ]);

        const dir = listing.entries.find((entry) => entry.name === 'nested');
        assert.equal(dir.kind, 'dir');
        assert.equal(dir.path, join(tree.root, 'nested'));

        const file = listing.entries.find((entry) => entry.name === 'alpha.txt');
        assert.equal(file.kind, 'file');
        assert.equal(file.size, 5);

        const link = listing.entries.find((entry) => entry.name === 'linked-file');
        assert.equal(link.symlink, true);
        assert.equal(link.kind, 'file');
        assert.equal(link.linkTo, join(tree.root, 'alpha.txt'));

        const hidden = await access.list(tree.root, { hidden: true });
        assert.ok(hidden.entries.some((entry) => entry.name === '.hidden'));

        assert.deepEqual(listing.breadcrumbs.map((crumb) => crumb.path).at(-1), tree.root);
        assert.equal(listing.parent, null);
        assert.equal(listing.total, listing.entries.length);
        assert.equal(listing.hiddenCount, 1);
        assert.equal(listing.truncated, false);
    } finally {
        await tree.cleanup();
    }
});

test('a symlink inside a root cannot escape it', async () => {
    const tree = await makeTree();
    try {
        const access = createFileAccess({ roots: [tree.root], home: tree.root });
        await assert.rejects(access.list(join(tree.root, 'escape')), (error) => {
            assert.ok(error instanceof FileRequestError);
            assert.equal(error.status, 403);
            assert.equal(error.code, 'outside-root');
            return true;
        });
        await assert.rejects(
            access.download(join(tree.root, 'escape', 'secret.txt')),
            (error) => error.code === 'outside-root',
        );
        // The default `/` root legitimately admits the same directory.
        const unrestricted = createFileAccess({ roots: ['/'] });
        const listing = await unrestricted.list(tree.outside);
        assert.ok(listing.entries.some((entry) => entry.name === 'secret.txt'));
    } finally {
        await tree.cleanup();
    }
});

test('followSymlinks: false refuses to traverse links', async () => {
    const tree = await makeTree();
    try {
        const access = createFileAccess({ roots: [tree.root], home: tree.root, followSymlinks: false });
        const listing = await access.list(tree.root);
        const link = listing.entries.find((entry) => entry.name === 'linked-file');
        assert.equal(link.kind, 'symlink');
        await assert.rejects(access.list(join(tree.root, 'escape')), (error) => error.code === 'symlink-blocked');
    } finally {
        await tree.cleanup();
    }
});

test('listing outside every root and non-directory targets are refused', async () => {
    const tree = await makeTree();
    try {
        const access = createFileAccess({ roots: [tree.root] });
        await assert.rejects(access.list('/etc'), (error) => {
            assert.equal(error.status, 403);
            assert.equal(error.code, 'outside-root');
            return true;
        });
        await assert.rejects(access.list(join(tree.root, 'alpha.txt')), (error) => {
            assert.equal(error.status, 400);
            assert.equal(error.code, 'not-a-directory');
            return true;
        });
        await assert.rejects(access.list(join(tree.root, 'missing')), (error) => error.code === 'not-found');
    } finally {
        await tree.cleanup();
    }
});

test('a huge directory is capped and reported as truncated', async () => {
    const tree = await makeTree();
    try {
        const many = join(tree.root, 'many');
        await mkdir(many);
        await Promise.all(Array.from({ length: 60 }, (_, index) => writeFile(join(many, `f${String(index).padStart(2, '0')}.txt`), 'x')));
        const access = createFileAccess({ roots: [tree.root], maxEntries: 50 });
        const listing = await access.list(many);
        assert.equal(listing.total, 60);
        assert.equal(listing.count, 50);
        assert.equal(listing.truncated, true);
        assert.equal(listing.maxEntries, 50);
    } finally {
        await tree.cleanup();
    }
});

test('download opens regular files and refuses everything else', async () => {
    const tree = await makeTree();
    try {
        const access = createFileAccess({ roots: [tree.root] });
        const file = await access.download(join(tree.root, 'alpha.txt'));
        assert.equal(file.name, 'alpha.txt');
        assert.equal(file.size, 5);
        const chunks = [];
        for await (const chunk of file.open()) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), 'alpha');

        await assert.rejects(access.download(tree.root), (error) => {
            assert.equal(error.status, 400);
            assert.equal(error.code, 'not-a-file');
            return true;
        });
        await assert.rejects(access.download(join(tree.root, 'missing.txt')), (error) => error.code === 'not-found');
    } finally {
        await tree.cleanup();
    }
});

test('places reports home, cwd and allowed roots', async () => {
    const tree = await makeTree();
    try {
        const access = createFileAccess({ roots: [tree.root], home: tree.root });
        const places = access.places();
        assert.equal(places.home, tree.root);
        // The server directory is outside the narrowed root, so it is withheld.
        assert.equal(places.cwd, '');
        assert.deepEqual(places.roots, [tree.root]);
        // Breadcrumbs stop at the configured root, so no crumb can leave it.
        const listing = await access.list(join(tree.root, 'nested'));
        assert.deepEqual(listing.breadcrumbs.map((crumb) => crumb.path), [tree.root, join(tree.root, 'nested')]);

        // Both shortcuts disappear when neither is reachable.
        const narrow = createFileAccess({ roots: [join(tree.root, 'nested')], home: tree.root });
        assert.equal(narrow.places().home, '');
        assert.equal(narrow.places().cwd, '');
    } finally {
        await tree.cleanup();
    }
});

test('contentDisposition keeps non-ASCII names via RFC 5987', () => {
    const header = contentDisposition('报告.txt');
    assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    assert.ok(!header.includes('"报告'));
    assert.equal(encodeRfc5987("a b'c(d)"), 'a%20b%27c%28d%29');
});
