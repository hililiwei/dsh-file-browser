import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

/** Absolute path of the browser half under test. */
const CLIENT = new URL('../client.js', import.meta.url);

/**
 * Evaluate the static Client-module artifact in a minimal browser-like shell
 * and return the module it declares. React is replaced by a stub: this test
 * covers module loading, `apply` wiring and the dictionaries, not rendering.
 *
 * @returns {Promise<object>} the module returned by the factory
 */
async function loadClientModule() {
    let definition = null;
    const previousWindow = globalThis.window;
    globalThis.window = {
        __ModuleLoader__: {
            load(value) {
                definition = value;
            },
        },
    };
    try {
        await import(`${pathToFileURL(CLIENT.pathname).href}?t=${Date.now()}`);
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }

    assert.ok(definition !== null, 'client.js registers one module with the loader');
    assert.equal(definition.id, '@local/dsh-file-browser');

    const react = {
        createElement(type, props, ...children) {
            return { type, props: { ...props, children } };
        },
        Fragment: Symbol('Fragment'),
        useId: () => 'test-id',
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useCallback: (callback) => callback,
        useMemo: (factory) => factory(),
        useRef: (value) => ({ current: value }),
    };
    return definition.factory((name) => {
        assert.equal(name, 'react', 'the browser half imports nothing but react');
        return react;
    });
}

/** @returns {{ ctx: object, registrations: object[], dictionaries: object }} */
function createContext() {
    /** @type {object[]} */
    const registrations = [];
    /** @type {Record<string, object>} */
    const dictionaries = {};
    const ctx = {
        effect(install) {
            return install();
        },
        locale: {
            register(namespace, dictionary) {
                dictionaries[namespace] = dictionary;
                return () => {};
            },
            subscribe() {
                return () => {};
            },
            getSnapshot() {
                return { active: 'zh' };
            },
            bind(namespace) {
                return (key) => dictionaries[namespace]?.[key] ?? key;
            },
        },
        slots: {
            inject(_name, callback) {
                callback();
            },
            register(options, component) {
                registrations.push({ options, component });
                return () => {};
            },
        },
    };
    return { ctx, registrations, dictionaries };
}

test('the browser half declares only the services it uses', async () => {
    const clientModule = await loadClientModule();
    assert.deepEqual(clientModule.inject, ['slots', 'locale']);
    assert.equal(typeof clientModule.apply, 'function');
});

test('apply registers the sidebar entry and the main panel it opens', async () => {
    const clientModule = await loadClientModule();
    const { ctx, registrations } = createContext();
    clientModule.apply(ctx);

    assert.equal(registrations.length, 2);
    const [panel, main] = registrations;
    assert.equal(panel.options.name, 'sidebar.panellist');
    assert.equal(panel.options.id, 'file-browser');
    assert.equal(panel.options.order, 40);
    assert.equal(panel.options.locale, 'file-browser');
    assert.equal(typeof panel.component, 'function');
    assert.equal(panel.options.label(), '文件浏览');

    assert.equal(main.options.name, 'main');
    assert.equal(main.options.key, 'file-browser');
    assert.equal(main.options.locale, 'file-browser');
    assert.equal(typeof main.component, 'function');
});

test('both dictionaries are registered and cover every literal key', async () => {
    const clientModule = await loadClientModule();
    const { ctx, dictionaries } = createContext();
    clientModule.apply(ctx);

    const dictionary = dictionaries['file-browser'];
    assert.ok(dictionary !== undefined, 'the locale namespace is registered');
    const zh = Object.keys(dictionary.zh).sort();
    const en = Object.keys(dictionary.en).sort();
    assert.deepEqual(zh, en, 'both languages expose the same keys');

    const source = await readFile(CLIENT, 'utf8');
    /** @type {Set<string>} */
    const used = new Set();
    for (const match of source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)) used.add(match[1]);
    for (const match of source.matchAll(/translate\([^,]+,\s*'([A-Za-z][A-Za-z0-9]*)'/g)) used.add(match[1]);

    const missing = [...used].filter((key) => !(key in dictionary.zh) || !(key in dictionary.en));
    assert.deepEqual(missing, [], 'every literal key exists in both dictionaries');
    // A guard against a dictionary that silently lost most of its entries.
    assert.ok(zh.length >= 50, `expected a full dictionary, saw ${zh.length} keys`);
});
