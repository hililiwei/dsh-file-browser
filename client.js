/**
 * @local/dsh-file-browser — browser half.
 *
 * Static Client-module artifact: the shell materializes this factory through
 * `window.__ModuleLoader__.load`, so it may only `require('react')`; browser
 * globals are available. It registers one left-sidebar entry
 * (`sidebar.panellist`, id `file-browser`) and the main panel of the same id
 * (`main`, key `file-browser`), which browses the Host filesystem through the
 * routes under `/api/file-browser/` and downloads files.
 *
 * Styling: the stylesheet is installed from `apply` inside `ctx.effect`, so
 * unloading the plugin removes it. A runtime that exposes the `styles` service
 * gets `styles.insert(css)`; the static Module Loader lane has no such service,
 * so the fallback owns one plugin-tagged `<style>` element. Every class is
 * prefixed `fb-` and every color is a `--dsw-alias-*` theme token, so light and
 * dark themes both work without literal colors.
 *
 * Scope: browse and download only. There is no preview, no upload, and no write
 * path; the page never reads file contents into the UI.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-file-browser',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Locale namespace owned by this plugin. */
    const NS = 'file-browser';
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'file-browser';
    /** Same-origin data API registered by the Host half. */
    const API_BASE = '/api/file-browser';
    /** Above this size the transfer is handed to the browser's own download. */
    const LARGE_FILE_BYTES = 128 * 1024 * 1024;

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------

    /** Both dictionaries are registered at once; a switch re-renders the page. */
    const DICTIONARIES = {
      zh: {
        panel: '文件浏览',
        title: '文件浏览',
        subtitle: '浏览运行 DSH 的主机（WSL）目录并下载文件',
        up: '上一级',
        home: '主目录',
        refresh: '刷新',
        pathLabel: '路径',
        pathPlaceholder: '输入绝对路径后回车，例如 /home/you/projects',
        go: '前往',
        showHidden: '显示隐藏文件',
        filterPlaceholder: '筛选当前目录',
        filterLabel: '筛选',
        placesTitle: '常用位置',
        placeRoot: '根目录',
        placeHome: '主目录',
        placeCwd: '服务当前目录',
        placeSession: '会话目录',
        colName: '名称',
        colSize: '大小',
        colModified: '修改时间',
        colActions: '操作',
        download: '下载',
        downloading: '正在下载 {name}…',
        downloaded: '已下载 {name}',
        downloadStarted: '已交给浏览器下载 {name}',
        downloadingPct: '正在下载 {name}（{percent}%）',
        backToLast: '返回上一处',
        loading: '正在读取目录…',
        empty: '此目录为空',
        emptyFilter: '已加载的条目中没有匹配「{filter}」的',
        hiddenOnly: '此目录只有隐藏文件。',
        errorTitle: '无法打开该目录',
        retry: '重试',
        symlink: '链接',
        kindOther: '特殊文件',
        kindUnreadable: '无法读取',
        kindBroken: '链接失效',
        truncated: '目录项过多，仅显示前 {count} 项',
        count: '共 {total} 项',
        countOne: '共 1 项',
        countFiltered: '显示 {shown} / {total} 项',
        notDownloadable: '该条目不是普通文件，无法下载',
        downloadFailed: '下载失败：{message}',
        errNetwork: '无法连接到 DSH 主机，请检查连接后重试。',
        sortBy: '按{column}排序',
        openDirectory: '打开 {name}',
        downloadFile: '下载 {name}',
        readOnlyNote: '只读浏览，不会修改任何文件。',
        dismiss: '关闭',
        downloadThisFile: '下载该文件',
        filePathHint: '这个路径是一个文件，可以直接下载。',
      },
      en: {
        panel: 'Files',
        title: 'Files',
        subtitle: 'Browse the WSL host that runs DSH and download files',
        up: 'Up',
        home: 'Home',
        refresh: 'Refresh',
        pathLabel: 'Path',
        pathPlaceholder: 'Type an absolute path and press Enter, e.g. /home/you/projects',
        go: 'Go',
        showHidden: 'Show hidden files',
        filterPlaceholder: 'Filter this directory',
        filterLabel: 'Filter',
        placesTitle: 'Places',
        placeRoot: 'Root',
        placeHome: 'Home',
        placeCwd: 'Server directory',
        placeSession: 'Session directory',
        colName: 'Name',
        colSize: 'Size',
        colModified: 'Modified',
        colActions: 'Actions',
        download: 'Download',
        downloading: 'Downloading {name}…',
        downloaded: 'Downloaded {name}',
        downloadStarted: 'Handed {name} to the browser',
        downloadingPct: 'Downloading {name} ({percent}%)',
        backToLast: 'Back to previous',
        loading: 'Reading the directory…',
        empty: 'This directory is empty',
        emptyFilter: 'No loaded item matches “{filter}”',
        hiddenOnly: 'This directory holds only hidden files.',
        errorTitle: 'This directory cannot be opened',
        retry: 'Retry',
        symlink: 'Link',
        kindOther: 'Special file',
        kindUnreadable: 'Unreadable',
        kindBroken: 'Broken link',
        truncated: 'Too many entries; showing the first {count}',
        count: '{total} items',
        countOne: '1 item',
        countFiltered: '{shown} of {total} items',
        notDownloadable: 'This entry is not a regular file and cannot be downloaded',
        downloadFailed: 'Download failed: {message}',
        errNetwork: 'The DSH host could not be reached. Check the connection and retry.',
        sortBy: 'Sort by {column}',
        openDirectory: 'Open {name}',
        downloadFile: 'Download {name}',
        readOnlyNote: 'Read-only browsing; no file is modified.',
        dismiss: 'Dismiss',
        downloadThisFile: 'Download this file',
        filePathHint: 'That path is a file, so it can be downloaded directly.',
      },
    };

    /** Client context captured in `apply`, used by the locale hook. */
    let runtimeContext = null;
    /**
     * @param {unknown} tag raw locale id
     * @returns {'zh' | 'en'} the dictionary this plugin ships
     */
    function normalizeLocale(tag) {
      return typeof tag === 'string' && tag.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    /** @returns {'zh' | 'en'} the shell's current locale, read on demand */
    function readLocale() {
      try {
        const snapshot = runtimeContext === null ? null : runtimeContext.locale.getSnapshot();
        const tag = snapshot?.active ?? snapshot?.locale ?? snapshot?.lang;
        if (typeof tag === 'string' && tag !== '') return normalizeLocale(tag);
      } catch (error) {
        // A runtime without a locale snapshot keeps the English default.
      }
      return 'en';
    }

    /**
     * Resolve one dictionary entry with `{name}` interpolation.
     *
     * @param {'zh' | 'en'} tag locale id
     * @param {string} key dictionary key
     * @param {Record<string, string | number>} [vars] interpolation values
     * @returns {string} localized text
     */
    function translate(tag, key, vars) {
      const dictionary = DICTIONARIES[tag] ?? DICTIONARIES.en;
      let value = dictionary[key] ?? DICTIONARIES.en[key] ?? key;
      if (vars !== undefined) {
        for (const [name, replacement] of Object.entries(vars)) {
          value = value.replaceAll(`{${name}}`, String(replacement));
        }
      }
      return value;
    }

    /** @returns {string} BCP-47 tag for `Intl` formatting */
    function localeTag(tag) {
      return tag === 'zh' ? 'zh-CN' : 'en-US';
    }

    /**
     * Subscribe React state to the shell locale so a switch re-renders the page.
     * @returns {'zh' | 'en'} the active dictionary
     */
    function useActiveLocale() {
      const [tag, setTag] = useState(readLocale);
      useEffect(() => {
        if (runtimeContext === null || typeof runtimeContext.locale?.subscribe !== 'function') {
          return undefined;
        }
        setTag(readLocale());
        const unsubscribe = runtimeContext.locale.subscribe(() => setTag(readLocale()));
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
      }, []);
      return tag;
    }

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------

    /**
     * @param {number | null} bytes file size
     * @param {'zh' | 'en'} tag locale id
     * @returns {string} human-readable size, or an em dash for directories
     */
    function formatSize(bytes, tag) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
      try {
        return `${new Intl.NumberFormat(localeTag(tag), { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
      } catch (error) {
        return `${value.toFixed(digits)} ${units[unit]}`;
      }
    }

    /**
     * @param {number | null} epochMs modification time
     * @param {'zh' | 'en'} tag locale id
     * @returns {string} localized date and time
     */
    function formatTime(epochMs, tag) {
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
      try {
        return new Intl.DateTimeFormat(localeTag(tag), {
          dateStyle: 'short',
          timeStyle: 'short',
          hour12: false,
        }).format(new Date(epochMs));
      } catch (error) {
        return new Date(epochMs).toISOString();
      }
    }

    /**
     * @param {number} total item count
     * @param {'zh' | 'en'} tag locale id
     * @returns {string} grouped number
     */
    function formatCount(total, tag) {
      try {
        return new Intl.NumberFormat(localeTag(tag)).format(total);
      } catch (error) {
        return String(total);
      }
    }

    // ---------------------------------------------------------------------
    // Data access
    // ---------------------------------------------------------------------

    /**
     * @param {string} endpoint API suffix such as `/list`
     * @param {Record<string, string>} params query values
     * @returns {string} same-origin URL
     */
    function apiUrl(endpoint, params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) query.set(key, value);
      const text = query.toString();
      return `${API_BASE}${endpoint}${text === '' ? '' : `?${text}`}`;
    }

    /**
     * One failure with a machine code, so the page can localize transport
     * problems and show the Host's own bilingual sentence otherwise.
     *
     * @param {string} code machine code
     * @param {string} message message
     * @param {number} [status] HTTP status
     * @returns {Error}
     */
    function apiError(code, message, status) {
      const error = new Error(message === '' ? code : message);
      error.code = code;
      error.status = status;
      return error;
    }

    /**
     * GET one JSON endpoint and unwrap the `{ ok, value }` envelope.
     *
     * @param {string} endpoint API suffix
     * @param {Record<string, string>} params query values
     * @param {AbortSignal} [signal] cancellation
     * @returns {Promise<any>} the envelope value
     */
    async function getJson(endpoint, params, signal) {
      let response;
      try {
        response = await fetch(apiUrl(endpoint, params), {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal,
        });
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
          const aborted = apiError('aborted', 'aborted');
          aborted.aborted = true;
          throw aborted;
        }
        throw apiError('network', '');
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const failure = payload !== null && typeof payload === 'object' ? payload.error : null;
        const message = failure !== null && typeof failure === 'object' && typeof failure.message === 'string'
          ? failure.message
          : `HTTP ${response.status}`;
        throw apiError(failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : 'http', message, response.status);
      }
      return payload.value;
    }

    /**
     * @param {unknown} error thrown value
     * @param {(key: string) => string} t translator
     * @returns {string} user-facing sentence
     */
    function describeError(error, t) {
      if (error === null || error === undefined) return t('errNetwork');
      if (typeof error === 'object' && error.code === 'network') return t('errNetwork');
      const message = error instanceof Error ? error.message : String(error);
      return message === '' ? t('errNetwork') : message;
    }

    /**
     * Hand one URL to the browser's download machinery. The anchor stays
     * detached: no node is added to the host document.
     *
     * @param {string} href same-origin route or object URL
     * @param {string} name suggested file name
     */
    function triggerBrowserDownload(href, name) {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = name;
      anchor.rel = 'noopener';
      anchor.click();
    }

    /**
     * Read a download response into a Blob, reporting bytes read when the size
     * is known so a multi-megabyte transfer is not a silent wait.
     *
     * @param {Response} response download response
     * @param {(loaded: number, total: number) => void} [onProgress] progress sink
     * @returns {Promise<Blob>} the body
     */
    async function readBody(response, onProgress) {
      const stream = response.body;
      const total = Number(response.headers.get('content-length') ?? '');
      if (stream === null || stream === undefined || typeof stream.getReader !== 'function') {
        return response.blob();
      }
      const reader = stream.getReader();
      const chunks = [];
      let loaded = 0;
      let reported = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined || value === null) continue;
        chunks.push(value);
        loaded += value.byteLength ?? value.length ?? 0;
        const now = Date.now();
        if (onProgress !== undefined && Number.isFinite(total) && total > 0 && now - reported > 120) {
          reported = now;
          onProgress(loaded, total);
        }
      }
      return new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    /**
     * @param {number} size square edge in pixels
     * @param {string[]} paths stroke-only path data
     * @param {string} [className] extra class
     * @returns {object} SVG element
     */
    function strokeIcon(size, paths, className) {
      return h('svg', {
        className,
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }, paths.map((d, index) => h('path', {
        key: index,
        d,
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: 'none',
      })));
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function FolderIcon(props) {
      return strokeIcon(props?.size ?? 16, [
        'M1.9 4.4A1.4 1.4 0 0 1 3.3 3h2.9l1.3 1.55h5.2a1.4 1.4 0 0 1 1.4 1.4v5.65a1.4 1.4 0 0 1-1.4 1.4H3.3a1.4 1.4 0 0 1-1.4-1.4z',
      ], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function FileIcon(props) {
      return strokeIcon(props?.size ?? 16, [
        'M4.1 2.1h4.6l3.2 3.2v8.6H4.1z',
        'M8.7 2.1v3.3h3.3',
      ], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function DownloadIcon(props) {
      return strokeIcon(props?.size ?? 16, [
        'M8 2.4v7.4',
        'M5.1 7.1 8 10l2.9-2.9',
        'M3 13.1h10',
      ], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function UpIcon(props) {
      return strokeIcon(props?.size ?? 16, ['M8 12.6V3.6', 'M4.3 7.3 8 3.6l3.7 3.7'], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function HomeIcon(props) {
      return strokeIcon(props?.size ?? 16, [
        'M2.4 7.4 8 2.5l5.6 4.9',
        'M3.9 6.7v6.6h8.2V6.7',
      ], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function RefreshIcon(props) {
      return strokeIcon(props?.size ?? 16, [
        'M13.2 8a5.2 5.2 0 1 1-1.6-3.7',
        'M13.4 2.6v3.2h-3.2',
      ], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function LinkIcon(props) {
      return strokeIcon(props?.size ?? 16, [
        'M6.6 9.4 9.4 6.6',
        'M7.6 4.6 8.5 3.7a2.4 2.4 0 0 1 3.4 3.4l-.9.9',
        'M8.4 11.4l-.9.9a2.4 2.4 0 0 1-3.4-3.4l.9-.9',
      ], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function ChevronIcon(props) {
      return strokeIcon(props?.size ?? 16, ['M6.3 3.6 9.9 8l-3.6 4.4'], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function AlertIcon(props) {
      return strokeIcon(props?.size ?? 16, [
        'M8 2.6 13.7 12.8H2.3z',
        'M8 6.4v3.1',
        'M8 11.4h.01',
      ], props?.className);
    }

    /** @param {{ size?: number, className?: string }} [props] */
    function CheckIcon(props) {
      return strokeIcon(props?.size ?? 16, ['M3.2 8.4 6.4 11.6 12.8 5.2'], props?.className);
    }

    /** The panel/header mark: a folder with a download arrow. */
    function PanelGlyph(props) {
      return strokeIcon(props?.size ?? 16, [
        'M2.2 4.7A1.4 1.4 0 0 1 3.6 3.3h2.8l1.3 1.5h4.7a1.4 1.4 0 0 1 1.4 1.4v6.1a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4z',
        'M8 6.8v3.6',
        'M6.5 8.9 8 10.4l1.5-1.5',
      ], props?.className);
    }

    // ---------------------------------------------------------------------
    // Stylesheet
    // ---------------------------------------------------------------------

    /** One prefixed stylesheet; every color is a theme token. */
    const CSS = `
.fb-page {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.fb-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  /* Clear the macOS traffic lights and the Windows caption, as host pages do. */
  padding: calc(16px + var(--dsh-frame-top-clearance, 0px)) 20px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.fb-headerMark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-brand-primary);
  flex: none;
}
.fb-headerBody { min-width: 0; flex: 1 1 auto; }
.fb-title { margin: 0; font-size: 15px; font-weight: 600; }
.fb-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.fb-headerActions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; justify-content: flex-end; }

.fb-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex-wrap: wrap;
  flex: none;
}
.fb-pathForm { display: flex; align-items: center; gap: 6px; flex: 1 1 260px; min-width: 0; }
.fb-input {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  /* A field below 13px makes iOS Safari zoom the viewport on focus. */
  font-size: max(13px, 1em);
  padding: 6px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
}
.fb-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.fb-input::placeholder { color: var(--dsw-alias-label-secondary); }
.fb-filter { flex: 0 1 180px; }
.fb-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; white-space: nowrap; }
.fb-checkbox { accent-color: var(--dsw-alias-brand-primary); width: 14px; height: 14px; margin: 0; }

.fb-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.fb-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.fb-button[disabled] { opacity: 0.5; cursor: default; }
@media (hover: hover) {
  .fb-button:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover); }
  .fb-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .fb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .fb-place:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .fb-name:hover { color: var(--dsw-alias-brand-primary); }
}
.fb-buttonPrimary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 600;
}
@media (hover: hover) {
  .fb-buttonPrimary:hover:not([disabled]) { background: var(--dsw-alias-brand-primary); opacity: 0.9; }
}
.fb-buttonSmall { padding: 3px 8px; font-size: 12px; }
.fb-iconButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.fb-iconButton:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.fb-iconButton[disabled] { opacity: 0.4; cursor: default; }
@media (hover: hover) {
  .fb-iconButton:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
}

.fb-crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding: 6px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  flex: none;
}
.fb-crumb {
  padding: 2px 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-crumb:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.fb-crumbCurrent { color: var(--dsw-alias-label-primary); font-weight: 600; }
.fb-crumbSep { color: var(--dsw-alias-label-secondary); opacity: 0.7; display: flex; }

.fb-body { flex: 1 1 auto; min-height: 0; display: flex; }
.fb-places {
  width: 208px;
  flex: none;
  border-right: 1px solid var(--dsw-alias-border-l1);
  overflow-y: auto;
  padding: 10px 8px;
  box-sizing: border-box;
}
.fb-placesTitle {
  margin: 0 0 6px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
}
.fb-place {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.fb-place:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.fb-placeIcon { color: var(--dsw-alias-label-secondary); display: flex; flex: none; }
.fb-placeBody { min-width: 0; display: flex; flex-direction: column; }
.fb-placeName { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-placePath { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fb-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.fb-main:focus { outline: none; }
.fb-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 20px 0;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  font-size: 12px;
  flex: none;
}
.fb-noticeInfo { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.fb-noticeOk { border-color: var(--dsw-alias-state-success-primary); }
.fb-noticeError { border-color: var(--dsw-alias-state-error-primary); }
.fb-noticeOk > svg { color: var(--dsw-alias-state-success-primary); }
.fb-noticeError > svg { color: var(--dsw-alias-state-error-primary); }
.fb-noticeText { min-width: 0; overflow-wrap: anywhere; }
.fb-noticeClose { margin-left: auto; flex: none; }

.fb-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 0 8px; }
.fb-table { width: 100%; min-width: 300px; border-collapse: collapse; table-layout: fixed; }
.fb-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dsw-alias-bg-base);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  padding: 0;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.fb-thButton {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.fb-thButton:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.fb-thActive { color: var(--dsw-alias-label-primary); }
.fb-sortIcon { transition: transform 120ms ease; opacity: 0.9; }
.fb-sortAsc { transform: rotate(-90deg); }
.fb-sortDesc { transform: rotate(90deg); }

.fb-colName { width: auto; }
.fb-colSize { width: 108px; }
.fb-colModified { width: 168px; }
.fb-colActions { width: 108px; }

.fb-table td {
  padding: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  vertical-align: middle;
}
.fb-cellName { padding: 0 10px; }
.fb-name {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 7px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.fb-name:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; border-radius: 4px; }
.fb-name[disabled] { cursor: default; opacity: 0.6; }
.fb-nameIcon { color: var(--dsw-alias-label-secondary); display: flex; flex: none; }
.fb-nameIconDir { color: var(--dsw-alias-brand-primary); }
.fb-nameText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fb-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary);
}
.fb-size, .fb-mtime { padding: 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fb-cellActions { padding: 0 10px; text-align: right; }

.fb-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 20px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.fb-stateIcon { color: var(--dsw-alias-label-secondary); }
.fb-stateTitle { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.fb-stateText { max-width: 520px; overflow-wrap: anywhere; }
.fb-stateActions { display: flex; gap: 8px; margin-top: 4px; }
.fb-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  border-radius: 50%;
  animation: fb-spin 800ms linear infinite;
}
@keyframes fb-spin { to { transform: rotate(360deg); } }
.fb-spinnerSmall { width: 12px; height: 12px; border-width: 2px; }
.fb-loadingBar {
  height: 2px;
  flex: none;
  background-image: linear-gradient(90deg, transparent, var(--dsw-alias-brand-primary), transparent);
  background-size: 200% 100%;
  animation: fb-slide 1.1s linear infinite;
}
@keyframes fb-slide { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .fb-spinner { animation-duration: 2400ms; }
  .fb-loadingBar { animation-duration: 3200ms; }
  .fb-sortIcon { transition: none; }
}

.fb-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 7px 20px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  flex: none;
}
.fb-footerMeta { margin-left: auto; }

.fb-srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* The center column narrows independently of the viewport when both sidebars
   are open, so columns collapse on the panel's own width. */
@container (max-width: 720px) {
  .fb-places { display: none; }
  .fb-colSize, .fb-colModified { display: none; }
  .fb-colActions { width: 84px; }
  .fb-header { flex-wrap: wrap; }
  .fb-headerActions { width: 100%; justify-content: flex-start; }
}
@container (max-width: 460px) {
  .fb-header, .fb-toolbar, .fb-footer, .fb-crumbs { padding-left: 12px; padding-right: 12px; }
  .fb-filter { flex-basis: 120px; }
}
@media (max-width: 760px) {
  /* Fallback for a runtime without container queries. */
  .fb-places { display: none; }
  .fb-colSize, .fb-colModified { display: none; }
  .fb-colActions { width: 84px; }
}
`;

    /**
     * Install the stylesheet, preferring the runtime service.
     * @param {object} ctx client context
     * @returns {() => void} disposer
     */
    function installStylesheet(ctx) {
      let styles;
      try {
        styles = typeof ctx.get === 'function' ? ctx.get('styles') : undefined;
      } catch (error) {
        styles = undefined;
      }
      if (styles !== undefined && styles !== null && typeof styles.insert === 'function') {
        const dispose = styles.insert(CSS);
        return typeof dispose === 'function' ? dispose : function () {};
      }
      if (typeof document === 'undefined' || document.head === null) return function () {};
      const tag = document.createElement('style');
      tag.setAttribute('data-dsh-file-browser-styles', '1');
      tag.setAttribute('data-plugin', '@local/dsh-file-browser');
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    // ---------------------------------------------------------------------
    // Session directory
    // ---------------------------------------------------------------------

    /**
     * The main Session's working directory, read through the slot's selector
     * hook so the page opens where the conversation works.
     *
     * @param {object} props slot props
     * @returns {string} absolute directory, or an empty string
     */
    function sessionWorkingDirectory(props) {
      const useSessions = props !== null && props !== undefined ? props.useSessions : undefined;
      if (typeof useSessions !== 'function') return '';
      try {
        const snapshot = useSessions(function selectMainSession(state) {
          const byId = state !== null && state !== undefined ? state.byId : undefined;
          if (byId === null || byId === undefined) return undefined;
          for (const row of Object.values(byId)) {
            if (row !== null && row !== undefined
              && typeof row.cwd === 'string' && row.cwd !== ''
              && (row.retainedBy?.mainView ?? 0) > 0) {
              return row.cwd;
            }
          }
          return undefined;
        });
        return typeof snapshot === 'string' ? snapshot : '';
      } catch (error) {
        return '';
      }
    }

    // ---------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------

    /**
     * @param {number | null} a nullable number
     * @param {number | null} b nullable number
     * @returns {number} ascending comparison with nulls last
     */
    function compareNullable(a, b) {
      const left = typeof a === 'number' && Number.isFinite(a) ? a : null;
      const right = typeof b === 'number' && Number.isFinite(b) ? b : null;
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    }

    /**
     * The shell renders only the selected main panel, so switching to the
     * conversation and back would reset the browser. This module keeps the last
     * position for the life of the page.
     */
    const PAGE_MEMORY = { path: '', filter: '', sort: null, hidden: null };

    /**
     * @param {string} target absolute path
     * @returns {string} final path segment
     */
    function baseNameOf(target) {
      const trimmed = target.replace(/\/+$/, '');
      return trimmed.split('/').pop() || target;
    }

    /**
     * @param {string[]} roots admitted roots
     * @param {string} target absolute path
     * @returns {boolean} whether the path is inside one of the roots
     */
    function isUnderRoots(roots, target) {
      for (const root of roots) {
        if (root === target) return true;
        const prefix = root.endsWith('/') ? root : root + '/';
        if (target.startsWith(prefix)) return true;
      }
      return false;
    }

    /**
     * The panel body: header, path bar, breadcrumbs, places and the listing.
     * @param {object} props slot props (standard shell hooks)
     * @returns {object} React element
     */
    function FileBrowserPage(props) {
      const sessionCwd = sessionWorkingDirectory(props);
      const tag = useActiveLocale();
      const t = useCallback(function translateForPage(key, vars) {
        return translate(tag, key, vars);
      }, [tag]);

      const [places, setPlaces] = useState(null);
      const [placesToken, setPlacesToken] = useState(0);
      const [path, setPath] = useState(PAGE_MEMORY.path);
      const [draft, setDraft] = useState(PAGE_MEMORY.path);
      const [listing, setListing] = useState(null);
      const [lastGood, setLastGood] = useState('');
      const [phase, setPhase] = useState('boot');
      const [failure, setFailure] = useState(null);
      const [hidden, setHidden] = useState(PAGE_MEMORY.hidden === true);
      const [filter, setFilter] = useState(PAGE_MEMORY.filter);
      const [sort, setSort] = useState(PAGE_MEMORY.sort ?? { key: 'name', direction: 1 });
      const [notice, setNotice] = useState(null);
      const [downloading, setDownloading] = useState('');
      const [reloadToken, setReloadToken] = useState(0);
      const uid = React.useId();
      const booted = useRef(false);
      const sessionCwdRef = useRef(sessionCwd);
      const mainRef = useRef(null);
      const focusAfterLoad = useRef(false);

      sessionCwdRef.current = sessionCwd;

      // Places once per mount (and again on Retry), then open the first folder.
      useEffect(() => {
        let cancelled = false;
        getJson('/places', {})
          .then((value) => {
            if (cancelled) return;
            setPlaces(value);
            if (PAGE_MEMORY.hidden === null) setHidden(value.showHidden === true);
            if (!booted.current) {
              booted.current = true;
              const roots = Array.isArray(value.roots) && value.roots.length > 0 ? value.roots : ['/'];
              const session = sessionCwdRef.current;
              const reachable = (candidate) => typeof candidate === 'string' && candidate !== '' && isUnderRoots(roots, candidate);
              const start = PAGE_MEMORY.path
                || (reachable(session) ? session : '')
                || (reachable(value.cwd) ? value.cwd : '')
                || (reachable(value.home) ? value.home : '')
                || roots[0]
                || '/';
              setPath(start);
              setPhase('loading');
            }
          })
          .catch((error) => {
            if (cancelled) return;
            setFailure(error);
            setPhase('error');
          });
        return () => { cancelled = true; };
      }, [placesToken]);

      // Read the current directory whenever the path or the hidden toggle moves.
      useEffect(() => {
        if (path === '') return undefined;
        const controller = new AbortController();
        setPhase('loading');
        setFailure(null);
        setDraft(path);
        getJson('/list', { path, hidden: hidden ? '1' : '0' }, controller.signal)
          .then((value) => {
            setListing(value);
            setDraft(value.path);
            setLastGood(value.path);
            setPhase('ready');
            if (focusAfterLoad.current) {
              focusAfterLoad.current = false;
              if (mainRef.current !== null && typeof mainRef.current.focus === 'function') mainRef.current.focus();
            }
          })
          .catch((error) => {
            if (error !== null && error !== undefined && error.aborted === true) return;
            // Drop the previous directory's chrome so no crumb, count or "Up"
            // still points at a directory the error is not about.
            setListing(null);
            setFailure(error);
            setPhase('error');
          });
        return () => controller.abort();
      }, [path, hidden, reloadToken]);

      // A non-error notice clears itself so it never becomes permanent chrome.
      useEffect(() => {
        if (notice === null || notice.tone === 'error' || downloading !== '') return undefined;
        const timer = window.setTimeout(() => setNotice(null), 5000);
        return () => window.clearTimeout(timer);
      }, [notice, downloading]);

      const navigate = useCallback((next) => {
        if (typeof next !== 'string' || next.trim() === '') return;
        const target = next.trim();
        PAGE_MEMORY.path = target;
        PAGE_MEMORY.filter = '';
        focusAfterLoad.current = true;
        setFilter('');
        setPath(target);
      }, []);

      const reload = useCallback(() => {
        if (path === '') {
          setPlacesToken((token) => token + 1);
          return;
        }
        setReloadToken((token) => token + 1);
      }, [path]);

      const download = useCallback(async (entry) => {
        if (entry === null || entry === undefined) return;
        if (entry.kind !== 'file') {
          setNotice({ tone: 'error', text: t('notDownloadable') });
          return;
        }
        if (downloading !== '') return;
        setDownloading(entry.path);
        setNotice({ tone: 'info', text: t('downloading', { name: entry.name }) });
        try {
          const response = await fetch(apiUrl('/download', { path: entry.path }), {
            method: 'GET',
            credentials: 'same-origin',
          });
          if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
              const payload = await response.json();
              if (payload !== null && payload !== undefined && payload.error !== null && payload.error !== undefined) {
                if (typeof payload.error.message === 'string' && payload.error.message !== '') {
                  message = payload.error.message;
                }
              }
            } catch (error) {
              // The body was not JSON; the status line is all we have.
            }
            throw apiError('http', message, response.status);
          }
          const length = Number(response.headers.get('content-length') ?? '');
          if (Number.isFinite(length) && length > LARGE_FILE_BYTES) {
            // Hand a large transfer to the browser instead of buffering it.
            try {
              if (response.body !== null) await response.body.cancel();
            } catch (error) {
              // The negotiated stream is already gone; nothing to release.
            }
            triggerBrowserDownload(apiUrl('/download', { path: entry.path }), entry.name);
            setNotice({ tone: 'ok', text: t('downloadStarted', { name: entry.name }) });
            return;
          }
          const blob = await readBody(response, (loaded, total) => {
            const percent = Math.min(99, Math.max(1, Math.round((loaded / total) * 100)));
            setNotice({ tone: 'info', text: t('downloadingPct', { name: entry.name, percent }) });
          });
          const objectUrl = URL.createObjectURL(blob);
          triggerBrowserDownload(objectUrl, entry.name);
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
          setNotice({ tone: 'ok', text: t('downloaded', { name: entry.name }) });
        } catch (error) {
          setNotice({ tone: 'error', text: t('downloadFailed', { message: describeError(error, t) }) });
        } finally {
          setDownloading('');
        }
      }, [downloading, t]);

      const entries = listing === null || listing.entries === undefined ? [] : listing.entries;
      const rows = useMemo(function sortAndFilter() {
        const collator = new Intl.Collator(localeTag(tag), { numeric: true, sensitivity: 'base' });
        const needle = filter.trim().toLowerCase();
        const filtered = needle === '' ? entries : entries.filter((entry) => entry.name.toLowerCase().includes(needle));
        return filtered.slice().sort((a, b) => {
          const rankA = a.kind === 'dir' ? 0 : 1;
          const rankB = b.kind === 'dir' ? 0 : 1;
          if (rankA !== rankB) return rankA - rankB;
          let result = 0;
          if (sort.key === 'size') result = compareNullable(a.size, b.size);
          else if (sort.key === 'mtime') result = compareNullable(a.mtimeMs, b.mtimeMs);
          else result = collator.compare(a.name, b.name);
          if (result === 0) result = collator.compare(a.name, b.name);
          return sort.direction === -1 ? -result : result;
        });
      }, [entries, filter, sort, tag]);

      const parent = listing === null ? null : listing.parent;
      const crumbs = listing === null || listing.breadcrumbs === undefined ? [] : listing.breadcrumbs;
      // The home shortcut only survives when a configured root admits it.
      const homeTarget = places === null || typeof places.home !== 'string' ? '' : places.home;
      const homeReachable = homeTarget !== ''
        && isUnderRoots(Array.isArray(places.roots) && places.roots.length > 0 ? places.roots : ['/'], homeTarget);

      /**
       * @param {string} key sort column id
       * @returns {void}
       */
      const toggleSort = (key) => {
        setSort((current) => {
          const next = current.key === key
            ? { key, direction: current.direction === 1 ? -1 : 1 }
            : { key, direction: key === 'name' ? 1 : -1 };
          PAGE_MEMORY.sort = next;
          return next;
        });
      };

      /**
       * @param {string} key sort column id
       * @param {string} label column label
       * @returns {object} header cell
       */
      const sortHeader = (key, label, className) => {
        const active = sort.key === key;
        return h('th', {
          key,
          scope: 'col',
          className,
          'aria-sort': active ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none',
        }, h('button', {
          type: 'button',
          className: active ? 'fb-thButton fb-thActive' : 'fb-thButton',
          onClick: () => toggleSort(key),
          title: t('sortBy', { column: label }),
        },
          label,
          active
            ? h(ChevronIcon, { size: 12, className: `fb-sortIcon ${sort.direction === 1 ? 'fb-sortAsc' : 'fb-sortDesc'}` })
            : null,
        ));
      };

      /** @param {object} entry listing entry @returns {object} one table row */
      const renderRow = (entry) => {
        const isDirectory = entry.kind === 'dir';
        const isFile = entry.kind === 'file';
        const disabled = entry.kind === 'unreadable' || entry.kind === 'broken' || entry.kind === 'symlink';
        const badges = [];
        if (entry.symlink === true) {
          badges.push(h('span', { key: 'link', className: 'fb-badge', title: entry.linkTo ?? '' },
            h(LinkIcon, { size: 10 }), t('symlink')));
        }
        if (entry.kind === 'other') badges.push(h('span', { key: 'other', className: 'fb-badge' }, t('kindOther')));
        if (entry.kind === 'unreadable') badges.push(h('span', { key: 'unreadable', className: 'fb-badge' }, t('kindUnreadable')));
        if (entry.kind === 'broken') badges.push(h('span', { key: 'broken', className: 'fb-badge' }, t('kindBroken')));

        return h('tr', { key: entry.path, className: 'fb-row' },
          h('td', { className: 'fb-cellName' },
            h('button', {
              type: 'button',
              className: 'fb-name',
              onClick: () => {
                if (isDirectory) navigate(entry.path);
                else download(entry);
              },
              disabled: disabled || (isFile && downloading !== ''),
              title: entry.path,
              'aria-label': isDirectory ? t('openDirectory', { name: entry.name }) : undefined,
            },
              h('span', { className: isDirectory ? 'fb-nameIcon fb-nameIconDir' : 'fb-nameIcon' },
                isDirectory ? h(FolderIcon, { size: 15 }) : h(FileIcon, { size: 15 })),
              h('span', { className: 'fb-nameText' }, entry.name),
              ...badges,
            ),
          ),
          h('td', { className: 'fb-size fb-colSize' }, isDirectory ? '—' : formatSize(entry.size, tag)),
          h('td', { className: 'fb-mtime fb-colModified' }, formatTime(entry.mtimeMs, tag)),
          h('td', { className: 'fb-cellActions' },
            isFile
              ? h('button', {
                type: 'button',
                className: 'fb-button fb-buttonSmall',
                onClick: () => download(entry),
                disabled: downloading !== '',
                'aria-label': t('downloadFile', { name: entry.name }),
              },
                downloading === entry.path
                  ? h('span', { className: 'fb-spinner fb-spinnerSmall' })
                  : h(DownloadIcon, { size: 13 }),
                t('download'),
              )
              : null,
          ),
        );
      };

      /** @returns {object} the notice banner, when there is one */
      const renderNotice = () => {
        if (notice === null) return null;
        const tone = notice.tone === 'error' ? 'fb-noticeError' : notice.tone === 'ok' ? 'fb-noticeOk' : 'fb-noticeInfo';
        return h('div', { className: `fb-notice ${tone}`, role: notice.tone === 'error' ? 'alert' : 'status' },
          notice.tone === 'error'
            ? h(AlertIcon, { size: 14 })
            : notice.tone === 'ok'
              ? h(CheckIcon, { size: 14 })
              : null,
          h('span', { className: 'fb-noticeText' }, notice.text),
          notice.tone === 'error'
            ? h('button', {
              type: 'button',
              className: 'fb-button fb-buttonSmall fb-noticeClose',
              onClick: () => setNotice(null),
              title: t('dismiss'),
              'aria-label': t('dismiss'),
            }, '×')
            : null,
        );
      };

      /** @returns {object} the state block for loading and error phases */
      const renderState = () => {
        if (phase === 'error') {
          // A typed path that names a file is one click away from a download,
          // so offer that instead of only an error.
          const fileCandidate = failure !== null && failure !== undefined && failure.code === 'not-a-directory'
            ? { name: baseNameOf(path), path, kind: 'file' }
            : null;
          return h('div', { className: 'fb-state', role: 'alert' },
            h('span', { className: 'fb-stateIcon' }, h(AlertIcon, { size: 26 })),
            h('div', { className: 'fb-stateTitle' }, fileCandidate === null ? t('errorTitle') : t('filePathHint')),
            h('div', { className: 'fb-stateText' }, describeError(failure, t)),
            h('div', { className: 'fb-stateActions' },
              fileCandidate === null
                ? null
                : h('button', {
                  type: 'button',
                  className: 'fb-button fb-buttonPrimary',
                  onClick: () => download(fileCandidate),
                  disabled: downloading !== '',
                }, h(DownloadIcon, { size: 13 }), t('downloadThisFile')),
              h('button', { type: 'button', className: 'fb-button', onClick: reload }, t('retry')),
              lastGood === '' || lastGood === path
                ? null
                : h('button', {
                  type: 'button',
                  className: 'fb-button',
                  onClick: () => navigate(lastGood),
                  title: lastGood,
                }, t('backToLast')),
              homeReachable
                ? h('button', { type: 'button', className: 'fb-button', onClick: () => navigate(homeTarget) }, t('home'))
                : null,
            ),
          );
        }
        return h('div', { className: 'fb-state', 'aria-busy': 'true' },
          h('span', { className: 'fb-spinner' }),
          h('div', { className: 'fb-stateText' }, t('loading')),
        );
      };

      const placeList = useMemo(function collectPlaces() {
        if (places === null) return [];
        const seen = new Set();
        const result = [];
        const push = (label, value, icon) => {
          if (typeof value !== 'string' || value === '' || seen.has(value)) return;
          seen.add(value);
          result.push({ key: value, label, path: value, icon });
        };
        const roots = Array.isArray(places.roots) && places.roots.length > 0 ? places.roots : ['/'];
        const reachable = (value) => typeof value === 'string' && value !== '' && isUnderRoots(roots, value);
        push(t('placeSession'), reachable(sessionCwd) ? sessionCwd : '', 'folder');
        push(t('placeCwd'), reachable(places.cwd) ? places.cwd : '', 'folder');
        push(t('placeHome'), reachable(places.home) ? places.home : '', 'home');
        for (const root of roots) {
          const name = root.split('/').filter((part) => part !== '').pop();
          push(root === '/' ? t('placeRoot') : (name ?? root), root, 'root');
        }
        return result;
      }, [places, sessionCwd, t]);

      return h('div', { className: 'fb-page' },
        h('header', { className: 'fb-header' },
          h('div', { className: 'fb-headerMark' }, h(PanelGlyph, { size: 17 })),
          h('div', { className: 'fb-headerBody' },
            h('h1', { className: 'fb-title' }, t('title')),
            h('p', { className: 'fb-subtitle' }, t('subtitle')),
          ),
          h('div', { className: 'fb-headerActions' },
            h('label', { className: 'fb-check' },
              h('input', {
                type: 'checkbox',
                className: 'fb-checkbox',
                checked: hidden,
                onChange: (event) => {
                  PAGE_MEMORY.hidden = event.target.checked;
                  setHidden(event.target.checked);
                },
              }),
              t('showHidden'),
            ),
            h('button', {
              type: 'button',
              className: 'fb-iconButton',
              onClick: reload,
              title: t('refresh'),
              'aria-label': t('refresh'),
              disabled: phase === 'loading',
            }, h(RefreshIcon, { size: 15 })),
          ),
        ),

        h('div', { className: 'fb-toolbar' },
          h('button', {
            type: 'button',
            className: 'fb-button',
            onClick: () => { if (parent !== null) navigate(parent); },
            disabled: parent === null,
            title: t('up'),
          }, h(UpIcon, { size: 14 }), t('up')),
          h('button', {
            type: 'button',
            className: 'fb-button',
            onClick: () => { if (homeReachable) navigate(homeTarget); },
            disabled: homeReachable !== true,
            title: t('home'),
          }, h(HomeIcon, { size: 14 }), t('home')),
          h('form', {
            className: 'fb-pathForm',
            onSubmit: (event) => {
              event.preventDefault();
              navigate(draft);
            },
          },
            h('label', { className: 'fb-srOnly', htmlFor: uid + '-path' }, t('pathLabel')),
            h('input', {
              id: uid + '-path',
              type: 'text',
              className: 'fb-input',
              value: draft,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: t('pathPlaceholder'),
              onChange: (event) => setDraft(event.target.value),
            }),
            h('button', {
              type: 'submit',
              className: 'fb-button',
              disabled: draft.trim() === '' || draft.trim() === path,
            }, t('go')),
          ),
          h('label', { className: 'fb-srOnly', htmlFor: uid + '-filter' }, t('filterLabel')),
          h('input', {
            id: uid + '-filter',
            type: 'text',
            className: 'fb-input fb-filter',
            value: filter,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: t('filterPlaceholder'),
            onChange: (event) => {
              PAGE_MEMORY.filter = event.target.value;
              setFilter(event.target.value);
            },
          }),
        ),

        crumbs.length === 0
          ? null
          : h('nav', { className: 'fb-crumbs', 'aria-label': t('pathLabel') },
            crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return h(React.Fragment, { key: `${crumb.path}#${index}` },
                index === 0 ? null : h('span', { className: 'fb-crumbSep', 'aria-hidden': 'true' }, h(ChevronIcon, { size: 11 })),
                h('button', {
                  type: 'button',
                  className: last ? 'fb-crumb fb-crumbCurrent' : 'fb-crumb',
                  onClick: () => navigate(crumb.path),
                  title: crumb.path,
                  'aria-current': last ? 'location' : undefined,
                }, crumb.name),
              );
            }),
          ),

        h('div', { className: 'fb-body' },
          h('aside', { className: 'fb-places' },
            h('h2', { className: 'fb-placesTitle' }, t('placesTitle')),
            placeList.map((place) => h('button', {
              key: place.key,
              type: 'button',
              className: 'fb-place',
              onClick: () => navigate(place.path),
              title: place.path,
            },
              h('span', { className: 'fb-placeIcon' }, place.icon === 'home' ? h(HomeIcon, { size: 14 }) : h(FolderIcon, { size: 14 })),
              h('span', { className: 'fb-placeBody' },
                h('span', { className: 'fb-placeName' }, place.label),
                h('span', { className: 'fb-placePath' }, place.path),
              ),
            )),
          ),
          h('section', { className: 'fb-main', 'aria-label': t('title'), ref: mainRef, tabIndex: -1 },
            renderNotice(),
            phase === 'loading' && listing !== null
              ? h('div', { className: 'fb-loadingBar', 'aria-hidden': 'true' })
              : null,
            phase === 'error' || (phase !== 'ready' && listing === null)
              ? renderState()
              : rows.length === 0
                ? h('div', { className: 'fb-state' },
                  h('div', { className: 'fb-stateText' }, filter.trim() !== ''
                    ? t('emptyFilter', { filter: filter.trim() })
                    : listing !== null && listing.hiddenCount > 0 && hidden !== true
                      ? t('hiddenOnly')
                      : t('empty')),
                  filter.trim() === '' && listing !== null && listing.hiddenCount > 0 && hidden !== true
                    ? h('button', {
                      type: 'button',
                      className: 'fb-button fb-buttonSmall',
                      onClick: () => {
                        PAGE_MEMORY.hidden = true;
                        setHidden(true);
                      },
                    }, t('showHidden'))
                    : null,
                )
                : h('div', { className: 'fb-scroll' },
                  h('table', { className: 'fb-table' },
                    h('thead', null,
                      h('tr', null,
                        sortHeader('name', t('colName'), 'fb-colName'),
                        sortHeader('size', t('colSize'), 'fb-colSize'),
                        sortHeader('mtime', t('colModified'), 'fb-colModified'),
                        h('th', { scope: 'col', className: 'fb-colActions' },
                          h('span', { className: 'fb-srOnly' }, t('colActions'))),
                      ),
                    ),
                    h('tbody', null, rows.map(renderRow)),
                  ),
                ),
            h('footer', { className: 'fb-footer' },
              h('span', null, listing === null
                ? ''
                : filter.trim() === ''
                  ? (listing.total ?? rows.length) === 1
                    ? t('countOne')
                    : t('count', { total: formatCount(listing.total ?? rows.length, tag) })
                  : t('countFiltered', {
                    shown: formatCount(rows.length, tag),
                    total: formatCount(listing.total ?? rows.length, tag),
                  })),
              listing !== null && listing.truncated === true
                ? h('span', null, t('truncated', { count: formatCount(listing.count ?? rows.length, tag) }))
                : null,
              h('span', { className: 'fb-footerMeta' }, t('readOnlyNote')),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Sidebar entry
    // ---------------------------------------------------------------------

    /**
     * The sidebar glyph. The sidebar owns the button, label and selected state;
     * this renders only the icon at the requested size.
     *
     * @param {{ size?: number, className?: string }} props slot props
     * @returns {object} React element
     */
    function FileBrowserIcon(props) {
      return h(PanelGlyph, { size: props?.size ?? 16, className: props?.className });
    }

    // ---------------------------------------------------------------------
    // Plugin registration
    // ---------------------------------------------------------------------

    /**
     * Register the dictionaries, the locale subscriptions, the stylesheet, the
     * sidebar entry and the main page it opens.
     *
     * @param {object} ctx client context
     */
    function apply(ctx) {
      runtimeContext = ctx;

      ctx.effect(function () {
        return ctx.locale.register(NS, DICTIONARIES);
      }, 'file-browser: dictionaries');

      ctx.effect(function () {
        return installStylesheet(ctx);
      }, 'file-browser: stylesheet');

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: function () {
              return translate(readLocale(), 'panel');
            },
            locale: NS,
          },
          FileBrowserIcon,
        );
      });

      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          FileBrowserPage,
        );
      });
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    };
  },
});
