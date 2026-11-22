/**
 * Hive Sync — admin UI controller.
 *
 * Vanilla JS, single namespace HSync. Reads HSyncBoot (localized by
 * includes/assets.php) for ajaxUrl + nonce. No jQuery, no React.
 */
(function () {
    'use strict';

    if (typeof window.HSyncBoot === 'undefined') {
        console.error('Hive Sync: HSyncBoot missing — bootstrap failed.');
        return;
    }

    const HSync = {
        state: {
            sources: [],
            mappings: [],
            sourceConfigs: [],
            pipelines: [],
            rules: [],
            jobs: [],
            registry: { operations: [], checks: [] },
            currentTab: 'home',
            editingMapping: null,
            editingPipeline: null,
            editingRule: null,
            editingJob: null,
        },
    };
    window.HSync = HSync;

    // ─── AJAX ─────────────────────────────────────────────────────

    HSync.ajax = async function (action, data) {
        const body = new URLSearchParams();
        body.set('action', 'hsync_ajax_' + action);
        body.set('nonce', HSyncBoot.nonce);
        Object.entries(data || {}).forEach(([k, v]) => {
            if (v === undefined || v === null) return;
            body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        });
        let resp;
        try {
            resp = await fetch(HSyncBoot.ajaxUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
        } catch (netErr) {
            // Network blip (offline, idle Chrome tab killed connection,
            // gateway timeout). Mark transient so the tick loop retries.
            const err = new Error('Rete: ' + (netErr.message || 'connessione interrotta'));
            err.transient = true;
            throw err;
        }
        // Read raw text first so we can give a useful error when the
        // server leaks an HTML error page instead of JSON (PHP fatal,
        // 502 from a reverse proxy, opcache reload mid-request).
        const raw = await resp.text();
        let json;
        try {
            json = JSON.parse(raw);
        } catch (e) {
            const snippet = raw.replace(/\s+/g, ' ').slice(0, 80);
            const err = new Error('HTTP ' + resp.status + ' risposta non-JSON: ' + snippet);
            err.transient = (resp.status === 0 || resp.status >= 500 || resp.status === 408);
            throw err;
        }
        if (!json.success) {
            const msg = (json.data && json.data.message) || 'AJAX error';
            const err = new Error(msg);
            err.payload = json.data || {};
            err.transient = !!(json.data && json.data.recoverable);
            throw err;
        }
        return json.data;
    };

    // ─── DOM helpers ──────────────────────────────────────────────

    const $  = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // ─── Time (site timezone) ─────────────────────────────────────
    //
    // Every timestamp the server sends is UTC ('Y-m-d H:i:s'). They are
    // shown on the SHOP's clock — the zone cron expressions are read in —
    // so a job "alle 00:00" and its runs in the Storico agree. Printing
    // raw UTC made a midnight job look like it ran at 00:00 while the shop
    // clock said 02:00, and "next" timestamps unreadable.

    HSync.tz = {
        name:   String(HSyncBoot.timezone || 'UTC'),
        // Seconds east of UTC right now — fallback for a zone Intl can't
        // resolve (a bare "+02:00" on older browsers).
        offset: parseInt(HSyncBoot.tzOffset, 10) || 0,
    };

    /** 'Y-m-d H:i:s' UTC (or ISO) → epoch ms; NaN when unparseable. */
    HSync.parseUtc = function (value) {
        if (!value) return NaN;
        const str = String(value).trim();
        const iso = str.indexOf('T') >= 0 ? str : str.replace(' ', 'T');
        return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + 'Z');
    };

    let siteFmt = null;
    /** Wall-clock parts of an epoch on the site clock (zero-padded strings). */
    HSync.siteParts = function (ms) {
        try {
            if (!siteFmt) {
                siteFmt = new Intl.DateTimeFormat('it-IT', {
                    timeZone: HSync.tz.name, hourCycle: 'h23',
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                });
            }
            const o = {};
            siteFmt.formatToParts(new Date(ms)).forEach(part => { o[part.type] = part.value; });
            return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
        } catch (e) {
            const d = new Date(ms + HSync.tz.offset * 1000);
            const p2 = n => String(n).padStart(2, '0');
            return {
                y: String(d.getUTCFullYear()), mo: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()),
                h: p2(d.getUTCHours()), mi: p2(d.getUTCMinutes()), s: p2(d.getUTCSeconds()),
            };
        }
    };

    /**
     * "04:30" when it's today on the site clock, else "25/09 04:30".
     * opts.date forces the date, opts.year adds the year.
     */
    HSync.fmtWhen = function (utc, opts) {
        const ms = HSync.parseUtc(utc);
        if (isNaN(ms)) return '—';
        const o = opts || {};
        const p = HSync.siteParts(ms);
        const t = HSync.siteParts(Date.now());
        const time = p.h + ':' + p.mi;
        const today = p.y === t.y && p.mo === t.mo && p.d === t.d;
        if (today && !o.date && !o.year) return time;
        return p.d + '/' + p.mo + (o.year ? '/' + p.y : '') + ' ' + time;
    };

    /** "tra 12 min" / "3 min fa" / "a momenti". */
    HSync.fmtRelative = function (utc) {
        const ms = HSync.parseUtc(utc);
        if (isNaN(ms)) return '';
        const diff = Math.round((ms - Date.now()) / 1000);
        const abs = Math.abs(diff);
        if (abs < 45) return diff >= 0 ? 'a momenti' : 'adesso';
        // Round to whole minutes FIRST, then split — rounding the minute
        // part on its own printed "4 h 60 min".
        const mins = Math.max(1, Math.round(abs / 60));
        let txt;
        if (mins < 60) {
            txt = mins + ' min';
        } else if (mins < 1440) {
            const h = Math.floor(mins / 60), m = mins % 60;
            txt = h + ' h' + (m ? ' ' + m + ' min' : '');
        } else {
            txt = Math.round(mins / 1440) + ' g';
        }
        return diff >= 0 ? 'tra ' + txt : txt + ' fa';
    };

    /** 42 → "42s", 312 → "5m 12s", 5400 → "1h 30m". */
    HSync.fmtDuration = function (seconds) {
        const s = Math.max(0, Math.round(seconds));
        if (s < 60)   return s + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
        return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
    };

    /** "Europe/Rome (UTC+2)" — the zone, with its offset right now. */
    HSync.tzLabel = function () {
        const now = Math.floor(Date.now() / 60000) * 60000;
        const p = HSync.siteParts(now);
        const wall = Date.UTC(+p.y, +p.mo - 1, +p.d, +p.h, +p.mi);
        const off = Math.round((wall - now) / 60000);
        const sign = off < 0 ? '-' : '+';
        const h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60;
        const utc = 'UTC' + (off === 0 ? '' : sign + h + (m ? ':' + String(m).padStart(2, '0') : ''));
        return HSync.tz.name === utc || /^[+-]/.test(HSync.tz.name) ? utc : HSync.tz.name + ' (' + utc + ')';
    };

    /** Seconds between a run row's start and end, or null. */
    HSync.runDuration = function (run) {
        if (!run || !run.started_at || !run.finished_at) return null;
        const d = (HSync.parseUtc(run.finished_at) - HSync.parseUtc(run.started_at)) / 1000;
        return isNaN(d) ? null : d;
    };

    /** Italian label + pill class for a wp_hsync_runs / job status. */
    HSync.runStatus = function (status) {
        return ({
            done:      { label: 'Completato',  cls: 'is-done',      icon: '✓' },
            failed:    { label: 'Fallito',     cls: 'is-failed',    icon: '✗' },
            partial:   { label: 'Parziale',    cls: 'is-partial',   icon: '◐' },
            cancelled: { label: 'Interrotto',  cls: 'is-cancelled', icon: '■' },
            abandoned: { label: 'Abbandonato', cls: 'is-abandoned', icon: '○' },
            skipped:   { label: 'Saltato',     cls: 'is-skipped',   icon: '–' },
            continue:  { label: 'In corso',    cls: 'is-continue',  icon: '▶' },
            running:   { label: 'In corso',    cls: 'is-running',   icon: '▶' },
        })[status] || { label: status || '—', cls: 'is-skipped', icon: '·' };
    };

    // ─── Tabs ─────────────────────────────────────────────────────

    HSync.state.usage = { source_configs: {}, mappings: {}, pipelines: {}, rules: {} };

    /**
     * Clone an entity for the "Duplica" flow. Produces a deep copy
     * with the identifier fields wiped (so save() creates a new row)
     * and the human-readable name suffixed with " (copia)" so the
     * editor shows something obviously different from the original.
     *
     * @param {object|null|undefined} entity
     * @param {string[]} idFields  e.g. ['slug'] for slug-keyed, ['id'] for id-keyed
     * @return {object|null}
     */
    HSync.cloneForDuplicate = function (entity, idFields) {
        if (!entity) return null;
        const copy = JSON.parse(JSON.stringify(entity));
        (idFields || ['slug']).forEach(f => {
            if (f === 'id') copy.id = 0;
            else            copy[f] = '';
        });
        // Suffix the most "namey" field we find. Entities have either
        // `name` (mapping/pipeline/rule/source-config) or `label`
        // (job seed_label) — handle both.
        if (typeof copy.name === 'string' && copy.name !== '') {
            copy.name = copy.name + ' (copia)';
        }
        if (copy.config && typeof copy.config._seed_label === 'string' && copy.config._seed_label !== '') {
            // Job clones lose the seed_label downstream too, but for
            // the brief moment it's in the editor, suffix it.
            copy.config._seed_label = copy.config._seed_label + ' (copia)';
        }
        return copy;
    };

    /**
     * Duplicating a source-config has to happen server-side because
     * secrets (token / cookie) are redacted in the JSON the client
     * sees — a JS-only clone would round-trip the placeholder ••••.
     * The server reads the row with plaintext access and creates a
     * new row with a fresh slug + " (copia)" suffix.
     */
    HSync.duplicateSourceConfig = async function (sourceId, slug) {
        if (!slug) return;
        try {
            const data = await HSync.ajax('source_configs_duplicate', { slug: slug });
            // Reload the sources panel so the new card row appears
            // under its parent source.
            await HSync.loadSources();
            // Auto-open the new copy in the editor for immediate tweaks.
            if (data.slug) HSync.loadSourceConfigEditor(sourceId, data.slug);
        } catch (e) { alert('Errore: ' + e.message); }
    };

    // ─── Cockpit (header status strip) ─────────────────────────────

    HSync.refreshCockpit = async function () {
        try {
            const data = await HSync.ajax('cockpit_status', {});
            HSync.renderCockpit(data);
        } catch (e) { /* non-fatal — header just stays in loading state */ }
    };

    HSync.renderCockpit = function (data) {
        // The Panoramica's status line reads the product count from here.
        HSync.state.cockpit = data;
        if (HSync.state.currentTab === 'home' && HSync.state.overview) HSync.renderHomeStatus();
        const set = (k, html, sub) => {
            const el = document.querySelector('[data-cockpit="' + k + '"]');
            if (el) el.innerHTML = html;
            if (sub !== undefined) {
                const subEl = document.querySelector('[data-cockpit="' + k + '-sub"]');
                if (subEl) subEl.innerHTML = sub;
            }
        };
        document.querySelectorAll('.hsync-cockpit-tile.is-loading').forEach(t => t.classList.remove('is-loading'));

        // ── Tile: Jobs ────────────────────────────────────────────
        const active = data.jobs_active || 0, total = data.jobs_total || 0;
        const running = data.jobs_running || 0;
        set('jobs', '<span class="' + (active > 0 ? 'is-good' : 'is-dim') + '">' + active + '</span><span class="hsync-cockpit-tile-total">/' + total + '</span>',
            (active > 0 ? 'attivi su ' + total + ' totali' : 'nessuna automazione attiva')
            + (running > 0 ? ' · <strong>' + running + ' in corso</strong>' : ''));

        // ── Tile: Last run ───────────────────────────────────────
        const lr = data.last_run;
        if (!lr) {
            set('lastrun', '—', 'nessun import ancora eseguito');
        } else {
            const created = lr.created || 0, updated = lr.updated || 0, patched = lr.patched || 0, failed = lr.failed || 0;
            const headline = (created + updated + patched) > 0
                ? '<span class="is-good">' + (created + updated + patched) + '</span>'
                : '<span class="' + (failed > 0 ? 'is-bad' : 'is-dim') + '">' + (failed > 0 ? failed : '0') + '</span>';
            const sub = HSync.timeAgo(lr.finished_at || lr.started_at)
                + (failed > 0 ? ' · <span class="is-bad">' + failed + ' falliti</span>' : '')
                + (patched > 0 ? ' · ' + patched + ' stock' : '');
            set('lastrun', headline, sub);
        }

        // ── Tile: Catalog ────────────────────────────────────────
        // Every product but trash / auto-draft — drafts included, so
        // "pubblicati" would have overstated it.
        set('products', String(data.product_count || 0), 'prodotti nel catalogo');
    };

    /**
     * "5 minuti fa", "2 ore fa", etc. Italian.
     */
    HSync.timeAgo = function (iso) {
        if (!iso) return '—';
        const t = Date.parse(iso.replace(' ', 'T') + (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z'));
        if (Number.isNaN(t)) return iso;
        const diff = Math.max(0, Date.now() - t) / 1000;
        if (diff < 60)        return 'pochi secondi fa';
        if (diff < 3600)      return Math.floor(diff / 60) + ' min fa';
        if (diff < 86400)     return Math.floor(diff / 3600) + ' ore fa';
        if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' giorni fa';
        return new Date(t).toLocaleDateString('it-IT');
    };

    HSync.cockpitTickNow = async function () {
        const btn = document.querySelector('[data-action="cockpit-tick"]');
        const restore = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="dashicons dashicons-update spin" aria-hidden="true"></span> In esecuzione…'; }
        try {
            const data = await HSync.ajax('jobs_tick_now', {});
            alert(HSync.describeTick(data));
        } catch (e) { alert('Errore: ' + e.message); }
        if (btn) { btn.disabled = false; btn.innerHTML = restore; }
        HSync.refreshCockpit();
        HSync.refreshSystemStatus();
    };

    /**
     * Surfaces a yellow/red strip in the cockpit when the WP-Cron tick
     * looks broken: hook overdue, DISABLE_WP_CRON without a real cron,
     * etc. Doesn't try to fix anything — just tells the operator what
     * to put in their crontab.
     */
    HSync.refreshSystemStatus = async function () {
        const region = document.querySelector('[data-region="cockpit-system-status"]');
        if (!region) return;
        try {
            const s = await HSync.ajax('system_status', {});
            HSync.state.systemStatus = s;
            if (HSync.state.currentTab === 'home' && HSync.state.overview) HSync.renderHomeStatus();
            // Healthy when a tick is scheduled and not over 10 minutes
            // late. A tick due a few seconds ago is normal — WP-Cron fires
            // on the next request — and used to read as "nothing
            // scheduled". The DISABLE_WP_CRON case is informational, not
            // a problem by itself — but combined with overdue it's the
            // smoking gun. The simple view shows its own, plain-words
            // version of this on the Panoramica.
            if (HSync.cronHealthy(s) || !HSync.isAdvanced()) {
                region.innerHTML = '';
                return;
            }
            const reason = s.overdue
                ? 'L\'evento WP-Cron è in ritardo di oltre 10 minuti.'
                : 'Nessun evento WP-Cron pianificato.';
            const remedy = s.disable_wp_cron
                ? 'Hai <code>DISABLE_WP_CRON=true</code>: serve un cron di sistema che chiami questo URL ogni minuto.'
                : 'Il cron interno di WP non sta scattando. Per produzione usa il cron di sistema (più affidabile):';
            region.innerHTML = ''
                + '<div class="hsync-cron-warn">'
                + '<strong>⚠ WP-Cron non sta lavorando.</strong> ' + reason + ' ' + remedy
                + '<br><br>'
                + '<code>' + esc(s.recommended_crontab) + '</code>'
                + '</div>';
        } catch (e) { /* non-fatal */ }
    };

    HSync.purgeRunsAll = async function () {
        if (!confirm('Cancellare TUTTO lo storico dei run? Le run in corso non vengono toccate.')) return;
        try {
            const data = await HSync.ajax('runs_purge_all', {});
            alert('Eliminati ' + (data.deleted || 0) + ' record dallo storico.');
            HSync.loadRuns();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.purgeRunsOlder = async function (days) {
        const d = parseInt(days, 10) || 30;
        if (!confirm('Cancellare i record più vecchi di ' + d + ' giorni?')) return;
        try {
            const data = await HSync.ajax('runs_purge_older', { days: d });
            alert('Eliminati ' + (data.deleted || 0) + ' record (più vecchi di ' + d + ' giorni).');
            HSync.loadRuns();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.clearMediaLog = async function () {
        if (!confirm('Svuotare il log delle eliminazioni media? Lo storico cancellazioni andrà perso.')) return;
        try {
            await HSync.ajax('media_log_clear', {});
            alert('Log eliminazioni svuotato.');
        } catch (e) { alert('Errore: ' + e.message); }
    };

    /**
     * Pulls the usage map (which slug is referenced by which jobs)
     * once and caches it on state. Cheap query — just iterates the
     * jobs table — so we refresh on every tab switch into a list-bearing
     * tab so newly-created jobs reflect immediately.
     */
    HSync.refreshUsage = async function () {
        try {
            const data = await HSync.ajax('usage_summary', {});
            HSync.state.usage = data.usage || HSync.state.usage;
        } catch (e) { /* non-fatal — pills just disappear */ }
    };

    /**
     * Render the usage badge for a given (kind, slug).
     *   - kind: 'source_configs' | 'mappings' | 'pipelines' | 'rules'
     *   - slug: the entity's identifier
     * Returns inline HTML — empty string when slug is empty.
     */
    HSync.usagePill = function (kind, slug) {
        if (!slug) return '';
        const u = (HSync.state.usage[kind] || {})[slug];
        if (!u || !u.jobs || !u.jobs.length) {
            return ' <span class="hsync-usage-pill is-orphan" title="Non referenziato da alcun job">non usato</span>';
        }
        const total   = u.jobs.length;
        const enabled = u.enabled_jobs || 0;
        const klass   = enabled > 0 ? 'is-active' : 'is-pending';
        const label   = enabled > 0
            ? '✓ in uso da ' + enabled + ' job ' + (enabled === 1 ? 'attivo' : 'attivi')
            : '○ collegato a ' + total + ' job ' + (total === 1 ? 'spento' : 'spenti');
        const title = 'Job collegati: #' + u.jobs.join(', #');
        return ' <span class="hsync-usage-pill ' + klass + '" title="' + esc(title) + '">' + label + '</span>';
    };

    HSync.switchTab = function (name) {
        // The simple view only has its three tabs: anything else (a stale
        // link, a "goto" button, the advanced switch just turned off)
        // lands on the Panoramica instead of on a hidden panel.
        if (!HSync.isAdvanced() && HSync.SIMPLE_TABS.indexOf(name) < 0) name = 'home';
        HSync.state.currentTab = name;
        $$('.hsync-tab').forEach(b => {
            const on = b.dataset.tab === name;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        $$('.hsync-panel').forEach(p => {
            p.classList.toggle('is-active', p.dataset.panel === name);
        });
        // Redraw from the state we have first (a save elsewhere may have
        // refreshed it), then refetch: never show the previous render.
        if (name === 'home')      { if (HSync.state.overview) HSync.renderHome(); HSync.loadOverview(); }
        if (name === 'import')    HSync.openImport();
        if (name === 'catalog')   HSync.openCatalog();
        if (name === 'mappings')  HSync.loadMappings();
        if (name === 'runs')      HSync.loadRuns();
        if (name === 'pipelines') HSync.loadPipelines();
        if (name === 'rules')     HSync.loadRules();
        if (name === 'jobs')      HSync.loadJobs();
        if (name === 'media')     HSync.loadMedia();
    };

    HSync.loadRegistry = async function () {
        if (HSync.state.registry.operations.length || HSync.state.registry.checks.length) return;
        try {
            const data = await HSync.ajax('registry_list', {});
            HSync.state.registry = {
                operations:    data.operations    || [],
                import_rules:  data.import_rules  || [],
                checks:        data.checks        || [],
                import_checks: data.import_checks || [],
            };
        } catch (e) { console.warn('registry_list:', e.message); }
    };

    // ─── Pipelines ────────────────────────────────────────────────

    HSync.loadPipelines = async function () {
        const region = $('[data-region="pipelines-list"]');
        try {
            await HSync.loadRegistry();
            const data = await HSync.ajax('pipelines_list', {});
            HSync.state.pipelines = data.pipelines || [];
            await HSync.refreshUsage();
            HSync.renderPipelinesList();
        } catch (e) {
            region.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.renderPipelinesList = function () {
        const region = $('[data-region="pipelines-list"]');
        if (!HSync.state.pipelines.length) {
            region.innerHTML = '<div class="hsync-empty">Nessuna pipeline salvata.</div>';
            return;
        }
        region.innerHTML = HSync.state.pipelines.map(p => ''
            + '<div class="hsync-mapping-row">'
            +   '<div class="hsync-row-main">'
            +     '<div class="hsync-row-name">' + esc(p.name) + HSync.usagePill('pipelines', p.slug) + '</div>'
            +     '<div class="hsync-row-meta"><code>' + esc(p.slug) + '</code> · ' + (p.steps || []).length + ' step</div>'
            +   '</div>'
            +   '<button class="button" data-action="pipeline-edit" data-slug="' + esc(p.slug) + '">Modifica</button>'
            +   '<button class="button" data-action="pipeline-duplicate" data-slug="' + esc(p.slug) + '">Duplica</button>'
            +   '<button class="button" data-action="pipeline-delete" data-slug="' + esc(p.slug) + '">Elimina</button>'
            + '</div>'
        ).join('');
    };

    HSync.openPipelineEditor = function (pipeline) {
        HSync.state.editingPipeline = pipeline ? JSON.parse(JSON.stringify(pipeline)) : { slug: '', name: '', steps: [] };
        $('[data-region="pipelines-list"]').classList.add('is-hidden');
        $('[data-region="pipeline-editor"]').classList.remove('is-hidden');
        HSync.renderPipelineEditor();
    };

    HSync.closePipelineEditor = function () {
        HSync.state.editingPipeline = null;
        $('[data-region="pipeline-editor"]').classList.add('is-hidden');
        $('[data-region="pipelines-list"]').classList.remove('is-hidden');
    };

    HSync.renderPipelineEditor = function () {
        const p = HSync.state.editingPipeline;
        const root = $('[data-region="pipeline-editor"]');
        const opts = HSync.state.registry.operations
            .filter(o => !o.is_import_rule)
            .map(o => '<option value="' + esc(o.id) + '">' + esc(o.label) + ' (' + esc(o.id) + ')</option>')
            .join('');
        const importRules = HSync.state.registry.operations
            .filter(o => o.is_import_rule)
            .map(o => '<option value="' + esc(o.id) + '">' + esc(o.label) + ' (' + esc(o.id) + ')</option>')
            .join('');
        const chkOpts = HSync.state.registry.checks.map(c =>
            '<option value="' + esc(c.id) + '">' + esc(c.label) + ' (' + esc(c.id) + ')</option>'
        ).join('');
        const preChkOpts = (HSync.state.registry.import_checks || []).map(c =>
            '<option value="' + esc(c.id) + '">' + esc(c.label) + ' (' + esc(c.id) + ')</option>'
        ).join('');

        const stepsHtml = (p.steps || []).map((s, i) => HSync.renderPipelineStep(s, i)).join('');

        root.innerHTML = ''
            + '<h2>' + (p.slug ? 'Modifica pipeline' : 'Nuova pipeline') + '</h2>'
            + '<label>Nome <input type="text" data-field="pipeline-name" value="' + esc(p.name) + '"></label>'
            + '<p class="hsync-muted">Step ordinati. Ciclo per item: <code>pre_check</code> → <code>import_rule</code> → materialize → <code>check</code>.</p>'
            + '<div class="hsync-pipeline-steps">' + (stepsHtml || '<p class="hsync-muted">Nessuno step. Aggiungi qui sotto.</p>') + '</div>'
            + '<div class="hsync-actions" style="flex-wrap:wrap;">'
            +   '<select data-field="pipeline-add-pre-id"><option value="">Pre-check (FeedItem)…</option>' + preChkOpts + '</select>'
            +   '<button class="button" data-action="pipeline-add-pre">+ Pre-check</button>'
            +   '<select data-field="pipeline-add-rule-id"><option value="">Import-rule (mutate draft)…</option>' + importRules + '</select>'
            +   '<button class="button" data-action="pipeline-add-rule">+ Import-rule</button>'
            +   '<select data-field="pipeline-add-op-id"><option value="">Post-import operation…</option>' + opts + '</select>'
            +   '<button class="button" data-action="pipeline-add-op">+ Operation</button>'
            +   '<select data-field="pipeline-add-chk-id"><option value="">Post-check (productId)…</option>' + chkOpts + '</select>'
            +   '<button class="button" data-action="pipeline-add-chk">+ Post-check</button>'
            + '</div>'
            + '<div class="hsync-actions" style="margin-top:24px;border-top:1px solid #ccd0d4;padding-top:16px;">'
            +   '<button class="button button-primary" data-action="pipeline-save">Salva</button>'
            +   '<button class="button" data-action="pipeline-cancel">Annulla</button>'
            + '</div>';
    };

    HSync.renderPipelineStep = function (step, idx) {
        let reg, kindLabel, pillKind;
        switch (step.kind) {
            case 'pre_check':
                reg = HSync.state.registry.import_checks || [];
                kindLabel = 'Pre-check';
                pillKind = 'is-skipped';
                break;
            case 'import_rule':
                reg = HSync.state.registry.import_rules || HSync.state.registry.operations.filter(o => o.is_import_rule);
                kindLabel = 'Import-rule';
                pillKind = 'is-updated';
                break;
            case 'check':
                reg = HSync.state.registry.checks;
                kindLabel = 'Post-check';
                pillKind = 'is-skipped';
                break;
            default:
                reg = HSync.state.registry.operations;
                kindLabel = 'Operation';
                pillKind = 'is-created';
        }
        const def = reg.find(r => r.id === step.ref_id);
        const schema = def ? def.params_schema : {};
        const fields = Object.entries(schema || {}).map(([f, spec]) => {
            const id = 'pl-step-' + idx + '-' + f;
            const val = step.params && step.params[f] !== undefined ? step.params[f] : (spec.default !== undefined ? spec.default : '');
            let input;
            if (spec.type === 'enum') {
                input = '<select data-step-idx="' + idx + '" data-step-field="' + esc(f) + '">'
                    + (spec.options || []).map(o => '<option value="' + esc(o) + '"' + (val === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('')
                    + '</select>';
            } else if (spec.type === 'bool') {
                input = '<input type="checkbox" data-step-idx="' + idx + '" data-step-field="' + esc(f) + '"' + (val ? ' checked' : '') + '>';
            } else if (spec.type === 'int') {
                input = '<input type="number" data-step-idx="' + idx + '" data-step-field="' + esc(f) + '" value="' + esc(val) + '">';
            } else {
                input = '<input type="text" data-step-idx="' + idx + '" data-step-field="' + esc(f) + '" value="' + esc(val) + '">';
            }
            return '<label style="display:inline-grid;gap:2px;margin-right:12px;font-size:12px;">' + esc(spec.label || f) + input + '</label>';
        }).join('');
        return ''
            + '<div class="hsync-mapping-row">'
            +   '<div class="hsync-row-main">'
            +     '<div class="hsync-row-name"><span class="hsync-action-pill ' + pillKind + '">' + kindLabel + '</span> <code>' + esc(step.ref_id) + '</code>' + (def ? ' — ' + esc(def.label) : ' <em>(sconosciuto)</em>') + '</div>'
            +     '<div class="hsync-row-meta">' + (fields || '<em>nessun parametro</em>') + '</div>'
            +   '</div>'
            +   '<button class="button" data-action="step-up" data-idx="' + idx + '">↑</button>'
            +   '<button class="button" data-action="step-down" data-idx="' + idx + '">↓</button>'
            +   '<button class="button" data-action="step-delete" data-idx="' + idx + '">✕</button>'
            + '</div>';
    };

    HSync.addPipelineStep = function (kind) {
        let selSelector;
        switch (kind) {
            case 'pre_check':   selSelector = '[data-field="pipeline-add-pre-id"]'; break;
            case 'import_rule': selSelector = '[data-field="pipeline-add-rule-id"]'; break;
            case 'check':       selSelector = '[data-field="pipeline-add-chk-id"]'; break;
            default:            selSelector = '[data-field="pipeline-add-op-id"]';
        }
        const sel = $(selSelector);
        const refId = sel ? sel.value : '';
        if (!refId) return;
        HSync.collectPipelineSteps();
        HSync.state.editingPipeline.steps.push({ kind: kind, ref_id: refId, params: {} });
        HSync.renderPipelineEditor();
    };

    HSync.collectPipelineSteps = function () {
        const p = HSync.state.editingPipeline;
        if (!p || !p.steps) return;
        $$('[data-step-idx]').forEach(el => {
            const idx = parseInt(el.dataset.stepIdx, 10);
            const f   = el.dataset.stepField;
            if (!p.steps[idx]) return;
            p.steps[idx].params = p.steps[idx].params || {};
            if (el.type === 'checkbox') p.steps[idx].params[f] = el.checked;
            else if (el.value !== '')   p.steps[idx].params[f] = el.value;
            else                        delete p.steps[idx].params[f];
        });
    };

    HSync.movePipelineStep = function (idx, dir) {
        HSync.collectPipelineSteps();
        const steps = HSync.state.editingPipeline.steps;
        const target = idx + dir;
        if (target < 0 || target >= steps.length) return;
        [steps[idx], steps[target]] = [steps[target], steps[idx]];
        HSync.renderPipelineEditor();
    };

    HSync.deletePipelineStep = function (idx) {
        HSync.collectPipelineSteps();
        HSync.state.editingPipeline.steps.splice(idx, 1);
        HSync.renderPipelineEditor();
    };

    HSync.savePipeline = async function () {
        HSync.collectPipelineSteps();
        const p = HSync.state.editingPipeline;
        const name = $('[data-field="pipeline-name"]').value;
        if (!name) { alert('Nome richiesto.'); return; }
        try {
            await HSync.ajax('pipeline_save', { slug: p.slug || '', name: name, steps: p.steps });
            HSync.closePipelineEditor();
            HSync.loadPipelines();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.deletePipeline = async function (slug) {
        if (!confirm('Eliminare questa pipeline?')) return;
        try {
            await HSync.ajax('pipeline_delete', { slug: slug });
            HSync.loadPipelines();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    // ─── Rules (scoped pipelines) ─────────────────────────────────

    HSync.loadRules = async function () {
        const region = $('[data-region="rules-list"]');
        try {
            await HSync.loadRegistry();
            const data = await HSync.ajax('rules_list', {});
            HSync.state.rules = data.rules || [];
            await HSync.refreshUsage();
            HSync.renderRulesList();
        } catch (e) {
            region.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.renderRulesList = function () {
        const region = $('[data-region="rules-list"]');
        if (!HSync.state.rules.length) {
            region.innerHTML = '<div class="hsync-empty">Nessuna rule salvata.</div>';
            return;
        }
        region.innerHTML = HSync.state.rules.map(r => ''
            + '<div class="hsync-mapping-row">'
            +   '<div class="hsync-row-main">'
            +     '<div class="hsync-row-name">'
            +       esc(r.name)
            +       (r.enabled ? ' <span class="hsync-action-pill is-created">on</span>' : ' <span class="hsync-action-pill is-skipped">off</span>')
            +       HSync.usagePill('rules', r.slug)
            +     '</div>'
            +     '<div class="hsync-row-meta"><code>' + esc(r.slug) + '</code> · '
            +       (r.operations || []).length + ' op · '
            +       (r.checks     || []).length + ' check</div>'
            +   '</div>'
            +   '<button class="button" data-action="rule-edit" data-slug="' + esc(r.slug) + '">Modifica</button>'
            +   '<button class="button" data-action="rule-duplicate" data-slug="' + esc(r.slug) + '">Duplica</button>'
            +   '<button class="button" data-action="rule-delete" data-slug="' + esc(r.slug) + '">Elimina</button>'
            + '</div>'
        ).join('');
    };

    HSync.openRuleEditor = async function (rule) {
        HSync.state.editingRule = rule
            ? JSON.parse(JSON.stringify(rule))
            : { slug: '', name: '', selection: { mode: 'all', filter: [] }, operations: [], checks: [], enabled: false };
        $('[data-region="rules-list"]').classList.add('is-hidden');
        $('[data-region="rule-editor"]').classList.remove('is-hidden');
        // Lazily load category + brand terms once per session — the
        // pickers re-use them. The endpoint is cheap (a couple of
        // get_terms calls) and the result rarely changes.
        if (! HSync.state.taxonomy) {
            try {
                HSync.state.taxonomy = await HSync.ajax('taxonomy_terms', {});
            } catch (e) {
                HSync.state.taxonomy = { categories: [], brands: [] };
            }
        }
        HSync.renderRuleEditor();
    };

    /**
     * Split the selection.filter conditions list into:
     *   - categoryIds: term ids for `type=category, operator=in`
     *   - brandIds:    term ids for `type=brand, operator=in`
     *   - extras:      everything else (kept as raw JSON for advanced use)
     * Round-trips losslessly: rebuildFilter(splitFilter(x)) === x for
     * filters this UI knows how to express.
     */
    HSync.splitRuleFilter = function (filter) {
        const arr = Array.isArray(filter) ? filter : [];
        const categoryIds = [];
        const brandIds    = [];
        const extras      = [];
        arr.forEach(c => {
            if (! c || typeof c !== 'object') { extras.push(c); return; }
            if (c.type === 'category' && c.operator === 'in' && Array.isArray(c.value)) {
                categoryIds.push(...c.value.map(v => parseInt(v, 10)).filter(v => v > 0));
            } else if (c.type === 'brand' && c.operator === 'in' && Array.isArray(c.value)) {
                brandIds.push(...c.value.map(v => parseInt(v, 10)).filter(v => v > 0));
            } else {
                extras.push(c);
            }
        });
        return { categoryIds, brandIds, extras };
    };

    HSync.buildRuleFilter = function (categoryIds, brandIds, extras) {
        const out = [];
        if (categoryIds.length) out.push({ type: 'category', operator: 'in', value: categoryIds });
        if (brandIds.length)    out.push({ type: 'brand',    operator: 'in', value: brandIds });
        (extras || []).forEach(e => out.push(e));
        return out;
    };

    /**
     * Read the current state of the filter pickers / ids textarea back
     * into editingRule.selection. Called before any re-render so the
     * user's in-progress edits survive mode flips.
     */
    HSync.captureRuleFilterState = function () {
        const r = HSync.state.editingRule;
        if (! r || ! r.selection) return;
        const catSel   = $('[data-field="rule-sel-categories"]');
        const brandSel = $('[data-field="rule-sel-brands"]');
        const idsEl    = $('[data-field="rule-sel-ids"]');
        const extrasEl = $('[data-field="rule-sel-extras"]');

        if (catSel || brandSel || extrasEl) {
            const categoryIds = catSel   ? Array.from(catSel.selectedOptions  ).map(o => parseInt(o.value, 10)) : [];
            const brandIds    = brandSel ? Array.from(brandSel.selectedOptions).map(o => parseInt(o.value, 10)) : [];
            let extras = [];
            if (extrasEl) {
                const raw = (extrasEl.value || '').trim();
                if (raw && raw !== '[]') {
                    try { const j = JSON.parse(raw); if (Array.isArray(j)) extras = j; } catch (e) { /* keep prior */ }
                }
            }
            r.selection.filter = HSync.buildRuleFilter(categoryIds, brandIds, extras);
        }
        if (idsEl) {
            r.selection.ids = (idsEl.value || '').split(/[,\s]+/).map(s => parseInt(s, 10)).filter(v => v > 0);
        }
    };

    HSync.closeRuleEditor = function () {
        HSync.state.editingRule = null;
        $('[data-region="rule-editor"]').classList.add('is-hidden');
        $('[data-region="rules-list"]').classList.remove('is-hidden');
    };

    HSync.renderRuleEditor = function () {
        const r = HSync.state.editingRule;
        const root = $('[data-region="rule-editor"]');
        // Rules operate on EXISTING products — ImportRule operations
        // mutate import drafts and refuse to run on a product_id, so
        // they'd 100%-fail every product if picked here. Hide them.
        const opts = HSync.state.registry.operations
            .filter(o => ! o.is_import_rule)
            .map(o => '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>')
            .join('');
        const chkOpts = HSync.state.registry.checks.map(c =>
            '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>'
        ).join('');
        const opSteps = (r.operations || []).map((s, i) => HSync.renderRuleStep(s, i, 'op')).join('');
        const chkSteps = (r.checks || []).map((s, i) => HSync.renderRuleStep(s, i, 'chk')).join('');
        const selMode = (r.selection && r.selection.mode) || 'all';
        const filter = (r.selection && r.selection.filter) || [];

        // Filter mode: split into picker-friendly parts. category/brand
        // get UI controls; anything else stays in the "Avanzati" textarea.
        // ids mode: show a numeric list textarea instead of category pickers.
        const split = HSync.splitRuleFilter(filter);
        const tax   = HSync.state.taxonomy || { categories: [], brands: [] };

        const renderTermPicker = (terms, selectedIds, dataField) => {
            if (! terms.length) {
                return '<p class="hsync-muted" style="margin:4px 0;font-size:12px;">Nessun termine trovato. Importa prima qualche prodotto.</p>';
            }
            const sel = new Set(selectedIds.map(i => parseInt(i, 10)));
            const opts = terms.map(t => {
                const indent = (t.parent ? '— ' : '');
                const label  = indent + t.name + ' (' + t.count + ')';
                return '<option value="' + t.id + '"' + (sel.has(t.id) ? ' selected' : '') + '>' + esc(label) + '</option>';
            }).join('');
            return '<select multiple data-field="' + dataField + '" size="6" style="width:100%;min-width:280px;">' + opts + '</select>';
        };

        const idsValue = (r.selection && Array.isArray(r.selection.ids)) ? r.selection.ids.join(', ') : '';

        const filterBlock = ''
            + '<div data-region="rule-filter-block" class="hsync-rule-filter">'
            +   '<div class="hsync-rule-filter-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px;">'
            +     '<label>Categorie <span class="hsync-muted" style="font-weight:normal;">(Ctrl/Cmd-clic per selezione multipla)</span>'
            +       renderTermPicker(tax.categories || [], split.categoryIds, 'rule-sel-categories')
            +     '</label>'
            +     '<label>Brand'
            +       renderTermPicker(tax.brands || [], split.brandIds, 'rule-sel-brands')
            +     '</label>'
            +   '</div>'
            +   '<details style="margin-top:12px;">'
            +     '<summary class="hsync-muted" style="cursor:pointer;font-size:12px;">Avanzati — condizioni extra (JSON, opzionale)</summary>'
            +     '<textarea data-field="rule-sel-extras" rows="4" style="font-family:monospace;font-size:12px;width:100%;margin-top:6px;" placeholder=\'[{"type":"stock_status","operator":"is","value":"instock"}]\'>' + esc(JSON.stringify(split.extras, null, 2)) + '</textarea>'
            +     '<p class="hsync-muted" style="font-size:11px;margin:4px 0 0;">Tipi supportati: stock_status, has_image, status, type, price_range, sku_pattern, ecc. Vedi <code>gh_get_condition_definitions()</code>.</p>'
            +   '</details>'
            + '</div>';

        const idsBlock = ''
            + '<div data-region="rule-ids-block">'
            +   '<label>ID prodotti (separati da virgola o newline)'
            +     '<textarea data-field="rule-sel-ids" rows="3" style="font-family:monospace;font-size:12px;">' + esc(idsValue) + '</textarea>'
            +   '</label>'
            + '</div>';

        root.innerHTML = ''
            + '<h2>' + (r.slug ? 'Modifica rule' : 'Nuova rule') + '</h2>'
            + '<label>Nome <input type="text" data-field="rule-name" value="' + esc(r.name) + '"></label>'
            + '<label class="hsync-dryrun"><input type="checkbox" data-field="rule-enabled"' + (r.enabled ? ' checked' : '') + '> Abilitata</label>'
            + '<h3>Scope</h3>'
            + '<label>Modalità selezione'
            +   '<select data-field="rule-sel-mode">'
            +     '<option value="all"'    + (selMode === 'all'    ? ' selected' : '') + '>Tutti i prodotti</option>'
            +     '<option value="filter"' + (selMode === 'filter' ? ' selected' : '') + '>Filtro per categoria/brand</option>'
            +     '<option value="ids"'    + (selMode === 'ids'    ? ' selected' : '') + '>Lista ID (manuale)</option>'
            +   '</select>'
            + '</label>'
            + (selMode === 'filter' ? filterBlock : '')
            + (selMode === 'ids'    ? idsBlock    : '')
            + '<h3>Operazioni (ordinate)</h3>'
            + '<div class="hsync-pipeline-steps">' + (opSteps || '<p class="hsync-muted">Nessuna operazione.</p>') + '</div>'
            + '<div class="hsync-actions">'
            +   '<select data-field="rule-add-op-id"><option value="">Operazione…</option>' + opts + '</select>'
            +   '<button class="button" data-action="rule-add-op">+ Operation</button>'
            + '</div>'
            + '<h3>Check</h3>'
            + '<div class="hsync-pipeline-steps">' + (chkSteps || '<p class="hsync-muted">Nessun check.</p>') + '</div>'
            + '<div class="hsync-actions">'
            +   '<select data-field="rule-add-chk-id"><option value="">Check…</option>' + chkOpts + '</select>'
            +   '<button class="button" data-action="rule-add-chk">+ Check</button>'
            + '</div>'
            + '<div class="hsync-actions" style="margin-top:24px;border-top:1px solid #ccd0d4;padding-top:16px;">'
            +   '<button class="button button-primary" data-action="rule-save">Salva</button>'
            +   '<button class="button" data-action="rule-cancel">Annulla</button>'
            + '</div>';
    };

    HSync.renderRuleStep = function (step, idx, kindKey) {
        const reg = kindKey === 'chk' ? HSync.state.registry.checks : HSync.state.registry.operations;
        const def = reg.find(r => r.id === step.ref_id);
        const schema = def ? def.params_schema : {};
        const fields = Object.entries(schema || {}).map(([f, spec]) => {
            const val = step.params && step.params[f] !== undefined ? step.params[f] : (spec.default !== undefined ? spec.default : '');
            const dataAttrs = 'data-rule-step-kind="' + kindKey + '" data-rule-step-idx="' + idx + '" data-rule-step-field="' + esc(f) + '"';
            let input;
            if (spec.type === 'enum') {
                input = '<select ' + dataAttrs + '>'
                    + (spec.options || []).map(o => '<option value="' + esc(o) + '"' + (val === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('')
                    + '</select>';
            } else if (spec.type === 'bool') {
                input = '<input type="checkbox" ' + dataAttrs + (val ? ' checked' : '') + '>';
            } else if (spec.type === 'int') {
                input = '<input type="number" ' + dataAttrs + ' value="' + esc(val) + '">';
            } else {
                input = '<input type="text" ' + dataAttrs + ' value="' + esc(val) + '">';
            }
            return '<label style="display:inline-grid;gap:2px;margin-right:12px;font-size:12px;">' + esc(spec.label || f) + input + '</label>';
        }).join('');
        return ''
            + '<div class="hsync-mapping-row">'
            +   '<div class="hsync-row-main">'
            +     '<div class="hsync-row-name"><code>' + esc(step.ref_id) + '</code>' + (def ? ' — ' + esc(def.label) : ' <em>(sconosciuto)</em>') + '</div>'
            +     '<div class="hsync-row-meta">' + (fields || '<em>nessun parametro</em>') + '</div>'
            +   '</div>'
            +   '<button class="button" data-action="rule-step-up"     data-kind="' + kindKey + '" data-idx="' + idx + '">↑</button>'
            +   '<button class="button" data-action="rule-step-down"   data-kind="' + kindKey + '" data-idx="' + idx + '">↓</button>'
            +   '<button class="button" data-action="rule-step-delete" data-kind="' + kindKey + '" data-idx="' + idx + '">✕</button>'
            + '</div>';
    };

    HSync.collectRuleSteps = function () {
        const r = HSync.state.editingRule;
        if (!r) return;
        $$('[data-rule-step-idx]').forEach(el => {
            const kindKey = el.dataset.ruleStepKind;
            const idx = parseInt(el.dataset.ruleStepIdx, 10);
            const f = el.dataset.ruleStepField;
            const arr = kindKey === 'chk' ? r.checks : r.operations;
            if (!arr[idx]) return;
            arr[idx].params = arr[idx].params || {};
            if (el.type === 'checkbox') arr[idx].params[f] = el.checked;
            else if (el.value !== '')   arr[idx].params[f] = el.value;
            else                        delete arr[idx].params[f];
        });
    };

    HSync.addRuleStep = function (kindKey) {
        const r = HSync.state.editingRule;
        const sel = $(kindKey === 'chk' ? '[data-field="rule-add-chk-id"]' : '[data-field="rule-add-op-id"]');
        const refId = sel ? sel.value : '';
        if (!refId) return;
        HSync.collectRuleSteps();
        const target = kindKey === 'chk' ? r.checks : r.operations;
        target.push({ ref_id: refId, params: {} });
        HSync.renderRuleEditor();
    };

    HSync.moveRuleStep = function (kindKey, idx, dir) {
        HSync.collectRuleSteps();
        const r = HSync.state.editingRule;
        const arr = kindKey === 'chk' ? r.checks : r.operations;
        const t = idx + dir;
        if (t < 0 || t >= arr.length) return;
        [arr[idx], arr[t]] = [arr[t], arr[idx]];
        HSync.renderRuleEditor();
    };

    HSync.deleteRuleStep = function (kindKey, idx) {
        HSync.collectRuleSteps();
        const r = HSync.state.editingRule;
        const arr = kindKey === 'chk' ? r.checks : r.operations;
        arr.splice(idx, 1);
        HSync.renderRuleEditor();
    };

    HSync.saveRule = async function () {
        HSync.collectRuleSteps();
        const r = HSync.state.editingRule;
        r.name    = $('[data-field="rule-name"]').value;
        r.enabled = $('[data-field="rule-enabled"]').checked;
        const mode = $('[data-field="rule-sel-mode"]').value;

        let filter = [];
        let ids    = [];

        if (mode === 'filter') {
            const catSel   = $('[data-field="rule-sel-categories"]');
            const brandSel = $('[data-field="rule-sel-brands"]');
            const categoryIds = catSel   ? Array.from(catSel.selectedOptions  ).map(o => parseInt(o.value, 10)).filter(v => v > 0) : [];
            const brandIds    = brandSel ? Array.from(brandSel.selectedOptions).map(o => parseInt(o.value, 10)).filter(v => v > 0) : [];
            let extras = [];
            const extrasEl = $('[data-field="rule-sel-extras"]');
            const extrasRaw = (extrasEl && extrasEl.value || '').trim();
            if (extrasRaw !== '' && extrasRaw !== '[]') {
                try { extras = JSON.parse(extrasRaw); }
                catch (e) { alert('Avanzati: JSON non valido — ' + e.message); return; }
                if (! Array.isArray(extras)) { alert('Avanzati: deve essere un array di condizioni.'); return; }
            }
            filter = HSync.buildRuleFilter(categoryIds, brandIds, extras);
            if (filter.length === 0) {
                if (! confirm('Nessuna condizione selezionata: la regola si applicherà a TUTTI i prodotti. Continuare?')) return;
            }
        } else if (mode === 'ids') {
            const raw = ($('[data-field="rule-sel-ids"]') || {}).value || '';
            ids = raw.split(/[,\s]+/).map(s => parseInt(s, 10)).filter(v => v > 0);
        }

        r.selection = { mode, filter, ids };
        if (!r.name) { alert('Nome richiesto.'); return; }
        try {
            await HSync.ajax('rule_save', {
                slug:       r.slug || '',
                name:       r.name,
                selection:  r.selection,
                operations: r.operations,
                checks:     r.checks,
                enabled:    r.enabled ? '1' : '0',
            });
            HSync.closeRuleEditor();
            HSync.loadRules();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.deleteRule = async function (slug) {
        if (!confirm('Eliminare questa rule?')) return;
        try {
            await HSync.ajax('rule_delete', { slug: slug });
            HSync.loadRules();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    // ─── Jobs ─────────────────────────────────────────────────────

    HSync.loadJobs = async function () {
        const region = $('[data-region="jobs-list"]');
        try {
            // Load rules + sources + configs so the editor's pickers populate.
            await HSync.loadRegistry();
            if (!HSync.state.rules.length) {
                try {
                    const r = await HSync.ajax('rules_list', {});
                    HSync.state.rules = r.rules || [];
                } catch {}
            }
            const data = await HSync.ajax('jobs_list', {});
            HSync.state.jobs = data.jobs || [];
            HSync.state.jobsMeta = {
                latest:    data.latest || {},
                runner:    data.runner || {},
                heartbeat: data.heartbeat || {},
            };
            HSync.renderJobsList();
        } catch (e) {
            region.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
        HSync.scheduleJobsPoll();
    };

    /**
     * Keep the cards live while the Automatizza tab is open: every 8s
     * while something runs (progress, "in coda" → "in corso"), every 30s
     * otherwise (the "tra N min" countdowns).
     */
    HSync.scheduleJobsPoll = function () {
        clearTimeout(HSync.state.jobsPollTimer);
        if (HSync.state.currentTab !== 'jobs') return;
        const meta = HSync.state.jobsMeta || {};
        const busy = HSync.state.jobs.some(j => j.run || j.run_control) || !!(meta.runner && meta.runner.busy);
        HSync.state.jobsPollTimer = setTimeout(function () {
            if (HSync.state.currentTab === 'jobs') HSync.loadJobs();
        }, busy ? 8000 : 30000);
    };

    /** A short-lived notice on one job card (Run / Interrompi feedback). */
    HSync.setJobFlash = function (id, kind, text) {
        HSync.state.jobFlash = HSync.state.jobFlash || {};
        HSync.state.jobFlash[id] = { kind: kind, text: text, until: Date.now() + 25000 };
    };

    HSync.renderJobsList = function () {
        const region = $('[data-region="jobs-list"]');
        const meta   = HSync.state.jobsMeta || {};
        const header = HSync.renderRunnerStatus(meta);
        if (!HSync.state.jobs.length) {
            region.innerHTML = header + '<div class="hsync-empty">Nessun job schedulato.</div>';
            return;
        }
        const latest = meta.latest || {};
        region.innerHTML = header + HSync.state.jobs.map(j => HSync.renderJobCard(j, latest[j.id] || null)).join('');
    };

    /** One line above the cards: is the engine working, and in which clock are the times. */
    HSync.renderRunnerStatus = function (meta) {
        const runner = meta.runner || {};
        const beat   = meta.heartbeat || {};
        const anyActive = HSync.state.jobs.some(j => j.run || j.run_control);
        let engine;
        if (runner.busy) {
            engine = '<span class="hsync-engine-dot is-busy" aria-hidden="true"></span> Motore al lavoro';
            if (!anyActive) {
                // Held by nobody visible: a drain between two jobs, or a
                // process that died holding it (it expires by itself).
                engine += ' <button type="button" class="button-link" data-action="runner-release"'
                    + ' title="Il motore risulta occupato ma nessun job è in corso. Se resta così per più di un quarto d\'ora, un processo si è interrotto: sbloccalo.">Sblocca</button>';
            }
        } else {
            engine = '<span class="hsync-engine-dot" aria-hidden="true"></span> Motore in attesa'
                + (beat.next_at ? ' · prossimo controllo ' + esc(HSync.fmtRelative(beat.next_at)) : '');
        }
        return '<div class="hsync-jobs-status">'
            + '<span>' + engine + '</span>'
            + '<span class="hsync-jobs-tz">Orari nel fuso del sito: <strong>' + esc(HSync.tzLabel()) + '</strong></span>'
            + '</div>';
    };

    HSync.renderJobCard = function (j, last) {
        const seedLabel = (j.config && (j.config._label || j.config._seed_label)) || '';
        const cronLabel = HSync.describeCron(j.cron_expr || '');
        const run       = j.run || null;
        const control   = j.run_control || '';
        const line      = (cls, icon, html) =>
            '<div class="hsync-job-state ' + cls + '"><span class="hsync-job-state-icon" aria-hidden="true">' + icon + '</span><span>' + html + '</span></div>';

        // ── What the cron says ────────────────────────────────────
        const schedule = j.cron_expr
            ? (cronLabel ? '<strong>' + esc(cronLabel) + '</strong> ' : '') + '<code>' + esc(j.cron_expr) + '</code>'
            : '<span class="hsync-muted-inline">Solo manuale — nessun cron</span>';

        // ── When it next starts ───────────────────────────────────
        let next = '';
        if (!j.enabled) {
            next = '<span class="hsync-muted-inline">Disattivato — non parte da solo</span>';
        } else if (j.cron_expr && j.next_run_at) {
            next = 'Prossima: <strong>' + esc(HSync.fmtWhen(j.next_run_at)) + '</strong>'
                + ' <span class="hsync-muted-inline">(' + esc(HSync.fmtRelative(j.next_run_at)) + ')</span>';
            if (run) {
                next += ' <span class="hsync-muted-inline" title="Se il run in corso non è finito a quell\'ora, quell\'esecuzione viene saltata e il job riparte all\'orario successivo.">— se il run è ancora in corso, si salta</span>';
            }
        } else if (j.cron_expr) {
            next = '<span class="hsync-muted-inline">Prossima: in pianificazione…</span>';
        }

        // ── What it is doing / did ────────────────────────────────
        let state;
        if (control === 'stop') {
            state = line('is-stopping', '■', '<strong>Arresto richiesto</strong> — si ferma alla fine del blocco in corso (al massimo ~30 secondi).');
        } else if (run) {
            const p   = run.progress || null;
            const pct = p && p.total > 0 ? Math.min(100, Math.round(p.done * 100 / p.total)) : null;
            const bits = [];
            bits.push('avviato ' + HSync.fmtWhen(run.started_at) + (run.trigger === 'manual' ? ' (manuale)' : ''));
            if (p && p.total > 0) bits.push(p.done + '/' + p.total + ' (' + pct + '%)');
            if (last && last.id === run.run_id && last.items_done) bits.push(last.items_done + ' scritti finora');
            bits.push(run.slices + (run.slices === 1 ? ' blocco' : ' blocchi'));
            if (run.last_slice_at) bits.push('ultimo blocco ' + HSync.fmtRelative(run.last_slice_at));
            const bar = pct !== null
                ? '<div class="hsync-job-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>'
                : '';
            state = (!j.enabled && run.trigger !== 'manual')
                ? line('is-paused', '⏸', '<strong>Run in pausa</strong> — il job è disattivato; il run riprende da dove si era fermato quando lo riattivi (o premi Run). ' + esc(bits.join(' · ')))
                : line('is-running', '▶', '<strong>In corso</strong> · ' + esc(bits.join(' · '))) + bar;
        } else if (control === 'run') {
            state = line('is-queued', '⏳', '<strong>In coda</strong> — parte al prossimo giro del motore (entro un minuto).');
        } else if (last) {
            const st   = HSync.runStatus(last.status);
            const dur  = HSync.runDuration(last);
            const bits = [ st.label + ' ' + HSync.fmtWhen(last.finished_at || last.started_at) ];
            if (dur !== null && last.status !== 'continue' && last.status !== 'running') bits.push('durata ' + HSync.fmtDuration(dur));
            bits.push((last.items_done || 0) + ' scritti');
            if (last.items_failed) bits.push(last.items_failed + ' errori');
            const report  = last.report || {};
            const skipped = report.schedule ? (report.schedule.skipped_slots || 0) : 0;
            let extra = '';
            if (skipped > 0) {
                extra += ' <span class="hsync-skip-note" title="Mentre il run lavorava sono passati ' + skipped + ' orari del cron. Non vengono recuperati uno dopo l\'altro: il job riparte al primo orario libero.">⚠ '
                    + skipped + (skipped === 1 ? ' esecuzione saltata' : ' esecuzioni saltate') + ': il run è durato più dell\'intervallo</span>';
            }
            if (last.status === 'failed' && report.error) {
                extra += '<div class="hsync-job-error">' + esc(String(report.error).slice(0, 240)) + '</div>';
            }
            state = line(st.cls, st.icon, 'Ultimo run: ' + esc(bits.join(' · ')) + extra);
        } else if (j.last_run_status) {
            const st = HSync.runStatus(j.last_run_status);
            state = line(st.cls, st.icon, 'Ultimo stato: ' + esc(st.label) + (j.last_run_at ? ' · ' + esc(HSync.fmtWhen(j.last_run_at)) : ''));
        } else {
            state = line('is-idle', '·', 'Mai eseguito');
        }

        // ── Flash from the last button press ──────────────────────
        const flashes = HSync.state.jobFlash || {};
        const flash   = flashes[j.id] && flashes[j.id].until > Date.now() ? flashes[j.id] : null;
        const flashHtml = flash ? '<div class="hsync-job-flash is-' + esc(flash.kind) + '">' + esc(flash.text) + '</div>' : '';

        const canStop = !!run || control === 'run';
        const runLabel = run && !j.enabled && run.trigger !== 'manual' ? 'Riprendi' : 'Run';
        return ''
            + '<div class="hsync-mapping-row hsync-job-card' + (run ? ' is-running' : '') + '">'
            +   '<div class="hsync-row-main">'
            +     '<div class="hsync-row-name">'
            +       (j.enabled ? '<span class="hsync-action-pill is-created">on</span>' : '<span class="hsync-action-pill is-skipped">off</span>') + ' '
            +       (seedLabel ? esc(seedLabel) : ('<code>' + esc(j.runnable_type) + '</code> · <code>' + esc(j.runnable_ref) + '</code>'))
            +     '</div>'
            +     '<div class="hsync-row-meta">' + schedule + (next ? ' · ' + next : '') + '</div>'
            +     state
            +     flashHtml
            +   '</div>'
            +   '<button class="button" data-action="job-run-now" data-id="' + j.id + '"' + (control === 'stop' ? ' disabled' : '') + '>' + runLabel + '</button>'
            +   (canStop ? '<button class="button" data-action="job-stop" data-id="' + j.id + '"' + (control === 'stop' ? ' disabled' : '') + '>Interrompi</button>' : '')
            +   '<button class="button" data-action="job-edit"    data-id="' + j.id + '">Modifica</button>'
            +   '<button class="button" data-action="job-duplicate" data-id="' + j.id + '">Duplica</button>'
            +   '<button class="button" data-action="job-delete"  data-id="' + j.id + '">Elimina</button>'
            + '</div>';
    };

    HSync.openJobEditor = function (job) {
        HSync.state.editingJob = job
            ? JSON.parse(JSON.stringify(job))
            : { id: 0, runnable_type: 'source.import', runnable_ref: '', cron_expr: '', enabled: false, config: {} };
        $('[data-region="jobs-list"]').classList.add('is-hidden');
        $('[data-region="job-editor"]').classList.remove('is-hidden');
        HSync.renderJobEditor();
    };

    HSync.closeJobEditor = function () {
        HSync.state.editingJob = null;
        $('[data-region="job-editor"]').classList.add('is-hidden');
        $('[data-region="jobs-list"]').classList.remove('is-hidden');
    };

    HSync.renderJobEditor = function () {
        const j = HSync.state.editingJob;
        const root = $('[data-region="job-editor"]');

        // Build ref picker depending on runnable_type.
        const sourceOpts = HSync.state.sources.map(s => '<option value="' + esc(s.id) + '"' + (j.runnable_ref === s.id ? ' selected' : '') + '>' + esc(s.label) + ' (' + esc(s.id) + ')</option>').join('');
        const ruleOpts   = HSync.state.rules.map(r => '<option value="' + esc(r.slug) + '"' + (j.runnable_ref === r.slug ? ' selected' : '') + '>' + esc(r.name) + ' (' + esc(r.slug) + ')</option>').join('');

        const refField = j.runnable_type === 'rule'
            ? '<select data-field="job-ref"><option value="">— scegli rule —</option>' + ruleOpts + '</select>'
            : '<select data-field="job-ref"><option value="">— scegli source —</option>' + sourceOpts + '</select>';

        // Source-specific inline config selector (saved configs)
        let configField = '';
        if (j.runnable_type === 'source.import' && HSync.state.sourceConfigs.length) {
            const filtered = HSync.state.sourceConfigs.filter(c => c.source_kind === j.runnable_ref);
            const cfgOpts  = filtered.map(c => '<option value="' + esc(c.slug) + '">' + esc(c.name) + '</option>').join('');
            const stored   = (j.config && j.config.config_slug) || '';
            const wrapped  = j.runnable_ref ? cfgOpts : '<option value="">— scegli prima un source —</option>';
            // Saved (consigliato): job stores only a reference to a config
            // saved in Connetti — tutti i job che la referenziano vedono
            // l'aggiornamento se la modifichi. Inline: il job porta una
            // copia self-contained delle credenziali, utile per one-shot.
            configField = '<label>Configurazione del feed'
                +   '<select data-field="job-config-slug">'
                +     '<option value="">— Inline (copia nel job, sconsigliato) —</option>'
                +     wrapped
                +   '</select>'
                +   '<small class="hsync-muted">Scegli una configurazione salvata da <strong>Connetti</strong> (consigliato) — il job vedrà le modifiche fatte lì. "Inline" copia i campi credenziali dentro al job e va modificata job per job.</small>'
                + '</label>';
        }

        root.innerHTML = ''
            + '<h2>' + (j.id ? 'Modifica job #' + j.id : 'Nuovo job') + '</h2>'
            + '<label>Tipo'
            +   '<select data-field="job-type">'
            +     '<option value="source.import"' + (j.runnable_type === 'source.import' ? ' selected' : '') + '>source.import</option>'
            +     '<option value="rule"'          + (j.runnable_type === 'rule'          ? ' selected' : '') + '>rule</option>'
            +   '</select>'
            + '</label>'
            + '<label>Riferimento ' + refField + '</label>'
            + configField
            + HSync.renderJobRunOptions(j)
            + '<label>Cron expression (5 campi)'
            +   '<input type="text" data-field="job-cron" value="' + esc(j.cron_expr || '') + '" placeholder="*/15 * * * *">'
            +   '<small class="hsync-muted" data-region="job-cron-readout">'
            +     (HSync.describeCron(j.cron_expr || '') || 'Inserisci una espressione cron valida.')
            +   '</small>'
            +   '<small class="hsync-muted">Gli orari del cron sono letti nel fuso del sito: <strong>' + esc(HSync.tzLabel()) + '</strong> (Impostazioni → Generali).'
            +     ' Se un run dura più dell\'intervallo, gli orari che passano mentre lavora vengono saltati, non accodati.</small>'
            + '</label>'
            + '<label class="hsync-dryrun"><input type="checkbox" data-field="job-enabled"' + (j.enabled ? ' checked' : '') + '> Abilitato</label>'
            + '<div class="hsync-actions" style="margin-top:24px;border-top:1px solid #ccd0d4;padding-top:16px;">'
            +   '<button class="button button-primary" data-action="job-save">Salva</button>'
            +   '<button class="button" data-action="job-cancel">Annulla</button>'
            + '</div>';
    };

    /**
     * Render the per-job run knobs that ImportRunner reads from
     * `config.options`: a hard cap on items processed per tick, and
     * the bucket subset (new / update / updateStock). Source-import
     * jobs only — rule jobs don't use these.
     */
    HSync.renderJobRunOptions = function (j) {
        if (j.runnable_type !== 'source.import') return '';
        const opts    = (j.config && j.config.options) || {};
        const limit   = parseInt(opts.limit, 10) > 0 ? parseInt(opts.limit, 10) : '';
        const buckets = Array.isArray(opts.buckets) && opts.buckets.length ? opts.buckets : ['new', 'update', 'updateStock'];
        const retire     = !!opts.retire_missing;
        const retireMode = ['hidden', 'outofstock', 'draft'].indexOf(opts.retire_mode) >= 0 ? opts.retire_mode : 'hidden';
        const retireRatio = (parseFloat(opts.retire_max_ratio) > 0 && parseFloat(opts.retire_max_ratio) <= 1)
            ? Math.round(parseFloat(opts.retire_max_ratio) * 100)
            : 35;
        const bucketCheck = (id, label, hint) =>
            '<label class="hsync-job-bucket" style="display:inline-flex;gap:6px;align-items:center;font-weight:400;margin-right:14px;">'
            +   '<input type="checkbox" data-field="job-bucket" value="' + id + '"' + (buckets.indexOf(id) >= 0 ? ' checked' : '') + '>'
            +   '<span>' + esc(label) + ' <small class="hsync-muted">' + esc(hint) + '</small></span>'
            + '</label>';
        // Preserved on save but not editable here: say it is there, or a
        // job that syncs one slice of the catalog looks like a full sync.
        const catScope = HSync.describeCategoryFilter(opts.category_filter);
        return ''
            + '<fieldset class="hsync-job-options" style="border:1px solid #ccd0d4;border-radius:4px;padding:12px 14px;margin:12px 0;">'
            +   '<legend style="padding:0 6px;font-weight:600;font-size:13px;">Opzioni di run</legend>'
            +   (catScope
                    ? '<div class="hsync-feed-note" style="margin:0 0 10px;">Solo le categorie: <strong>' + esc(catScope) + '</strong>'
                      + ' <small class="hsync-muted">(<code>options.category_filter</code> — si modifica dal JSON del job, tab Config)</small></div>'
                    : '')
            +   '<label>Limite massimo prodotti per esecuzione'
            +     '<input type="number" min="0" step="1" data-field="job-limit" value="' + esc(String(limit)) + '" placeholder="0 = nessun limite" style="max-width:14em;">'
            +     '<small class="hsync-muted">Cappa il numero di FeedItem processati in un singolo tick. Utile per primi import controllati o per non saturare il server. <code>0</code> o vuoto = nessun limite.</small>'
            +   '</label>'
            +   '<div class="hsync-job-retire" style="margin-top:12px;">'
            +     '<label class="hsync-dryrun" style="display:inline-flex;gap:6px;align-items:center;font-weight:400;">'
            +       '<input type="checkbox" data-field="job-retire-missing"' + (retire ? ' checked' : '') + '>'
            +       '<span>Oscura i prodotti spariti dal feed</span>'
            +     '</label>'
            +     '<label style="margin-top:6px;">Modo'
            +       '<select data-field="job-retire-mode" style="max-width:22em;">'
            +         '<option value="hidden"' + (retireMode === 'hidden' ? ' selected' : '') + '>Nascondi dal catalogo + esaurito</option>'
            +         '<option value="outofstock"' + (retireMode === 'outofstock' ? ' selected' : '') + '>Solo esaurito</option>'
            +         '<option value="draft"' + (retireMode === 'draft' ? ' selected' : '') + '>Metti in bozza + esaurito</option>'
            +       '</select>'
            +     '</label>'
            +     '<label style="margin-top:6px;">Soglia di sicurezza (%)'
            +       '<input type="number" min="1" max="100" step="1" data-field="job-retire-max-ratio" value="' + esc(String(retireRatio)) + '" style="max-width:8em;">'
            +       '<small class="hsync-muted">Percentuale massima del catalogo della sorgente che può essere oscurata in un singolo run. Oltre la soglia la spazzata si annulla, dice quanti prodotti avrebbe toccato e ne elenca un campione. Default 35. Su un cron lasciala bassa: è ciò che impedisce a un feed troncato o a un token scaduto di spegnere mezzo negozio senza che nessuno guardi.</small>'
            +     '</label>'
            +     '<label style="margin-top:6px;">'
            +       '<small class="hsync-muted">Quando il fornitore toglie uno SKU dal listino, il prodotto resta altrimenti pubblicato e acquistabile per sempre: il diff guarda solo gli SKU che il feed <em>restituisce</em>. Reversibile — se lo SKU torna nel feed il prodotto viene ripristinato nello stesso run. La spazzata si annulla da sola se il feed è vuoto o se supera la soglia qui sopra, e viene ignorata se il job ha un limite "Max prodotti" o un filtro di categoria (in quel caso il feed è solo una fetta del catalogo, e tutto il resto risulterebbe sparito). I ripristini girano comunque, su ogni sync.</small>'
            +     '</label>'
            +   '</div>'
            +   '<div class="hsync-job-buckets" style="margin-top:8px;">'
            +     '<div style="font-size:13px;font-weight:600;margin-bottom:4px;">Bucket attivi</div>'
            +     bucketCheck('new',         'new',         'crea SKU mancanti (pipeline completa)')
            +     bucketCheck('update',      'update',      'rinfresca SKU esistenti, campi non-stock (pipeline completa)')
            +     bucketCheck('updateStock', 'updateStock', 'fast-patch prezzo + stock (~10ms/prodotto)')
            +     '<small class="hsync-muted" style="display:block;margin-top:4px;">Default: tutti e tre. Disattivane qualcuno per esecuzioni mirate (es. solo <code>updateStock</code> per refresh super-veloci).</small>'
            +   '</div>'
            + '</fieldset>';
    };

    /**
     * JS twin of CategoryFilter::describe(): "Calzature, Borse › Zaini".
     * '' for no filter.
     */
    HSync.describeCategoryFilter = function (raw) {
        const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
        return list.map(v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim()).filter(Boolean).map(v => {
            const i = v.indexOf('>');
            if (i < 0) return '«' + v + '»';
            const cat = v.slice(0, i).trim(), sub = v.slice(i + 1).trim();
            return (sub === '' || sub === '*') ? cat : cat + ' › ' + sub;
        }).join(', ');
    };

    HSync.saveJob = async function () {
        const j = HSync.state.editingJob;
        // Preserve the full original config (buckets, mapping_slug,
        // pipeline_slug, category_filter, markup_percent_override, …)
        // — the editor doesn't expose those as form fields, so wiping
        // the config to {} on every save would silently strip them.
        // The only key the form CAN override is config_slug.
        const baseConfig = j && typeof j.config === 'object' && j.config !== null
            ? Object.assign({}, j.config)
            : {};
        const data = {
            id:            String(j.id || 0),
            runnable_type: $('[data-field="job-type"]').value,
            runnable_ref:  $('[data-field="job-ref"]').value,
            cron_expr:     $('[data-field="job-cron"]').value,
            enabled:       $('[data-field="job-enabled"]').checked ? '1' : '0',
            config:        baseConfig,
        };
        if (!data.runnable_ref) { alert('Scegli un riferimento.'); return; }
        const cfgSlugEl = $('[data-field="job-config-slug"]');
        if (cfgSlugEl && cfgSlugEl.value) data.config.config_slug = cfgSlugEl.value;

        // Run-options: limit + buckets. Merge into existing options
        // so we don't strip seeder-set keys (mapping_slug,
        // pipeline_slug, category_filter, …) that the editor
        // doesn't expose as fields.
        if (data.runnable_type === 'source.import') {
            const options = (data.config.options && typeof data.config.options === 'object')
                ? Object.assign({}, data.config.options)
                : {};
            const limitEl = $('[data-field="job-limit"]');
            if (limitEl) {
                const limit = parseInt(limitEl.value, 10);
                if (limit > 0) options.limit = limit;
                else delete options.limit;  // 0 / empty = no cap
            }
            const retireEl = $('[data-field="job-retire-missing"]');
            if (retireEl && retireEl.checked) {
                options.retire_missing = true;
                const modeEl = $('[data-field="job-retire-mode"]');
                options.retire_mode = modeEl ? modeEl.value : 'hidden';
                const ratioEl = $('[data-field="job-retire-max-ratio"]');
                const ratio = ratioEl ? Math.min(100, Math.max(1, parseInt(ratioEl.value, 10) || 35)) : 35;
                options.retire_max_ratio = ratio / 100;
            } else {
                delete options.retire_missing;
                delete options.retire_mode;
                delete options.retire_max_ratio;
            }
            const checkedBuckets = $$('[data-field="job-bucket"]:checked').map(cb => cb.value);
            const allBuckets     = ['new', 'update', 'updateStock'];
            const isAllSelected  = checkedBuckets.length === allBuckets.length;
            if (checkedBuckets.length === 0 || isAllSelected) {
                // Empty selection or full set → drop the key so
                // ImportRunner falls back to its default (all three).
                // Storing [] would mean "process nothing" downstream.
                delete options.buckets;
            } else {
                options.buckets = checkedBuckets;
            }
            data.config.options = options;
        }

        try {
            const res = await HSync.ajax('job_save', data);
            if (res && res.running && res.id) {
                HSync.setJobFlash(res.id, 'info', 'Salvato. Il run in corso finisce con la configurazione con cui è partito: le modifiche valgono dal prossimo run (oppure premi Interrompi).');
            }
            HSync.closeJobEditor();
            HSync.loadJobs();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.deleteJob = async function (id) {
        if (!confirm('Eliminare questo job?')) return;
        try {
            await HSync.ajax('job_delete', { id: String(id) });
            HSync.loadJobs();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.runJobNow = async function (id) {
        const btn = document.querySelector('[data-action="job-run-now"][data-id="' + id + '"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Avvio…'; }
        try {
            const data = await HSync.ajax('job_run_now', { id: String(id) });
            HSync.setJobFlash(id, data.status === 'failed' ? 'err' : 'ok', HSync.describeRunNow(data));
        } catch (e) {
            HSync.setJobFlash(id, 'err', 'Errore: ' + e.message);
        }
        HSync.loadJobs();
    };

    /** What happened after "Run", in words. */
    HSync.describeRunNow = function (data) {
        const p = data.progress || {};
        switch (data.status) {
            case 'queued':
                return 'In coda: il motore sta già lavorando, il job parte al suo prossimo giro (entro un minuto).';
            case 'continue':
                return 'Blocco eseguito' + (p.total ? ' (' + (p.done || 0) + '/' + p.total + ')' : '')
                    + '. Il resto prosegue da solo in background: puoi lasciare la pagina.';
            case 'done':
                return 'Completato in un solo blocco.';
            case 'partial':
                return 'Eseguito in parte: il resto al prossimo orario del cron.';
            case 'skipped':
                return 'Saltato: ' + (data.reason || 'niente da fare');
            case 'failed':
                return 'Fallito: ' + (data.error || 'errore sconosciuto');
            default:
                return 'Stato: ' + (data.status || '—');
        }
    };

    HSync.stopJob = async function (id) {
        if (!confirm('Interrompere il run in corso?\n\nI prodotti già elaborati restano come sono; il prossimo run riparte dal feed aggiornato.')) return;
        try {
            const data = await HSync.ajax('job_stop', { id: String(id) });
            HSync.setJobFlash(id, 'ok', data.idle
                ? 'Nessun run in corso: richiesta di avvio annullata.'
                : (data.stopped
                    ? 'Run interrotto.'
                    : 'Arresto richiesto: il run si ferma alla fine del blocco in corso.'));
        } catch (e) {
            HSync.setJobFlash(id, 'err', 'Errore: ' + e.message);
        }
        HSync.loadJobs();
    };

    HSync.releaseRunner = async function () {
        if (!confirm('Sbloccare il motore?\n\nSe un processo sta davvero lavorando, si ferma alla fine del blocco in corso e il run riprende al giro successivo.')) return;
        try {
            await HSync.ajax('release_tick_lock', {});
        } catch (e) { alert('Errore: ' + e.message); }
        HSync.loadJobs();
    };

    // ─── Exports ──────────────────────────────────────────────────

    HSync.downloadBlob = function (filename, mime, body) {
        const blob = new Blob([body], { type: mime || 'application/octet-stream' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    };

    HSync.exportInventory = async function (format) {
        const out = $('[data-region="exports-output"]');
        out.innerHTML = '<p class="hsync-loading">Generating ' + esc(format) + '…</p>';
        try {
            const data = await HSync.ajax('export_inventory', { format: format });
            HSync.downloadBlob(data.filename, data.mime, data.body);
            out.innerHTML = '<p>' + (data.count || 0) + ' prodotti esportati come <code>' + esc(data.filename) + '</code>.</p>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.exportCatalog = async function () {
        const out = $('[data-region="exports-output"]');
        out.innerHTML = '<p class="hsync-loading">Generating catalog…</p>';
        try {
            const data = await HSync.ajax('export_catalog', {});
            HSync.downloadBlob(data.filename, data.mime, data.body);
            out.innerHTML = '<p>' + (data.count || 0) + ' gruppi esportati come <code>' + esc(data.filename) + '</code>.</p>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    // ─── Action Scheduler health ──────────────────────────────────

    HSync.asHealth = async function () {
        const out = $('[data-region="as-health-output"]');
        out.innerHTML = '<p class="hsync-loading">Reading Action Scheduler state…</p>';
        try {
            const data = await HSync.ajax('as_health', {});
            const stat = (label, num, kind) =>
                '<div class="hsync-stat ' + (kind || '') + '"><div class="hsync-stat-num">' + (num || 0) + '</div><div class="hsync-stat-label">' + label + '</div></div>';
            const cronWarn = data.cron_disabled
                ? '<div class="hsync-warning"><code>DISABLE_WP_CRON</code> attivo. Hive Sync drena la coda ad ogni admin page load (max 1/min). In produzione: configura un cron host che pinghi <code>wp-cron.php</code>.</div>'
                : '';
            out.innerHTML = ''
                + cronWarn
                + '<div class="hsync-summary" style="grid-template-columns:repeat(3,1fr);">'
                +   stat('Pending', data.pending)
                +   stat('Past-due', data.past_due, data.past_due > 100 ? 'is-bad' : '')
                +   stat('Failed', data.failed, data.failed > 0 ? 'is-bad' : '')
                + '</div>'
                + '<div class="hsync-actions">'
                +   '<button class="button" data-action="as-run-queue">Run queue now</button>'
                +   '<button class="button" data-action="as-purge-past-due">Purge past-due (>7gg)</button>'
                + '</div>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.asRunQueue = async function () {
        try {
            const data = await HSync.ajax('as_run_queue', {});
            alert('Coda riavviata (' + data.duration_ms + ' ms).');
            HSync.asHealth();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.asPurgePastDue = async function () {
        if (!confirm('Eliminare definitivamente le pending actions in ritardo da più di 7 giorni? Questa operazione non è reversibile.')) return;
        try {
            const data = await HSync.ajax('as_purge_past_due', {});
            alert('Eliminati ' + (data.deleted || 0) + ' record (azioni + log).');
            HSync.asHealth();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.tickNow = async function () {
        try {
            const data = await HSync.ajax('jobs_tick_now', {});
            alert(HSync.describeTick(data));
        } catch (e) { alert('Errore: ' + e.message); }
        HSync.loadJobs();
    };

    /** Human reading of a jobs_tick_now / heartbeat result. */
    HSync.describeTick = function (data) {
        if (!data) return '';
        if (data.locked) {
            return 'Il motore sta già lavorando in background: i job in scadenza vengono eseguiti lì, non serve forzarlo.';
        }
        if (!data.slices) {
            return 'Niente da eseguire adesso: nessun job è in scadenza o in corso.';
        }
        return 'Eseguiti ' + data.slices + (data.slices === 1 ? ' blocco' : ' blocchi')
            + ' su ' + (data.dispatched || 0) + (data.dispatched === 1 ? ' job' : ' job')
            + (data.skipped ? ' (' + data.skipped + ' saltati)' : '')
            + '. I run non ancora finiti proseguono da soli in background.';
    };

    // ─── Sources ──────────────────────────────────────────────────

    HSync.loadSources = async function () {
        const region = $('[data-region="sources-list"]');
        try {
            const data = await HSync.ajax('sources_list', {});
            HSync.state.sources = data.sources || [];
            HSync.renderSources();
            HSync.populateSourcePickers();
        } catch (e) {
            region.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.renderSources = async function () {
        const region = $('[data-region="sources-list"]');
        if (!HSync.state.sources.length) {
            region.innerHTML = '<div class="hsync-empty">Nessuna sorgente registrata.</div>';
            return;
        }
        // Pre-load saved configs + usage map once so each card can
        // show its own list with usage pills.
        try {
            const data = await HSync.ajax('source_configs_list', {});
            HSync.state.sourceConfigs = data.configs || [];
        } catch (e) { /* non-fatal — render with empty config lists */ }
        await HSync.refreshUsage();

        region.innerHTML = HSync.state.sources.map(s => {
            const caps = Object.entries(s.capabilities).map(([k, v]) =>
                '<span class="hsync-cap-pill' + (v ? ' is-on' : '') + '">' + esc(k) + '</span>'
            ).join('');
            const schemaHtml = HSync.renderSchema(s.config_schema, 'src-' + s.id);
            const configs = HSync.state.sourceConfigs.filter(c => c.source_kind === s.id);
            const configRows = configs.length
                ? configs.map(c => ''
                    + '<div class="hsync-config-row">'
                    +   '<div class="hsync-row-main">'
                    +     '<div class="hsync-row-name">' + esc(c.name) + HSync.usagePill('source_configs', c.slug) + '</div>'
                    +     '<div class="hsync-row-meta"><code>' + esc(c.slug) + '</code> · '
                    +       Object.keys(c.config || {}).length + ' campi'
                    +       HSync.markupSummary(s.id, c.config)
                    +     '</div>'
                    +   '</div>'
                    +   '<button class="button" data-action="src-config-load" data-source="' + esc(s.id) + '" data-slug="' + esc(c.slug) + '">Modifica</button>'
                    +   '<button class="button" data-action="src-config-duplicate" data-source="' + esc(s.id) + '" data-slug="' + esc(c.slug) + '">Duplica</button>'
                    +   '<button class="button" data-action="src-config-delete" data-slug="' + esc(c.slug) + '">Elimina</button>'
                    + '</div>'
                ).join('')
                : '<div class="hsync-empty hsync-empty-compact">Nessuna config salvata. Compila qui sotto e clicca <em>Salva</em>.</div>';

            return ''
                + '<div class="hsync-source-card" data-source-card="' + esc(s.id) + '">'
                +   '<h3>' + esc(s.label) + ' <span class="hsync-source-id">' + esc(s.id) + '</span></h3>'
                +   '<div class="hsync-caps">' + caps + '</div>'
                +   '<div class="hsync-source-section">'
                +     '<div class="hsync-summary-label">Config salvate</div>'
                +     '<div data-region="src-configs-' + esc(s.id) + '">' + configRows + '</div>'
                +   '</div>'
                +   '<div class="hsync-source-section">'
                +     '<div class="hsync-summary-label">Editor config</div>'
                +     '<form class="hsync-config-form" data-source="' + esc(s.id) + '" data-context="src">'
                +       '<input type="hidden" data-field="src-slug-' + esc(s.id) + '" value="">'
                +       '<label>Nome <input type="text" data-field="src-name-' + esc(s.id) + '" placeholder="Es. GS produzione"></label>'
                +       schemaHtml
                +       '<div class="hsync-actions">'
                +         '<button type="button" class="button button-primary" data-action="src-config-save" data-source="' + esc(s.id) + '">Salva</button>'
                +         '<button type="button" class="button" data-action="src-config-reset" data-source="' + esc(s.id) + '">Nuova</button>'
                +         '<button type="button" class="button" data-action="test-fetch" data-source="' + esc(s.id) + '">Test fetch</button>'
                +       '</div>'
                +       '<div data-region="test-fetch-output-' + esc(s.id) + '"></div>'
                +     '</form>'
                +   '</div>'
                + '</div>';
        }).join('');

        // Apply flavor-driven markup visibility on every freshly
        // rendered source card. The flavor selector defaults vary per
        // source kind (json=generic, csv=generic) so the visibility
        // call yields the right initial state without further wiring.
        $$('form.hsync-config-form[data-context="src"]', region).forEach(form => {
            HSync.applyMarkupFlavorVisibility(form);
        });
    };

    // ─── Markup field suggestions + flavor visibility ─────────────
    //
    // markup_rules are only honored for some flavor combinations:
    //   - csv/stockfirmati → bypassed (uses sf_markup_mode/sf_markup_value
    //                       formula). markup_percent + markup_rules
    //                       are hidden in the UI to avoid the false
    //                       impression that they're consulted.
    //   - all other flavors → consulted; field input gets a flavor-
    //     specific datalist so the operator sees the available feed
    //     keys without having to remember them. Datalist (not strict
    //     dropdown) so generic JSON feeds can still use any field
    //     name the operator wants.
    HSync.MARKUP_FIELD_SUGGESTIONS = {
        'json|generic':         [],
        'json|goldensneakers':  ['_gs_brand', '_gs_category'],
        'csv|generic':          ['brand', 'pa_brand', 'pa_color', 'pa_gender', 'pa_material', 'pa_model', 'categories'],
        // SF flavor honors per-rule overrides (the flat sf_markup_value
        // is the fallback when no rule matches). Field paths are the
        // SF-prefixed keys the transform projects onto each grouped
        // product before resolving rules.
        //
        // `_sf_taxonomy_any` is the safest choice: contains the
        // subcategory when the feed has one, otherwise the category.
        // Saves the operator from having to know which level holds
        // the value they want to target. Listed FIRST so the
        // datalist surfaces it as the suggested default.
        // `_sf_taxonomy` is the same idea but combined ("Cat > Sub"),
        // useful with `contains` operator.
        'csv|stockfirmati':     ['_sf_taxonomy_any', '_sf_taxonomy', '_sf_brand', '_sf_category', '_sf_subcategory', '_sf_sex', '_sf_color', '_sf_material', '_sf_season'],
    };
    // markup_percent (the flat-percent fallback) is irrelevant for
    // csv/stockfirmati — that flavor falls back to sf_markup_value
    // instead. We hide JUST that one field; markup_rules itself is
    // visible because rules now apply to SF too (with sf_markup_value
    // as the fallback). The hint banner explains the split.
    HSync.MARKUP_HIDDEN_FOR = {};
    HSync.MARKUP_HIDDEN_PERCENT_FOR = {
        'csv|stockfirmati': 'Per StockFirmati il fallback è <strong>sf_markup_value</strong> qui sopra; <em>markup_percent</em> è ignorato. Le regole qui sotto si applicano normalmente — il match vince sul fallback.',
    };

    HSync.applyMarkupFlavorVisibility = function (form) {
        if (!form) return;
        const sourceId = form.dataset.source || '';
        const flavorEl = form.querySelector('[name="flavor"]');
        const flavor   = flavorEl ? String(flavorEl.value || '').trim() : '';
        const key      = sourceId + '|' + (flavor || 'generic');

        // Whole-block hide (markup_percent + markup_rules together).
        // Currently empty — kept as the API surface in case a future
        // flavor needs it. For SF we only hide markup_percent.
        const hideAllMessage = HSync.MARKUP_HIDDEN_FOR[key] || null;
        // markup_percent-only hide. Used by csv/stockfirmati: the
        // flat-percent fallback is irrelevant there (sf_markup_value
        // owns that role) but markup_rules themselves DO apply.
        const hidePercentMessage = HSync.MARKUP_HIDDEN_PERCENT_FOR[key] || null;

        $$('label', form).forEach(lbl => {
            const pct  = lbl.querySelector('[name="markup_percent"]');
            const rule = lbl.querySelector('[name="markup_rules"]');
            if (pct) {
                lbl.style.display = (hideAllMessage || hidePercentMessage) ? 'none' : '';
            } else if (rule) {
                lbl.style.display = hideAllMessage ? 'none' : '';
            }
        });

        // Surface a banner explaining whichever hide is active.
        let hint = form.querySelector('[data-markup-flavor-hint]');
        const message = hideAllMessage || hidePercentMessage;
        if (message) {
            if (!hint) {
                hint = document.createElement('div');
                hint.dataset.markupFlavorHint = '1';
                hint.className = 'hsync-muted';
                hint.style.padding = '6px 8px';
                hint.style.background = '#f6f7f9';
                hint.style.border = '1px dashed #cdd0d6';
                hint.style.borderRadius = '4px';
                hint.style.margin = '8px 0';
                const anchor = form.querySelector('label > [name="sf_markup_value"], label > [name="markup_percent"], label > [name="markup_rules"]');
                if (anchor && anchor.parentElement && anchor.parentElement.parentElement) {
                    anchor.parentElement.parentElement.insertBefore(hint, anchor.parentElement.nextSibling);
                } else {
                    form.appendChild(hint);
                }
            }
            hint.innerHTML = message;
        } else if (hint) {
            hint.remove();
        }

        // Refresh datalist suggestions on the markup-rules region.
        const region = form.querySelector('[data-markup-region]');
        if (region) {
            HSync.applyMarkupFieldSuggestions(region, HSync.MARKUP_FIELD_SUGGESTIONS[key] || []);
        }
    };

    /**
     * Produce a one-line "· markup +25% (+2 regole)" summary for a
     * saved source-config row, so the operator sees at a glance which
     * markup is actually wired without having to open the editor.
     * Returns '' when no markup is configured for that flavor (which
     * is the case when csv/stockfirmati uses sf_markup_value=0 default).
     */
    HSync.markupSummary = function (sourceId, config) {
        if (!config) return '';
        const flavor = String(config.flavor || 'generic');
        const key    = sourceId + '|' + flavor;

        // SF: report the sf_markup_value formula, not markup_percent.
        if (key === 'csv|stockfirmati') {
            const mode  = String(config.sf_markup_mode || 'multiplier');
            const value = String(config.sf_markup_value || '');
            if (value === '' || value === '0') return '';
            return ' · <strong>SF markup</strong> ' + esc(mode) + '=' + esc(value);
        }

        // Other flavors: markup_percent fallback + markup_rules count.
        const pct   = parseFloat(config.markup_percent || 0);
        const rules = Array.isArray(config.markup_rules) ? config.markup_rules.length : 0;
        if (!pct && !rules) return '';
        const parts = [];
        if (pct)   parts.push((pct > 0 ? '+' : '') + pct + '%');
        if (rules) parts.push(rules + (rules === 1 ? ' regola' : ' regole'));
        return ' · <strong>markup</strong> ' + parts.join(' · ');
    };

    HSync.applyMarkupFieldSuggestions = function (region, suggestions) {
        if (!region) return;
        const datalistId = (region.id || ('markup-' + Math.random().toString(36).slice(2))) + '__field_suggestions';
        let datalist = region.querySelector('datalist[id="' + datalistId + '"]');
        if (Array.isArray(suggestions) && suggestions.length) {
            if (!datalist) {
                datalist = document.createElement('datalist');
                datalist.id = datalistId;
                region.appendChild(datalist);
            }
            datalist.innerHTML = suggestions.map(s => '<option value="' + esc(s) + '">').join('');
        } else if (datalist) {
            datalist.remove();
        }
        $$('[data-rule-field="field"]', region).forEach(inp => {
            if (Array.isArray(suggestions) && suggestions.length) inp.setAttribute('list', datalistId);
            else inp.removeAttribute('list');
        });
    };

    HSync.loadSourceConfigEditor = function (sourceId, slug) {
        const cfg = HSync.state.sourceConfigs.find(c => c.slug === slug);
        if (!cfg) return;
        const card = document.querySelector('[data-source-card="' + sourceId + '"]');
        if (!card) return;
        card.querySelector('[data-field="src-slug-' + sourceId + '"]').value = cfg.slug;
        card.querySelector('[data-field="src-name-' + sourceId + '"]').value = cfg.name;
        const form = card.querySelector('[data-context="src"]');
        $$('input, select, textarea', form).forEach(el => {
            if (!el.name) return;
            if (Object.prototype.hasOwnProperty.call(cfg.config || {}, el.name)) {
                const val = cfg.config[el.name];
                if (el.type === 'checkbox') el.checked = !!val;
                else if (el.type === 'password' && /^•+/.test(String(val))) {
                    // Server returned a redacted secret: keep value empty and
                    // hint via placeholder. Empty submit = "unchanged" (server
                    // hydrates from stored value).
                    el.placeholder = String(val);
                    el.value = '';
                } else if (el.name === 'markup_rules') {
                    // Hidden carrier holds the JSON; we ALSO need to
                    // repaint the visible rows with the saved values.
                    const list = Array.isArray(val) ? val : [];
                    el.value = JSON.stringify(list);
                    const region = el.closest('[data-markup-region]');
                    const rowsEl = region && region.querySelector('[data-markup-rows]');
                    if (rowsEl) {
                        rowsEl.innerHTML = list.map((r, i) => HSync.renderMarkupRuleRow(r, i)).join('');
                    }
                } else {
                    el.value = String(val ?? '');
                }
            }
        });
        // Refresh markup row visibility AFTER values are populated —
        // flavor may have just been set from the saved config.
        HSync.applyMarkupFlavorVisibility(form);
    };

    HSync.resetSourceConfigEditor = function (sourceId) {
        const card = document.querySelector('[data-source-card="' + sourceId + '"]');
        if (!card) return;
        card.querySelector('[data-field="src-slug-' + sourceId + '"]').value = '';
        card.querySelector('[data-field="src-name-' + sourceId + '"]').value = '';
        const form = card.querySelector('[data-context="src"]');
        $$('input, select, textarea', form).forEach(el => {
            if (!el.name) return;
            if (el.type === 'checkbox') el.checked = false;
            else el.value = '';
        });
    };

    HSync.saveSourceConfig = async function (sourceId) {
        const card = document.querySelector('[data-source-card="' + sourceId + '"]');
        if (!card) return;
        const form = card.querySelector('[data-context="src"]');
        const slug = card.querySelector('[data-field="src-slug-' + sourceId + '"]').value;
        const name = card.querySelector('[data-field="src-name-' + sourceId + '"]').value.trim();
        if (!name) { alert('Inserisci un nome (es. "GS produzione").'); return; }
        const config = HSync.collectConfig(form);
        try {
            const data = await HSync.ajax('source_configs_save', {
                slug: slug, name: name, source_kind: sourceId, config: config,
            });
            alert('Configurazione salvata.');
            HSync.loadSources();
            // Repopulate the Run tab picker too if cached.
            if (HSync.state.currentTab === 'run') HSync.loadSourceConfigs(sourceId);
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.deleteSourceConfig = async function (slug) {
        if (!confirm('Eliminare questa config? Le run/job che la usano dovranno essere riconfigurati.')) return;
        try {
            await HSync.ajax('source_configs_delete', { slug: slug });
            HSync.loadSources();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.renderSchema = function (schema, idPrefix) {
        return Object.entries(schema || {}).map(([field, spec]) => {
            const type     = spec.type || 'text';
            const label    = spec.label || field;
            const required = spec.required ? '<span class="hsync-required">*</span>' : '';
            const id = idPrefix + '-' + field;
            let input = '';
            if (type === 'enum') {
                // Enum options can carry human labels via spec.option_labels
                // (a {value: label} map). When absent the raw value is
                // shown — kept for backward compat.
                const labels = spec.option_labels || {};
                const opts = (spec.options || []).map(o => {
                    const txt = (labels[o] !== undefined && labels[o] !== null) ? labels[o] : o;
                    return '<option value="' + esc(o) + '"' + (spec.default === o ? ' selected' : '') + '>' + esc(txt) + '</option>';
                }).join('');
                input = '<select id="' + esc(id) + '" name="' + esc(field) + '"><option value="">—</option>' + opts + '</select>';
            } else if (type === 'bool') {
                input = '<input type="checkbox" id="' + esc(id) + '" name="' + esc(field) + '"' + (spec.default ? ' checked' : '') + '>';
            } else if (type === 'int') {
                input = '<input type="number" id="' + esc(id) + '" name="' + esc(field) + '" value="' + esc(spec.default || '') + '">';
            } else if (type === 'secret') {
                input = '<input type="password" id="' + esc(id) + '" name="' + esc(field) + '" autocomplete="new-password" spellcheck="false">';
            } else if (type === 'url') {
                input = '<input type="url" id="' + esc(id) + '" name="' + esc(field) + '" placeholder="https://…">';
            } else if (type === 'markup_rules') {
                // Repeater UI for per-feed-field markup rules. The
                // hidden <input name="markup_rules"> carries the full
                // JSON; row inputs sync into it on every change.
                input = HSync.renderMarkupRulesField(id, field, spec.default || []);
            } else {
                input = '<input type="text" id="' + esc(id) + '" name="' + esc(field) + '" value="' + esc(spec.default || '') + '">';
            }
            // Optional inline help — surfaces underneath the input as a
            // muted small line. Schema author opts in by adding
            // spec.description.
            const desc = spec.description
                ? '<small class="hsync-muted">' + esc(spec.description) + '</small>'
                : '';
            return '<label for="' + esc(id) + '">' + esc(label) + required + input + desc + '</label>';
        }).join('');
    };

    HSync.MARKUP_OPS = [
        ['equals',      'è uguale a'],
        ['not_equals',  'è diverso da'],
        ['in',          'è uno di (lista, separati da virgola)'],
        ['not_in',      'non è uno di (lista)'],
        ['contains',    'contiene'],
        ['starts_with', 'inizia con'],
    ];

    HSync.renderMarkupRulesField = function (id, field, initial) {
        const list = Array.isArray(initial) ? initial : [];
        const rows = list.map((r, i) => HSync.renderMarkupRuleRow(r, i)).join('');
        return ''
          + '<div class="hsync-markup-rules" id="' + esc(id) + '" data-markup-region>'
          +   '<div data-markup-rows>' + rows + '</div>'
          +   '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">'
          +     '<button type="button" class="button" data-action="markup-rule-add">+ Aggiungi regola</button>'
          +     '<button type="button" class="button" data-action="markup-rules-test" title="Esegui un test fetch e mostra per ogni prodotto quale regola matcha e quale moltiplicatore viene applicato.">🔍 Verifica regole sui dati reali</button>'
          +   '</div>'
          +   '<div data-region="markup-rules-test-output" style="margin-top:8px;"></div>'
          // Hidden carrier — collectConfig reads it like any other named input,
          // markup_rules special-case in collectConfig parses the JSON.
          +   '<input type="hidden" name="' + esc(field) + '" value="' + esc(JSON.stringify(list)) + '">'
          + '</div>';
    };

    HSync.renderMarkupRuleRow = function (rule, idx) {
        rule = rule || {};
        const opOpts = HSync.MARKUP_OPS.map(([v, label]) =>
            '<option value="' + v + '"' + (rule.operator === v ? ' selected' : '') + '>' + esc(label) + '</option>'
        ).join('');
        const valStr = Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value != null ? String(rule.value) : '');
        return ''
          + '<div class="hsync-markup-rule" data-markup-rule-idx="' + idx + '" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">'
          +   '<input type="text"   data-rule-field="field"    placeholder="campo (es. _gs_brand)" value="' + esc(rule.field || '') + '" style="min-width:14em;flex:1;">'
          +   '<select               data-rule-field="operator" style="min-width:11em;">' + opOpts + '</select>'
          +   '<input type="text"   data-rule-field="value"    placeholder="valore"               value="' + esc(valStr) + '" style="min-width:10em;flex:1;">'
          +   '<input type="number" data-rule-field="percent"  placeholder="%" step="1"          value="' + esc(rule.percent != null ? rule.percent : '') + '" style="width:6em;">'
          +   '<button type="button" class="button" data-action="markup-rule-remove">✕</button>'
          + '</div>';
    };

    /**
     * Sync the in-memory rows back into the hidden input. Called on
     * every change in the repeater so collectConfig sees fresh data
     * even if the user never blurs out of the last input.
     */
    /**
     * Live diagnostic: fetch a few real products from the source (with
     * the operator's current config including markup_rules) and show
     * which rule matched each. Removes the "did my rule fire?" guessing.
     */
    HSync.runMarkupRulesTest = async function (button) {
        const region = button.closest('[data-markup-region]');
        if (!region) return;
        const out = region.querySelector('[data-region="markup-rules-test-output"]');
        const form = button.closest('form.hsync-config-form');
        if (!form) {
            out.innerHTML = '<div class="hsync-error">Form non trovato.</div>';
            return;
        }
        // Make sure the hidden markup_rules input reflects the latest
        // edits before we ship the config to the server.
        HSync.syncMarkupRules(region);
        const sourceId = form.dataset.source || '';
        const config   = HSync.collectConfig(form);
        const rules    = Array.isArray(config.markup_rules) ? config.markup_rules : [];

        out.innerHTML = '<p class="hsync-loading">Verifica regole in corso…</p>';
        try {
            const data = await HSync.ajax('markup_rules_test', {
                source_id: sourceId,
                config:    config,
            });
            if (!data.rows || data.rows.length === 0) {
                out.innerHTML = '<div class="hsync-warning">Nessun prodotto restituito dalla sorgente. Controlla URL/credenziali.</div>';
                return;
            }
            // Per-product diagnostic. For each row we walk the rules
            // client-side to mirror what the server already did — the
            // server returns _sf_applied_multiplier for SF, but we
            // ALSO want to show which rule index matched + the value
            // that was compared, so the operator can see the exact
            // pairing. Client-side mirror is fine because the source-
            // returned ruleData is already projected.
            const ruleMatch = (rowFields, rule) => {
                if (!rule || !rule.field) return false;
                const actual = String(rowFields[rule.field] ?? '').trim().toLowerCase();
                const value  = String(rule.value ?? '').trim().toLowerCase();
                switch (rule.operator) {
                    case 'equals':      return actual === value;
                    case 'not_equals':  return actual !== value;
                    case 'contains':    return actual !== '' && actual.includes(value);
                    case 'starts_with': return actual !== '' && actual.startsWith(value);
                    case 'in': {
                        const list = String(rule.value || '').split(',').map(v => v.trim().toLowerCase());
                        return list.includes(actual);
                    }
                    case 'not_in': {
                        const list = String(rule.value || '').split(',').map(v => v.trim().toLowerCase());
                        return !list.includes(actual);
                    }
                    default: return false;
                }
            };

            const head = ''
                + '<tr>'
                + '<th>#</th><th>SKU</th><th>Nome</th>'
                + '<th><code>_sf_taxonomy_any</code></th>'
                + '<th><code>_sf_brand</code></th>'
                + '<th><code>_sf_category</code></th>'
                + '<th><code>_sf_subcategory</code></th>'
                + '<th>Regola</th>'
                + '<th>Moltiplicatore</th>'
                + '<th>Prezzo variante</th>'
                + '</tr>';

            const body = data.rows.map((r, i) => {
                // Client-side rule walk for "which rule index matched".
                let matchedRule = null;
                let matchedIdx  = -1;
                for (let j = 0; j < rules.length; j++) {
                    if (ruleMatch(r, rules[j])) { matchedRule = rules[j]; matchedIdx = j; break; }
                }
                const ruleCell = matchedRule
                    ? '<span class="hsync-action-pill is-created">#' + (matchedIdx + 1)
                        + ' · ' + esc(String(matchedRule.field)) + ' ' + esc(String(matchedRule.operator)) + ' "' + esc(String(matchedRule.value)) + '"</span>'
                    : '<span class="hsync-action-pill is-skipped">— nessuna —</span>';
                const mult = r.applied_multiplier != null ? Number(r.applied_multiplier).toFixed(2) : '?';
                const fv = r.first_variation_prices;
                const priceCell = fv
                    ? 'reg=<code>' + esc(String(fv.regular_price || '?')) + '</code> sale=<code>' + esc(String(fv.sale_price || '?')) + '</code> qty=<code>' + esc(String(fv.stock_quantity)) + '</code>'
                    : '—';
                return ''
                    + '<tr>'
                    + '<td>' + (i + 1) + '</td>'
                    + '<td><code>' + esc(r.sku) + '</code></td>'
                    + '<td>' + esc(r.name || '') + '</td>'
                    + '<td><code>' + esc(r._sf_taxonomy_any || '') + '</code></td>'
                    + '<td><code>' + esc(r._sf_brand || '') + '</code></td>'
                    + '<td><code>' + esc(r._sf_category || '') + '</code></td>'
                    + '<td><code>' + esc(r._sf_subcategory || '') + '</code></td>'
                    + '<td>' + ruleCell + '</td>'
                    + '<td><strong>×' + mult + '</strong></td>'
                    + '<td>' + priceCell + '</td>'
                    + '</tr>';
            }).join('');

            const matchedCount = data.rows.filter(r => rules.some(rule => ruleMatch(r, rule))).length;
            const summary = rules.length === 0
                ? '<div class="hsync-warning">Nessuna regola definita. Stai usando solo il moltiplicatore di fallback (sf_markup_value).</div>'
                : '<div class="hsync-summary-foot">' + matchedCount + ' / ' + data.rows.length + ' prodotti del campione matchano almeno una regola (lato JS).</div>';
            // Server-side debug: what PHP actually received and how it
            // normalized the rules. If applied_multiplier is wrong
            // despite the JS pill being green, the issue is here:
            // either normalized_rules dropped a rule (look at
            // rules_dropped > 0), the percent was lost in transit, or
            // the flat_sf_multiplier is unexpectedly low.
            let dbg = '';
            if (data._debug) {
                const d = data._debug;
                dbg = '<details style="margin:8px 0;padding:8px;background:#f6f7f9;border:1px dashed #cdd0d6;border-radius:4px;">'
                    + '<summary><strong>Debug server-side</strong> (clicca per espandere)</summary>'
                    + '<table class="hsync-table" style="margin-top:6px;">'
                    + '<tr><th>flavor</th><td><code>' + esc(d.flavor || '?') + '</code></td></tr>'
                    + (d.flat_sf_multiplier !== undefined ? '<tr><th>flat multiplier (sf_markup_value)</th><td><code>×' + Number(d.flat_sf_multiplier).toFixed(2) + '</code></td></tr>' : '')
                    + '<tr><th>regole inviate</th><td><pre style="margin:0;font-size:11px;">' + esc(JSON.stringify(d.raw_rules || [], null, 2)) + '</pre></td></tr>'
                    + '<tr><th>regole normalizzate (post-validation)</th><td><pre style="margin:0;font-size:11px;">' + esc(JSON.stringify(d.normalized_rules || [], null, 2)) + '</pre></td></tr>'
                    + (d.rules_dropped > 0 ? '<tr><th style="color:#b32d2e;">⚠ regole scartate</th><td><code>' + d.rules_dropped + '</code> regole non hanno passato la validazione (field vuoto, operator non valido, o percent non numerico)</td></tr>' : '')
                    + '</table></details>';
            }
            out.innerHTML = summary + dbg
                + '<div style="overflow-x:auto;"><table class="hsync-table">' + head + body + '</table></div>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.syncMarkupRules = function (region) {
        const rows = $$('[data-markup-rule-idx]', region);
        const list = rows.map(row => {
            const get = (f) => {
                const el = $('[data-rule-field="' + f + '"]', row);
                return el ? el.value : '';
            };
            return {
                field:    get('field').trim(),
                operator: get('operator') || 'equals',
                value:    get('value'),
                percent:  parseFloat(get('percent') || '0'),
            };
        }).filter(r => r.field !== '');
        const hidden = $('input[type="hidden"][name]', region);
        if (hidden) hidden.value = JSON.stringify(list);
    };

    HSync.collectConfig = function (formEl) {
        const out = {};
        $$('input, select, textarea', formEl).forEach(el => {
            if (!el.name) return;
            if (el.type === 'checkbox') {
                out[el.name] = el.checked;
            } else if (el.value !== '') {
                // markup_rules carries a JSON-stringified array — parse so
                // the upstream JSON.stringify doesn't double-encode it.
                if (el.name === 'markup_rules') {
                    try { out[el.name] = JSON.parse(el.value); }
                    catch (e) { out[el.name] = []; }
                } else {
                    out[el.name] = el.value;
                }
            }
        });
        return out;
    };

    HSync.testFetch = async function (sourceId, formEl) {
        const config = HSync.collectConfig(formEl);
        const out = $('[data-region="test-fetch-output-' + sourceId + '"]', formEl);
        out.innerHTML = '<p class="hsync-loading">Fetching…</p>';
        try {
            const data = await HSync.ajax('source_test_fetch', {
                source_id: sourceId,
                config: config,
                options: {},
            });
            const warns = (data.warnings || []).map(w =>
                '<div class="hsync-warning">' + esc(w) + '</div>'
            ).join('');
            const rows  = (data.preview || []).map((p, i) =>
                '<tr><td>' + (i + 1) + '</td><td><code>' + esc(p.sku) + '</code></td><td>' + HSync.summarizePreviewData(p.data) + '</td></tr>'
            ).join('');
            out.innerHTML = ''
                + '<p><strong>' + data.count + '</strong> items fetched.</p>'
                + (warns ? '<div class="hsync-warnings">' + warns + '</div>' : '')
                + (rows
                    ? '<table class="hsync-table"><thead><tr><th>#</th><th>SKU</th><th>Shape preview</th></tr></thead><tbody>' + rows + '</tbody></table>'
                    : '');
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.populateSourcePickers = function () {
        const opts = HSync.state.sources.map(s =>
            '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>'
        ).join('');
        const blank = '<option value="">— scegli sorgente —</option>';
        const filt  = $('[data-control="mappings-filter"]');
        if (filt) filt.innerHTML = '<option value="">Tutte le sorgenti</option>' + opts;
        const mapSrc = $('[data-field="map-source"]');
        if (mapSrc) mapSrc.innerHTML = blank + opts;
        const runSrc = $('[data-field="run-source"]');
        if (runSrc) {
            runSrc.innerHTML = blank + opts;
            runSrc.addEventListener('change', HSync.onRunSourceChange);
        }
    };

    // ─── Mappings ─────────────────────────────────────────────────

    HSync.loadMappings = async function () {
        const region = $('[data-region="mappings-list"]');
        const filter = $('[data-control="mappings-filter"]').value;
        try {
            const data = await HSync.ajax('mappings_list', { source_kind: filter });
            HSync.state.mappings = data.mappings || [];
            await HSync.refreshUsage();
            HSync.renderMappings();
            HSync.populateRunMappings();
        } catch (e) {
            region.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.renderMappings = function () {
        const region = $('[data-region="mappings-list"]');
        if (!HSync.state.mappings.length) {
            region.innerHTML = '<div class="hsync-empty">Nessuna mapping salvata.</div>';
            return;
        }
        region.innerHTML = HSync.state.mappings.map(m => ''
            + '<div class="hsync-mapping-row">'
            +   '<div class="hsync-row-main">'
            +     '<div class="hsync-row-name">' + esc(m.name) + HSync.usagePill('mappings', m.slug) + '</div>'
            +     '<div class="hsync-row-meta">'
            +       esc(m.source_kind) + ' · <code>' + esc(m.slug) + '</code> · '
            +       Object.keys(m.config || {}).length + ' campi mappati'
            +     '</div>'
            +   '</div>'
            +   '<button class="button" data-action="mapping-edit" data-slug="' + esc(m.slug) + '">Modifica</button>'
            +   '<button class="button" data-action="mapping-duplicate" data-slug="' + esc(m.slug) + '">Duplica</button>'
            +   '<button class="button" data-action="mapping-delete" data-slug="' + esc(m.slug) + '">Elimina</button>'
            + '</div>'
        ).join('');
    };

    // Canonical Woo target fields shown in the mapping editor's row picker.
    // These are the keys downstream operations (CsvSource materialize +
    // ResolveTaxonomy + DownloadMedia + AdjustPrice) typically read from
    // the mapped FeedItem.data shape. The list is intentionally small —
    // a "+ Campo personalizzato" row lets the user add anything else.
    // The Woo target schema is the FIXED spine of every mapping. The
    // user can only choose what to map INTO each slot — not what the
    // slots themselves are. Two groups: `minimal` (the fields that
    // give a usable Woo product on import) and `advanced` (SEO + meta
    // + extras you may not always need). Custom keys outside this
    // schema land in their own dedicated section below.
    HSync.WOO_SCHEMA = [
        // ── Minimal — visible by default ───────────────────────
        { key: 'sku',               label: 'SKU',                  group: 'minimal', required: true,  hint: 'Identificatore univoco del prodotto' },
        { key: 'name',              label: 'Nome prodotto',        group: 'minimal', required: true },
        { key: 'regular_price',     label: 'Prezzo listino',       group: 'minimal', required: true },
        { key: 'description',       label: 'Descrizione',          group: 'minimal', hint: 'Supporta HTML — usa template per arricchirla' },
        { key: 'image_url',         label: 'Immagine principale',  group: 'minimal' },
        { key: 'categories',        label: 'Categoria',            group: 'minimal' },
        { key: 'brand',             label: 'Brand',                group: 'minimal' },
        { key: 'stock_quantity',    label: 'Quantità a stock',     group: 'minimal' },

        // ── Attributi globali (pa_*) ───────────────────────────
        // Promossi automaticamente in $woo['attributes'] dal merger
        // post-mapping. La tassonomia globale `pa_<slug>` viene
        // creata da ResolveTaxonomy se manca.
        { key: 'pa_brand',          label: 'Attributo brand',      group: 'attributes', hint: 'Tassonomia pa_brand. Mostrata come filtro frontend.' },
        { key: 'pa_model',          label: 'Attributo modello',    group: 'attributes', hint: 'Tassonomia pa_model.' },
        { key: 'pa_gender',         label: 'Attributo genere',     group: 'attributes', hint: 'Tassonomia pa_gender (uomo/donna/unisex/bambino).' },
        { key: 'pa_color',          label: 'Attributo colore',     group: 'attributes', hint: 'Tassonomia pa_color.' },
        { key: 'pa_material',       label: 'Attributo materiale',  group: 'attributes', hint: 'Tassonomia pa_material.' },
        { key: 'pa_taglia',         label: 'Attributo taglia (variazione)', group: 'attributes', hint: 'pa_taglia genera le varianti. Usa una path multi-valore (es. sizes.size_eu).' },

        // ── Advanced — collapsed by default ────────────────────
        { key: 'short_description', label: 'Descrizione breve',    group: 'advanced' },
        { key: 'sale_price',        label: 'Prezzo scontato',      group: 'advanced' },
        { key: 'stock_status',      label: 'Stato stock',          group: 'advanced', hint: 'instock | outofstock' },
        { key: 'manage_stock',      label: 'Gestione stock',       group: 'advanced', hint: 'true | false' },
        { key: 'status',            label: 'Stato pubblicazione',  group: 'advanced', hint: 'publish | draft' },
        { key: 'gallery_urls',      label: 'Gallery URLs',         group: 'advanced', hint: 'lista pipe-joined' },
        { key: 'tags',              label: 'Tag',                  group: 'advanced' },
        { key: 'meta_title',        label: 'SEO title',            group: 'advanced' },
        { key: 'meta_description',  label: 'SEO meta description', group: 'advanced' },
        { key: 'meta_keywords',     label: 'SEO keywords',         group: 'advanced' },
    ];

    HSync.MAPPING_SNIPPETS = [
        { label: 'Brand + nome prodotto',                  value: '{brand_name} {name}' },
        { label: 'Descrizione lunga (con HTML)',           value: '<p>{brand_name} <strong>{name}</strong> originali — {colorway}</p>' },
        { label: 'Descrizione breve',                      value: '{brand_name} {name}' },
        { label: 'Titolo SEO',                             value: '{name} | {brand_name} | Sneakers' },
        { label: 'Meta description SEO',                   value: 'Acquista {name} di {brand_name}. Modello {colorway}, taglie disponibili. Spedizione veloce.' },
        { label: 'SKU con prefisso brand',                 value: '{brand_name}-{sku}' },
    ];

    /**
     * Editor state model is keyed by Woo field name so the row order
     * is implicit (it follows the schema). Custom keys outside the
     * schema live in a parallel ordered list rendered separately.
     */
    HSync.openMappingEditor = function (mapping) {
        HSync.state.editingMapping = mapping || null;
        HSync.state.mappingValues = {};
        HSync.state.mappingCustomKeys = [];
        HSync.state.mappingProbe = { pathsRaw: [], pathsData: [], sampleRaw: null, sampleData: null };
        HSync.state.mappingFocusedKey = null;

        const cfg = (mapping && mapping.config) || {};
        const schemaKeys = new Set(HSync.WOO_SCHEMA.map(f => f.key));
        Object.entries(cfg).forEach(([k, v]) => {
            HSync.state.mappingValues[k] = String(v == null ? '' : v);
            if (!schemaKeys.has(k)) HSync.state.mappingCustomKeys.push(k);
        });

        // Auto-expand advanced if any advanced slot is already filled —
        // saves a click for users editing existing mappings that touch
        // SEO/meta.
        HSync.state.mappingShowAdvanced = HSync.WOO_SCHEMA.some(f =>
            f.group === 'advanced'
            && (HSync.state.mappingValues[f.key] || '').toString().trim() !== '',
        );

        $('[data-region="mapping-editor"]').classList.remove('is-hidden');
        $('[data-field="map-name"]').value   = mapping ? mapping.name : '';
        $('[data-field="map-source"]').value = mapping ? mapping.source_kind : '';
        $('[data-field="map-config"]').value = mapping ? JSON.stringify(mapping.config || {}, null, 2) : '';
        // JSON-first: the textarea is the durable contract (LLM-friendly,
        // copy/paste-friendly). The visual builder stays available as a
        // helper but the JSON view opens by default.
        $('[data-region="mapping-json-view"]').classList.remove('is-hidden');
        const toggle = $('[data-action="mapping-toggle-json"]');
        if (toggle) toggle.checked = true;
        $('[data-region="mapping-probe-output"]').classList.add('is-hidden');
        HSync.renderMappingRows();
    };

    HSync.closeMappingEditor = function () {
        HSync.state.editingMapping = null;
        $('[data-region="mapping-editor"]').classList.add('is-hidden');
    };

    /** Drop empty values + empty keys, then return the saved-shape object. */
    HSync.mappingValuesToConfig = function () {
        const out = {};
        Object.entries(HSync.state.mappingValues || {}).forEach(([k, v]) => {
            const key = String(k || '').trim();
            const val = String(v || '').trim();
            if (key !== '' && val !== '') out[key] = val;
        });
        return out;
    };

    HSync.renderMappingRows = function () {
        const region = $('[data-region="mapping-rows"]');
        const probe = HSync.state.mappingProbe || {};
        // Two path groups:
        // - rawPaths: native upstream fields (e.g. GS API: presented_price,
        //   offer_price, available_summary_quantity, sizes.size_eu).
        //   This is what the user wants to map FROM.
        // - dataPaths: post-bridge payload (sometimes partially Woo-shaped).
        //   Shown as a fallback for sources that don't expose raw fields.
        const rawPaths  = probe.pathsRaw  || [];
        const dataPaths = probe.pathsData || [];
        const datalistId = 'hsync-paths-datalist';
        // Datalist combines both so autocomplete works regardless. Raw
        // entries come first (what we recommend).
        const allPaths = Array.from(new Set([...rawPaths, ...dataPaths]));
        const datalist = '<datalist id="' + datalistId + '">'
            + allPaths.map(p => '<option value="' + esc(p) + '">').join('')
            + '</datalist>';

        const buildChips = (list) => list.map(p =>
            '<button type="button" class="hsync-chip" data-action="mapping-insert-token" data-token="{' + esc(p) + '}">{' + esc(p) + '}</button>',
        ).join('');

        const snippetOpts = HSync.MAPPING_SNIPPETS.map((s, i) =>
            '<option value="' + i + '">' + esc(s.label) + '</option>',
        ).join('');

        let paletteRows;
        if (!rawPaths.length && !dataPaths.length) {
            paletteRows = '<div class="hsync-palette-row">'
                + '<span class="hsync-muted">Premi <em>Anteprima sorgente</em> qui sopra per scoprire quali campi puoi inserire.</span>'
                + '</div>';
        } else {
            const rawSection = rawPaths.length
                ? '<div class="hsync-palette-row">'
                +   '<strong>Campi del feed esterno:</strong> ' + buildChips(rawPaths)
                + '</div>'
                : '';
            const dataSection = dataPaths.length
                ? '<div class="hsync-palette-row hsync-palette-row-secondary">'
                +   '<strong>Campi normalizzati' + (rawPaths.length ? ' (alternativa)' : '') + ':</strong> '
                +   buildChips(dataPaths)
                +   (!rawPaths.length
                          ? ' <small class="hsync-muted">Questa sorgente non espone i campi grezzi: i nomi qui sotto possono assomigliare a quelli di WooCommerce.</small>'
                          : '')
                + '</div>'
                : '';
            paletteRows = rawSection + dataSection;
        }

        const palette = ''
            + '<div class="hsync-mapping-palette is-hidden" data-region="mapping-palette">'
            +   paletteRows
            +   '<div class="hsync-palette-row">'
            +     '<strong>Oppure parti da un esempio:</strong> '
            +     '<select data-action="mapping-insert-snippet">'
            +       '<option value="">— scegli un esempio —</option>'
            +       snippetOpts
            +     '</select>'
            +     '<span class="hsync-muted">Le parentesi <code>{ }</code> contengono il campo del feed. Puoi mescolare testo libero e HTML.</span>'
            +   '</div>'
            + '</div>';

        // Spine row: target label is FIXED, only the source side is editable.
        // Required + empty = visual warning so the user can spot gaps.
        const renderSpineRow = (f) => {
            const value = HSync.state.mappingValues[f.key] || '';
            const isEmpty = String(value).trim() === '';
            const warnClass = f.required && isEmpty ? ' is-required-missing' : '';
            const filledClass = !isEmpty ? ' is-filled' : '';
            return ''
                + '<div class="hsync-mapping-row-builder' + warnClass + filledClass + '" data-key="' + esc(f.key) + '">'
                +   '<div class="hsync-mapping-cell hsync-mapping-target">'
                +     '<div class="hsync-mapping-label">'
                +       (f.required ? '<span class="hsync-required-marker" title="Obbligatorio">*</span>' : '')
                +       esc(f.label)
                +     '</div>'
                +     '<code class="hsync-mapping-key">' + esc(f.key) + '</code>'
                +     (f.hint ? '<small class="hsync-muted">' + esc(f.hint) + '</small>' : '')
                +   '</div>'
                +   '<div class="hsync-mapping-cell hsync-mapping-arrow" title="campo Woo ← campo sorgente">←</div>'
                +   '<div class="hsync-mapping-cell hsync-mapping-source">'
                +     '<input type="text" data-mapping-key="' + esc(f.key) + '"'
                +       ' value="' + esc(value) + '"'
                +       ' list="' + datalistId + '"'
                +       ' placeholder="es. presented_price, sizes.size_eu, oppure {brand_name} {name}">'
                +     (!allPaths.length
                          ? '<small class="hsync-muted">Premi <em>Anteprima sorgente</em> per vedere i campi disponibili.</small>'
                          : '')
                +   '</div>'
                +   (isEmpty
                          ? ''
                          : '<button type="button" class="button button-small" data-action="mapping-clear" data-key="' + esc(f.key) + '" title="Pulisci">✕</button>')
                + '</div>';
        };

        const renderCustomRow = (key, idx) => {
            const value = HSync.state.mappingValues[key] || '';
            return ''
                + '<div class="hsync-mapping-row-builder hsync-mapping-row-custom" data-custom-idx="' + idx + '">'
                +   '<div class="hsync-mapping-cell hsync-mapping-target">'
                +     '<input type="text" data-custom-key="' + idx + '"'
                +       ' value="' + esc(key) + '"'
                +       ' placeholder="es. meta_seo_focus_keyword">'
                +     '<small class="hsync-muted">campo personalizzato</small>'
                +   '</div>'
                +   '<div class="hsync-mapping-cell hsync-mapping-arrow">←</div>'
                +   '<div class="hsync-mapping-cell hsync-mapping-source">'
                +     '<input type="text" data-custom-value="' + idx + '"'
                +       ' value="' + esc(value) + '"'
                +       ' list="' + datalistId + '"'
                +       ' placeholder="campo della sorgente o template">'
                +   '</div>'
                +   '<button type="button" class="button button-small" data-action="mapping-custom-delete" data-idx="' + idx + '" title="Elimina">✕</button>'
                + '</div>';
        };

        const minimalRows   = HSync.WOO_SCHEMA.filter(f => f.group === 'minimal').map(renderSpineRow).join('');
        const attributeRows = HSync.WOO_SCHEMA.filter(f => f.group === 'attributes').map(renderSpineRow).join('');
        const advancedRows  = HSync.WOO_SCHEMA.filter(f => f.group === 'advanced').map(renderSpineRow).join('');
        const customRows    = HSync.state.mappingCustomKeys.map(renderCustomRow).join('');
        const showAdv       = !!HSync.state.mappingShowAdvanced;
        const advCount      = HSync.WOO_SCHEMA.filter(f =>
            f.group === 'advanced' && String(HSync.state.mappingValues[f.key] || '').trim() !== '',
        ).length;
        const attrCount     = HSync.WOO_SCHEMA.filter(f =>
            f.group === 'attributes' && String(HSync.state.mappingValues[f.key] || '').trim() !== '',
        ).length;
        const customCount   = HSync.state.mappingCustomKeys.length;

        // Required-fields summary banner — counts what's still missing
        // out of the Woo-mandatory triplet (sku/name/regular_price).
        const missingRequired = HSync.WOO_SCHEMA.filter(f =>
            f.required && String(HSync.state.mappingValues[f.key] || '').trim() === '',
        );
        const requiredBanner = missingRequired.length
            ? '<div class="hsync-warning">'
              + '<strong>Manca ancora qualcosa.</strong> Per creare un prodotto servono: '
              + missingRequired.map(f => '<code>' + esc(f.label || f.key) + '</code>').join(', ')
              + '. Compilali per poter salvare.</div>'
            : '<div class="hsync-summary-foot">Tutto pronto — i campi essenziali sono compilati ✓</div>';

        region.innerHTML = ''
            + datalist + palette
            + requiredBanner
            + '<section class="hsync-mapping-section">'
            +   '<h3 class="hsync-mapping-section-h">'
            +     '<span class="hsync-section-badge">Essenziali</span>'
            +     'Campi base del prodotto'
            +   '</h3>'
            +   '<p class="hsync-muted">Quelli con <span class="hsync-required-marker">*</span> sono indispensabili per creare un prodotto.</p>'
            +   minimalRows
            + '</section>'
            + '<section class="hsync-mapping-section">'
            +   '<h3 class="hsync-mapping-section-h">'
            +     '<span class="hsync-section-badge">Attributi</span>'
            +     'Attributi globali Woo (pa_*)'
            +     ' <small class="hsync-muted">(' + attrCount + ' compilati)</small>'
            +   '</h3>'
            +   '<p class="hsync-muted">Diventano filtri nella vetrina e ricerche. Le tassonomie <code>pa_*</code> mancanti vengono create automaticamente al primo import.</p>'
            +   attributeRows
            + '</section>'
            + '<section class="hsync-mapping-section">'
            +   '<button class="hsync-mapping-toggle" data-action="mapping-toggle-advanced">'
            +     (showAdv ? '▼' : '▶') + ' Campi avanzati'
            +     ' <small class="hsync-muted">(SEO, gallery, sconti — ' + advCount + ' compilati)</small>'
            +   '</button>'
            +   (showAdv
                ? '<p class="hsync-muted">Compilali solo se ti servono. Altrimenti lasciali vuoti.</p>' + advancedRows
                : '')
            + '</section>'
            + '<section class="hsync-mapping-section">'
            +   '<h3 class="hsync-mapping-section-h">'
            +     '<span class="hsync-section-badge is-custom">Personalizzati</span>'
            +     'I tuoi campi extra'
            +     ' <small class="hsync-muted">(' + customCount + ')</small>'
            +   '</h3>'
            +   '<p class="hsync-muted">Per chiavi che non rientrano nello standard — utili per meta SEO, attributi specifici del tuo store.</p>'
            +   customRows
            +   '<div class="hsync-actions"><button type="button" class="button" data-action="mapping-add-custom">+ Aggiungi campo</button></div>'
            + '</section>';
    };

    HSync.toggleAdvancedMapping = function () {
        HSync.state.mappingShowAdvanced = !HSync.state.mappingShowAdvanced;
        HSync.renderMappingRows();
    };

    HSync.clearMappingValue = function (key) {
        if (HSync.state.mappingValues[key] != null) {
            HSync.state.mappingValues[key] = '';
            HSync.renderMappingRows();
        }
    };

    HSync.addCustomMappingRow = function () {
        // Reserve a placeholder key. The user fills it in via the
        // editable left input. Using a unique placeholder key keeps
        // mappingValues coherent until the user types something.
        let n = 1;
        while (HSync.state.mappingValues['custom_' + n] !== undefined) n++;
        const key = 'custom_' + n;
        HSync.state.mappingValues[key] = '';
        HSync.state.mappingCustomKeys.push(key);
        HSync.renderMappingRows();
        // Focus the new key field so the user can rename immediately.
        setTimeout(() => {
            const idx = HSync.state.mappingCustomKeys.length - 1;
            const input = document.querySelector('[data-custom-key="' + idx + '"]');
            if (input) input.focus();
        }, 0);
    };

    HSync.deleteCustomMappingRow = function (idx) {
        const key = HSync.state.mappingCustomKeys[idx];
        if (!key) return;
        delete HSync.state.mappingValues[key];
        HSync.state.mappingCustomKeys.splice(idx, 1);
        HSync.renderMappingRows();
    };

    HSync.renameCustomMappingKey = function (idx, newKey) {
        const oldKey = HSync.state.mappingCustomKeys[idx];
        const trimmed = (newKey || '').trim();
        if (!oldKey || trimmed === '' || trimmed === oldKey) return;
        // Avoid clobbering a schema key or another custom key.
        const schemaKeys = new Set(HSync.WOO_SCHEMA.map(f => f.key));
        if (schemaKeys.has(trimmed) || (HSync.state.mappingValues[trimmed] !== undefined && trimmed !== oldKey)) {
            alert('La chiave "' + trimmed + '" è già usata. Scegline un\'altra.');
            HSync.renderMappingRows();
            return;
        }
        HSync.state.mappingValues[trimmed] = HSync.state.mappingValues[oldKey] || '';
        delete HSync.state.mappingValues[oldKey];
        HSync.state.mappingCustomKeys[idx] = trimmed;
    };

    /**
     * Track which value input currently has focus. Stored as the Woo
     * key for spine rows or as the "custom:N" string for custom rows
     * — the palette uses this to know where to insert.
     */
    HSync.onMappingValueFocus = function (input) {
        if (input.dataset.mappingKey) {
            HSync.state.mappingFocusedKey = input.dataset.mappingKey;
        } else if (input.dataset.customValue) {
            HSync.state.mappingFocusedKey = 'custom:' + input.dataset.customValue;
        } else {
            return;
        }
        const palette = $('[data-region="mapping-palette"]');
        if (palette) palette.classList.remove('is-hidden');
    };

    function focusedMappingInput() {
        const fk = HSync.state.mappingFocusedKey;
        if (!fk) return null;
        if (fk.startsWith('custom:')) {
            const idx = fk.slice(7);
            return document.querySelector('[data-custom-value="' + idx + '"]');
        }
        return document.querySelector('[data-mapping-key="' + fk + '"]');
    }

    HSync.insertMappingToken = function (token) {
        const input = focusedMappingInput();
        if (!input) {
            alert('Clicca prima dentro un campo per scegliere dove inserire il valore.');
            return;
        }
        const start = input.selectionStart ?? input.value.length;
        const end   = input.selectionEnd   ?? input.value.length;
        const next  = input.value.slice(0, start) + token + input.value.slice(end);
        input.value = next;
        // Sync into state.
        if (input.dataset.mappingKey) {
            HSync.state.mappingValues[input.dataset.mappingKey] = next;
        } else if (input.dataset.customValue) {
            const key = HSync.state.mappingCustomKeys[parseInt(input.dataset.customValue, 10)];
            if (key) HSync.state.mappingValues[key] = next;
        }
        input.focus();
        const caret = start + token.length;
        try { input.setSelectionRange(caret, caret); } catch {}
    };

    HSync.insertMappingSnippet = function (snippetIdx) {
        const snippet = HSync.MAPPING_SNIPPETS[snippetIdx];
        if (!snippet) return;
        const input = focusedMappingInput();
        if (!input) {
            alert('Clicca prima dentro un campo per scegliere dove applicare l\'esempio.');
            return;
        }
        if (input.value && !confirm('Questo campo ha già un valore. Vuoi sostituirlo con l\'esempio?')) return;
        input.value = snippet.value;
        if (input.dataset.mappingKey) {
            HSync.state.mappingValues[input.dataset.mappingKey] = snippet.value;
        } else if (input.dataset.customValue) {
            const key = HSync.state.mappingCustomKeys[parseInt(input.dataset.customValue, 10)];
            if (key) HSync.state.mappingValues[key] = snippet.value;
        }
        HSync.renderMappingRows();
    };

    HSync.toggleMappingJson = function (checked) {
        const view = $('[data-region="mapping-json-view"]');
        view.classList.toggle('is-hidden', !checked);
        if (checked) {
            $('[data-field="map-config"]').value = JSON.stringify(
                HSync.mappingValuesToConfig(), null, 2,
            );
        }
    };

    HSync.applyMappingJson = function () {
        let cfg;
        try {
            cfg = JSON.parse($('[data-field="map-config"]').value || '{}');
        } catch (e) {
            alert('JSON invalido: ' + e.message);
            return;
        }
        HSync.state.mappingValues = {};
        HSync.state.mappingCustomKeys = [];
        const schemaKeys = new Set(HSync.WOO_SCHEMA.map(f => f.key));
        Object.entries(cfg).forEach(([k, v]) => {
            HSync.state.mappingValues[k] = String(v == null ? '' : v);
            if (!schemaKeys.has(k)) HSync.state.mappingCustomKeys.push(k);
        });
        HSync.renderMappingRows();
        alert('JSON applicato — controlla i campi qui sotto.');
    };

    HSync.probeMappingSource = async function () {
        const sourceId = $('[data-field="map-source"]').value;
        if (!sourceId) { alert('Scegli prima la sorgente.'); return; }
        if (!HSync.state.sourceConfigs.length) {
            try {
                const data = await HSync.ajax('source_configs_list', {});
                HSync.state.sourceConfigs = data.configs || [];
            } catch {}
        }
        const cfg = HSync.state.sourceConfigs.find(c => c.source_kind === sourceId);
        if (!cfg) {
            alert('Per fare l\'anteprima ti serve una configurazione salvata per "' + sourceId + '". Vai su Connetti per aggiungerla.');
            return;
        }
        const out = $('[data-region="mapping-probe-output"]');
        out.classList.remove('is-hidden');
        out.innerHTML = '<p class="hsync-loading">Sto leggendo un esempio dalla sorgente…</p>';
        try {
            const data = await HSync.ajax('mapping_probe', {
                source_id: sourceId, config_slug: cfg.slug,
            });
            const rawPaths  = data.paths_raw  || [];
            const dataPaths = data.paths_data || [];
            HSync.state.mappingProbe = {
                pathsRaw:   rawPaths,
                pathsData:  dataPaths,
                sampleRaw:  data.sample_raw,
                sampleData: data.sample_data,
            };
            const warns = (data.warnings || []).map(w =>
                '<div class="hsync-warning">' + esc(w) + '</div>').join('');

            const renderSampleBlock = (label, payload) => payload
                ? '<details><summary>' + esc(label) + '</summary>'
                  + '<pre class="hsync-pre">' + esc(JSON.stringify(payload, null, 2)) + '</pre>'
                  + '</details>'
                : '';

            const sampleSummary = (data.sample_raw || data.sample_data)
                ? renderSampleBlock(
                    'Vedi il prodotto grezzo dal feed (' + data.count + ' totali nella sorgente)',
                    data.sample_raw,
                  )
                  + renderSampleBlock(
                    'Vedi il prodotto dopo la normalizzazione (alternativa)',
                    data.sample_data,
                  )
                : '<div class="hsync-empty">La sorgente non ha restituito alcun prodotto.</div>';

            const tally = rawPaths.length
                ? '<strong>' + rawPaths.length + '</strong> campi del feed disponibili'
                  + (dataPaths.length ? ' (+ ' + dataPaths.length + ' normalizzati come fallback)' : '')
                : (dataPaths.length
                    ? '<strong>' + dataPaths.length + '</strong> campi disponibili '
                      + '<em>(la sorgente non espone i campi grezzi separatamente)</em>'
                    : 'Nessun campo rilevato');

            out.innerHTML = ''
                + '<div class="hsync-summary-label">Anteprima da ' + esc(cfg.name) + '</div>'
                + '<p class="hsync-muted">' + tally + '. Clicca su un campo qui sotto per inserirlo.</p>'
                + warns
                + sampleSummary;
            HSync.renderMappingRows();
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.saveMapping = async function () {
        const jsonOpen = !$('[data-region="mapping-json-view"]').classList.contains('is-hidden');
        let cfg;
        if (jsonOpen) {
            try {
                cfg = JSON.parse($('[data-field="map-config"]').value || '{}');
            } catch (e) {
                alert('Il JSON contiene un errore: ' + e.message);
                return;
            }
        } else {
            cfg = HSync.mappingValuesToConfig();
        }
        // Block save when required fields are unmapped — those are
        // genuine fail-fast cases (no SKU = no upsert key).
        const missing = HSync.WOO_SCHEMA.filter(f =>
            f.required && (!cfg[f.key] || String(cfg[f.key]).trim() === ''),
        );
        if (missing.length) {
            alert('Mancano alcuni campi obbligatori: ' + missing.map(f => f.label || f.key).join(', '));
            return;
        }
        if (!Object.keys(cfg).length) {
            if (!confirm('La mappatura è vuota — vuoi salvarla lo stesso?')) return;
        }
        try {
            await HSync.ajax('mappings_save', {
                slug:        HSync.state.editingMapping ? HSync.state.editingMapping.slug : '',
                name:        $('[data-field="map-name"]').value,
                source_kind: $('[data-field="map-source"]').value,
                config:      cfg,
            });
            HSync.closeMappingEditor();
            HSync.loadMappings();
        } catch (e) {
            alert('Errore salvataggio: ' + e.message);
        }
    };

    HSync.installDefaults = async function (force) {
        if (force && !confirm('Sovrascrive le mappature e i flussi default con la versione del codice. Eventuali modifiche fatte a "gs-default" / "import-default" andranno perse. Procedere?')) return;
        try {
            const data = await HSync.ajax('install_defaults', force ? { force: '1' } : {});
            const m = data.mappings || 0, p = data.pipelines || 0;
            if (m === 0 && p === 0) {
                alert('Default già installati — nessuna modifica.');
            } else {
                alert((force ? 'Aggiornati ' : 'Installati ') + m + ' mappature + ' + p + ' flussi default.');
            }
            HSync.loadMappings();
            if (HSync.state.pipelines.length || HSync.state.currentTab === 'pipelines') HSync.loadPipelines();
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.deleteMapping = async function (slug) {
        if (!confirm('Eliminare questa mapping?')) return;
        try {
            await HSync.ajax('mappings_delete', { slug: slug });
            HSync.loadMappings();
        } catch (e) {
            alert('Errore eliminazione: ' + e.message);
        }
    };

    HSync.populateRunMappings = function () {
        const sel = $('[data-field="run-mapping"]');
        if (!sel) return;
        const sourceId = $('[data-field="run-source"]').value;
        const filtered = sourceId
            ? HSync.state.mappings.filter(m => m.source_kind === sourceId)
            : HSync.state.mappings;
        sel.innerHTML = '<option value="">— nessuna —</option>'
            + filtered.map(m => '<option value="' + esc(m.slug) + '">' + esc(m.name) + '</option>').join('');
    };

    // ─── Run ──────────────────────────────────────────────────────

    HSync.onRunSourceChange = function () {
        const sourceId = $('[data-field="run-source"]').value;
        const region   = $('[data-region="run-config-fields"]');
        if (!sourceId) {
            region.innerHTML = '';
            HSync.populateRunConfigPicker();
            return;
        }
        const src = HSync.state.sources.find(s => s.id === sourceId);
        if (!src) return;
        region.innerHTML = '<form class="hsync-config-form" data-source="' + esc(src.id) + '" data-context="run">'
            + HSync.renderSchema(src.config_schema, 'run-' + src.id)
            + '</form>';
        // Datalist suggestions for the markup-rules `field` input —
        // same flavor-aware autocomplete the Connetti tab gets.
        // Without this call the run form rendered the `campo` input
        // as plain text and the operator had to remember field names
        // (_sf_brand / _gs_category / pa_brand / …) by heart.
        const runForm = region.querySelector('form.hsync-config-form');
        if (runForm) HSync.applyMarkupFlavorVisibility(runForm);
        if (HSync.state.mappings.length === 0) HSync.loadMappings();
        else HSync.populateRunMappings();
        HSync.loadSourceConfigs(sourceId);
        HSync.populateRunPipelinePicker();
    };

    HSync.populateRunPipelinePicker = async function () {
        const sel = $('[data-field="run-pipeline"]');
        if (!sel) return;
        if (!HSync.state.pipelines.length) {
            try { await HSync.loadPipelines(); } catch {}
        }
        const previous = sel.value;
        sel.innerHTML = '<option value="">— nessuna (fetch → diff → materialize) —</option>'
            + HSync.state.pipelines.map(p =>
                '<option value="' + esc(p.slug) + '"' + (p.slug === 'import-default' && !previous ? ' selected' : '') + '>'
                + esc(p.name) + '</option>'
            ).join('');
        if (previous) sel.value = previous;
    };

    HSync.loadSourceConfigs = async function (sourceId) {
        try {
            const data = await HSync.ajax('source_configs_list', { source_kind: sourceId || '' });
            HSync.state.sourceConfigs = data.configs || [];
            HSync.populateRunConfigPicker();
        } catch (e) {
            console.warn('Hive Sync: source_configs_list failed —', e.message);
        }
    };

    HSync.populateRunConfigPicker = function () {
        const sel = $('[data-field="run-config-slug"]');
        if (!sel) return;
        const sourceId = $('[data-field="run-source"]').value;
        const filtered = sourceId
            ? HSync.state.sourceConfigs.filter(c => c.source_kind === sourceId)
            : [];
        sel.innerHTML = '<option value="">— Inline (compila i campi qui sotto) —</option>'
            + filtered.map(c => '<option value="' + esc(c.slug) + '">' + esc(c.name) + '</option>').join('');
        sel.addEventListener('change', HSync.onRunConfigSlugChange, { once: true });
    };

    HSync.onRunConfigSlugChange = function () {
        const slug = $('[data-field="run-config-slug"]').value;
        const cfg  = slug ? (HSync.state.sourceConfigs.find(c => c.slug === slug)?.config || {}) : null;
        const form = $('[data-context="run"]');
        if (!form) return;
        if (!cfg) return;
        // Hydrate visible fields with stored values (secrets stay redacted).
        // Mirrors loadSourceConfigEditor's special-case for markup_rules:
        // the hidden carrier holds the JSON, but the visible rows need
        // an explicit repaint — without it picking a saved config
        // showed empty rule rows even when the config had rules.
        $$('input, select, textarea', form).forEach(el => {
            if (!el.name) return;
            if (Object.prototype.hasOwnProperty.call(cfg, el.name)) {
                const val = cfg[el.name];
                if (el.type === 'checkbox') {
                    el.checked = !!val;
                } else if (el.type === 'password' && /^•+/.test(String(val))) {
                    el.placeholder = String(val);
                    el.value = '';
                } else if (el.name === 'markup_rules') {
                    const list = Array.isArray(val) ? val : [];
                    el.value = JSON.stringify(list);
                    const region = el.closest('[data-markup-region]');
                    const rowsEl = region && region.querySelector('[data-markup-rows]');
                    if (rowsEl) {
                        rowsEl.innerHTML = list.map((r, i) => HSync.renderMarkupRuleRow(r, i)).join('');
                    }
                } else {
                    el.value = String(val ?? '');
                }
            }
        });
        // Flavor may have just changed via the saved config — refresh
        // markup-rules visibility + datalist suggestions on the
        // `field` (campo) inputs so the operator gets the right
        // autocomplete (_sf_*, _gs_*, pa_*) for the picked flavor.
        HSync.applyMarkupFlavorVisibility(form);
        // Re-attach listener so subsequent picks still hydrate.
        $('[data-field="run-config-slug"]').addEventListener('change', HSync.onRunConfigSlugChange, { once: true });
    };

    HSync.saveCurrentConfig = async function () {
        const sourceId = $('[data-field="run-source"]').value;
        if (!sourceId) { alert('Scegli una sorgente.'); return; }
        const form = $('[data-context="run"]');
        const config = form ? HSync.collectConfig(form) : {};
        const slug = $('[data-field="run-config-slug"]').value;  // empty = new
        const name = prompt(slug ? 'Aggiorna il nome:' : 'Nome per questa config:', slug ? (HSync.state.sourceConfigs.find(c => c.slug === slug)?.name || '') : '');
        if (!name) return;
        try {
            const data = await HSync.ajax('source_configs_save', {
                slug: slug, name: name, source_kind: sourceId, config: config,
            });
            await HSync.loadSourceConfigs(sourceId);
            $('[data-field="run-config-slug"]').value = data.slug;
        } catch (e) {
            alert('Errore: ' + e.message);
        }
    };

    /**
     * Cron presets the user picks from when saving a Run as a scheduled
     * Job. Free-form input is also accepted — the server validates via
     * CronExpr::parse.
     */
    HSync.cronPresets = [
        { label: 'Ogni 15 minuti',     expr: '*/15 * * * *' },
        { label: 'Ogni 30 minuti',     expr: '*/30 * * * *' },
        { label: 'Ogni ora',           expr: '0 * * * *' },
        { label: 'Ogni 6 ore',         expr: '0 */6 * * *' },
        { label: 'Giornaliero (02:00)',expr: '0 2 * * *' },
        { label: 'Lun-Ven 02:00',      expr: '0 2 * * 1-5' },
    ];

    /**
     * Translate a 5-field cron expression into Italian. Returns
     * an empty string when the expression is unknown — caller falls
     * back to showing the raw expression alone.
     *
     * Pattern matching only — no full cron evaluation. Common shapes
     * (every N minutes/hours, daily, weekly, monthly) get a friendly
     * label; anything else returns ''. The raw cron is always shown
     * alongside this label so the operator can verify.
     */
    HSync.describeCron = function (expr) {
        const e = String(expr || '').trim();
        if (!e) return '';
        const parts = e.split(/\s+/);
        if (parts.length !== 5) return '';
        const [m, h, dom, mon, dow] = parts;

        const pad = n => String(n).padStart(2, '0');
        const star = '*';

        // Day-of-week phrases used when dow is restricted.
        const dowPhrase = (s) => {
            if (s === star) return 'ogni giorno';
            if (s === '1-5') return 'da lunedì a venerdì';
            if (s === '0,6' || s === '6,0') return 'sabato e domenica';
            const single = { 0: 'domenica', 1: 'lunedì', 2: 'martedì', 3: 'mercoledì', 4: 'giovedì', 5: 'venerdì', 6: 'sabato', 7: 'domenica' };
            if (/^\d$/.test(s) && single[s]) return single[s];
            return '';
        };

        // — Sub-hour: */N * * * *  → ogni N minuti
        const stepMin = m.match(/^\*\/(\d+)$/);
        if (stepMin && h === star && dom === star && mon === star && dow === star) {
            const n = parseInt(stepMin[1], 10);
            if (n === 1) return 'Ogni minuto';
            return 'Ogni ' + n + ' minuti';
        }
        // — Hourly at minute M: M * * * *
        if (/^\d+$/.test(m) && h === star && dom === star && mon === star && dow === star) {
            const mm = parseInt(m, 10);
            if (mm === 0) return 'Ogni ora (al minuto :00)';
            return 'Ogni ora (al minuto :' + pad(mm) + ')';
        }
        // — Every N hours at minute M: M */N * * *
        const stepHr = h.match(/^\*\/(\d+)$/);
        if (/^\d+$/.test(m) && stepHr && dom === star && mon === star && dow === star) {
            const n = parseInt(stepHr[1], 10);
            const mm = parseInt(m, 10);
            const at = mm === 0 ? '' : ' (al minuto :' + pad(mm) + ')';
            if (n === 1) return 'Ogni ora' + at;
            return 'Ogni ' + n + ' ore' + at;
        }
        // — Daily at H:M: M H * * <dow>
        if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === star && mon === star) {
            const time = pad(parseInt(h, 10)) + ':' + pad(parseInt(m, 10));
            const phrase = dowPhrase(dow);
            if (phrase === 'ogni giorno') return 'Ogni giorno alle ' + time;
            if (phrase) return ucfirst(phrase) + ' alle ' + time;
            return '';
        }
        // — Monthly on day D at H:M: M H D * *
        if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === star && dow === star) {
            const day = parseInt(dom, 10);
            const time = pad(parseInt(h, 10)) + ':' + pad(parseInt(m, 10));
            const ord = day === 1 ? 'il 1°' : 'il ' + day;
            return ucfirst(ord) + ' di ogni mese alle ' + time;
        }
        return '';

        function ucfirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    };

    HSync.saveCurrentAsJob = async function () {
        const sourceId = $('[data-field="run-source"]').value;
        if (!sourceId) { alert('Scegli una sorgente.'); return; }

        const formEl = $('[data-context="run"]');
        const config = formEl ? HSync.collectConfig(formEl) : {};
        const configSlug  = $('[data-field="run-config-slug"]').value;
        const mappingSlug = $('[data-field="run-mapping"]').value;
        const mapping     = mappingSlug ? HSync.state.mappings.find(m => m.slug === mappingSlug) : null;
        const options     = mapping ? { mapping: mapping.config } : {};

        // Build a tiny picker as a prompt — keeps the dependency surface
        // small (no modal library). User can paste a custom cron too.
        const presetList = HSync.cronPresets
            .map((p, i) => '  ' + (i + 1) + ') ' + p.label + '   →  ' + p.expr)
            .join('\n');
        const choice = prompt(
            'Inserisci una cron expression (5 campi)\n\n' +
            'Presets:\n' + presetList + '\n\n' +
            'Digita il numero di un preset OPPURE l\'espressione cron completa:',
            '0 * * * *',
        );
        if (!choice) return;

        let cron = choice.trim();
        const idx = parseInt(cron, 10);
        if (!isNaN(idx) && cron === String(idx) && idx >= 1 && idx <= HSync.cronPresets.length) {
            cron = HSync.cronPresets[idx - 1].expr;
        }

        // Job ref: 'sourceId' for inline config, 'sourceId/configSlug' for stored.
        const ref = configSlug ? (sourceId + '/' + configSlug) : sourceId;

        // Job config: when using a saved config, only options travel; the
        // dispatcher hydrates the rest from SourceConfigRepository.
        // When inline, ship the full form payload so the job is self-contained.
        const jobConfig = configSlug
            ? { options: options }
            : { inline_config: config, options: options };

        try {
            const data = await HSync.ajax('job_save', {
                id:            '0',
                runnable_type: 'source.import',
                runnable_ref:  ref,
                cron_expr:     cron,
                enabled:       '1',
                config:        jobConfig,
            });
            const next = data.next_run_at
                ? HSync.fmtWhen(data.next_run_at, { date: true }) + ' (' + HSync.tzLabel() + ')'
                : '—';
            if (confirm('Automazione creata.\nProssima esecuzione: ' + next + '\n\nApri il tab Automatizza?')) {
                HSync.switchTab('jobs');
            }
        } catch (e) {
            alert('Errore creazione job: ' + e.message);
        }
    };

    /**
     * Run the configured source, auto-resuming whenever the server
     * yields with status='continue' (cooperative deadline). Each tick
     * is capped server-side at ~25s so Apache workers don't stall;
     * the JS loops fresh AJAX calls until the run finishes or fails.
     *
     * Accumulates rows across ticks so the result table grows
     * incrementally — the user sees progress live instead of staring
     * at a spinner for the full duration.
     */
    HSync.runNow = async function () {
        // Claim the output region — a Media-tab repair may have pointed
        // it elsewhere, and this run must render in the Importa tab.
        HSync.runOutputSel = '[data-region="run-output"]';
        HSync.runListener  = null;
        const sourceId = $('[data-field="run-source"]').value;
        if (!sourceId) { alert('Scegli una sorgente.'); return; }
        const formEl = $('[data-context="run"]');
        const config = formEl ? HSync.collectConfig(formEl) : {};
        const configSlug = $('[data-field="run-config-slug"]').value;
        const dryRun = $('[data-field="run-dry-run"]').checked;
        const mappingSlug = $('[data-field="run-mapping"]').value;
        const mapping = mappingSlug ? HSync.state.mappings.find(m => m.slug === mappingSlug) : null;
        const pipelineSlug = ($('[data-field="run-pipeline"]') || {}).value || '';
        const limitInput = $('[data-field="run-limit"]');
        const limit = limitInput ? Math.max(0, parseInt(limitInput.value, 10) || 0) : 0;
        const maxTicksInput = $('[data-field="run-max-ticks"]');
        const maxTicks = maxTicksInput ? Math.max(0, parseInt(maxTicksInput.value, 10) || 0) : 200;
        const modeEl = document.querySelector('input[name="hsync-run-mode"]:checked');
        const mode = modeEl ? String(modeEl.value || 'full') : 'full';
        const forceRecreateEl = $('[data-field="run-force-recreate"]');
        const forceRecreate = forceRecreateEl ? !!forceRecreateEl.checked : false;
        const healMediaEl = $('[data-field="run-heal-media"]');
        const healMedia = healMediaEl ? !!healMediaEl.checked : false;
        const skusEl = $('[data-field="run-skus"]');
        const skus = skusEl ? String(skusEl.value || '').trim() : '';
        const retireEl = $('[data-field="run-retire-missing"]');
        const retireMissing = retireEl ? !!retireEl.checked : false;
        const retireModeEl = $('[data-field="run-retire-mode"]');
        const retireMode = retireModeEl ? String(retireModeEl.value || 'hidden') : 'hidden';
        const retireRatioEl = $('[data-field="run-retire-max-ratio"]');
        // Sent as a fraction — the field is a percentage because that is
        // how the guard reports itself. Clamped to 1..100 so a stray 0
        // can't read as "no limit" (the server re-clamps anyway).
        const retireMaxRatio = retireRatioEl
            ? Math.min(100, Math.max(1, parseInt(retireRatioEl.value, 10) || 35)) / 100
            : 0.35;
        const options = {};
        if (mapping)        options.mapping = mapping.config;
        if (pipelineSlug)   options.pipeline_slug = pipelineSlug;
        if (limit > 0)      options.limit = limit;
        if (mode && mode !== 'full') options.mode = mode;
        if (forceRecreate)  options.force_recreate = true;
        // Sent raw — the server parses newline / comma / semicolon / space
        // separated lists (operators paste straight out of a spreadsheet).
        if (skus)           options.skus = skus;
        // Non-destructive, so no confirm gate: it only re-queues products
        // that are visibly broken (no featured image) and that the feed
        // can actually repair, through the ordinary update path.
        if (healMedia)      options.heal_media = true;
        // Reversible by construction (the previous status/visibility is
        // snapshotted per product and replayed if the SKU comes back),
        // and guarded server-side against an empty or truncated feed —
        // so no confirm gate. The server also refuses to sweep when the
        // run is narrowed by `skus` or capped by `limit`, and says so in
        // the warnings rather than silently doing nothing.
        if (retireMissing) {
            options.retire_missing  = true;
            options.retire_mode     = retireMode;
            options.retire_max_ratio = retireMaxRatio;
        }

        // Force-recreate is destructive on the variation set — confirm
        // before kicking off a non-dry run. Skip the prompt in dry-run
        // mode (no writes happen) and when there's a saved cursor (the
        // user already confirmed for this run; resuming doesn't re-ask).
        if (forceRecreate && ! dryRun) {
            const limitLabel = limit > 0 ? ' Limite: ' + limit + '.' : '';
            // The blast radius depends on whether a SKU selection is
            // active. Saying "OGNI prodotto del feed" when the operator
            // narrowed the run to 12 SKUs would either scare them off a
            // safe action or teach them to dismiss the dialog unread.
            const skuCount = skus
                ? skus.split(/[\r\n,;\t ]+/).filter(Boolean).length
                : 0;
            const scope = skuCount > 0
                ? 'Per i ' + skuCount + ' SKU selezionati'
                : 'Per OGNI prodotto esistente nel feed corrente';
            const ok = confirm(
                'Forza ricreazione attiva.\n\n' +
                scope + ' verranno cancellate' +
                ' tutte le varianti, i termini pa_* e il meta _product_attributes,' +
                ' poi tutto sarà riscritto dal feed come fosse un primo import.\n\n' +
                'L\'ID del prodotto viene preservato (gli ordini storici restano' +
                ' validi). Gli ID delle VARIANTI cambiano.' + limitLabel + '\n\n' +
                'Continuare?'
            );
            if (! ok) return;
        }

        await HSync.runImportTicked(sourceId, configSlug, config, options, dryRun, null, maxTicks);
    };

    /**
     * The reusable tick-loop body. Extracted from runNow so the
     * "Riprendi da qui" button (after a transient tick failure) can
     * re-enter the loop with a preserved cursor instead of restarting
     * from scratch on a 15k-product import.
     */
    /**
     * Where the tick loop renders. Defaults to the Importa tab; the
     * Media tab's repair points it at its own region so the operator
     * watches progress where they started, instead of being teleported
     * to another tab mid-action. Whoever STARTS a run sets this, so a
     * run abandoned half-way can never leave the next one writing into
     * a hidden panel.
     */
    HSync.runOutputSel = '[data-region="run-output"]';

    /**
     * Optional observer of the tick loop: listener(phase, payload) with
     * phase 'start' | 'tick' | 'end'. The simple Importa draws its own
     * progress from it instead of forking the loop (retry, backoff and
     * resume stay in one place). Same ownership rule as runOutputSel:
     * whoever STARTS a run sets it — or clears it — so a later run can
     * never report into the previous run's view.
     */
    HSync.runListener = null;

    HSync.runImportTicked = async function (sourceId, configSlug, config, options, dryRun, startCursor, maxTicksOpt) {
        const out = $(HSync.runOutputSel);
        if (! startCursor) {
            out.innerHTML = '<p class="hsync-loading">Tick 1: starting…</p>';
        }
        // Captured now: the listener of the run being started, not of
        // whatever run is started next.
        const listener = typeof HSync.runListener === 'function' ? HSync.runListener : null;
        const notify = (phase, payload) => {
            if (!listener) return;
            try { listener(phase, payload || {}); } catch (err) { /* a broken view must not break the run */ }
        };
        // "Interrompi" sets this; the loop reads it between two ticks.
        HSync.state.runAbort = false;
        notify('start', { resumed: !!startCursor });

        // Two-bucket accumulator across ticks:
        //   - diffSnapshot: the source-diff numbers (fetched, new,
        //     update, update_stock, unchanged) — captured ONCE from the
        //     first tick and held stable. On subsequent ticks the diff
        //     re-runs and counts shrink as items get processed (already-
        //     created items leave the `new` bucket on tick 2, etc.) so
        //     they're not the right thing to display.
        //   - totals: the result counters (created, updated,
        //     stock_patched, skipped, failed, pre_blocked, post_blocked)
        //     SUMMED across every tick — that's the cumulative work
        //     done by the run, not just the last tick's slice.
        // Server-side each tick still resets its own summary; the JS
        // is the system of record for cross-tick aggregation.
        const RESULT_KEYS = ['created', 'updated', 'recreated', 'stock_patched', 'skipped', 'failed', 'pre_blocked', 'post_blocked',
                             // Sweep results. Per-tick like the rest —
                             // the diff-level counts (`missing`,
                             // `restorable`) live in the snapshot below.
                             'retired', 'restored'];
        const accumulated = {
            rows: [], warnings: [], runId: null,
            diffSnapshot: null,
            totals: RESULT_KEYS.reduce((acc, k) => (acc[k] = 0, acc), {}),
        };
        let cursor = startCursor || null;
        let tick = 0;
        // Operator-controlled cap (input data-field="run-max-ticks", default 200).
        // 0 means uncapped — surfaced as Infinity so the loop never short-circuits.
        const requestedCap = (typeof maxTicksOpt === 'number') ? maxTicksOpt : 200;
        const maxTicks = requestedCap > 0 ? requestedCap : Infinity;

        // Retry-with-backoff for transient tick failures (PHP fatal,
        // 502, idle-tab killed connection). Runs of 15k+ products
        // can't tolerate a single bad tick aborting the whole loop.
        const maxRetries  = 3;
        const backoffMs   = [2000, 4000, 8000];
        const sleep       = (ms) => new Promise(r => setTimeout(r, ms));

        const fetchTick = async () => {
            let lastErr = null;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    return await HSync.ajax('run_now', {
                        source_id:   sourceId,
                        config_slug: configSlug,
                        config:      config,
                        options:     options,
                        dry_run:     dryRun ? '1' : '0',
                        cursor:      cursor || {},
                    });
                } catch (e) {
                    lastErr = e;
                    if (! e.transient || attempt === maxRetries) throw e;
                    // "Interrompi" while the loop is waiting to retry: stop
                    // now, as a stop — not 14s later as a failure.
                    if (HSync.state.runAbort) { e.aborted = true; throw e; }
                    const wait = backoffMs[attempt] || 8000;
                    out.insertAdjacentHTML('beforeend',
                        '<div class="hsync-warning">Tick ' + tick + ' instabile (' + esc(e.message) + '). Ritento tra ' + (wait / 1000) + 's…</div>');
                    await sleep(wait);
                    if (HSync.state.runAbort) { e.aborted = true; throw e; }
                }
            }
            throw lastErr;
        };

        let lastData = null;
        let lastComposed = null;
        let aborted = false;
        try {
            while (tick < maxTicks) {
                // Stop between ticks: the one in flight finishes (≤ ~25s)
                // so the run ends on a clean cursor, never mid-product.
                if (HSync.state.runAbort) { aborted = true; break; }
                tick++;
                const data = await fetchTick();
                lastData = data;

                accumulated.runId    = data.run_id || accumulated.runId;
                accumulated.warnings = data.warnings || accumulated.warnings;
                if (Array.isArray(data.rows)) {
                    // Server returns rows from THIS tick only; concat to grow live.
                    accumulated.rows = accumulated.rows.concat(data.rows).slice(0, 1000);
                }

                const tickSummary = data.summary || {};
                if (!accumulated.diffSnapshot) {
                    accumulated.diffSnapshot = {
                        fetched:        tickSummary.fetched        || 0,
                        new:            tickSummary.new            || 0,
                        update:         tickSummary.update         || 0,
                        update_stock:   tickSummary.update_stock   || 0,
                        unchanged:      tickSummary.unchanged      || 0,
                        // Snapshot the force-recreate queue size so the
                        // processing-pool math + reconciliation line
                        // include the unchanged items the runner pulled
                        // into the force queue. Without this snapshot
                        // the pool reads as new + update + update_stock
                        // only, leaving every recreated-from-unchanged
                        // item looking like "extra accounted" instead
                        // of accounted-against-pool.
                        force_recreate: tickSummary.force_recreate || 0,
                        // Diff-level like force_recreate, NOT a per-tick
                        // result counter: the healed items are already
                        // folded into `update`, so summing it across
                        // ticks would double-report the repair.
                        healed_media:   tickSummary.healed_media   || 0,
                        // Selection accounting — diff-level like the two
                        // above. The missing list is carried verbatim so
                        // the report can name the SKUs that didn't land.
                        sku_requested:    tickSummary.sku_requested    || 0,
                        sku_matched:      tickSummary.sku_matched      || 0,
                        sku_missing:      tickSummary.sku_missing      || 0,
                        sku_missing_list: tickSummary.sku_missing_list || [],
                        // Sweep accounting — diff-level, computed once
                        // on tick 1 from a catalog-wide query. Summing
                        // these across ticks would multiply the queue
                        // size by the tick count.
                        missing:          tickSummary.missing          || 0,
                        restorable:       tickSummary.restorable       || 0,
                        retire_mode:      tickSummary.retire_mode      || '',
                        retire_owned:     tickSummary.retire_owned     || 0,
                        retire_skipped:   tickSummary.retire_skipped   || '',
                        retire_aborted:   tickSummary.retire_aborted   || '',
                        retire_would:     tickSummary.retire_would     || 0,
                    };
                }
                RESULT_KEYS.forEach(k => {
                    accumulated.totals[k] += (tickSummary[k] || 0);
                });

                // Compose the summary the renderer reads: diff snapshot
                // from tick 1, result totals across all ticks.
                const composed = Object.assign({}, accumulated.diffSnapshot, accumulated.totals);
                lastComposed = composed;

                HSync.renderRunResult({
                    status:   data.status,
                    run_id:   accumulated.runId,
                    summary:  composed,
                    warnings: accumulated.warnings,
                    rows:     accumulated.rows,
                    progress: data.progress,
                    tick:     tick,
                });
                notify('tick', {
                    status:   data.status,
                    run_id:   accumulated.runId,
                    summary:  composed,
                    progress: data.progress || null,
                    warnings: accumulated.warnings,
                    tick:     tick,
                });

                if (data.status === 'continue') {
                    cursor = data.cursor || null;
                    if (!cursor || cursor.index === undefined) break;  // server forgot a cursor — bail
                    continue;
                }
                break;  // 'done' or 'failed'
            }
            if (aborted) {
                // Close the Storico row now: a browser run that just stops
                // ticking reads "In corso" for a day, until the upkeep files
                // it as abandoned.
                if (accumulated.runId) {
                    try { await HSync.ajax('run_cancel', { run_id: accumulated.runId }); } catch (err) { /* row is closed by the upkeep */ }
                }
                out.insertAdjacentHTML('beforeend', '<div class="hsync-warning">Run interrotto dall\'operatore.</div>');
                notify('end', { status: 'cancelled', run_id: accumulated.runId, summary: lastComposed });
                return;
            }
            // Only when the cap actually cut the run short: a run whose
            // last allowed tick FINISHED still holds the previous cursor.
            if (tick >= maxTicks && cursor && lastData && lastData.status === 'continue') {
                // Mirror the catch-path: stash everything needed so the
                // resume button below has state to act on. Without this
                // hitting the cap leaves the operator stranded.
                HSync.lastFailedRun = {
                    sourceId, configSlug, config, options, dryRun,
                    cursor, tick, accumulated,
                    maxTicks: requestedCap,
                };
                out.insertAdjacentHTML('beforeend',
                    '<div class="hsync-warning">Tetto Max tick raggiunto (' + maxTicks + '). Cursor preservato. '
                    + '<button type="button" class="hsync-button" data-action="run-resume">Riprendi da qui</button>'
                    + '</div>');
                notify('end', { status: 'paused', run_id: accumulated.runId, summary: lastComposed, resumable: true });
                return;
            }
            const finalStatus = lastData ? String(lastData.status || '') : '';
            notify('end', {
                status:   finalStatus === 'continue' ? 'error' : finalStatus,
                run_id:   accumulated.runId,
                summary:  lastComposed,
                warnings: accumulated.warnings,
                error:    lastData && lastData.error ? String(lastData.error)
                          : (finalStatus === 'continue' ? 'il server non ha restituito il punto da cui riprendere' : ''),
            });
        } catch (e) {
            if (e.aborted) {
                // Stopped while retrying a shaky tick: same ending as a
                // stop between two healthy ticks.
                if (accumulated.runId) {
                    try { await HSync.ajax('run_cancel', { run_id: accumulated.runId }); } catch (err) { /* closed by the upkeep */ }
                }
                out.insertAdjacentHTML('beforeend', '<div class="hsync-warning">Run interrotto dall\'operatore.</div>');
                notify('end', { status: 'cancelled', run_id: accumulated.runId, summary: lastComposed });
                return;
            }
            // Persist the in-flight cursor so the operator can resume
            // manually. Cursor was returned by the LAST successful tick
            // and is what we'd send next — so it points at the item we
            // were about to process when things broke.
            const resumeCursor = cursor || (e.payload && e.payload.cursor) || null;
            HSync.lastFailedRun = {
                sourceId, configSlug, config, options, dryRun,
                cursor: resumeCursor,
                tick,
                accumulated,
                // Without it a resumed run fell back to the 200-tick
                // default, capping a run that was started uncapped.
                maxTicks: requestedCap,
            };
            const resumeBtn = resumeCursor
                ? '<button type="button" class="hsync-button" data-action="run-resume">Riprendi da qui</button>'
                : '';
            out.insertAdjacentHTML('beforeend',
                '<div class="hsync-error">Tick ' + tick + ' fallito: ' + esc(e.message)
                + (resumeCursor ? ' · cursor preservato' : '')
                + ' ' + resumeBtn + '</div>');
            notify('end', {
                status: 'error', run_id: accumulated.runId, summary: lastComposed,
                error: e.message, resumable: !!resumeCursor,
            });
        }
    };

    /**
     * Resume the last failed run from its preserved cursor. Wired to
     * the "Riprendi da qui" button shown when the tick loop blows up.
     * Reuses runImportTicked but threads the saved cursor in so the
     * server picks up where the crash left off.
     */
    HSync.resumeFailedRun = async function () {
        const r = HSync.lastFailedRun;
        if (! r || ! r.cursor) return;
        const out = $(HSync.runOutputSel);
        out.insertAdjacentHTML('beforeend',
            '<div class="hsync-loading">Ripresa da tick ' + r.tick + '…</div>');
        // Re-enter the tick loop with the saved cursor as the starting
        // point. We rebuild a fresh accumulator so reconciliation
        // numbers are clean for the resumed segment.
        await HSync.runImportTicked(r.sourceId, r.configSlug, r.config, r.options, r.dryRun, r.cursor, r.maxTicks);
    };

    HSync.renderRunResult = function (data) {
        const out = $(HSync.runOutputSel);
        const s   = data.summary || {};
        const p   = data.progress || {};
        const stat = (label, num, kind) =>
            '<div class="hsync-stat ' + (kind || '') + '"><div class="hsync-stat-num">' + (num || 0) + '</div><div class="hsync-stat-label">' + label + '</div></div>';

        // Status banner: continue→spinner, done→green, failed→red.
        let status = data.status || '';
        let statusBadge;
        if (status === 'continue') {
            const pct = p.total ? Math.round((p.done || 0) * 100 / p.total) : 0;
            statusBadge = '<span class="hsync-action-pill is-updated">running</span> '
                + 'tick ' + (data.tick || 1)
                + ' · ' + (p.done || 0) + '/' + (p.total || '?')
                + ' (' + pct + '%)';
        } else if (status === 'done') {
            statusBadge = '<span class="hsync-action-pill is-created">done</span>';
        } else if (status === 'failed') {
            statusBadge = '<span class="hsync-action-pill is-failed">failed</span>';
        } else {
            statusBadge = '<span class="hsync-action-pill is-skipped">' + esc(status) + '</span>';
        }

        // `unchanged` items were never processed (diff said they're identical
        // to the existing product). The processing pool is `new + update`,
        // and the result must reconcile to that count. We surface every
        // bucket — including the four blocking/failure paths — so users can
        // see exactly where each item went.
        // Reconciliation math — every bucket the diff produced is part
        // of the processing pool, every result counter is part of the
        // accounted total. update_stock + stock_patched are first-class
        // here (the fast-stock-patch path can dwarf new+update on big
        // refresh runs).
        // The sweep items are queued items like any other, so they belong
        // on BOTH sides of the reconciliation. Counting the retires as
        // results without counting them into the pool would report a
        // permanent "N extra accounted" on every swept run.
        const sweepPool = (s.missing || 0) + (s.restorable || 0);
        const processingPool = (s.new || 0) + (s.update || 0) + (s.update_stock || 0)
                        // Force-recreate pulls `unchanged` into the
                        // processing pool too — they're not unchanged
                        // when the operator explicitly asked for a
                        // rewrite. summary.force_recreate is the
                        // override count; if present, it replaces the
                        // sum of update + update_stock since they got
                        // re-bucketed into one combined queue.
                        + ((s.force_recreate || 0) > 0
                            ? Math.max(0, (s.force_recreate || 0) - ((s.update || 0) + (s.update_stock || 0)))
                            : 0)
                        + sweepPool;
        const accounted = (s.created || 0) + (s.updated || 0) + (s.recreated || 0)
                        + (s.stock_patched || 0)
                        + (s.retired || 0) + (s.restored || 0)
                        + (s.skipped || 0) + (s.failed || 0)
                        + (s.pre_blocked || 0) + (s.post_blocked || 0);
        const inFlight = Math.max(0, processingPool - accounted);
        const reconcileBad = (status === 'done' && inFlight > 0) ? 'is-bad' : '';

        // Selection block — only when the run was narrowed to a SKU
        // list. Missing SKUs get named, not just counted: "10 of 12
        // imported" is useless if you can't tell WHICH two didn't.
        const missingList = Array.isArray(s.sku_missing_list) ? s.sku_missing_list : [];
        const selection = (s.sku_requested || 0) > 0
            ? '<div class="hsync-summary-section">'
            +   '<div class="hsync-summary-label">Selezione SKU</div>'
            +   '<div class="hsync-summary">'
            +     stat('Richiesti', s.sku_requested)
            +     stat('Trovati nel feed', s.sku_matched,
                       (s.sku_matched || 0) > 0 ? 'is-good' : 'is-bad')
            +     stat('Non trovati', s.sku_missing,
                       (s.sku_missing || 0) > 0 ? 'is-bad' : 'is-dim')
            +   '</div>'
            +   (missingList.length
                    ? '<div class="hsync-warning">Non presenti nel feed: '
                      + missingList.map(esc).join(', ')
                      + ((s.sku_missing || 0) > missingList.length ? ', …' : '')
                      + '</div>'
                    : '')
            + '</div>'
            : '';

        // Sweep block — only when the run asked for it. Deliberately
        // ABOVE the diff: a delisted product live on the storefront is
        // the thing the operator turned this on to see, and burying it
        // under the import counters is how it stays unnoticed.
        const sweepOn = (s.retire_mode || '') !== '';
        const sweepModeLabel = {
            hidden:       'nascosto dal catalogo + esaurito',
            outofstock:   'solo esaurito',
            draft:        'in bozza + esaurito',
            // The restore-only pass runs on every sync, so its block
            // only appears when it actually brought something back.
            restore_only: 'solo ripristini',
        }[s.retire_mode] || s.retire_mode;
        const sweepBlocked = {
            skus:            'il run è ristretto a una lista di SKU',
            limit:           'è attivo un limite "Max prodotti"',
            media_only:      'modalità Solo media',
            category_filter: 'il job ha un filtro di categoria: vede solo una fetta del catalogo',
            no_provenance:   'la sorgente non marca i prodotti che crea',
        }[s.retire_skipped] || s.retire_skipped;
        const sweepNote = s.retire_aborted
            ? '<div class="hsync-warning">Spazzata ANNULLATA ('
              + (s.retire_aborted === 'feed_empty'
                    ? 'il feed non ha restituito nessuno SKU'
                    : s.retire_aborted === 'ratio_guard'
                        ? 'oltre la soglia di sicurezza: ' + (s.retire_would || 0) + ' prodotti su '
                          + (s.retire_owned || 0) + ', mentre il feed ne ha restituiti ' + (s.fetched || 0)
                          + ' di cui ' + (s.retire_matched || 0) + ' combacianti'
                        : esc(s.retire_aborted))
              + '). Nessun prodotto è stato oscurato.</div>'
            : (s.retire_skipped
                ? '<div class="hsync-warning">Spazzata non eseguita: ' + esc(sweepBlocked)
                  + '. I ripristini vengono comunque applicati.</div>'
                : '');
        const sweepBlock = sweepOn
            ? '<div class="hsync-summary-section">'
            +   '<div class="hsync-summary-label">Prodotti spariti dal feed — '
            +     esc(sweepModeLabel) + '</div>'
            +   '<div class="hsync-summary">'
            +     (s.retire_mode === 'restore_only'
                    ? ''
                    : stat('Del fornitore in Woo', s.retire_owned, 'is-dim')
                    + stat('Spariti dal feed', s.missing, (s.missing || 0) > 0 ? 'is-bad' : 'is-dim'))
            +     stat('Oscurati',             s.retired,    (s.retired    || 0) > 0 ? 'is-good' : 'is-dim')
            +     stat('Tornati nel feed',     s.restorable, (s.restorable || 0) > 0 ? 'is-good' : 'is-dim')
            +     stat('Ripristinati',         s.restored,   (s.restored   || 0) > 0 ? 'is-good' : 'is-dim')
            +   '</div>'
            +   sweepNote
            +   (Array.isArray(s.retire_sample) && s.retire_sample.length
                    ? '<div class="hsync-summary-foot">SKU interessati (campione): '
                      + s.retire_sample.map(esc).join(', ')
                      + (((s.missing || 0) + (s.retire_would || 0)) > s.retire_sample.length ? ', …' : '')
                      + '</div>'
                    : '')
            + '</div>'
            : '';

        const summary = ''
            + selection
            + sweepBlock
            + '<div class="hsync-summary-section">'
            +   '<div class="hsync-summary-label">Source diff</div>'
            +   '<div class="hsync-summary">'
            +     stat('Fetched',         s.fetched)
            +     stat('New',             s.new)
            +     stat('Update (full)',   s.update)
            +     stat('Update (stock)',  s.update_stock,
                                          (s.update_stock || 0) > 0 ? 'is-good' : 'is-dim')
            +     stat('Unchanged',       s.unchanged, 'is-dim')
            +     ((s.healed_media || 0) > 0
                    ? stat('Media da riparare', s.healed_media, 'is-good')
                    : '')
            +   '</div>'
            + '</div>'
            + '<div class="hsync-summary-section">'
            +   '<div class="hsync-summary-label">Processing pool: ' + processingPool + ' items'
            +     ' (new + update + update_stock' + (sweepPool > 0 ? ' + spariti dal feed' : '') + ')</div>'
            +   '<div class="hsync-summary">'
            +     stat('Created',           s.created,       (s.created       || 0) > 0 ? 'is-good' : '')
            +     stat('Updated',           s.updated,       (s.updated       || 0) > 0 ? 'is-good' : '')
            +     stat('Recreated',         s.recreated,     (s.recreated     || 0) > 0 ? 'is-good' : '')
            +     stat('Stock patched',     s.stock_patched, (s.stock_patched || 0) > 0 ? 'is-good' : '')
            +     stat('Skipped',           s.skipped,       (s.skipped       || 0) > 0 ? 'is-dim'  : '')
            +     stat('Failed',            s.failed,        (s.failed        || 0) > 0 ? 'is-bad'  : '')
            +     stat('Pre-check blocked',  s.pre_blocked,  (s.pre_blocked   || 0) > 0 ? 'is-bad' : '')
            +     stat('Post-check blocked', s.post_blocked, (s.post_blocked  || 0) > 0 ? 'is-bad' : '')
            +   '</div>'
            +   (status === 'done' && processingPool > 0
                ? '<div class="hsync-summary-foot ' + reconcileBad + '">'
                +   'Reconciled ' + accounted + '/' + processingPool
                +   (inFlight > 0
                    ? ' — <strong>' + inFlight + ' unaccounted</strong> (likely a runtime error mid-loop; check the run log)'
                    : ' ✓')
                + '</div>'
                : '')
            + '</div>';

        const warns = (data.warnings || []).map(w =>
            '<div class="hsync-warning">' + esc(w) + '</div>'
        ).join('');

        const rows = (data.rows || []).map((r, i) => {
            const klass  = r.action === 'failed' ? 'is-error' : '';
            const pillKl = 'is-' + (r.action || 'skipped');
            // `error` wins over `reason` — both feed the same column.
            // Skip reasons explain non-failure decisions (dry_run,
            // conflict_block, no_change, etc.) so the user knows whether
            // a "skipped" line is benign or worth investigating.
            const detail = r.error
                ? esc(r.error)
                : (r.reason ? '<span class="hsync-row-reason">' + esc(r.reason) + '</span>' : '');
            // Shape diagnostic: captured by ImportRunner immediately
            // before materialize. Surfaces type/variations-count/
            // attribute-keys/has-reg-price/flavor so the operator can
            // tell at a glance whether a "created" row reached the
            // bridge with the expected variant + price payload, or
            // whether something stripped them upstream.
            let shapeCell = '—';
            if (r.shape) {
                const sh = r.shape;
                const variantsBadge = '<span class="hsync-action-pill is-' + ((sh.variations || 0) > 0 ? 'created' : 'skipped') + '">'
                    + 'var:' + (sh.variations || 0) + '</span>';
                const priceBadge = '<span class="hsync-action-pill is-' + (sh.has_reg_price ? 'created' : 'skipped') + '">'
                    + (sh.has_reg_price ? 'price✓' : 'price✗') + '</span>';
                const attrsTxt = Array.isArray(sh.attribute_keys) ? sh.attribute_keys.join(',') : '';
                shapeCell = '<code>type=' + esc(sh.type || '?') + '</code> '
                    + variantsBadge + ' '
                    + priceBadge
                    + (attrsTxt ? ' <small class="hsync-muted">attrs: ' + esc(attrsTxt) + '</small>' : '')
                    + (sh.flavor ? ' <small class="hsync-muted">flavor: ' + esc(sh.flavor) + '</small>' : '');
            }
            // Post-materialize: what's actually written in Woo NOW.
            // Distinguishes "bridge swallowed the data" from "data
            // never arrived" — both look identical in the Woo admin
            // but only the latter has a `var:0` pre-materialize shape.
            let writtenCell = '—';
            if (r.written) {
                const w = r.written;
                if (w.error) {
                    writtenCell = '<span class="hsync-action-pill is-failed">' + esc(w.error) + '</span>';
                } else if (w.type === 'variable') {
                    const cnt = w.variations_in_woo || 0;
                    const fv = w.first_variation || {};
                    const cntBadge = '<span class="hsync-action-pill is-' + (cnt > 0 ? 'created' : 'skipped') + '">'
                        + 'woo-var:' + cnt + '</span>';
                    writtenCell = '<code>type=variable</code> ' + cntBadge
                        + (cnt > 0
                            ? ' <small>1ª: reg=<code>' + esc(String(fv.regular_price || '?')) + '</code>'
                                + ' sale=<code>' + esc(String(fv.sale_price || '?')) + '</code>'
                                + ' qty=<code>' + esc(String(fv.stock_quantity ?? '?')) + '</code></small>'
                            : '')
                        + ' <small class="hsync-muted">parent stock: ' + esc(w.stock_status || '?') + '</small>';
                } else {
                    writtenCell = '<code>type=' + esc(w.type || '?') + '</code>'
                        + ' <small>reg=<code>' + esc(String(w.regular_price || '?')) + '</code>'
                        + ' qty=<code>' + esc(String(w.stock_quantity ?? '?')) + '</code></small>';
                }
            }
            return '<tr class="' + klass + '"><td>' + (i + 1) + '</td>'
                + '<td>' + (r.pid || '—') + '</td>'
                + '<td><code>' + esc(r.sku) + '</code></td>'
                + '<td><span class="hsync-action-pill ' + pillKl + '">' + esc(r.action) + '</span></td>'
                + '<td>' + shapeCell + '</td>'
                + '<td>' + writtenCell + '</td>'
                + '<td>' + detail + '</td></tr>';
        }).join('');

        out.innerHTML = ''
            + '<h3>Run #' + (data.run_id || '?') + ' — ' + statusBadge + '</h3>'
            + summary
            + (warns ? '<div class="hsync-warnings">' + warns + '</div>' : '')
            + (rows
                ? '<table class="hsync-table"><thead><tr><th>#</th><th>PID</th><th>SKU</th><th>Action</th><th>Pre-materialize</th><th>Post-materialize (Woo)</th><th>Error / Reason</th></tr></thead><tbody>' + rows + '</tbody></table>'
                : '<div class="hsync-empty">Nessuna riga processata.</div>');
    };

    /**
     * Operator-friendly per-item summary for test-fetch previews. The
     * raw FeedItem.data is full of nested arrays (variations, attributes,
     * _sf_* meta) that are unreadable when JSON.stringify-truncated.
     * This pulls out the four signals that matter when debugging
     * "products imported with no prices/stocks/variants":
     *   - type (simple vs variable)
     *   - variations count + first variant's reg/sale/qty
     *   - attribute keys
     *   - flavor marker
     */
    HSync.summarizePreviewData = function (d) {
        if (!d || typeof d !== 'object') return '<em class="hsync-muted">(no data)</em>';
        const type  = d.type || '?';
        const vars  = Array.isArray(d.variations) ? d.variations : [];
        const v0    = vars[0] || {};
        const attrs = d.attributes && typeof d.attributes === 'object' ? Object.keys(d.attributes).join(',') : '';
        const parts = [
            '<code>type=' + esc(type) + '</code>',
            'var:<strong>' + vars.length + '</strong>',
        ];
        if (vars.length > 0) {
            parts.push('1ª var: reg=<code>' + esc(String(v0.regular_price ?? '?')) + '</code>'
                + ' sale=<code>' + esc(String(v0.sale_price ?? '?')) + '</code>'
                + ' qty=<code>' + esc(String(v0.stock_quantity ?? '?')) + '</code>');
        } else {
            parts.push('reg=<code>' + esc(String(d.regular_price ?? '?')) + '</code>'
                + ' qty=<code>' + esc(String(d.stock_quantity ?? '?')) + '</code>');
        }
        if (attrs) parts.push('<small class="hsync-muted">attrs: ' + esc(attrs) + '</small>');
        if (d._hsync_flavor) parts.push('<small class="hsync-muted">flavor: ' + esc(d._hsync_flavor) + '</small>');
        // SF-specific markup diagnostic: which multiplier was actually
        // resolved for THIS product (rule match → rule's multiplier;
        // no match → flat sf_markup_value). Lets the operator verify
        // markup_rules are firing without combing through prices.
        if (d._sf_applied_multiplier !== undefined) {
            const mult = Number(d._sf_applied_multiplier);
            const tgt  = d._sf_markup_target ? esc(String(d._sf_markup_target)) : 'sale';
            const cat  = d._sf_category    ? esc(String(d._sf_category))    : '';
            const sub  = d._sf_subcategory ? esc(String(d._sf_subcategory)) : '';
            const taxo = (cat || sub) ? ' [' + cat + (sub ? ' › ' + sub : '') + ']' : '';
            parts.push('<small class="hsync-muted">markup: <code>×' + (Number.isFinite(mult) ? mult.toFixed(2) : '?') + '</code> target=<code>' + tgt + '</code>' + taxo + '</small>');
        }
        return parts.join(' · ');
    };

    HSync.testFetchFromRun = async function () {
        const sourceId = $('[data-field="run-source"]').value;
        if (!sourceId) { alert('Scegli una sorgente.'); return; }
        const formEl = $('[data-context="run"]');
        const config = formEl ? HSync.collectConfig(formEl) : {};
        const out = $('[data-region="run-output"]');
        out.innerHTML = '<p class="hsync-loading">Fetching…</p>';
        try {
            const data = await HSync.ajax('source_test_fetch', {
                source_id: sourceId,
                config:    config,
                options:   {},
            });
            const warns = (data.warnings || []).map(w => '<div class="hsync-warning">' + esc(w) + '</div>').join('');
            const rows  = (data.preview || []).map((p, i) =>
                '<tr><td>' + (i + 1) + '</td><td><code>' + esc(p.sku) + '</code></td><td>' + HSync.summarizePreviewData(p.data) + '</td></tr>'
            ).join('');
            out.innerHTML = ''
                + '<p><strong>' + data.count + '</strong> items in fetch (preview limit 10).</p>'
                + (warns ? '<div class="hsync-warnings">' + warns + '</div>' : '')
                + (rows  ? '<table class="hsync-table"><thead><tr><th>#</th><th>SKU</th><th>Shape preview</th></tr></thead><tbody>' + rows + '</tbody></table>' : '');
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    // ─── Runs history ─────────────────────────────────────────────

    HSync.loadRuns = async function () {
        const region = $('[data-region="runs-list"]');
        try {
            const data = await HSync.ajax('runs_recent', { limit: '50' });
            const runs = data.runs || [];
            const labels = data.job_labels || {};
            if (!runs.length) {
                region.innerHTML = '<div class="hsync-empty">'
                    + (HSync.isAdvanced() ? 'Nessun run registrato.' : 'Ancora nessuna sincronizzazione o importazione.')
                    + '</div>';
                return;
            }
            if (!HSync.isAdvanced()) {
                region.innerHTML = HSync.renderRunsSimple(runs, labels);
                return;
            }
            const rows = runs.map(r => {
                const st       = HSync.runStatus(r.status);
                const label    = r.job_id && labels[r.job_id] ? labels[r.job_id] : '';
                const inFlight = r.status === 'continue' || r.status === 'running';
                const sched    = r.report && r.report.schedule ? r.report.schedule : null;
                const skipped  = sched ? (sched.skipped_slots || 0) : 0;

                const who = label
                    ? '<strong>' + esc(label) + '</strong><div class="hsync-run-ref"><code>' + esc(r.runnable_ref) + '</code></div>'
                    : '<code>' + esc(r.runnable_ref) + '</code><div class="hsync-muted-inline">'
                        + (r.job_id ? 'job #' + r.job_id + ' (eliminato)' : 'manuale (Importa)') + '</div>';
                const trigger = sched ? (sched.trigger === 'manual' ? 'avviato a mano' : 'da cron') : '';

                let dur = inFlight ? (Date.now() - HSync.parseUtc(r.started_at)) / 1000 : HSync.runDuration(r);
                if (dur !== null && isNaN(dur)) dur = null;
                const durHtml = dur === null ? '—'
                    : esc(HSync.fmtDuration(dur)) + (inFlight ? ' <span class="hsync-muted-inline">finora</span>' : '');

                const doneHtml = (r.items_done || 0)
                    + (inFlight && r.items_total ? ' <span class="hsync-muted-inline">su ' + r.items_total + ' in coda</span>' : '');

                return '<tr>'
                    + '<td>' + r.id + '</td>'
                    + '<td>' + who + '</td>'
                    + '<td><code>' + esc(r.runnable_type) + '</code>' + (trigger ? '<div class="hsync-muted-inline">' + trigger + '</div>' : '') + '</td>'
                    + '<td><span class="hsync-action-pill ' + st.cls + '" title="' + esc(r.status) + '">' + esc(st.label) + '</span>'
                    +   (skipped > 0
                            ? '<div class="hsync-skip-note" title="Mentre questo run lavorava sono passati ' + skipped + ' orari del cron: non vengono recuperati, il job riparte al primo orario libero.">⚠ '
                              + skipped + (skipped === 1 ? ' esecuzione saltata' : ' esecuzioni saltate') + '</div>'
                            : '')
                    + '</td>'
                    + '<td title="' + esc(r.started_at) + ' UTC">' + esc(HSync.fmtWhen(r.started_at, { date: true })) + '</td>'
                    + '<td>' + durHtml + '</td>'
                    + '<td>' + doneHtml + '</td>'
                    + '<td>' + (r.items_failed || 0) + '</td>'
                    + '</tr>';
            }).join('');
            region.innerHTML = ''
                + '<p class="hsync-muted">Orari nel fuso del sito: <strong>' + esc(HSync.tzLabel()) + '</strong>. '
                + '<em>Scritti</em> = prodotti creati, aggiornati, ritoccati (prezzo/stock), oscurati o ripristinati in tutto il run — non solo nell\'ultimo blocco. '
                + 'Un run lungo è <strong>una</strong> riga, anche se lavora in più blocchi.</p>'
                + '<table class="hsync-table">'
                + '<thead><tr><th>ID</th><th>Job / feed</th><th>Tipo</th><th>Stato</th><th>Avviato</th><th>Durata</th><th>Scritti</th><th>Errori</th></tr></thead>'
                + '<tbody>' + rows + '</tbody></table>';
        } catch (e) {
            region.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    // ─── Simple view (default) ────────────────────────────────────
    //
    // What the shop owner sees: Panoramica (one card per automation),
    // Importa prodotti (a supplier, optionally some of its categories,
    // one button) and the Storico in plain words. It never asks for a
    // source, a mapping or a pipeline: it works in AUTOMATIONS, whose job
    // row already carries them, and the server resolves the rest (see
    // includes/ajax-simple.php). The technical tabs are untouched and sit
    // behind "Modalità avanzata".

    HSync.SIMPLE_TABS  = ['home', 'catalog', 'import', 'runs'];
    HSync.ADVANCED_KEY = 'hsync.advanced';

    HSync.isAdvanced = function () {
        const app = document.getElementById('hsync-app');
        return !!(app && app.classList.contains('is-advanced'));
    };

    /** Per-browser preference: storage can be blocked, and then simple wins. */
    HSync.readAdvancedPref = function () {
        try { return window.localStorage.getItem(HSync.ADVANCED_KEY) === '1'; } catch (e) { return false; }
    };

    HSync.setAdvanced = function (on, byUser) {
        const app = document.getElementById('hsync-app');
        if (!app) return;
        app.classList.toggle('is-advanced', !!on);
        const sw = $('[data-action="toggle-advanced"]');
        if (sw) sw.checked = !!on;
        if (!byUser) return;
        try { window.localStorage.setItem(HSync.ADVANCED_KEY, on ? '1' : '0'); } catch (e) { /* per-tab only */ }
        if (HSync.SIMPLE_TABS.indexOf(HSync.state.currentTab) < 0) {
            if (!on) HSync.switchTab('home');
        } else if (HSync.state.currentTab === 'runs') {
            HSync.loadRuns();   // the columns differ between the two views
        } else if (HSync.state.currentTab === 'home') {
            HSync.renderHome();
        }
        HSync.refreshSystemStatus();
    };

    /** 1240 → "1.240". */
    HSync.num = function (n) {
        return Number(n || 0).toLocaleString('it-IT');
    };

    /** A heartbeat is scheduled and not over 10 minutes late. */
    HSync.cronHealthy = function (s) {
        return !!s && s.next_tick_in_sec !== null && s.next_tick_in_sec !== undefined && !s.overdue;
    };

    /** Raw run errors → words a shop owner can act on. */
    HSync.friendlyError = function (msg) {
        const m = String(msg || '').trim();
        const http = m.match(/^HTTP (\d{3}) risposta non-JSON/);
        if (http) return 'il server ha risposto con un errore (' + http[1] + '): di solito è momentaneo';
        if (/^Rete:/.test(m))      return 'la connessione si è interrotta';
        if (/^PHP fatal:/.test(m)) return 'errore del server — i dettagli sono in «Dettagli tecnici»';
        if (/^Tick fallito:/.test(m)) return 'errore durante l\'importazione: ' + HSync.friendlyError(m.replace(/^Tick fallito:\s*/, ''));
        if (/^source_config_not_found:/.test(m)) return 'manca il collegamento al fornitore';
        if (/^source_not_registered:/.test(m))   return 'tipo di fornitore non disponibile';
        if (/^rule_not_found:/.test(m))          return 'la regola non esiste più';
        if (m === 'bootstrap_not_initialized')    return 'il plugin non si è avviato correttamente';
        if (/timed? ?out|cURL error 28/i.test(m)) return 'il fornitore non ha risposto in tempo';
        if (/\b40[13]\b|unauthori[sz]ed|forbidden/i.test(m)) return 'il fornitore ha rifiutato le credenziali';
        return m.length > 180 ? m.slice(0, 177) + '…' : m;
    };

    /** A run summary in words: "12 nuovi · 340 aggiornati · 2 errori". */
    HSync.countsPhrase = function (s, fallbackDone) {
        s = s || {};
        const n = HSync.num;
        const parts = [];
        const created = s.created || 0;
        const updated = (s.updated || 0) + (s.recreated || 0) + (s.stock_patched || 0);
        const blocked = (s.pre_blocked || 0) + (s.post_blocked || 0);
        if (created)     parts.push(n(created) + (created === 1 ? ' nuovo' : ' nuovi'));
        if (updated)     parts.push(n(updated) + (updated === 1 ? ' aggiornato' : ' aggiornati'));
        if (s.retired)   parts.push(n(s.retired) + (s.retired === 1 ? ' nascosto' : ' nascosti') + ' (non più in vendita dal fornitore)');
        if (s.restored)  parts.push(n(s.restored) + (s.restored === 1 ? ' tornato disponibile' : ' tornati disponibili'));
        if (blocked)     parts.push(n(blocked) + ' non importabili (dati incompleti)');
        if (s.failed)    parts.push(n(s.failed) + (s.failed === 1 ? ' errore' : ' errori'));
        if (parts.length) return parts.join(' · ');
        if (fallbackDone) return n(fallbackDone) + ' prodotti aggiornati';
        return 'nessuna modifica necessaria';
    };

    const simpleLine = (cls, icon, html) =>
        '<div class="hsync-feed-line ' + (cls || '') + '"><span class="dashicons dashicons-' + icon + '" aria-hidden="true"></span><span>' + html + '</span></div>';

    // ── Panoramica ────────────────────────────────────────────────

    HSync.loadOverview = async function () {
        try {
            HSync.state.overview = await HSync.ajax('overview', {});
            HSync.state.overviewError = '';
        } catch (e) {
            HSync.state.overviewError = e.message;
        }
        if (HSync.state.currentTab === 'home') HSync.renderHome();
        HSync.scheduleHomePoll();
        return HSync.state.overview;
    };

    /**
     * Keep the cards live while the Panoramica is open: every 8s while
     * something runs, every 30s otherwise (the "tra N min" countdowns).
     */
    HSync.scheduleHomePoll = function () {
        clearTimeout(HSync.state.homePollTimer);
        if (HSync.state.currentTab !== 'home') return;
        const o = HSync.state.overview || {};
        const busy = (o.cards || []).some(c => c.run || c.run_control) || !!(o.runner && o.runner.busy);
        HSync.state.homePollTimer = setTimeout(function () {
            if (HSync.state.currentTab !== 'home') return;
            // Never redraw under the owner's hands: an open select would
            // close mid-choice.
            const a = document.activeElement;
            if (a && a.tagName === 'SELECT' && a.closest('[data-region="home-cards"]')) return HSync.scheduleHomePoll();
            HSync.loadOverview();
        }, busy ? 8000 : 30000);
    };

    HSync.renderHome = function () {
        HSync.renderHomeStatus();
        const region = $('[data-region="home-cards"]');
        if (!region) return;
        const o = HSync.state.overview;
        if (!o) {
            region.innerHTML = HSync.state.overviewError
                ? '<div class="hsync-error">' + esc(HSync.state.overviewError) + '</div>'
                : '<p class="hsync-loading">Caricamento…</p>';
            return;
        }
        const cards = o.cards || [];
        if (!cards.length) {
            region.innerHTML = ''
                + '<div class="hsync-empty-state">'
                +   '<span class="dashicons dashicons-admin-plugins" aria-hidden="true"></span>'
                +   '<h3>Nessun fornitore collegato</h3>'
                +   '<p>Per iniziare va collegato il feed di un fornitore (indirizzo e credenziali). Si fa una volta sola: se non l\'hai fatto tu, chiedilo a chi ha configurato il sito.</p>'
                +   '<p class="hsync-muted">Per chi lo configura: <strong>Modalità avanzata</strong> → <strong>Connetti</strong>, poi la sincronizzazione si accende da qui.</p>'
                + '</div>';
            return;
        }
        region.innerHTML = cards.map(HSync.renderFeedCard).join('');
    };

    /** The line on top of the Panoramica: is everything fine, and if not, what. */
    HSync.renderHomeStatus = function () {
        const region = $('[data-region="home-status"]');
        if (!region) return;
        const o = HSync.state.overview;
        if (!o) { region.innerHTML = ''; return; }
        const cards    = o.cards || [];
        const enabled  = cards.filter(c => c.enabled);
        const problems = [];
        const sys      = HSync.state.systemStatus;
        if (enabled.length && sys && !HSync.cronHealthy(sys)) {
            problems.push('Le sincronizzazioni automatiche non stanno partendo: il sito non esegue le attività programmate. Avvisa chi gestisce il sito o l\'hosting.'
                + '<details class="hsync-tech"><summary>Dettagli per il tecnico</summary>'
                +   (sys.next_tick_at ? 'Il heartbeat <code>hive_sync_jobs_tick</code> è in ritardo di oltre 10 minuti.' : 'Nessun heartbeat <code>hive_sync_jobs_tick</code> pianificato.')
                +   (sys.disable_wp_cron ? ' <code>DISABLE_WP_CRON</code> è attivo: serve' : ' Consigliato:')
                +   ' un cron di sistema che chiami ogni minuto<br><code>' + esc(sys.recommended_crontab || '') + '</code>'
                + '</details>');
        }
        cards.forEach(c => {
            if (c.problem) {
                problems.push('«' + esc(c.label) + '» non è più collegata al fornitore e non può partire: spegnila, o fai ricollegare il feed (Modalità avanzata → Connetti).');
            } else if (!c.run && c.last && c.last.status === 'failed') {
                problems.push('L\'ultima esecuzione di «' + esc(c.label) + '» non è riuscita'
                    + (c.last.error ? ': ' + esc(HSync.friendlyError(c.last.error)) + '.' : '.'));
            }
        });

        const facts = [];
        const ck = HSync.state.cockpit;
        if (ck && typeof ck.product_count === 'number') facts.push(HSync.num(ck.product_count) + ' prodotti nel negozio');
        facts.push(enabled.length
            ? (enabled.length === 1 ? '1 sincronizzazione automatica attiva' : enabled.length + ' sincronizzazioni automatiche attive')
            : 'nessuna sincronizzazione automatica attiva');
        const running = cards.filter(c => c.run).length;
        if (running) facts.push(running === 1 ? '1 in corso adesso' : running + ' in corso adesso');

        const ok = !problems.length;
        region.innerHTML = ''
            + '<div class="hsync-health ' + (ok ? 'is-ok' : 'is-warn') + '" role="status">'
            +   '<span class="hsync-health-icon dashicons dashicons-' + (ok ? 'yes-alt' : 'warning') + '" aria-hidden="true"></span>'
            +   '<div class="hsync-health-body">'
            +     '<strong>' + (ok ? 'Tutto in ordine' : (problems.length === 1 ? 'C\'è una cosa da controllare' : 'Ci sono ' + problems.length + ' cose da controllare')) + '</strong>'
            +     (ok ? '' : '<ul>' + problems.map(p => '<li>' + p + '</li>').join('') + '</ul>')
            +     '<div class="hsync-health-facts">' + esc(facts.join(' · ')) + '</div>'
            +   '</div>'
            + '</div>';
    };

    HSync.renderFeedCard = function (c) {
        const o       = HSync.state.overview || {};
        const run     = c.run || null;
        const control = c.run_control || '';
        const paused  = !!run && !c.enabled && run.trigger !== 'manual';

        let pill;
        if (c.problem)               pill = ['is-bad',  'Da sistemare'];
        else if (control === 'stop') pill = ['is-busy', 'Si sta fermando'];
        else if (paused)             pill = ['is-warn', 'Ferma a metà'];
        else if (run)                pill = ['is-busy', 'In corso'];
        else if (control === 'run')  pill = ['is-busy', 'In partenza'];
        else if (c.enabled)          pill = ['is-good', 'Attiva'];
        else                         pill = ['is-dim',  'Spenta'];

        const sub = c.kind === 'import'
            ? (c.config_name && c.config_name !== c.label ? 'Fornitore: ' + c.config_name : 'Catalogo, prezzi e disponibilità dal fornitore')
            : (c.kind === 'prices' ? 'Prezzi aggiornati da KicksDB' : (c.kind === 'rule' ? 'Regola automatica sui prodotti del negozio' : ''));

        // ── State lines ───────────────────────────────────────────
        const lines = [];
        if (c.problem) {
            lines.push(simpleLine('is-bad', 'warning', c.problem === 'rule_missing'
                ? 'La regola che questa automazione esegue non esiste più.'
                : 'Il collegamento al fornitore non esiste più: questa automazione non può partire.'));
        }
        if (control === 'stop') {
            lines.push(simpleLine('is-busy', 'controls-pause', 'Si ferma alla fine del blocco in corso (al massimo mezzo minuto).'));
        } else if (run) {
            const p   = run.progress || null;
            const pct = p && p.total > 0 ? Math.min(100, Math.round(p.done * 100 / p.total)) : null;
            const what = pct !== null
                ? HSync.num(p.done) + ' di ' + HSync.num(p.total) + ' prodotti (' + pct + '%)'
                : 'sto leggendo il catalogo del fornitore…';
            lines.push(simpleLine(paused ? 'is-warn' : 'is-busy', paused ? 'controls-pause' : 'update',
                (paused ? 'Ferma a metà — riparte da qui quando la riaccendi o premi Riprendi: ' : 'In corso: ')
                + esc(what) + ' · avviata ' + esc(HSync.fmtWhen(run.started_at)))
                + (pct !== null ? '<div class="hsync-progress"><span style="width:' + pct + '%"></span></div>' : ''));
        } else if (control === 'run') {
            lines.push(simpleLine('is-busy', 'clock', 'In partenza: inizia entro un minuto.'));
        }
        if (!c.problem) {
            if (c.enabled && c.cron_expr && c.next_run_at) {
                lines.push(simpleLine('', 'calendar-alt', 'Prossima: <strong>' + esc(HSync.fmtWhen(c.next_run_at)) + '</strong>'
                    + ' <span class="hsync-muted-inline">(' + esc(HSync.fmtRelative(c.next_run_at)) + ')</span>'));
            } else if (!c.enabled && !run) {
                lines.push(simpleLine('is-dim', 'controls-pause', c.kind === 'import'
                    ? 'Spenta: prezzi e disponibilità non si aggiornano da soli.'
                    : 'Spenta: non parte da sola.'));
            }
        }
        if (c.last && !run) lines.push(HSync.lastRunLine(c));
        else if (!c.last && !run && !c.problem) lines.push(simpleLine('is-dim', 'minus', 'Non è ancora mai partita.'));

        // ── Settings ──────────────────────────────────────────────
        const scheduleOpts = (o.schedules || []).map(s =>
            '<option value="' + esc(s.key) + '"' + (s.key === c.schedule ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('');
        // A hand-written cron is shown as it is and left alone until the
        // owner picks one of the presets.
        const custom = c.schedule === 'custom'
            ? '<option value="custom" selected disabled>' + esc(HSync.describeCron(c.cron_expr) || c.cron_expr) + ' (personalizzata)</option>'
            : '';
        const unset = c.schedule === '' ? '<option value="" selected disabled>— scegli —</option>' : '';
        let settings = '<label class="hsync-feed-field">Ogni quanto'
            + '<select data-action="feed-schedule" data-id="' + c.id + '"' + (c.problem ? ' disabled' : '') + '>' + unset + custom + scheduleOpts + '</select>'
            + '</label>';
        if (c.kind === 'import') {
            if (c.add_new === null) {
                settings += '<div class="hsync-feed-note">Cosa viene sincronizzato è stato personalizzato: si cambia in modalità avanzata.</div>';
            } else {
                settings += '<label class="hsync-feed-check">'
                    + '<input type="checkbox" data-action="feed-addnew" data-id="' + c.id + '"' + (c.add_new ? ' checked' : '') + (c.problem ? ' disabled' : '') + '>'
                    + ' Aggiungi da sola i nuovi prodotti del fornitore</label>'
                    + '<div class="hsync-feed-note">' + (c.add_new
                        ? 'Aggiunge al negozio i prodotti nuovi del fornitore e aggiorna prezzi e disponibilità degli altri.'
                        : 'Aggiorna solo prezzi e disponibilità dei prodotti già nel negozio: i nuovi li aggiungi tu da «Importa prodotti», anche per categoria.')
                    + (c.hides_missing ? ' I prodotti che il fornitore non vende più vengono nascosti dal negozio (e tornano se riappaiono).' : '')
                    + '</div>';
            }
            if (c.importable) {
                settings += '<div class="hsync-feed-facts">'
                    + '<div><span class="hsync-feed-k">Vende</span> ' + (c.categories_label ? 'solo <strong>' + esc(c.categories_label) + '</strong>' : 'tutto il catalogo del fornitore') + '</div>'
                    + (c.margins_label ? '<div><span class="hsync-feed-k">Prezzi</span> costo <strong>' + esc(c.margins_label) + '</strong></div>' : '')
                    + '</div>';
            } else if (c.categories_label) {
                settings += '<div class="hsync-feed-note">Solo le categorie: <strong>' + esc(c.categories_label) + '</strong></div>';
            }
        }

        // ── Actions ───────────────────────────────────────────────
        const actions = [];
        if (!c.problem) {
            if (paused) {
                actions.push('<button type="button" class="button button-primary" data-action="feed-run" data-id="' + c.id + '">Riprendi</button>');
            } else if (!run && control !== 'run') {
                actions.push('<button type="button" class="button button-primary" data-action="feed-run" data-id="' + c.id + '">'
                    + (c.kind === 'import' ? 'Sincronizza ora' : 'Esegui ora') + '</button>');
            }
            if (run || control === 'run') {
                actions.push('<button type="button" class="button" data-action="feed-stop" data-id="' + c.id + '"' + (control === 'stop' ? ' disabled' : '') + '>Interrompi</button>');
            }
            if (c.importable) {
                actions.push('<button type="button" class="button" data-action="feed-catalog" data-id="' + c.id + '">'
                    + '<span class="dashicons dashicons-tag" aria-hidden="true"></span> Catalogo e prezzi</button>');
                actions.push('<button type="button" class="button" data-action="feed-import" data-id="' + c.id + '">'
                    + '<span class="dashicons dashicons-download" aria-hidden="true"></span> '
                    + (c.has_categories ? 'Importa per categoria' : 'Importa prodotti') + '</button>');
            }
        }

        const flashes = HSync.state.jobFlash || {};
        const flash   = flashes[c.id] && flashes[c.id].until > Date.now() ? flashes[c.id] : null;

        return ''
            + '<article class="hsync-feed ' + pill[0] + '" data-job="' + c.id + '">'
            +   '<header class="hsync-feed-head">'
            +     '<div class="hsync-feed-title">'
            +       '<h3>' + esc(c.label) + ' <span class="hsync-pill ' + pill[0] + '">' + esc(pill[1]) + '</span></h3>'
            +       (sub ? '<div class="hsync-feed-sub">' + esc(sub) + '</div>' : '')
            +     '</div>'
            +     ((c.problem && !c.enabled) ? '' :
                    '<label class="hsync-switch" title="' + (c.enabled ? 'Spegni' : 'Accendi') + ' la sincronizzazione automatica">'
                  +   '<input type="checkbox" data-action="feed-toggle" data-id="' + c.id + '"' + (c.enabled ? ' checked' : '') + '>'
                  +   '<span class="hsync-switch-track" aria-hidden="true"></span>'
                  +   '<span class="hsync-switch-text">Automatica</span>'
                  + '</label>')
            +   '</header>'
            +   '<div class="hsync-feed-body">' + lines.join('') + '</div>'
            +   '<div class="hsync-feed-settings">' + settings + '</div>'
            +   (actions.length ? '<footer class="hsync-feed-actions">' + actions.join('') + '</footer>' : '')
            +   (flash ? '<div class="hsync-job-flash is-' + esc(flash.kind) + '">' + esc(flash.text) + '</div>' : '')
            + '</article>';
    };

    /** "Ultima: oggi 12:03 · 3m 10s — 12 nuovi · 340 aggiornati". */
    HSync.lastRunLine = function (c) {
        const l    = c.last;
        const when = HSync.fmtWhen(l.finished_at || l.started_at);
        const dur  = HSync.runDuration(l);
        const took = dur !== null ? ' · ' + HSync.fmtDuration(dur) : '';
        const scope = l.categories ? ' (solo ' + l.categories + ')' : '';
        const counts = HSync.countsPhrase(l.summary || {}, c.kind === 'import' ? 0 : l.items_done);
        let cls = '', icon = 'yes-alt', text;
        switch (l.status) {
            case 'done':      cls = 'is-good'; text = 'Ultima: ' + when + took + scope + ' — ' + counts; break;
            case 'partial':   cls = 'is-warn'; icon = 'marker'; text = 'Ultima: ' + when + scope + ' — fatta in parte: ' + counts; break;
            case 'failed':    cls = 'is-bad';  icon = 'dismiss'; text = 'Ultima: ' + when + ' — non riuscita' + (l.error ? ': ' + HSync.friendlyError(l.error) : ''); break;
            case 'cancelled': cls = 'is-dim';  icon = 'controls-pause'; text = 'Ultima: ' + when + scope + ' — interrotta' + (l.items_done ? ' dopo: ' + counts : ''); break;
            case 'abandoned': cls = 'is-dim';  icon = 'minus'; text = 'Ultima: ' + when + ' — lasciata a metà'; break;
            case 'skipped':   cls = 'is-dim';  icon = 'minus'; text = 'Ultima: ' + when + ' — saltata'; break;
            default:          cls = 'is-dim';  icon = 'minus'; text = 'Ultima: ' + when + ' — ' + HSync.runStatus(l.status).label.toLowerCase();
        }
        let html = esc(text);
        if (l.skipped_slots > 0) {
            html += ' <span class="hsync-muted-inline">· ' + l.skipped_slots
                + (l.skipped_slots === 1 ? ' orario saltato' : ' orari saltati') + ' perché è durata più dell\'intervallo</span>';
        }
        return simpleLine(cls, icon, html);
    };

    HSync.feedRunNow = async function (id) {
        const btn = $('[data-action="feed-run"][data-id="' + id + '"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Avvio…'; }
        try {
            const data = await HSync.ajax('job_run_now', { id: String(id) });
            HSync.setJobFlash(id, data.status === 'failed' ? 'err' : 'ok', HSync.describeRunNowSimple(data));
        } catch (e) {
            HSync.setJobFlash(id, 'err', e.message);
        }
        HSync.loadOverview();
        HSync.refreshCockpit();
    };

    HSync.describeRunNowSimple = function (data) {
        switch (data.status) {
            case 'queued':   return 'In coda: parte entro un minuto.';
            case 'continue': return 'Avviata: prosegue da sola, puoi anche chiudere la pagina.';
            case 'done':     return 'Fatto.';
            case 'partial':  return 'Fatta in parte: il resto alla prossima esecuzione.';
            case 'skipped':  return 'Non è partita: ' + (data.reason || 'niente da fare') + '.';
            case 'failed':   return 'Non riuscita: ' + HSync.friendlyError(data.error || '') + '.';
            default:         return HSync.describeRunNow(data);
        }
    };

    HSync.feedStop = async function (id) {
        if (!confirm('Interrompere adesso?\n\nI prodotti già aggiornati restano come sono: la prossima esecuzione riparte dal catalogo aggiornato del fornitore.')) return;
        try {
            const data = await HSync.ajax('job_stop', { id: String(id) });
            HSync.setJobFlash(id, 'ok', data.idle ? 'Partenza annullata.' : (data.stopped ? 'Interrotta.' : 'Si ferma alla fine del blocco in corso.'));
        } catch (e) {
            HSync.setJobFlash(id, 'err', e.message);
        }
        HSync.loadOverview();
    };

    /** One knob of an automation card: enabled / schedule / add_new. */
    HSync.feedSetting = async function (id, field, value) {
        const cards = (HSync.state.overview && HSync.state.overview.cards) || [];
        const card  = cards.find(c => c.id === id);
        const payload = { job_id: String(id) };
        if (field === 'enabled') {
            if (!value && card && card.kind === 'import' && !confirm(
                'Spegnere la sincronizzazione automatica di «' + card.label + '»?\n\n'
                + 'Prezzi e disponibilità smetteranno di aggiornarsi da soli finché non la riaccendi.')) {
                return HSync.renderHome();   // puts the switch back
            }
            payload.enabled = value ? '1' : '0';
            // Never scheduled: switching it on needs a cadence — the seeded one.
            if (value && card && !card.cron_expr) payload.schedule = '2h';
        } else if (field === 'schedule') {
            payload.schedule = value;
        } else if (field === 'add_new') {
            payload.add_new = value ? '1' : '0';
        }
        try {
            const res  = await HSync.ajax('feed_settings_save', payload);
            const next = res.next_run_at && res.enabled ? ': prossima ' + HSync.fmtWhen(res.next_run_at) + '.' : '.';
            let msg = 'Salvato.';
            if (field === 'enabled')  msg = value ? 'Sincronizzazione automatica accesa' + next : 'Sincronizzazione automatica spenta.';
            if (field === 'schedule') msg = 'Frequenza aggiornata' + next;
            if (field === 'add_new')  msg = value ? 'Da ora i nuovi prodotti del fornitore vengono aggiunti da soli.' : 'Da ora si aggiornano solo i prodotti già nel negozio.';
            if (res.running) msg += ' L\'esecuzione in corso finisce con le impostazioni di prima.';
            HSync.setJobFlash(id, 'ok', msg);
        } catch (e) {
            HSync.setJobFlash(id, 'err', e.message);
        }
        await HSync.loadOverview();
        HSync.refreshCockpit();
    };

    // ── Importa prodotti ──────────────────────────────────────────

    HSync.state.qi = {
        jobId: 0, pendingJob: 0, scope: 'cats',
        tree: null, treeJob: 0, treeLoading: false, treeError: '',
        selected: new Set(), expanded: new Set(), search: '',
        // idle | running | done | error | cancelled | paused
        phase: 'idle', stopping: false,
        runId: 0, startedAt: 0, endedAt: 0,
        progress: null, summary: null, base: null, warnings: [],
        error: '', resumable: false, label: '', scopeLabel: '',
    };

    const QI_RESULT_KEYS = ['created', 'updated', 'recreated', 'stock_patched', 'skipped', 'failed', 'pre_blocked', 'post_blocked', 'retired', 'restored'];

    HSync.importableFeeds = function () {
        const o = HSync.state.overview;
        return o ? (o.cards || []).filter(c => c.kind === 'import' && c.importable) : [];
    };

    HSync.qiFeed = function () {
        const id = HSync.state.qi.jobId;
        return HSync.importableFeeds().find(f => f.id === id) || null;
    };

    /** Case-, accent- and whitespace-insensitive key for the search box. */
    HSync.qiNorm = function (s) {
        return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    };

    /** Whole-run counters: a resumed segment restarts the loop's own. */
    HSync.qiSum = function (a, b) {
        const out = Object.assign({}, b || a || {});
        QI_RESULT_KEYS.forEach(k => { out[k] = ((a && a[k]) || 0) + ((b && b[k]) || 0); });
        return out;
    };

    /** Entry point of the tab — also from a card's "Importa" button. */
    HSync.openImport = async function (jobId) {
        const qi = HSync.state.qi;
        if (jobId && qi.phase !== 'running') {
            qi.pendingJob = jobId;
            if (HSync.state.currentTab !== 'import') return HSync.switchTab('import');
        } else if (jobId && HSync.state.currentTab !== 'import') {
            return HSync.switchTab('import');
        }
        if (!HSync.state.overview) {
            HSync.renderImport();
            await HSync.loadOverview();
        }
        if (qi.phase === 'running') return HSync.renderImport();
        const feeds = HSync.importableFeeds();
        let want = qi.pendingJob || qi.jobId;
        qi.pendingJob = 0;
        if (!feeds.some(f => f.id === want)) {
            // Prefer a supplier with categories: that is what this tab is for.
            const pick = feeds.find(f => f.has_categories) || feeds[0];
            want = pick ? pick.id : 0;
        }
        if (want !== qi.jobId || !qi.jobId) return HSync.qiSelectFeed(want);
        HSync.renderImport();
        // Back on the tab: "già nel negozio" may have moved since (a sync
        // ran meanwhile). Re-counting reuses the cached feed snapshot.
        const feed = HSync.qiFeed();
        if (feed && feed.has_categories && qi.tree && !qi.treeLoading) HSync.qiLoadCategories(false);
    };

    HSync.qiSelectFeed = function (jobId) {
        const qi = HSync.state.qi;
        if (qi.phase === 'running') return;
        qi.jobId = jobId || 0;
        qi.selected = new Set();
        qi.expanded = new Set();
        qi.search = '';
        if (qi.phase !== 'idle') HSync.qiResetState();
        const feed = HSync.qiFeed();
        qi.scope = feed && feed.has_categories ? 'cats' : 'all';
        if (qi.treeJob !== qi.jobId) { qi.tree = null; qi.treeError = ''; }
        HSync.renderImport();
        if (feed && feed.has_categories && !qi.tree) HSync.qiLoadCategories(false);
    };

    HSync.qiSetScope = function (scope) {
        const qi = HSync.state.qi;
        qi.scope = scope === 'all' ? 'all' : 'cats';
        const feed = HSync.qiFeed();
        if (qi.scope === 'cats' && feed && feed.has_categories && !qi.tree && !qi.treeLoading) HSync.qiLoadCategories(false);
        HSync.renderImportPicker();
        HSync.renderImportAction();
    };

    HSync.qiLoadCategories = async function (refresh) {
        const qi   = HSync.state.qi;
        const feed = HSync.qiFeed();
        if (!feed || !feed.has_categories) return;
        const jobId = feed.id;
        qi.treeLoading = true;
        qi.treeError = '';
        HSync.renderImportPicker();
        try {
            const tree = await HSync.ajax('feed_categories', { job_id: jobId, refresh: refresh ? '1' : '' });
            if (qi.jobId !== jobId) return;   // the owner switched supplier meanwhile
            if (!tree.supported) {
                qi.tree = null;
                qi.scope = 'all';
            } else {
                qi.tree = tree;
                qi.treeJob = jobId;
                // A refreshed listing may have lost a category the owner had
                // ticked: drop it rather than send a filter that matches nothing.
                const valid = new Set();
                (tree.categories || []).forEach(c => { valid.add(c.value); (c.subs || []).forEach(s => valid.add(s.value)); });
                qi.selected.forEach(v => { if (!valid.has(v)) qi.selected.delete(v); });
            }
        } catch (e) {
            if (qi.jobId !== jobId) return;
            qi.treeError = e.message;
        }
        qi.treeLoading = false;
        HSync.renderImportPicker();
        HSync.renderImportAction();
    };

    HSync.renderImport = function () {
        const root = $('[data-region="qi"]');
        if (!root) return;
        if (!root.querySelector('[data-region="qi-form"]')) {
            root.innerHTML = ''
                + '<p class="hsync-lead">Aggiungi al negozio i prodotti di un fornitore — tutto il catalogo, o solo le categorie che vuoi. '
                +   'I prodotti nuovi vengono aggiunti, quelli già nel negozio aggiornati.</p>'
                + '<div class="hsync-qi" data-region="qi-form"></div>'
                + '<div data-region="qi-progress"></div>'
                // Hidden until an import has actually produced something to show.
                + '<details class="hsync-tech hsync-qi-tech" data-region="qi-tech-box" hidden><summary>Dettagli tecnici dell\'ultima importazione</summary><div data-region="qi-tech"></div></details>';
        }
        HSync.renderImportForm();
        HSync.renderImportProgress();
    };

    HSync.renderImportForm = function () {
        const qi = HSync.state.qi;
        const el = $('[data-region="qi-form"]');
        if (!el) return;
        if (!HSync.state.overview) {
            el.innerHTML = HSync.state.overviewError
                ? '<div class="hsync-error">' + esc(HSync.state.overviewError) + '</div>'
                : '<p class="hsync-loading">Caricamento…</p>';
            return;
        }
        const feeds = HSync.importableFeeds();
        if (!feeds.length) {
            el.innerHTML = '<div class="hsync-empty-state">'
                + '<span class="dashicons dashicons-admin-plugins" aria-hidden="true"></span>'
                + '<h3>Nessun fornitore da cui importare</h3>'
                + '<p>Serve prima il collegamento al feed di un fornitore. Se non l\'hai fatto tu, chiedilo a chi ha configurato il sito.</p>'
                + '</div>';
            return;
        }
        const feed   = HSync.qiFeed();
        const locked = qi.phase === 'running';
        const feedPick = feeds.length === 1
            ? '<strong class="hsync-qi-feedname">' + esc(feeds[0].label) + '</strong>'
            : '<select data-action="qi-feed">' + feeds.map(f =>
                '<option value="' + f.id + '"' + (f.id === qi.jobId ? ' selected' : '') + '>' + esc(f.label) + '</option>').join('') + '</select>';
        const radio = (value, title, hint) =>
            '<label class="hsync-qi-scope' + (qi.scope === value ? ' is-on' : '') + '">'
            + '<input type="radio" name="hsync-qi-scope" value="' + value + '"' + (qi.scope === value ? ' checked' : '') + '>'
            + '<span><strong>' + esc(title) + '</strong><small>' + esc(hint) + '</small></span></label>';
        const scope = feed && feed.has_categories
            ? '<div class="hsync-qi-scopes" role="radiogroup" aria-label="Cosa importare">'
              + radio('cats', 'Solo alcune categorie', 'Scegli tu cosa portare nel negozio.')
              + radio('all',  'Tutto il catalogo',     'Tutti i prodotti che il fornitore ha in listino.')
              + '</div>'
            : '<p class="hsync-qi-hint">Questo fornitore non divide il catalogo in categorie: viene importato tutto il catalogo.</p>';

        el.innerHTML = ''
            + '<fieldset class="hsync-qi-step"' + (locked ? ' disabled' : '') + '>'
            +   '<legend><span class="hsync-qi-num">1</span> Fornitore</legend>'
            +   feedPick
            + '</fieldset>'
            + '<fieldset class="hsync-qi-step"' + (locked ? ' disabled' : '') + '>'
            +   '<legend><span class="hsync-qi-num">2</span> Cosa vuoi importare?</legend>'
            +   scope
            +   '<div data-region="qi-picker"></div>'
            + '</fieldset>'
            + '<div class="hsync-qi-step hsync-qi-go" data-region="qi-action"></div>';
        HSync.renderImportPicker();
        HSync.renderImportAction();
    };

    HSync.renderImportPicker = function () {
        const qi = HSync.state.qi;
        const el = $('[data-region="qi-picker"]');
        if (!el) return;
        const feed = HSync.qiFeed();
        if (!feed || !feed.has_categories || qi.scope !== 'cats') { el.innerHTML = ''; return; }
        if (!qi.tree) {
            el.innerHTML = qi.treeError
                ? '<div class="hsync-error">' + esc(qi.treeError) + ' <button type="button" class="button-link" data-action="qi-retry">Riprova</button></div>'
                : '<div class="hsync-qi-wait"><span class="spinner is-active" aria-hidden="true"></span> Leggo le categorie dal fornitore… La prima volta può volerci un minuto.</div>';
            return;
        }
        const t = qi.tree;
        el.innerHTML = ''
            + '<div class="hsync-cats">'
            +   '<div class="hsync-cats-bar">'
            +     '<input type="search" class="hsync-cats-search" data-action="qi-search" placeholder="Cerca una categoria…" aria-label="Cerca una categoria" value="' + esc(qi.search) + '">'
            +     '<span class="hsync-cats-meta">'
            +       HSync.num((t.categories || []).length) + ' categorie · ' + HSync.num(t.total) + ' prodotti in listino'
            +       (t.fetched_at ? ' · elenco del ' + esc(HSync.fmtWhen(t.fetched_at)) : '')
            +       ' · <button type="button" class="button-link" data-action="qi-refresh"' + (qi.treeLoading ? ' disabled' : '') + '>'
            +         (qi.treeLoading ? 'Aggiorno…' : 'Aggiorna elenco') + '</button>'
            +     '</span>'
            +   '</div>'
            +   (qi.treeError ? '<div class="hsync-error">' + esc(qi.treeError) + '</div>' : '')
            +   '<ul class="hsync-cats-list" data-region="qi-cats-list"></ul>'
            +   (t.uncategorized
                    ? '<div class="hsync-cats-foot">' + (t.uncategorized === 1
                        ? '1 prodotto del listino non ha una categoria: entra solo con «Tutto il catalogo».'
                        : HSync.num(t.uncategorized) + ' prodotti del listino non hanno una categoria: entrano solo con «Tutto il catalogo».')
                      + '</div>'
                    : '')
            + '</div>';
        HSync.renderImportList();
    };

    HSync.qiCount = function (node) {
        const all = node.in_shop >= node.count && node.count > 0;
        return '<span class="hsync-cat-count">' + HSync.num(node.count)
            + (node.in_shop ? ' <small>· ' + (all ? 'già tutti nel negozio' : HSync.num(node.in_shop) + ' già nel negozio') + '</small>' : '')
            + '</span>';
    };

    HSync.renderImportList = function () {
        const qi = HSync.state.qi;
        const el = $('[data-region="qi-cats-list"]');
        if (!el || !qi.tree) return;
        const q = HSync.qiNorm(qi.search);
        const rows = (qi.tree.categories || []).map(cat => {
            const subs     = cat.subs || [];
            const catHit   = !q || HSync.qiNorm(cat.name).indexOf(q) >= 0;
            const subHits  = q && !catHit ? subs.filter(s => HSync.qiNorm(s.name).indexOf(q) >= 0) : subs;
            if (q && !catHit && !subHits.length) return '';
            const whole    = qi.selected.has(cat.value);
            const picked   = subs.filter(s => qi.selected.has(s.value)).length;
            const open     = qi.expanded.has(cat.value) || (q && !catHit);
            const subRows  = open ? subHits.map(s =>
                '<li class="hsync-sub">'
                + '<label><input type="checkbox" data-action="qi-sub" data-cat="' + esc(cat.value) + '" data-value="' + esc(s.value) + '"'
                +   ((whole || qi.selected.has(s.value)) ? ' checked' : '') + '> ' + esc(s.name) + '</label>'
                + HSync.qiCount(s)
                + '</li>').join('') : '';
            return '<li class="hsync-cat' + (whole || picked ? ' is-picked' : '') + '">'
                + '<div class="hsync-cat-row">'
                +   (subs.length
                        ? '<button type="button" class="hsync-cat-caret" data-action="qi-expand" data-value="' + esc(cat.value) + '"'
                          + ' aria-expanded="' + (open ? 'true' : 'false') + '" title="' + (open ? 'Nascondi' : 'Mostra') + ' le sottocategorie">'
                          + '<span class="dashicons dashicons-arrow-' + (open ? 'down' : 'right') + '-alt2" aria-hidden="true"></span></button>'
                        : '<span class="hsync-cat-caret is-empty" aria-hidden="true"></span>')
                +   '<label class="hsync-cat-label"><input type="checkbox" data-action="qi-cat" data-value="' + esc(cat.value) + '"'
                +     (whole ? ' checked' : '') + (picked && !whole ? ' data-partial="1"' : '') + '> ' + esc(cat.name) + '</label>'
                +   (picked && !whole ? '<span class="hsync-cat-partial">' + picked + ' di ' + subs.length + ' sottocategorie</span>' : '')
                +   HSync.qiCount(cat)
                + '</div>'
                + (subRows ? '<ul class="hsync-subs">' + subRows + '</ul>' : '')
                + '</li>';
        }).join('');
        el.innerHTML = rows || '<li class="hsync-cats-empty">Nessuna categoria contiene «' + esc(qi.search) + '».</li>';
        // A checkbox can only be half-checked from script.
        $$('input[data-partial="1"]', el).forEach(cb => { cb.indeterminate = true; });
    };

    HSync.qiCatByValue = function (value) {
        const t = HSync.state.qi.tree;
        return t ? (t.categories || []).find(c => c.value === value) || null : null;
    };

    /**
     * Category selection over a picker state {tree, selected:Set}: the
     * Importa picker and the Catalogo e prezzi table share it.
     */
    HSync.pickCat = function (st, value, on) {
        const cat = st.tree ? (st.tree.categories || []).find(c => c.value === value) : null;
        if (!cat) return;
        // The whole category replaces any of its subcategories.
        (cat.subs || []).forEach(s => st.selected.delete(s.value));
        if (on) st.selected.add(cat.value); else st.selected.delete(cat.value);
    };

    HSync.pickSub = function (st, catValue, value, on) {
        const cat = st.tree ? (st.tree.categories || []).find(c => c.value === catValue) : null;
        if (!cat) return;
        const subs = cat.subs || [];
        if (st.selected.has(cat.value)) {
            // The whole category was ticked: unticking one subcategory
            // keeps all the others.
            st.selected.delete(cat.value);
            subs.forEach(s => { if (s.value !== value) st.selected.add(s.value); });
        } else if (on) {
            st.selected.add(value);
        } else {
            st.selected.delete(value);
        }
        // Every subcategory ticked and together they ARE the category
        // (no product without a subcategory left out): one entry.
        const covered = subs.reduce((n, s) => n + (s.count || 0), 0) === cat.count;
        if (subs.length && covered && subs.every(s => st.selected.has(s.value))) {
            subs.forEach(s => st.selected.delete(s.value));
            st.selected.add(cat.value);
        }
    };

    HSync.qiToggleCat = function (value, on) {
        HSync.pickCat(HSync.state.qi, value, on);
        HSync.renderImportList();
        HSync.renderImportAction();
    };

    HSync.qiToggleSub = function (catValue, value, on) {
        HSync.pickSub(HSync.state.qi, catValue, value, on);
        HSync.renderImportList();
        HSync.renderImportAction();
    };

    HSync.qiToggleExpand = function (value) {
        const qi = HSync.state.qi;
        if (qi.expanded.has(value)) qi.expanded.delete(value); else qi.expanded.add(value);
        HSync.renderImportList();
    };

    HSync.qiClearSelection = function () {
        HSync.state.qi.selected.clear();
        HSync.renderImportList();
        HSync.renderImportAction();
    };

    HSync.qiSearch = function (value) {
        HSync.state.qi.search = String(value || '');
        clearTimeout(HSync.state.qiSearchTimer);
        HSync.state.qiSearchTimer = setTimeout(HSync.renderImportList, 120);
    };

    /** Products in the ticked nodes, and how many of them the shop already has. */
    HSync.qiSelectionStats = function () {
        const qi = HSync.state.qi;
        const st = { count: 0, inShop: 0, nodes: 0 };
        if (!qi.tree) return st;
        (qi.tree.categories || []).forEach(cat => {
            if (qi.selected.has(cat.value)) {
                st.count += cat.count; st.inShop += cat.in_shop; st.nodes++;
                return;
            }
            (cat.subs || []).forEach(s => {
                if (qi.selected.has(s.value)) { st.count += s.count; st.inShop += s.in_shop; st.nodes++; }
            });
        });
        return st;
    };

    HSync.renderImportAction = function () {
        const qi = HSync.state.qi;
        const el = $('[data-region="qi-action"]');
        if (!el) return;
        const feed = HSync.qiFeed();
        if (!feed || qi.phase === 'running') { el.innerHTML = ''; return; }
        let label, disabled = false, note = '';
        if (qi.scope === 'cats' && feed.has_categories) {
            const st = HSync.qiSelectionStats();
            if (!qi.tree) {
                label = 'Importa'; disabled = true;
            } else if (!st.nodes) {
                label = 'Scegli almeno una categoria'; disabled = true;
            } else {
                const fresh = st.count - st.inShop;
                label = 'Importa ' + HSync.num(st.count) + (st.count === 1 ? ' prodotto' : ' prodotti');
                note = (fresh > 0 ? HSync.num(fresh) + (fresh === 1 ? ' nuovo da aggiungere' : ' nuovi da aggiungere') : 'nessun prodotto nuovo')
                    + (st.inShop ? ' · ' + HSync.num(st.inShop) + ' già nel negozio, da aggiornare' : '')
                    + ' · <button type="button" class="button-link" data-action="qi-clear">Togli la selezione</button>';
            }
        } else {
            label = 'Importa tutto il catalogo';
            if (qi.tree && qi.tree.total) note = HSync.num(qi.tree.total) + ' prodotti nel listino del fornitore';
        }
        // The price the products will get, BEFORE clicking: the margins
        // live on the supplier (Catalogo e prezzi), not on this import.
        const prices = feed.margins_label
            ? '<div class="hsync-qi-note"><span class="dashicons dashicons-tag" aria-hidden="true"></span> Prezzo di vendita: costo '
              + esc(feed.margins_label)
              + ' · <button type="button" class="button-link" data-action="feed-catalog" data-id="' + feed.id + '">Cambia i ricarichi</button></div>'
            : '';
        el.innerHTML = ''
            + '<span class="hsync-qi-num">3</span>'
            + '<div class="hsync-qi-go-body">'
            +   '<button type="button" class="button button-primary button-hero" data-action="qi-start"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>'
            +   (note ? '<div class="hsync-qi-note">' + note + '</div>' : '')
            +   prices
            + '</div>';
    };

    HSync.qiStart = async function () {
        const qi   = HSync.state.qi;
        const feed = HSync.qiFeed();
        if (!feed || qi.phase === 'running') return;
        const byCategory = qi.scope === 'cats' && feed.has_categories;
        const cats = byCategory ? Array.from(qi.selected) : [];
        if (byCategory && !cats.length) return;
        if (!byCategory && !confirm('Importare tutto il catalogo di «' + feed.label + '»?\n\n'
            + 'Su un listino grande può richiedere parecchio tempo. I prodotti già nel negozio vengono aggiornati, quelli nuovi aggiunti.')) return;

        let params;
        try {
            params = await HSync.ajax('import_params', { job_id: feed.id, categories: cats });
        } catch (e) {
            Object.assign(qi, { phase: 'error', error: e.message, resumable: false, label: feed.label, scopeLabel: '' });
            HSync.renderImportProgress();
            return;
        }
        Object.assign(qi, {
            phase: 'running', stopping: false, runId: 0,
            startedAt: Date.now(), endedAt: 0,
            progress: null, summary: null, base: null, warnings: [],
            error: '', resumable: false,
            label: feed.label, scopeLabel: params.categories_label || '',
        });
        const tech = $('[data-region="qi-tech"]');
        if (tech) tech.innerHTML = '';
        const techBox = $('[data-region="qi-tech-box"]');
        if (techBox) techBox.hidden = false;
        HSync.renderImportForm();
        HSync.renderImportProgress();
        HSync.runOutputSel = '[data-region="qi-tech"]';
        HSync.runListener  = HSync.qiListener;
        await HSync.qiDrive(() => HSync.runImportTicked(
            params.source_id, params.config_slug,
            {},              // the config comes from the saved slug, server-side
            params.options,
            false,           // a real import: the counts on screen were the preview
            null,
            0,               // uncapped: it runs until the selection is done
        ));
    };

    /** Warn before the tab closes while the browser is driving an import. */
    HSync.qiDrive = async function (fn) {
        window.addEventListener('beforeunload', HSync.qiBeforeUnload);
        clearInterval(HSync.state.qiClock);
        HSync.state.qiClock = setInterval(HSync.qiTickClock, 1000);
        try {
            await fn();
        } finally {
            window.removeEventListener('beforeunload', HSync.qiBeforeUnload);
            clearInterval(HSync.state.qiClock);
        }
    };

    HSync.qiBeforeUnload = function (e) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    };

    HSync.qiTickClock = function () {
        const qi = HSync.state.qi;
        const el = document.querySelector('[data-qi-elapsed]');
        if (el && qi.phase === 'running') el.textContent = HSync.fmtDuration((Date.now() - qi.startedAt) / 1000);
    };

    HSync.qiListener = function (phase, p) {
        const qi = HSync.state.qi;
        if (phase === 'start') {
            if (p.resumed && qi.summary) qi.base = HSync.qiSum(qi.base, qi.summary);
            qi.summary = null;
            HSync.renderImportProgress();
            return;
        }
        if (p.run_id)   qi.runId    = p.run_id;
        if (p.summary)  qi.summary  = p.summary;
        if (p.progress) qi.progress = p.progress;
        if (p.warnings) qi.warnings = p.warnings;
        if (phase === 'end') {
            qi.phase = ({ done: 'done', cancelled: 'cancelled', paused: 'paused' })[p.status] || 'error';
            if (qi.phase === 'error') {
                qi.error = p.error || 'l\'importazione non è riuscita';
                qi.resumable = !!p.resumable;
            }
            if (qi.phase === 'paused') qi.resumable = true;
            qi.endedAt  = Date.now();
            qi.stopping = false;
            HSync.renderImportForm();
            if (qi.phase === 'done' || qi.phase === 'cancelled') {
                // "Già nel negozio" changed: re-count it (the feed snapshot
                // is reused, only the shop side is re-read).
                HSync.qiLoadCategories(false);
                HSync.refreshCockpit();
                HSync.loadOverview();
            }
        }
        HSync.renderImportProgress();
    };

    HSync.qiStop = function () {
        const qi = HSync.state.qi;
        if (qi.phase !== 'running' || qi.stopping) return;
        if (!confirm('Interrompere l\'importazione?\n\nI prodotti già importati restano nel negozio.')) return;
        qi.stopping = true;
        HSync.state.runAbort = true;
        HSync.renderImportProgress();
    };

    HSync.qiResume = async function () {
        const qi = HSync.state.qi;
        if (!HSync.lastFailedRun || !HSync.lastFailedRun.cursor) {
            qi.resumable = false;
            HSync.renderImportProgress();
            return;
        }
        Object.assign(qi, { phase: 'running', error: '', endedAt: 0, stopping: false });
        HSync.renderImportForm();
        HSync.renderImportProgress();
        HSync.runOutputSel = '[data-region="qi-tech"]';
        HSync.runListener  = HSync.qiListener;
        await HSync.qiDrive(() => HSync.resumeFailedRun());
    };

    HSync.qiResetState = function () {
        Object.assign(HSync.state.qi, {
            phase: 'idle', stopping: false, error: '', resumable: false,
            progress: null, summary: null, base: null, warnings: [],
        });
    };

    HSync.qiReset = function () {
        if (HSync.state.qi.phase === 'running') return;
        HSync.qiResetState();
        HSync.renderImportForm();
        HSync.renderImportProgress();
    };

    HSync.qiNotes = function (warnings, open) {
        const list = (warnings || []).filter(Boolean);
        if (!list.length) return '';
        return '<details class="hsync-qi-notes"' + (open ? ' open' : '') + '><summary>'
            + list.length + (list.length === 1 ? ' nota' : ' note') + ' dal controllo del feed</summary>'
            + '<ul>' + list.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul></details>';
    };

    HSync.renderImportProgress = function () {
        const qi = HSync.state.qi;
        const el = $('[data-region="qi-progress"]');
        if (!el) return;
        if (qi.phase === 'idle') { el.innerHTML = ''; return; }
        const s       = HSync.qiSum(qi.base, qi.summary);
        const what    = esc(qi.label) + ' — ' + (qi.scopeLabel ? 'solo ' + esc(qi.scopeLabel) : 'tutto il catalogo');
        const elapsed = HSync.fmtDuration(((qi.endedAt || Date.now()) - qi.startedAt) / 1000);
        const box = (cls, icon, head, body, actions) =>
            '<div class="hsync-qi-run ' + cls + '" role="status">'
            + '<div class="hsync-qi-run-head">' + icon + '<strong>' + head + '</strong></div>'
            + body
            + (actions ? '<div class="hsync-actions">' + actions + '</div>' : '')
            + '</div>';
        const dash = name => '<span class="dashicons dashicons-' + name + '" aria-hidden="true"></span>';

        if (qi.phase === 'running') {
            const p   = qi.progress;
            const pct = p && p.total > 0 ? Math.min(100, Math.round((p.done || 0) * 100 / p.total)) : null;
            const head = qi.stopping
                ? 'Mi fermo alla fine del blocco in corso…'
                : (pct === null
                    ? 'Scarico il catalogo dal fornitore e preparo l\'importazione…'
                    : 'Importazione in corso: ' + HSync.num(p.done) + ' di ' + HSync.num(p.total) + ' (' + pct + '%)');
            el.innerHTML = box('is-running', '<span class="spinner is-active" aria-hidden="true"></span>', esc(head),
                '<div class="hsync-progress' + (pct === null ? ' is-indeterminate' : '') + '"><span style="width:' + (pct === null ? 100 : pct) + '%"></span></div>'
                + '<div class="hsync-qi-run-meta">' + what + ' · <span data-qi-elapsed>' + esc(elapsed) + '</span>'
                +   (qi.summary || qi.base ? ' · finora ' + esc(HSync.countsPhrase(s)) : '') + '</div>'
                + '<p class="hsync-qi-run-hint">Lascia aperta questa scheda finché non ha finito: puoi lavorare in un\'altra.</p>',
                '<button type="button" class="button" data-action="qi-stop"' + (qi.stopping ? ' disabled' : '') + '>Interrompi</button>');
            return;
        }
        if (qi.phase === 'done') {
            const touched = QI_RESULT_KEYS.some(k => k !== 'skipped' && (s[k] || 0) > 0);
            // The slice, not `fetched`: with a category filter `fetched`
            // is the whole feed and the slice is what the diff classified.
            const empty   = ((s.new || 0) + (s.update || 0) + (s.update_stock || 0) + (s.unchanged || 0)) === 0;
            const head = empty
                ? 'Il fornitore non ha restituito prodotti per questa scelta.'
                : (touched ? 'Importazione completata in ' + elapsed : 'Niente da fare: era già tutto aggiornato.');
            el.innerHTML = box(empty ? 'is-warn' : 'is-done', dash(empty ? 'warning' : 'yes-alt'), esc(head),
                (touched ? '<div class="hsync-qi-run-meta"><strong>' + esc(HSync.countsPhrase(s)) + '</strong></div>' : '')
                + '<div class="hsync-qi-run-meta">' + what + '</div>'
                + ((s.failed || 0) > 0 ? '<p class="hsync-qi-run-hint">Alcuni prodotti non sono stati importati: in «Dettagli tecnici» qui sotto trovi quali e perché.</p>' : '')
                + HSync.qiNotes(qi.warnings, empty),
                '<button type="button" class="button button-primary" data-action="qi-reset">Fatto</button>'
                + '<button type="button" class="button" data-action="goto-tab" data-tab="runs">Vedi lo storico</button>');
            return;
        }
        if (qi.phase === 'cancelled') {
            el.innerHTML = box('is-dim', dash('controls-pause'), 'Importazione interrotta',
                '<div class="hsync-qi-run-meta">' + what + '</div>'
                + '<p class="hsync-qi-run-hint">I prodotti già elaborati restano nel negozio' + (qi.summary || qi.base ? ': ' + esc(HSync.countsPhrase(s)) : '') + '.</p>',
                '<button type="button" class="button" data-action="qi-reset">Chiudi</button>');
            return;
        }
        // error / paused
        el.innerHTML = box('is-bad', dash('warning'), qi.phase === 'paused' ? 'Importazione in pausa' : 'L\'importazione si è fermata',
            (qi.error ? '<div class="hsync-qi-run-meta">' + esc(HSync.friendlyError(qi.error)) + '</div>' : '')
            + (qi.label ? '<div class="hsync-qi-run-meta">' + what + '</div>' : '')
            + (qi.resumable ? '<p class="hsync-qi-run-hint">Riprendendo, continua da dove si era fermata: i prodotti già fatti non vengono rifatti.</p>' : ''),
            (qi.resumable ? '<button type="button" class="button button-primary" data-action="qi-resume">Riprendi da dove si era fermata</button>' : '')
            + '<button type="button" class="button" data-action="qi-reset">Chiudi</button>');
    };

    // ── Catalogo e prezzi ─────────────────────────────────────────
    //
    // Per supplier: the default markup ("prezzo = costo × N"), what the
    // automatic sync sells (everything / only the ticked categories) and
    // an optional markup per category. Scope is saved on the automation,
    // margins on the supplier's config — see catalog_settings_save.

    HSync.state.cat = {
        jobId: 0, settings: null, error: '',
        tree: null, treeLoading: false, treeError: '',
        scope: 'all', selected: new Set(), expanded: new Set(), search: '',
        def: '', margins: {}, orphanMargins: {},
        dirty: false, saving: false, msg: null,
    };

    /** "3,5" ← 3.5; '' for nothing. */
    HSync.fmtMult = function (n) {
        if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '';
        return String(Math.round(Number(n) * 1000) / 1000).replace('.', ',');
    };
    /** "3,5" / "3.5" → 3.5; NaN when not a number; null when empty. */
    HSync.parseMult = function (v) {
        const t = String(v == null ? '' : v).trim().replace(',', '.');
        if (t === '') return null;
        return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
    };

    HSync.openCatalog = async function (jobId, fromSelect) {
        const st = HSync.state.cat;
        if (jobId && HSync.state.currentTab !== 'catalog') {
            st.pendingJob = jobId;
            return HSync.switchTab('catalog');
        }
        if (!HSync.state.overview) {
            HSync.renderCatalog();
            await HSync.loadOverview();
        }
        const feeds = HSync.importableFeeds();
        let want = jobId || st.pendingJob || st.jobId;
        st.pendingJob = 0;
        if (!feeds.some(f => f.id === want)) want = feeds.length ? (feeds.find(f => f.has_categories) || feeds[0]).id : 0;
        if (st.dirty && want !== st.jobId && !confirm('Ci sono modifiche non salvate. Cambiare fornitore e perderle?')) {
            return HSync.renderCatalog();
        }
        if (want !== st.jobId || !st.settings || fromSelect) {
            st.jobId = want;
            st.tree = null;
            return HSync.catLoad(true);
        }
        HSync.renderCatalog();
    };

    /** Settings (scope + margins) and, for feeds with categories, the tree. */
    HSync.catLoad = async function (resetEdits) {
        const st = HSync.state.cat;
        if (resetEdits && st.dirty && st.settings && !confirm('Annullare le modifiche non salvate?')) return;
        Object.assign(st, { settings: null, error: '', dirty: false, msg: null, search: '' });
        HSync.renderCatalog();
        if (!st.jobId) return;
        const jobId = st.jobId;
        try {
            const s = await HSync.ajax('catalog_settings', { job_id: jobId });
            if (st.jobId !== jobId) return;
            st.settings = s;
            st.scope    = s.scope;
            st.selected = new Set(s.scope === 'cats' ? s.categories : []);
            st.expanded = new Set();
            st.def      = HSync.fmtMult(s.margins.default);
        } catch (e) {
            st.error = e.message;
            return HSync.renderCatalog();
        }
        HSync.renderCatalog();
        if (st.settings.has_categories) HSync.catLoadTree(false);
    };

    HSync.catLoadTree = async function (refresh) {
        const st = HSync.state.cat;
        const jobId = st.jobId;
        st.treeLoading = true; st.treeError = '';
        HSync.renderCatTable();
        try {
            const t = await HSync.ajax('feed_categories', { job_id: jobId, refresh: refresh ? '1' : '' });
            if (st.jobId !== jobId) return;
            st.tree = t.supported ? t : null;
        } catch (e) {
            if (st.jobId !== jobId) return;
            st.treeError = e.message;
        }
        st.treeLoading = false;
        HSync.catAdoptTree();
        HSync.renderCatalog();
    };

    /**
     * Line the saved values up with the tree's own spelling (matching is
     * case-insensitive), keeping the ones the feed no longer lists so a
     * save never silently drops them.
     */
    HSync.catAdoptTree = function () {
        const st = HSync.state.cat;
        if (!st.tree || !st.settings) return;
        const byNorm = {};
        (st.tree.categories || []).forEach(c => {
            byNorm[HSync.qiNorm(c.value)] = c.value;
            (c.subs || []).forEach(s => { byNorm[HSync.qiNorm(s.value)] = s.value; });
        });
        if (!st.dirty) {
            st.margins = {}; st.orphanMargins = {};
            Object.entries(st.settings.margins.categories || {}).forEach(([v, n]) => {
                const hit = byNorm[HSync.qiNorm(v)];
                if (hit) st.margins[hit] = HSync.fmtMult(n); else st.orphanMargins[v] = n;
            });
            const sel = new Set();
            st.selected.forEach(v => sel.add(byNorm[HSync.qiNorm(v)] || v));
            st.selected = sel;
        }
    };

    HSync.catFeed = function () {
        const id = HSync.state.cat.jobId;
        return HSync.importableFeeds().find(f => f.id === id) || null;
    };

    HSync.renderCatalog = function () {
        const st   = HSync.state.cat;
        const root = $('[data-region="cat"]');
        if (!root) return;
        if (!HSync.state.overview) { root.innerHTML = '<p class="hsync-loading">Caricamento…</p>'; return; }
        const feeds = HSync.importableFeeds();
        if (!feeds.length) {
            root.innerHTML = '<div class="hsync-empty-state"><span class="dashicons dashicons-admin-plugins" aria-hidden="true"></span>'
                + '<h3>Nessun fornitore collegato</h3><p>Serve prima il collegamento al feed di un fornitore. Se non l\'hai fatto tu, chiedilo a chi ha configurato il sito.</p></div>';
            return;
        }
        const feed = HSync.catFeed();
        const feedPick = feeds.length === 1
            ? '<strong class="hsync-qi-feedname">' + esc(feeds[0].label) + '</strong>'
            : '<select data-action="cat-feed">' + feeds.map(f => '<option value="' + f.id + '"' + (f.id === st.jobId ? ' selected' : '') + '>' + esc(f.label) + '</option>').join('') + '</select>';
        let body;
        if (st.error) {
            body = '<div class="hsync-error">' + esc(st.error) + ' <button type="button" class="button-link" data-action="cat-retry">Riprova</button></div>';
        } else if (!st.settings) {
            body = '<p class="hsync-loading">Caricamento…</p>';
        } else {
            const s = st.settings;
            const m = s.margins;
            const sfNote = s.has_categories
                ? 'Il prezzo pieno del fornitore resta come prezzo di listino (barrato); il ricarico decide il prezzo di vendita.'
                : '';
            const margin = !m.supported
                ? '<p class="hsync-qi-hint">I prezzi di questo fornitore si impostano in modalità avanzata.</p>'
                : '<div class="hsync-cat-default">'
                  + '<label>Prezzo di vendita = costo del fornitore × '
                  +   '<input type="text" inputmode="decimal" class="hsync-mult" data-action="cat-default" value="' + esc(st.def) + '" aria-label="Ricarico predefinito"></label>'
                  + '<div class="hsync-feed-note">Esempio: costo 40 € × ' + esc(st.def || '?') + ' = '
                  +   esc(HSync.catExample(st.def)) + '. ' + sfNote
                  +   (m.by_category ? ' Puoi dare un ricarico diverso a singole categorie qui sotto.' : '') + '</div>'
                  + (m.custom_rules ? '<div class="hsync-feed-note">Ci sono anche ' + m.custom_rules + (m.custom_rules === 1 ? ' regola personalizzata' : ' regole personalizzate')
                      + ' (es. per marca) impostate in modalità avanzata: hanno la precedenza su quelle qui.</div>' : '')
                  + '</div>';
            const scope = s.has_categories
                ? (s.scope === 'custom'
                    ? '<p class="hsync-qi-hint">Questa automazione usa un filtro categorie scritto a mano (' + esc(HSync.describeCategoryFilter(s.categories)) + '): si cambia in modalità avanzata.</p>'
                    : '<div class="hsync-qi-scopes" role="radiogroup" aria-label="Cosa vendere">'
                      + HSync.catRadio('all', 'Tutto il catalogo', 'La sincronizzazione importa e aggiorna tutti i prodotti del fornitore.')
                      + HSync.catRadio('cats', 'Solo le categorie spuntate', 'Importa e aggiorna solo le categorie che scegli qui sotto.')
                      + '</div>')
                : '<p class="hsync-qi-hint">Questo fornitore non divide il catalogo in categorie: si sincronizza tutto il catalogo.</p>';
            body = ''
                + '<fieldset class="hsync-qi-step"><legend><span class="hsync-qi-num">2</span> Ricarico</legend>' + margin + '</fieldset>'
                + '<fieldset class="hsync-qi-step"><legend><span class="hsync-qi-num">3</span> Cosa vendere' + (s.has_categories && m.by_category ? ' e ricarico per categoria' : '') + '</legend>'
                +   scope + '<div data-region="cat-table"></div>'
                + '</fieldset>'
                + '<div class="hsync-cat-save" data-region="cat-save"></div>';
        }
        root.innerHTML = ''
            + '<p class="hsync-lead">Scegli cosa vendere di ogni fornitore e con quale ricarico. La sincronizzazione automatica importa e aggiorna solo questo, a questi prezzi.</p>'
            + '<div class="hsync-qi">'
            +   '<fieldset class="hsync-qi-step"><legend><span class="hsync-qi-num">1</span> Fornitore</legend>' + feedPick
            +     (feed && feed.config_name && feed.config_name !== feed.label ? ' <span class="hsync-muted-inline">' + esc(feed.config_name) + '</span>' : '')
            +   '</fieldset>'
            +   body
            + '</div>';
        HSync.renderCatTable();
        HSync.renderCatSave();
    };

    HSync.catRadio = function (value, title, hint) {
        const st = HSync.state.cat;
        return '<label class="hsync-qi-scope' + (st.scope === value ? ' is-on' : '') + '">'
            + '<input type="radio" name="hsync-cat-scope" value="' + value + '"' + (st.scope === value ? ' checked' : '') + '>'
            + '<span><strong>' + esc(title) + '</strong><small>' + esc(hint) + '</small></span></label>';
    };

    HSync.catExample = function (mult) {
        const n = HSync.parseMult(mult);
        if (n === null || isNaN(n)) return '—';
        return (40 * n).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €';
    };

    HSync.renderCatTable = function () {
        const st = HSync.state.cat;
        const el = $('[data-region="cat-table"]');
        if (!el || !st.settings || !st.settings.has_categories) { if (el) el.innerHTML = ''; return; }
        if (!st.tree) {
            el.innerHTML = st.treeError
                ? '<div class="hsync-error">' + esc(st.treeError) + ' <button type="button" class="button-link" data-action="cat-refresh">Riprova</button></div>'
                : '<div class="hsync-qi-wait"><span class="spinner is-active" aria-hidden="true"></span> Leggo le categorie dal fornitore… La prima volta può volerci un minuto.</div>';
            return;
        }
        const t = st.tree;
        const byCat = st.settings.margins.by_category;
        el.innerHTML = ''
            + '<div class="hsync-cats hsync-cat-table' + (st.scope === 'cats' ? '' : ' is-all') + '">'
            +   '<div class="hsync-cats-bar">'
            +     '<input type="search" class="hsync-cats-search" data-action="cat-search" placeholder="Cerca una categoria…" aria-label="Cerca una categoria" value="' + esc(st.search) + '">'
            +     '<span class="hsync-cats-meta">' + HSync.num((t.categories || []).length) + ' categorie · ' + HSync.num(t.total) + ' prodotti in listino'
            +       ' · <button type="button" class="button-link" data-action="cat-refresh"' + (st.treeLoading ? ' disabled' : '') + '>' + (st.treeLoading ? 'Aggiorno…' : 'Aggiorna elenco') + '</button></span>'
            +   '</div>'
            +   '<div class="hsync-cat-head"><span>Categoria</span><span>Prodotti</span>' + (byCat ? '<span>Ricarico</span>' : '') + '</div>'
            +   '<ul class="hsync-cats-list" data-region="cat-list"></ul>'
            +   '<div class="hsync-cats-foot" data-region="cat-foot"></div>'
            + '</div>';
        HSync.renderCatList();
    };

    HSync.renderCatList = function () {
        const st = HSync.state.cat;
        const el = $('[data-region="cat-list"]');
        if (!el || !st.tree) return;
        const byCat = st.settings.margins.by_category;
        const picking = st.scope === 'cats';
        const q = HSync.qiNorm(st.search);
        const marginInput = (value, inherited) => byCat
            ? '<span class="hsync-cat-mult">× <input type="text" inputmode="decimal" class="hsync-mult" data-action="cat-margin" data-value="' + esc(value) + '"'
              + ' value="' + esc(st.margins[value] || '') + '" placeholder="' + esc(inherited) + '" aria-label="Ricarico"></span>'
            : '';
        const box = (attrs, checked) => picking
            ? '<input type="checkbox" data-action="cat-pick" ' + attrs + (checked ? ' checked' : '') + '>'
            : '';
        const rows = (st.tree.categories || []).map(cat => {
            const subs    = cat.subs || [];
            const catHit  = !q || HSync.qiNorm(cat.name).indexOf(q) >= 0;
            const subHits = q && !catHit ? subs.filter(s => HSync.qiNorm(s.name).indexOf(q) >= 0) : subs;
            if (q && !catHit && !subHits.length) return '';
            const whole   = st.selected.has(cat.value);
            const picked  = subs.filter(s => st.selected.has(s.value)).length;
            const open    = st.expanded.has(cat.value) || (q && !catHit) || subs.some(s => st.margins[s.value]);
            const catMult = st.margins[cat.value] || st.def;
            const subRows = open ? subHits.map(s =>
                '<li class="hsync-sub">'
                + '<label>' + box('data-cat="' + esc(cat.value) + '" data-value="' + esc(s.value) + '"', whole || st.selected.has(s.value)) + ' ' + esc(s.name) + '</label>'
                + HSync.qiCount(s)
                + marginInput(s.value, catMult)
                + '</li>').join('') : '';
            return '<li class="hsync-cat' + (picking && (whole || picked) ? ' is-picked' : '') + '">'
                + '<div class="hsync-cat-row">'
                +   (subs.length
                        ? '<button type="button" class="hsync-cat-caret" data-action="cat-expand" data-value="' + esc(cat.value) + '" aria-expanded="' + (open ? 'true' : 'false') + '" title="Sottocategorie">'
                          + '<span class="dashicons dashicons-arrow-' + (open ? 'down' : 'right') + '-alt2" aria-hidden="true"></span></button>'
                        : '<span class="hsync-cat-caret is-empty" aria-hidden="true"></span>')
                +   '<label class="hsync-cat-label">' + box('data-value="' + esc(cat.value) + '"' + (picked && !whole ? ' data-partial="1"' : ''), whole) + ' ' + esc(cat.name) + '</label>'
                +   HSync.qiCount(cat)
                +   marginInput(cat.value, st.def)
                + '</div>'
                + (subRows ? '<ul class="hsync-subs">' + subRows + '</ul>' : '')
                + '</li>';
        }).join('');
        el.innerHTML = rows || '<li class="hsync-cats-empty">Nessuna categoria contiene «' + esc(st.search) + '».</li>';
        $$('input[data-partial="1"]', el).forEach(cb => { cb.indeterminate = true; });
        HSync.renderCatFoot();
    };

    /** Products in the shop that a "solo queste categorie" choice leaves out. */
    HSync.catLeftOut = function () {
        const st = HSync.state.cat;
        if (!st.tree || st.scope !== 'cats') return 0;
        let n = 0;
        (st.tree.categories || []).forEach(cat => {
            if (st.selected.has(cat.value)) return;
            const subsIn = (cat.subs || []).filter(s => st.selected.has(s.value)).reduce((a, s) => a + (s.in_shop || 0), 0);
            n += Math.max(0, (cat.in_shop || 0) - subsIn);
        });
        return n;
    };

    HSync.renderCatFoot = function () {
        const st = HSync.state.cat;
        const el = $('[data-region="cat-foot"]');
        if (!el) return;
        const bits = [];
        if (st.scope === 'cats') {
            const left = HSync.catLeftOut();
            if (left) bits.push('<strong>' + HSync.num(left) + ' prodotti già nel negozio</strong> sono in categorie non spuntate: restano in vendita ma la sincronizzazione non aggiornerà più il loro prezzo e la disponibilità.');
        }
        if (st.settings && st.settings.margins.by_category) bits.push('Ricarico vuoto = quello della categoria, o quello predefinito.');
        if (st.tree && st.tree.uncategorized) bits.push(HSync.num(st.tree.uncategorized) + (st.tree.uncategorized === 1 ? ' prodotto senza categoria entra' : ' prodotti senza categoria entrano') + ' solo con «Tutto il catalogo».');
        el.innerHTML = bits.join('<br>');
        el.hidden = !bits.length;
    };

    HSync.catSetScope = function (scope) {
        const st = HSync.state.cat;
        st.scope = scope === 'cats' ? 'cats' : 'all';
        st.dirty = true;
        $$('.hsync-qi-scope', $('[data-region="cat"]')).forEach(l => l.classList.toggle('is-on', l.querySelector('input').value === st.scope));
        HSync.renderCatTable();
        HSync.renderCatSave();
    };

    HSync.catPick = function (catValue, value, on) {
        const st = HSync.state.cat;
        if (catValue) HSync.pickSub(st, catValue, value, on); else HSync.pickCat(st, value, on);
        st.dirty = true;
        HSync.renderCatList();
        HSync.renderCatSave();
    };

    HSync.catToggleExpand = function (value) {
        const st = HSync.state.cat;
        if (st.expanded.has(value)) st.expanded.delete(value); else st.expanded.add(value);
        HSync.renderCatList();
    };

    HSync.catSearch = function (value) {
        HSync.state.cat.search = String(value || '');
        clearTimeout(HSync.state.catSearchTimer);
        HSync.state.catSearchTimer = setTimeout(HSync.renderCatList, 120);
    };

    /** Typing: keep the value; on commit (change), redraw the inherited placeholders. */
    HSync.catMarginChanged = function (input, committed) {
        const st = HSync.state.cat;
        const v  = String(input.value || '').trim();
        const n  = HSync.parseMult(v);
        input.classList.toggle('is-invalid', n !== null && (isNaN(n) || n < 1 || n > 20));
        if (input.dataset.action === 'cat-default') st.def = v;
        else if (v === '') delete st.margins[input.dataset.value];
        else st.margins[input.dataset.value] = v;
        st.dirty = true;
        if (committed) {
            if (input.dataset.action === 'cat-default') HSync.renderCatalog();
            else HSync.renderCatList();
        }
        HSync.renderCatSave();
    };

    HSync.renderCatSave = function () {
        const st = HSync.state.cat;
        const el = $('[data-region="cat-save"]');
        if (!el || !st.settings) return;
        const feed = HSync.catFeed();
        const shared = st.settings.shared_jobs > 1
            ? '<div class="hsync-feed-note">I ricarichi valgono per tutte le ' + st.settings.shared_jobs + ' automazioni di questo fornitore.</div>' : '';
        let msg = '';
        if (st.msg) {
            msg = '<div class="hsync-job-flash is-' + esc(st.msg.kind) + '">' + st.msg.html + '</div>';
        }
        el.innerHTML = ''
            + '<div class="hsync-actions">'
            +   '<button type="button" class="button button-primary button-hero" data-action="cat-save"' + (st.saving || !st.dirty ? ' disabled' : '') + '>'
            +     (st.saving ? 'Salvo…' : 'Salva') + '</button>'
            +   (st.dirty ? '<span class="hsync-cat-dirty">Modifiche non salvate · <button type="button" class="button-link" data-action="cat-reset">Annulla</button></span>' : '')
            + '</div>'
            + shared + msg
            + (feed && !feed.enabled ? '<div class="hsync-feed-note">La sincronizzazione automatica di questo fornitore è spenta: si accende dalla Panoramica.</div>' : '');
    };

    HSync.catSave = async function () {
        const st = HSync.state.cat;
        const s  = st.settings;
        if (!s || st.saving) return;
        const payload = { job_id: st.jobId };
        if (s.margins.supported) {
            const def = HSync.parseMult(st.def);
            if (def === null || isNaN(def) || def < 1 || def > 20) {
                st.msg = { kind: 'err', html: 'Il ricarico predefinito deve essere un numero tra 1 e 20 (es. 3,5).' };
                return HSync.renderCatSave();
            }
            payload.default = String(def);
            if (s.margins.by_category) {
                const out = Object.assign({}, st.orphanMargins);
                for (const [v, raw] of Object.entries(st.margins)) {
                    const n = HSync.parseMult(raw);
                    if (n === null) continue;
                    if (isNaN(n) || n < 1 || n > 20) {
                        st.msg = { kind: 'err', html: 'Ricarico non valido per «' + esc(HSync.describeCategoryFilter([v])) + '»: usa un numero tra 1 e 20.' };
                        return HSync.renderCatSave();
                    }
                    out[v] = n;
                }
                payload.margins = out;
            }
        }
        if (s.has_categories && s.scope !== 'custom') {
            payload.scope = st.scope;
            if (st.scope === 'cats') {
                if (!st.selected.size) {
                    st.msg = { kind: 'err', html: 'Spunta almeno una categoria, oppure scegli «Tutto il catalogo».' };
                    return HSync.renderCatSave();
                }
                payload.categories = Array.from(st.selected);
            }
        }
        st.saving = true; st.msg = null;
        HSync.renderCatSave();
        try {
            const r = await HSync.ajax('catalog_settings_save', payload);
            st.dirty = false;
            const when = r.enabled && r.next_run_at ? ' alla prossima sincronizzazione (' + esc(HSync.fmtWhen(r.next_run_at)) + ')' : ' alla prossima sincronizzazione';
            st.msg = { kind: 'ok', html: 'Salvato. Prodotti e prezzi si aggiornano' + when + '.'
                + (r.running ? ' Quella in corso finisce con le impostazioni di prima.' : '')
                + ' <button type="button" class="button" data-action="cat-sync">Sincronizza ora</button>' };
            await HSync.loadOverview();
            const fresh = await HSync.ajax('catalog_settings', { job_id: st.jobId });
            st.settings = fresh;
            st.def = HSync.fmtMult(fresh.margins.default);
            HSync.catAdoptTree();
        } catch (e) {
            st.msg = { kind: 'err', html: esc(e.message) };
        }
        st.saving = false;
        HSync.renderCatalog();
    };

    HSync.catSyncNow = async function () {
        const st = HSync.state.cat;
        st.msg = { kind: 'ok', html: 'Avvio…' };
        HSync.renderCatSave();
        try {
            const data = await HSync.ajax('job_run_now', { id: String(st.jobId) });
            st.msg = { kind: data.status === 'failed' ? 'err' : 'ok', html: esc(HSync.describeRunNowSimple(data)) + ' Lo stato è nella Panoramica.' };
        } catch (e) {
            st.msg = { kind: 'err', html: esc(e.message) };
        }
        HSync.renderCatSave();
        HSync.loadOverview();
    };

    // ── Storico (simple columns) ──────────────────────────────────

    HSync.renderRunsSimple = function (runs, labels) {
        const cards = (HSync.state.overview && HSync.state.overview.cards) || [];
        const byRef = {};
        cards.forEach(c => { if (c.source_id && c.config_slug) byRef[c.source_id + '/' + c.config_slug] = c.label; });
        const rows = runs.map(r => {
            const st       = HSync.runStatus(r.status);
            const report   = r.report || {};
            const summary  = report.summary || {};
            const sched    = report.schedule || null;
            const inFlight = r.status === 'continue' || r.status === 'running';
            const name     = (r.job_id && labels[r.job_id]) || byRef[r.runnable_ref] || r.runnable_ref;
            const how      = r.job_id
                ? (sched && sched.trigger === 'manual' ? 'avviata a mano' : 'automatica')
                : 'importazione manuale';
            let dur = inFlight ? (Date.now() - HSync.parseUtc(r.started_at)) / 1000 : HSync.runDuration(r);
            if (dur !== null && isNaN(dur)) dur = null;
            let result;
            if (r.status === 'failed') {
                result = '<span class="is-bad">' + esc(HSync.friendlyError(report.error || 'non riuscita')) + '</span>';
            } else if (inFlight) {
                result = esc(HSync.num(r.items_done || 0)) + (r.items_total ? ' di ' + esc(HSync.num(r.items_total)) : '') + ' finora';
            } else {
                result = esc(HSync.countsPhrase(summary, r.runnable_type === 'source.import' ? 0 : r.items_done));
            }
            return '<tr>'
                + '<td>' + esc(HSync.fmtWhen(r.started_at, { date: true })) + (dur !== null ? '<div class="hsync-muted-inline">' + esc(HSync.fmtDuration(dur)) + (inFlight ? ' finora' : '') + '</div>' : '') + '</td>'
                + '<td><strong>' + esc(name) + '</strong><div class="hsync-muted-inline">' + esc(how)
                +   (summary.categories ? ' · solo ' + esc(summary.categories) : '') + '</div></td>'
                + '<td><span class="hsync-action-pill ' + st.cls + '">' + esc(st.label) + '</span></td>'
                + '<td>' + result + '</td>'
                + '</tr>';
        }).join('');
        return '<table class="hsync-table hsync-runs-simple">'
            + '<thead><tr><th>Quando</th><th>Cosa</th><th>Esito</th><th>Risultato</th></tr></thead>'
            + '<tbody>' + rows + '</tbody></table>'
            + '<p class="hsync-muted">Orari nel fuso del negozio (' + esc(HSync.tzLabel()) + ').</p>';
    };

    // ─── Event delegation ─────────────────────────────────────────

    document.addEventListener('click', function (e) {
        // Tab buttons contain nested spans (icon + step number) — when
        // the user clicks one of those spans, e.target IS the span, not
        // the button. closest() resolves to the nearest tab button.
        const tabBtn = e.target.closest && e.target.closest('.hsync-tab');
        if (tabBtn) return HSync.switchTab(tabBtn.dataset.tab);
        const t = e.target;

        // Simple view (Panoramica / Importa prodotti). closest(), because
        // these buttons carry icons and a click on one targets the span.
        const sa  = t.closest && t.closest('[data-action]');
        const act = sa ? sa.dataset.action : '';
        if (act === 'feed-run')    return HSync.feedRunNow(parseInt(sa.dataset.id, 10));
        if (act === 'feed-stop')   return HSync.feedStop(parseInt(sa.dataset.id, 10));
        if (act === 'feed-import') return HSync.openImport(parseInt(sa.dataset.id, 10));
        if (act === 'feed-catalog') return HSync.openCatalog(parseInt(sa.dataset.id, 10));
        if (act === 'cat-save')    return HSync.catSave();
        if (act === 'cat-reset')   return HSync.catLoad(true);
        if (act === 'cat-refresh') return HSync.catLoadTree(true);
        if (act === 'cat-retry')   return HSync.catLoad(false);
        if (act === 'cat-expand')  return HSync.catToggleExpand(sa.dataset.value);
        if (act === 'cat-sync')    return HSync.catSyncNow();
        if (act === 'goto-tab')    return HSync.switchTab(sa.dataset.tab);
        if (act === 'qi-start')    return HSync.qiStart();
        if (act === 'qi-stop')     return HSync.qiStop();
        if (act === 'qi-resume')   return HSync.qiResume();
        if (act === 'qi-reset')    return HSync.qiReset();
        if (act === 'qi-retry')    return HSync.qiLoadCategories(false);
        if (act === 'qi-refresh')  return HSync.qiLoadCategories(true);
        if (act === 'qi-expand')   return HSync.qiToggleExpand(sa.dataset.value);
        if (act === 'qi-clear')    return HSync.qiClearSelection();
        if (t.matches('[data-action="goto-run"]'))      return HSync.switchTab('run');
        if (t.matches('[data-action="cockpit-tick"]')) return HSync.cockpitTickNow();
        if (t.matches('[data-action="runs-purge-all"]'))    return HSync.purgeRunsAll();
        if (t.matches('[data-action="runs-purge-older"]'))  return HSync.purgeRunsOlder(t.dataset.days);
        if (t.matches('[data-action="media-log-clear"]'))   return HSync.clearMediaLog();
        if (t.matches('[data-action="test-fetch"]'))    return HSync.testFetch(t.dataset.source, t.closest('form'));
        if (t.matches('[data-action="src-config-save"]'))   return HSync.saveSourceConfig(t.dataset.source);
        if (t.matches('[data-action="src-config-reset"]'))  return HSync.resetSourceConfigEditor(t.dataset.source);
        if (t.matches('[data-action="src-config-load"]'))   return HSync.loadSourceConfigEditor(t.dataset.source, t.dataset.slug);
        if (t.matches('[data-action="src-config-duplicate"]'))   return HSync.duplicateSourceConfig(t.dataset.source, t.dataset.slug);
        if (t.matches('[data-action="src-config-delete"]')) return HSync.deleteSourceConfig(t.dataset.slug);
        if (t.matches('[data-action="mapping-new"]'))   return HSync.openMappingEditor(null);
        if (t.matches('[data-action="mapping-edit"]')) {
            const m = HSync.state.mappings.find(x => x.slug === t.dataset.slug);
            return HSync.openMappingEditor(m);
        }
        if (t.matches('[data-action="mapping-duplicate"]')) {
            const m = HSync.state.mappings.find(x => x.slug === t.dataset.slug);
            return HSync.openMappingEditor(HSync.cloneForDuplicate(m, ['slug']));
        }
        if (t.matches('[data-action="mapping-delete"]')) return HSync.deleteMapping(t.dataset.slug);
        if (t.matches('[data-action="mapping-save"]'))   return HSync.saveMapping();
        if (t.matches('[data-action="mapping-cancel"]')) return HSync.closeMappingEditor();
        if (t.matches('[data-action="mapping-probe"]'))          return HSync.probeMappingSource();
        if (t.matches('[data-action="mapping-toggle-advanced"]')) return HSync.toggleAdvancedMapping();
        if (t.matches('[data-action="mapping-clear"]'))          return HSync.clearMappingValue(t.dataset.key);
        if (t.matches('[data-action="mapping-add-custom"]'))     return HSync.addCustomMappingRow();
        if (t.matches('[data-action="mapping-custom-delete"]'))  return HSync.deleteCustomMappingRow(parseInt(t.dataset.idx, 10));
        if (t.matches('[data-action="mapping-json-apply"]'))     return HSync.applyMappingJson();
        if (t.matches('[data-action="mapping-insert-token"]'))   return HSync.insertMappingToken(t.dataset.token);
        if (t.matches('[data-action="install-defaults"]'))       return HSync.installDefaults(false);
        if (t.matches('[data-action="install-defaults-force"]')) return HSync.installDefaults(true);
        if (t.matches('[data-action="run-now"]'))        return HSync.runNow();
        if (t.matches('[data-action="run-resume"]'))     return HSync.resumeFailedRun();

        // Markup-rules repeater (lives inside the source-config form)
        if (t.matches('[data-action="markup-rule-add"]')) {
            const region = t.closest('[data-markup-region]');
            if (! region) return;
            const rowsEl = region.querySelector('[data-markup-rows]');
            const idx = region.querySelectorAll('[data-markup-rule-idx]').length;
            rowsEl.insertAdjacentHTML('beforeend', HSync.renderMarkupRuleRow({}, idx));
            HSync.syncMarkupRules(region);
            // Datalist suggestions: only the new row needs them. Avoid
            // re-running the full applyMarkupFlavorVisibility here —
            // it walks every label in the form and was reported to
            // glitch the UI when re-toggling labels mid-interaction.
            // The button's existence already implies markup_rules is
            // visible, so there's nothing to re-hide.
            const form = region.closest('form.hsync-config-form');
            const datalist = region.querySelector('datalist[id$="__field_suggestions"]');
            if (datalist && form) {
                const newField = rowsEl.lastElementChild
                    ? rowsEl.lastElementChild.querySelector('[data-rule-field="field"]')
                    : null;
                if (newField) newField.setAttribute('list', datalist.id);
            }
            return;
        }
        if (t.matches('[data-action="markup-rule-remove"]')) {
            const row = t.closest('[data-markup-rule-idx]');
            const region = t.closest('[data-markup-region]');
            if (row) row.remove();
            if (region) HSync.syncMarkupRules(region);
            return;
        }
        if (t.matches('[data-action="markup-rules-test"]')) {
            return HSync.runMarkupRulesTest(t);
        }
        if (t.matches('[data-action="run-test-fetch"]')) return HSync.testFetchFromRun();
        if (t.matches('[data-action="run-save-config"]'))return HSync.saveCurrentConfig();
        if (t.matches('[data-action="run-save-job"]'))   return HSync.saveCurrentAsJob();
        if (t.matches('[data-action="runs-refresh"]'))   return HSync.loadRuns();

        // Pipelines
        if (t.matches('[data-action="pipeline-new"]'))    return HSync.openPipelineEditor(null);
        if (t.matches('[data-action="pipeline-edit"]')) {
            const p = HSync.state.pipelines.find(x => x.slug === t.dataset.slug);
            return HSync.openPipelineEditor(p);
        }
        if (t.matches('[data-action="pipeline-duplicate"]')) {
            const p = HSync.state.pipelines.find(x => x.slug === t.dataset.slug);
            return HSync.openPipelineEditor(HSync.cloneForDuplicate(p, ['slug']));
        }
        if (t.matches('[data-action="pipeline-delete"]')) return HSync.deletePipeline(t.dataset.slug);
        if (t.matches('[data-action="pipeline-save"]'))   return HSync.savePipeline();
        if (t.matches('[data-action="pipeline-cancel"]')) return HSync.closePipelineEditor();
        if (t.matches('[data-action="pipeline-add-op"]'))   return HSync.addPipelineStep('operation');
        if (t.matches('[data-action="pipeline-add-chk"]'))  return HSync.addPipelineStep('check');
        if (t.matches('[data-action="pipeline-add-pre"]'))  return HSync.addPipelineStep('pre_check');
        if (t.matches('[data-action="pipeline-add-rule"]')) return HSync.addPipelineStep('import_rule');
        if (t.matches('[data-action="step-up"]'))     return HSync.movePipelineStep(parseInt(t.dataset.idx, 10), -1);
        if (t.matches('[data-action="step-down"]'))   return HSync.movePipelineStep(parseInt(t.dataset.idx, 10), 1);
        if (t.matches('[data-action="step-delete"]')) return HSync.deletePipelineStep(parseInt(t.dataset.idx, 10));

        // Rules
        if (t.matches('[data-action="rule-new"]')) return HSync.openRuleEditor(null);
        if (t.matches('[data-action="rule-edit"]')) {
            const r = HSync.state.rules.find(x => x.slug === t.dataset.slug);
            return HSync.openRuleEditor(r);
        }
        if (t.matches('[data-action="rule-duplicate"]')) {
            const r = HSync.state.rules.find(x => x.slug === t.dataset.slug);
            return HSync.openRuleEditor(HSync.cloneForDuplicate(r, ['slug']));
        }
        if (t.matches('[data-action="rule-delete"]'))     return HSync.deleteRule(t.dataset.slug);
        if (t.matches('[data-action="rule-save"]'))       return HSync.saveRule();
        if (t.matches('[data-action="rule-cancel"]'))     return HSync.closeRuleEditor();
        if (t.matches('[data-action="rule-add-op"]'))     return HSync.addRuleStep('op');
        if (t.matches('[data-action="rule-add-chk"]'))    return HSync.addRuleStep('chk');
        if (t.matches('[data-action="rule-step-up"]'))    return HSync.moveRuleStep(t.dataset.kind, parseInt(t.dataset.idx,10), -1);
        if (t.matches('[data-action="rule-step-down"]'))  return HSync.moveRuleStep(t.dataset.kind, parseInt(t.dataset.idx,10), 1);
        if (t.matches('[data-action="rule-step-delete"]'))return HSync.deleteRuleStep(t.dataset.kind, parseInt(t.dataset.idx,10));

        // Jobs
        if (t.matches('[data-action="job-new"]'))      return HSync.openJobEditor(null);
        if (t.matches('[data-action="job-edit"]')) {
            const j = HSync.state.jobs.find(x => x.id === parseInt(t.dataset.id, 10));
            return HSync.openJobEditor(j);
        }
        if (t.matches('[data-action="job-duplicate"]')) {
            const j = HSync.state.jobs.find(x => x.id === parseInt(t.dataset.id, 10));
            // Jobs are id-keyed not slug-keyed; clear id + the
            // _seed_id marker so the seeder doesn't think the copy
            // is one of its managed defaults. Also start the copy
            // disabled — duplicating an active cron is a footgun.
            const clone = HSync.cloneForDuplicate(j, ['id']);
            if (clone) {
                if (clone.config && clone.config._seed_id !== undefined) delete clone.config._seed_id;
                if (clone.config && clone.config._seed_label !== undefined) delete clone.config._seed_label;
                clone.enabled = false;
                clone.last_run_at = null;
                clone.last_run_status = null;
                clone.next_run_at = null;
                // Runtime state belongs to the original's run, never to
                // the copy (the server ignores it on save anyway).
                delete clone.run;
                delete clone.run_control;
            }
            return HSync.openJobEditor(clone);
        }
        if (t.matches('[data-action="job-delete"]'))   return HSync.deleteJob(parseInt(t.dataset.id, 10));
        if (t.matches('[data-action="job-run-now"]'))  return HSync.runJobNow(parseInt(t.dataset.id, 10));
        if (t.matches('[data-action="job-stop"]'))     return HSync.stopJob(parseInt(t.dataset.id, 10));
        if (t.matches('[data-action="runner-release"]')) return HSync.releaseRunner();
        if (t.matches('[data-action="job-save"]'))     return HSync.saveJob();
        if (t.matches('[data-action="job-cancel"]'))   return HSync.closeJobEditor();
        if (t.matches('[data-action="jobs-tick-now"]'))    return HSync.tickNow();
        if (t.matches('[data-action="as-health"]'))        return HSync.asHealth();
        if (t.matches('[data-action="as-run-queue"]'))     return HSync.asRunQueue();
        if (t.matches('[data-action="as-purge-past-due"]'))return HSync.asPurgePastDue();

        // Exports
        if (t.matches('[data-action="export-inventory"]')) return HSync.exportInventory(t.dataset.format || 'csv');
        if (t.matches('[data-action="export-catalog"]'))   return HSync.exportCatalog();

        // Tools
        if (t.matches('[data-action="tools-preview"]'))       return HSync.toolsPreview();
        if (t.matches('[data-action="tools-execute"]'))       return HSync.toolsExecute();
        if (t.matches('[data-action="tools-source-count"]'))  return HSync.toolsSourceCount();
        if (t.matches('[data-action="tools-source-delete"]')) return HSync.toolsSourceDelete();
        if (t.matches('[data-action="tools-repair-attrs-preview"]')) return HSync.toolsRepairAttrsPreview();
        if (t.matches('[data-action="tools-repair-attrs-apply"]'))   return HSync.toolsRepairAttrsApply();
        if (t.matches('[data-action="tools-feed-diagnostic"]'))      return HSync.toolsFeedDiagnostic();

        // Config-as-code
        if (t.matches('[data-action="config-export"]'))       return HSync.configExport();
        if (t.matches('[data-action="config-copy"]'))         return HSync.configCopy();
        if (t.matches('[data-action="config-validate"]'))     return HSync.configValidate();
        if (t.matches('[data-action="config-apply"]'))        return HSync.configApply();

        // Per-tab JSON paste modal
        if (t.matches('[data-action="json-paste"]'))          return HSync.openJsonPaste(t.dataset.section || '');
        if (t.matches('[data-action="json-paste-cancel"]'))   return HSync.closeJsonPaste();
        if (t.matches('[data-action="json-paste-validate"]')) return HSync.jsonPasteValidate();
        if (t.matches('[data-action="json-paste-apply"]'))    return HSync.jsonPasteApply();

        // Media
        if (t.matches('[data-action="media-search"]'))             return HSync.loadMedia(1);
        if (t.matches('[data-action="media-rebuild-index"]'))      return HSync.rebuildMediaIndex();
        if (t.matches('[data-action="media-cleanup-preview"]'))    return HSync.previewMediaCleanup();
        if (t.matches('[data-action="media-cleanup-confirm"]'))    return HSync.confirmMediaCleanup(t.dataset.ids || '[]');
        if (t.matches('[data-action="media-page"]'))               return HSync.loadMedia(parseInt(t.dataset.page, 10));
        if (t.matches('[data-action="media-whitelist-toggle"]'))   return HSync.toggleMediaWhitelist(parseInt(t.dataset.id, 10));
        if (t.matches('[data-action="media-delete-one"]'))         return HSync.deleteMediaOne(parseInt(t.dataset.id, 10));
        if (t.matches('[data-action="media-missing-scan"]'))       return HSync.scanMissingImages();
        if (t.matches('[data-action="media-missing-repair"]'))     return HSync.repairMissingImages();
    });

    document.addEventListener('change', function (e) {
        // Simple view.
        const el = e.target;
        if (el.matches('[data-action="toggle-advanced"]')) return HSync.setAdvanced(el.checked, true);
        if (el.matches('[data-action="feed-toggle"]'))     return HSync.feedSetting(parseInt(el.dataset.id, 10), 'enabled', el.checked);
        if (el.matches('[data-action="feed-schedule"]'))   return HSync.feedSetting(parseInt(el.dataset.id, 10), 'schedule', el.value);
        if (el.matches('[data-action="feed-addnew"]'))     return HSync.feedSetting(parseInt(el.dataset.id, 10), 'add_new', el.checked);
        if (el.matches('[data-action="qi-feed"]'))         return HSync.qiSelectFeed(parseInt(el.value, 10));
        if (el.matches('[name="hsync-qi-scope"]'))         return HSync.qiSetScope(el.value);
        if (el.matches('[data-action="qi-cat"]'))          return HSync.qiToggleCat(el.dataset.value, el.checked);
        if (el.matches('[data-action="qi-sub"]'))          return HSync.qiToggleSub(el.dataset.cat, el.dataset.value, el.checked);
        if (el.matches('[data-action="cat-feed"]'))        return HSync.openCatalog(parseInt(el.value, 10), true);
        if (el.matches('[name="hsync-cat-scope"]'))        return HSync.catSetScope(el.value);
        if (el.matches('[data-action="cat-pick"]'))        return HSync.catPick(el.dataset.cat || '', el.dataset.value, el.checked);
        if (el.matches('[data-action="cat-margin"], [data-action="cat-default"]')) return HSync.catMarginChanged(el, true);

        if (e.target.matches('[data-control="mappings-filter"]')) HSync.loadMappings();
        if (e.target.matches('[data-field="run-source"]'))        HSync.populateRunMappings();
        if (e.target.matches('[data-field="rule-sel-mode"]')) {
            // Capture current picker state into editingRule before
            // re-rendering so a user who picks categories then flips
            // to "ids" doesn't lose the work on flip-back.
            HSync.captureRuleFilterState();
            HSync.state.editingRule.selection.mode = e.target.value;
            HSync.renderRuleEditor();
        }
        if (e.target.matches('[data-field="job-type"]'))          { HSync.state.editingJob.runnable_type = e.target.value; HSync.renderJobEditor(); }
        if (e.target.matches('[data-field="job-ref"]'))           { HSync.state.editingJob.runnable_ref  = e.target.value; if (HSync.state.editingJob.runnable_type === 'source.import') HSync.loadSourceConfigs(e.target.value).then(() => HSync.renderJobEditor()); }
        // Source-config flavor changed → toggle markup-rules visibility
        // and refresh per-flavor field suggestions on the rule rows.
        if (e.target.matches('[name="flavor"]')) {
            const form = e.target.closest('form.hsync-config-form');
            if (form) HSync.applyMarkupFlavorVisibility(form);
        }
        if (e.target.matches('[data-action="media-toggle"]'))     HSync.toggleMediaSelection(parseInt(e.target.dataset.id, 10));
        if (e.target.matches('[data-action="mapping-toggle-json"]')) HSync.toggleMappingJson(e.target.checked);
        if (e.target.matches('[data-action="mapping-insert-snippet"]')) {
            const sel = e.target;
            const idx = parseInt(sel.value, 10);
            sel.value = '';
            if (!Number.isNaN(idx)) HSync.insertMappingSnippet(idx);
        }
        // Keep markup-rules' hidden JSON synced as the operator types
        // / picks operators. Listening on `change` (covers selects +
        // blur for inputs) is enough — collectConfig also runs at save.
        if (e.target.matches('[data-rule-field]')) {
            const region = e.target.closest('[data-markup-region]');
            if (region) HSync.syncMarkupRules(region);
        }

        // Custom row key rename fires on commit (blur), not on every keystroke
        if (e.target.matches('[data-custom-key]')) {
            const idx = parseInt(e.target.dataset.customKey, 10);
            HSync.renameCustomMappingKey(idx, e.target.value);
        }
    });

    document.addEventListener('input', function (e) {
        if (e.target.matches('[data-action="qi-search"]')) return HSync.qiSearch(e.target.value);
        if (e.target.matches('[data-action="cat-search"]')) return HSync.catSearch(e.target.value);
        if (e.target.matches('[data-action="cat-margin"], [data-action="cat-default"]')) return HSync.catMarginChanged(e.target, false);
        // Live-sync spine value inputs into state.
        if (e.target.matches('[data-mapping-key]')) {
            HSync.state.mappingValues[e.target.dataset.mappingKey] = e.target.value;
        }
        // Live-sync custom row VALUE inputs (key inputs sync on change).
        if (e.target.matches('[data-custom-value]')) {
            const idx = parseInt(e.target.dataset.customValue, 10);
            const key = HSync.state.mappingCustomKeys[idx];
            if (key) HSync.state.mappingValues[key] = e.target.value;
        }
        // Live cron-to-Italian readout under the job-cron input.
        if (e.target.matches('[data-field="job-cron"]')) {
            const readout = document.querySelector('[data-region="job-cron-readout"]');
            if (readout) {
                const t = HSync.describeCron(e.target.value);
                readout.textContent = t || 'Espressione non riconosciuta — controlla i 5 campi (min ora dom mese dow).';
            }
        }
    });

    document.addEventListener('focusin', function (e) {
        if (e.target.matches('[data-mapping-key]') || e.target.matches('[data-custom-value]')) {
            HSync.onMappingValueFocus(e.target);
        }
    });

    document.addEventListener('keydown', function (e) {
        // Enter inside the media filename input triggers a search.
        if (e.target.matches('[data-field="media-filename"]') && e.key === 'Enter') {
            e.preventDefault();
            HSync.loadMedia(1);
        }
    });

    // ─── Media ────────────────────────────────────────────────────

    HSync.state.media = { items: [], page: 1, perPage: 60, total: 0, totalPages: 1, selected: new Set() };

    HSync.loadMedia = function (page) {
        const region = $('[data-region="media-list"]');
        const filename  = ($('[data-field="media-filename"]')  || {}).value || '';
        const usage     = ($('[data-field="media-usage"]')     || {}).value || 'all';
        const whitelist = ($('[data-field="media-whitelist"]') || {}).value || 'all';
        const target = page || HSync.state.media.page || 1;
        region.innerHTML = '<p class="hsync-loading">Caricamento media…</p>';
        return HSync.ajax('media_query', {
            filename: filename, usage: usage, whitelist: whitelist,
            page: target, per_page: HSync.state.media.perPage,
        }).then(data => {
            HSync.state.media.items       = data.items || [];
            HSync.state.media.page        = data.page || 1;
            HSync.state.media.perPage     = data.per_page || 60;
            HSync.state.media.total       = data.total || 0;
            HSync.state.media.totalPages  = data.total_pages || 1;
            HSync.renderMedia();
            HSync.renderMediaPager();
        }).catch(e => {
            region.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        });
    };

    HSync.renderMedia = function () {
        const region = $('[data-region="media-list"]');
        if (!HSync.state.media.items.length) {
            region.innerHTML = '<div class="hsync-empty">Nessun media trovato con i filtri correnti.</div>';
            return;
        }
        const sel = HSync.state.media.selected;
        const cards = HSync.state.media.items.map(it => {
            const usage = it.usage || [];
            const isMapped  = usage.length > 0;
            const isWl      = !!it.is_whitelisted;
            const usageStr  = usage.length
                ? usage.slice(0, 2).map(u => esc(u.role) + ' #' + u.pid + (u.sku ? ' (' + esc(u.sku) + ')' : '')).join(' · ')
                  + (usage.length > 2 ? ' +' + (usage.length - 2) : '')
                : 'orfano';
            const badges = ''
                + (isMapped ? '<span class="hsync-media-badge is-mapped">used</span>' : '<span class="hsync-media-badge is-orphan">orphan</span>')
                + (isWl     ? '<span class="hsync-media-badge is-whitelist">WL</span>' : '');
            const checked = sel.has(it.id) ? ' checked' : '';
            return ''
                + '<div class="hsync-media-card' + (sel.has(it.id) ? ' is-selected' : '') + '" data-id="' + it.id + '">'
                +   '<label class="hsync-media-checkbox"><input type="checkbox" data-action="media-toggle" data-id="' + it.id + '"' + checked + '></label>'
                +   '<div class="hsync-media-badges">' + badges + '</div>'
                +   '<div class="hsync-media-thumb" style="background-image:url(\'' + esc(it.thumbnail_url || it.url) + '\')"></div>'
                +   '<div class="hsync-media-meta">'
                +     '<div class="hsync-media-name" title="' + esc(it.filename) + '">' + esc(it.filename || ('#' + it.id)) + '</div>'
                +     '<div class="hsync-media-size">' + esc(it.filesize_human || '—') + '</div>'
                +     '<div class="hsync-media-size">' + esc(usageStr) + '</div>'
                +     '<div class="hsync-actions" style="margin-top:6px;">'
                +       '<button class="button button-small" data-action="media-whitelist-toggle" data-id="' + it.id + '">'
                +         (isWl ? 'Rimuovi WL' : 'Aggiungi WL')
                +       '</button>'
                +       (isMapped
                          ? ''
                          : '<button class="button button-small" data-action="media-delete-one" data-id="' + it.id + '">Elimina</button>')
                +     '</div>'
                +   '</div>'
                + '</div>';
        }).join('');
        region.innerHTML = '<div class="hsync-media-grid">' + cards + '</div>';
    };

    HSync.renderMediaPager = function () {
        const pager = $('[data-region="media-pager"]');
        const m = HSync.state.media;
        if (m.totalPages <= 1) {
            pager.innerHTML = '<span class="hsync-muted">' + m.total + ' risultati</span>';
            return;
        }
        const prev = m.page > 1
            ? '<button class="button" data-action="media-page" data-page="' + (m.page - 1) + '">←</button>'
            : '';
        const next = m.page < m.totalPages
            ? '<button class="button" data-action="media-page" data-page="' + (m.page + 1) + '">→</button>'
            : '';
        pager.innerHTML = prev
            + ' <span class="hsync-muted">Pagina ' + m.page + ' di ' + m.totalPages + ' · ' + m.total + ' risultati</span> '
            + next;
    };

    HSync.toggleMediaSelection = function (id) {
        const sel = HSync.state.media.selected;
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
        const card = document.querySelector('.hsync-media-card[data-id="' + id + '"]');
        if (card) card.classList.toggle('is-selected', sel.has(id));
    };

    HSync.toggleMediaWhitelist = async function (id) {
        const item = HSync.state.media.items.find(x => x.id === id);
        if (!item) return;
        try {
            if (item.is_whitelisted) {
                await HSync.ajax('media_whitelist_remove', { attachment_id: id });
            } else {
                const reason = prompt('Motivo della whitelist (opzionale):', '') || '';
                await HSync.ajax('media_whitelist_add', { attachment_id: id, reason: reason });
            }
            await HSync.loadMedia(HSync.state.media.page);
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.deleteMediaOne = async function (id) {
        if (!confirm('Eliminare definitivamente l\'attachment #' + id + ' dalla media library?\n\nFile + thumbnail saranno rimossi dal disco.')) return;
        try {
            const data = await HSync.ajax('media_cleanup_apply', { ids: [id] });
            if ((data.errors || {})[id]) {
                alert('Eliminazione bloccata: ' + data.errors[id]);
            } else if (data.skipped_whitelist?.includes(id)) {
                alert('Skipped: attachment è in whitelist.');
            } else {
                alert('Eliminato. Liberati ' + data.freed_human + '.');
            }
            HSync.loadMedia(HSync.state.media.page);
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.rebuildMediaIndex = async function () {
        try {
            const data = await HSync.ajax('media_index_rebuild', {});
            alert('Indice ricostruito. ' + data.attachments_indexed + ' attachment con utilizzo registrato.');
            HSync.loadMedia(HSync.state.media.page);
        } catch (e) { alert('Errore: ' + e.message); }
    };

    HSync.previewMediaCleanup = async function () {
        const out = $('[data-region="media-cleanup-output"]');
        out.innerHTML = '<p class="hsync-loading">Calcolo orfani…</p>';
        try {
            const data = await HSync.ajax('media_cleanup_preview', {});
            const idsJson = JSON.stringify(data.to_delete_ids || []);
            const wlRows = (data.whitelist_details || []).slice(0, 50).map(w =>
                '<tr><td>#' + w.id + '</td><td>' + esc(w.reason || '—') + '</td><td><a href="' + esc(w.url) + '" target="_blank">link</a></td></tr>'
            ).join('');
            out.innerHTML = ''
                + '<div class="hsync-summary" style="grid-template-columns:repeat(3,1fr);">'
                +   '<div class="hsync-stat"><div class="hsync-stat-num">' + data.total_matched + '</div><div class="hsync-stat-label">Orfani totali</div></div>'
                +   '<div class="hsync-stat is-bad"><div class="hsync-stat-num">' + data.to_delete_count + '</div><div class="hsync-stat-label">Da eliminare</div></div>'
                +   '<div class="hsync-stat"><div class="hsync-stat-num">' + data.whitelisted_count + '</div><div class="hsync-stat-label">Protetti (WL)</div></div>'
                + '</div>'
                + (wlRows ? '<details><summary>Whitelist esclusi (' + data.whitelisted_count + ')</summary>'
                    + '<table class="hsync-table"><thead><tr><th>ID</th><th>Reason</th><th>URL</th></tr></thead><tbody>'
                    + wlRows + '</tbody></table></details>' : '')
                + '<div class="hsync-actions">'
                +   '<button class="button button-primary" data-action="media-cleanup-confirm" data-ids=\'' + idsJson + '\'>'
                +     'Elimina ' + data.to_delete_count + ' orfani'
                +   '</button>'
                + '</div>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    /**
     * Read-only scan: how many products render without a cover image,
     * which ones, and where they came from. No feed, no writes — the
     * operator gets a number before committing to anything.
     */
    HSync.scanMissingImages = async function () {
        const out = $('[data-region="media-missing-output"]');
        out.innerHTML = '<p class="hsync-loading">Analisi del catalogo…</p>';
        try {
            const data = await HSync.ajax('media_missing_scan', { sample: 50 });
            HSync.missingImagesJobs = data.jobs || [];

            if (!data.total) {
                out.innerHTML = '<div class="hsync-summary" style="grid-template-columns:1fr;">'
                    + '<div class="hsync-stat is-good"><div class="hsync-stat-num">0</div>'
                    + '<div class="hsync-stat-label">Tutti i prodotti hanno una copertina</div></div></div>';
                return;
            }

            // Provenance histogram. This is the triage: a product with
            // no import source was made by hand and NO feed run will
            // ever repair it, so saying "47 broken" without the split
            // would set the wrong expectation for the repair.
            const bySource = data.by_source || {};
            const sourceRows = Object.keys(bySource).map(k =>
                '<tr><td>' + esc(k) + '</td><td>' + bySource[k] + '</td></tr>'
            ).join('');

            const sampleRows = (data.sample || []).map(p =>
                '<tr>'
                + '<td>' + (p.edit_url
                    ? '<a href="' + esc(p.edit_url) + '" target="_blank">#' + p.id + '</a>'
                    : '#' + p.id) + '</td>'
                + '<td>' + esc(p.sku || '—') + '</td>'
                + '<td>' + esc(p.name || '—') + '</td>'
                + '<td>' + esc(p.source || '(nessuna)') + '</td>'
                + '<td>' + esc(p.status || '') + '</td>'
                + '</tr>'
            ).join('');

            // The repair needs a feed. Reuse a configured import job so
            // it writes with the SAME source + mapping + pipeline as the
            // real sync, instead of asking the operator to re-pick and
            // risk a different combination.
            const jobs = HSync.missingImagesJobs;
            let repairUi;
            if (!jobs.length) {
                repairUi = '<div class="hsync-warning">'
                    + 'Nessun job di import configurato: la riparazione ha bisogno di una '
                    + 'sorgente per sapere da dove ri-scaricare le immagini. Creane uno nel '
                    + 'tab <strong>Automatizza</strong>, poi torna qui.'
                    + '</div>';
            } else {
                const opts = jobs.map(j =>
                    '<option value="' + j.id + '"' + (j.id === data.default_job_id ? ' selected' : '') + '>'
                    + esc(j.ref) + (j.enabled ? '' : ' (disattivo)') + '</option>'
                ).join('');
                repairUi = '<div class="hsync-actions">'
                    + '<label>Usa la configurazione di '
                    + '<select data-field="media-missing-job">' + opts + '</select>'
                    + '</label>'
                    + '<button class="button button-primary" data-action="media-missing-repair">'
                    + 'Ripara dal feed</button>'
                    + '</div>'
                    + '<p class="hsync-muted">'
                    + 'Vengono ri-scaricate solo le immagini dei prodotti elencati sopra che '
                    + 'esistono nel feed scelto e per cui il feed ha un URL valido. Prezzi, '
                    + 'stock, varianti e modifiche manuali non vengono toccati.'
                    + '</p>';
            }

            out.innerHTML = ''
                + '<div class="hsync-summary" style="grid-template-columns:repeat(2,1fr);">'
                +   '<div class="hsync-stat is-bad"><div class="hsync-stat-num">' + data.total + '</div>'
                +     '<div class="hsync-stat-label">Prodotti senza copertina</div></div>'
                +   '<div class="hsync-stat"><div class="hsync-stat-num">' + Object.keys(bySource).length + '</div>'
                +     '<div class="hsync-stat-label">Sorgenti coinvolte</div></div>'
                + '</div>'
                + (sourceRows
                    ? '<table class="hsync-table"><thead><tr><th>Sorgente</th><th>Prodotti</th></tr></thead>'
                      + '<tbody>' + sourceRows + '</tbody></table>'
                    : '')
                + '<details><summary>Primi ' + (data.sample || []).length + ' prodotti'
                +   (data.sample_capped ? ' (di ' + data.total + ')' : '') + '</summary>'
                +   '<table class="hsync-table"><thead><tr>'
                +     '<th>ID</th><th>SKU</th><th>Nome</th><th>Sorgente</th><th>Stato</th>'
                +   '</tr></thead><tbody>' + sampleRows + '</tbody></table>'
                + '</details>'
                + repairUi;
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    /**
     * Resolve the chosen job into run parameters, then drive the
     * ORDINARY import tick loop with heal_media forced on. Nothing
     * bespoke executes: same ImportRunner, same cursor/resume, same
     * entry in Storico — so a repair that dies half-way resumes like
     * any other run.
     */
    HSync.repairMissingImages = async function () {
        const sel = $('[data-field="media-missing-job"]');
        const jobId = sel ? parseInt(sel.value, 10) : 0;
        if (!jobId) { alert('Scegli una configurazione di import.'); return; }

        const out = $('[data-region="media-missing-output"]');
        if (!confirm(
            'Riparazione immagini.\n\n' +
            'Per i prodotti senza copertina presenti nel feed verranno ri-scaricate ' +
            'le immagini e riagganciate al prodotto.\n\n' +
            'Prezzi, stock, varianti e ID prodotto non vengono toccati. ' +
            'I prodotti che il feed non conosce restano invariati.\n\n' +
            'Procedere?'
        )) return;

        let params;
        try {
            params = await HSync.ajax('media_missing_repair_params', { job_id: jobId });
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
            return;
        }

        // Render the run report inside THIS card — the operator started
        // here and shouldn't be thrown into another tab to watch it.
        // Deliberately NOT restored afterwards: a failed tick leaves a
        // "Riprendi da qui" button in this card, and resumeRun must
        // render where that button lives. runNow() re-claims the
        // selector when the operator next starts a run from Importa.
        HSync.runOutputSel = '[data-region="media-missing-output"]';
        HSync.runListener  = null;
        await HSync.runImportTicked(
            params.source_id,
            params.config_slug,
            {},                 // config comes from the saved slug
            params.options,
            false,              // not a dry run: the scan was the preview
            null,
            0,                  // uncapped ticks — a repair must run to completion
        );
    };

    HSync.confirmMediaCleanup = async function (idsJson) {
        let ids;
        try { ids = JSON.parse(idsJson); } catch (e) { alert('Payload corrotto.'); return; }
        if (!Array.isArray(ids) || !ids.length) { alert('Nessun ID da eliminare.'); return; }
        if (!confirm('Eliminare definitivamente ' + ids.length + ' attachment? L\'operazione non è reversibile.')) return;
        const out = $('[data-region="media-cleanup-output"]');
        out.innerHTML = '<p class="hsync-loading">Eliminazione in corso…</p>';
        try {
            const data = await HSync.ajax('media_cleanup_apply', { ids: ids });
            const errCount = Object.keys(data.errors || {}).length;
            out.innerHTML = ''
                + '<div class="hsync-summary" style="grid-template-columns:repeat(3,1fr);">'
                +   '<div class="hsync-stat is-good"><div class="hsync-stat-num">' + (data.deleted || []).length + '</div><div class="hsync-stat-label">Eliminati</div></div>'
                +   '<div class="hsync-stat"><div class="hsync-stat-num">' + (data.skipped_whitelist || []).length + '</div><div class="hsync-stat-label">Saltati WL</div></div>'
                +   '<div class="hsync-stat ' + (errCount > 0 ? 'is-bad' : '') + '"><div class="hsync-stat-num">' + errCount + '</div><div class="hsync-stat-label">Errori</div></div>'
                + '</div>'
                + '<p>Liberati ' + esc(data.freed_human || '0 B') + ' dal disco.</p>';
            HSync.loadMedia(1);
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    // ─── Tools / Nuclear Cleanup ─────────────────────────────────

    HSync.collectToolsTargets = function () {
        const targets = {};
        $$('[data-tools-target]').forEach(el => {
            if (el.checked) targets[el.dataset.toolsTarget] = true;
        });
        return targets;
    };

    HSync.toolsPreview = async function () {
        const targets = HSync.collectToolsTargets();
        const out = $('[data-region="tools-output"]');
        const exec = $('[data-action="tools-execute"]');
        if (!Object.keys(targets).length) {
            out.innerHTML = '<div class="hsync-warning">Seleziona almeno un target.</div>';
            exec.disabled = true;
            return;
        }
        out.innerHTML = '<p class="hsync-loading">Conteggio in corso…</p>';
        try {
            const data = await HSync.ajax('nuclear_preview', { targets: targets });
            const rows = Object.entries(data.preview || {}).map(([k, v]) => ''
                + '<tr>'
                +   '<td><strong>' + esc(k) + '</strong></td>'
                +   '<td>' + (v.count || 0) + '</td>'
                +   '<td>' + esc(v.label || '') + '</td>'
                + '</tr>'
            ).join('');
            out.innerHTML = rows
                ? '<table class="hsync-table"><thead><tr><th>Target</th><th>Count</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>'
                : '<div class="hsync-empty">Niente da eliminare per i target scelti.</div>';
            exec.disabled = !rows;
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
            exec.disabled = true;
        }
    };

    HSync.toolsExecute = async function () {
        const targets = HSync.collectToolsTargets();
        if (!Object.keys(targets).length) return;
        const labels = Object.keys(targets).join(', ');
        const phrase = 'ELIMINA';
        const typed = prompt(
            'Stai per ELIMINARE definitivamente: ' + labels + '.\n\n'
            + 'L\'operazione NON è reversibile. Ho già fatto un backup del DB e dei file.\n\n'
            + 'Per confermare, digita ' + phrase + ':',
            '',
        );
        if (typed !== phrase) {
            alert('Annullato.');
            return;
        }
        const out = $('[data-region="tools-output"]');
        out.innerHTML = '<p class="hsync-loading">Cleanup in corso… (può richiedere parecchi minuti su store grandi)</p>';
        try {
            const data = await HSync.ajax('nuclear_execute', { targets: targets, confirm: '1' });
            const rows = Object.entries(data.results || {}).map(([k, v]) => ''
                + '<tr><td><strong>' + esc(k) + '</strong></td><td><pre class="hsync-pre">'
                + esc(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)) + '</pre></td></tr>'
            ).join('');
            out.innerHTML = ''
                + '<div class="hsync-summary-foot">Cleanup completato in ' + (data.duration_s || 0) + 's.</div>'
                + (rows
                    ? '<table class="hsync-table"><thead><tr><th>Target</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>'
                    : '');
            $('[data-action="tools-execute"]').disabled = true;
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.toolsSourceCount = async function () {
        const source = ($('[data-field="tools-source"]') || {}).value;
        const out = $('[data-region="tools-source-output"]');
        if (!source) { out.innerHTML = '<div class="hsync-warning">Scegli una sorgente.</div>'; return; }
        out.innerHTML = '<p class="hsync-loading">Conteggio…</p>';
        try {
            const data = await HSync.ajax('nuclear_count_by_source', { source: source });
            out.innerHTML = '<p><strong>' + data.count + '</strong> prodotti taggati come <code>'
                + esc(data.source) + '</code>.</p>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.toolsSourceDelete = async function () {
        const source = ($('[data-field="tools-source"]') || {}).value;
        if (!source) { alert('Scegli una sorgente.'); return; }
        const phrase = 'ELIMINA ' + source.toUpperCase();
        const typed = prompt(
            'Eliminerai TUTTI i prodotti importati da "' + source + '".\n\n'
            + 'Per confermare, digita ' + phrase + ':',
            '',
        );
        if (typed !== phrase) { alert('Annullato.'); return; }
        const out = $('[data-region="tools-source-output"]');
        out.innerHTML = '<p class="hsync-loading">Eliminazione in corso…</p>';
        try {
            const data = await HSync.ajax('nuclear_delete_by_source', { source: source, confirm: '1' });
            out.innerHTML = '<p>Eliminati <strong>' + data.deleted + '</strong> parent + <strong>'
                + data.variations + '</strong> varianti.</p>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.toolsRepairAttrsPreview = async function () {
        const out = $('[data-region="tools-repair-attrs-output"]');
        const apply = $('[data-action="tools-repair-attrs-apply"]');
        out.innerHTML = '<p class="hsync-loading">Scansione varianti…</p>';
        if (apply) apply.disabled = true;
        try {
            const d = await HSync.ajax('repair_variation_attrs_preview', {});
            let html = '<div class="hsync-tools-preview">';
            html += '<p><strong>' + (d.scanned || 0) + '</strong> righe meta scansionate · '
                  + '<strong>' + (d.already_ok || 0) + '</strong> già corrette · '
                  + '<strong>' + (d.broken || 0) + '</strong> da riparare · '
                  + '<strong>' + (d.missing_term || 0) + '</strong> senza termine corrispondente</p>';
            if (d.broken > 0 && d.samples && d.samples.length) {
                html += '<details open><summary>Campioni (primi ' + d.samples.length + ')</summary>';
                html += '<table class="hsync-table"><thead><tr><th>VID</th><th>Parent</th><th>SKU</th><th>Tassonomia</th><th>Attuale</th><th>→ Corretto</th></tr></thead><tbody>';
                d.samples.forEach(function (s) {
                    html += '<tr><td>' + s.vid + '</td><td>' + s.parent_id + '</td><td>'
                          + esc(s.sku) + '</td><td><code>' + esc(s.taxonomy) + '</code></td><td><code>'
                          + esc(s.current) + '</code></td><td><code>' + esc(s.correct) + '</code></td></tr>';
                });
                html += '</tbody></table></details>';
                if (apply) apply.disabled = false;
            } else if (d.broken === 0) {
                html += '<p class="hsync-ok">Nessuna riparazione necessaria.</p>';
            }
            html += '</div>';
            out.innerHTML = html;
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.toolsFeedDiagnostic = async function () {
        const slug = ($('[data-field="diag-config-slug"]') || {}).value || '';
        const size = parseInt(($('[data-field="diag-sample-size"]') || {}).value || '50', 10);
        const out = $('[data-region="tools-feed-diagnostic-output"]');
        if (!slug) { out.innerHTML = '<div class="hsync-warning">Inserisci uno slug config.</div>'; return; }
        out.innerHTML = '<p class="hsync-loading">Fetch + confronto in corso…</p>';
        try {
            const d = await HSync.ajax('feed_diagnostic', { config_slug: slug, sample_size: String(size) });
            if (d.error) { out.innerHTML = '<div class="hsync-error">' + esc(d.error) + '</div>'; return; }
            let html = '<div class="hsync-tools-preview">';
            html += '<h4>Feed</h4>';
            html += '<ul>'
                  + '<li><strong>' + d.feed_total_rows + '</strong> righe totali dall\'upstream</li>'
                  + '<li><strong>' + d.feed_distinct_skus + '</strong> SKU distinti dopo grouping</li>'
                  + '<li>' + d.feed_rows_without_sku + ' righe senza SKU (scartate dal grouper)</li>'
                  + '<li>' + d.feed_rows_without_size + ' righe senza size_eu (scartate dal grouper)</li>'
                  + '</ul>';
            html += '<h4>Campione di righe grezze (prime 2)</h4>';
            html += '<pre style="background:#f6f7f7;padding:10px;border-radius:4px;overflow:auto;max-height:240px;font-size:11px;">'
                  + esc(JSON.stringify(d.sample_raw_rows, null, 2)) + '</pre>';
            html += '<h4>Confronto sui primi ' + d.sample_size + ' SKU del feed</h4>';
            html += '<ul>'
                  + '<li><strong>' + d.perfect + '</strong> prodotti perfettamente allineati</li>'
                  + '<li><strong>' + d.mismatches.length + '</strong> prodotti con disallineamento (mostrati i 25 peggiori)</li>'
                  + '<li><strong>' + d.not_in_woo + '</strong> SKU nel feed ma NON in Woo (mai creati)</li>'
                  + '<li><strong>' + d.missing_in_woo_total + '</strong> taglie totali presenti nel feed ma mancanti in Woo</li>'
                  + '<li><strong>' + d.extra_in_woo_total + '</strong> taglie in Woo ma assenti dal feed (size discontinuate)</li>'
                  + '</ul>';
            if (d.mismatches.length) {
                html += '<table class="hsync-table"><thead><tr><th>SKU</th><th>Feed</th><th>Woo</th><th>Δ</th><th>Mancanti in Woo</th><th>Extra in Woo</th></tr></thead><tbody>';
                d.mismatches.forEach(function (m) {
                    html += '<tr>'
                          + '<td><code>' + esc(m.sku) + '</code></td>'
                          + '<td>' + m.feed_sizes + '</td>'
                          + '<td>' + m.woo_variations + '</td>'
                          + '<td>' + (m.gap > 0 ? '+' + m.gap : m.gap) + '</td>'
                          + '<td>' + esc(m.missing_in_woo.join(', ')) + '</td>'
                          + '<td>' + esc(m.extra_in_woo.join(', ')) + '</td>'
                          + '</tr>';
                });
                html += '</tbody></table>';
            }
            html += '</div>';
            out.innerHTML = html;
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    HSync.toolsRepairAttrsApply = async function () {
        if (!confirm('Riscrivere i meta delle varianti rotte? Idempotente, ma fai un backup DB se preferisci.')) return;
        const out = $('[data-region="tools-repair-attrs-output"]');
        const apply = $('[data-action="tools-repair-attrs-apply"]');
        out.innerHTML = '<p class="hsync-loading">Riparazione in corso…</p>';
        if (apply) apply.disabled = true;
        try {
            const d = await HSync.ajax('repair_variation_attrs_apply', { confirm: '1' });
            out.innerHTML = '<p class="hsync-ok">Riparate <strong>' + (d.repaired || 0) + '</strong> varianti su '
                          + '<strong>' + (d.parents_touched || 0) + '</strong> prodotti padre in '
                          + (d.duration_s || 0) + 's.'
                          + (d.missing_term ? ' (' + d.missing_term + ' meta senza termine, lasciati invariati)' : '')
                          + '</p>';
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    // ─── Config-as-code (project export / validate / apply) ──────

    HSync.state.lastValidatedProject = null;

    HSync.configExport = async function () {
        const region = $('[data-region="config-export-output"]');
        const ta     = $('[data-field="config-export-json"]');
        try {
            const data = await HSync.ajax('project_export', {});
            const json = JSON.stringify(data.project || {}, null, 2);
            ta.value = json;
            region.classList.remove('is-hidden');
        } catch (e) {
            alert('Errore export: ' + e.message);
        }
    };

    HSync.configCopy = async function () {
        const ta = $('[data-field="config-export-json"]');
        if (!ta || !ta.value) {
            // Force an export first if the textarea is empty.
            await HSync.configExport();
        }
        try {
            await navigator.clipboard.writeText(ta.value);
            alert('Copiato negli appunti.');
        } catch (e) {
            ta.select();
            document.execCommand('copy');
            alert('Copiato (fallback).');
        }
    };

    HSync.configValidate = async function () {
        const out  = $('[data-region="config-apply-output"]');
        const ta   = $('[data-field="config-apply-json"]');
        const apply = $('[data-action="config-apply"]');
        const raw  = (ta.value || '').trim();
        if (raw === '') {
            out.innerHTML = '<div class="hsync-warning">Incolla un JSON prima di validare.</div>';
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">JSON non parsabile: ' + esc(e.message) + '</div>';
            HSync.state.lastValidatedProject = null;
            apply.disabled = true;
            return;
        }
        out.innerHTML = '<p class="hsync-loading">Validazione…</p>';
        try {
            const data = await HSync.ajax('project_validate', { project: parsed });
            if (!data.ok) {
                out.innerHTML = '<div class="hsync-error"><strong>'
                    + (data.errors || []).length + ' errore/i</strong><ul>'
                    + (data.errors || []).map(e => '<li><code>' + esc(e) + '</code></li>').join('')
                    + '</ul></div>';
                HSync.state.lastValidatedProject = null;
                apply.disabled = true;
                return;
            }
            HSync.state.lastValidatedProject = parsed;
            apply.disabled = false;
            const diffSections = data.diff || {};
            const sectionRows = Object.entries(diffSections).map(([section, entries]) => {
                const rows = Object.entries(entries || {}).map(([slug, info]) =>
                    '<tr><td><code>' + esc(slug) + '</code></td>'
                    + '<td><span class="hsync-status hsync-status--' + (info.op === 'create' ? 'ok' : 'info') + '">'
                    + esc(info.op) + '</span></td>'
                    + '<td><small class="hsync-muted">' + esc(JSON.stringify(info)) + '</small></td></tr>',
                ).join('');
                return rows
                    ? '<h3>' + esc(section) + ' <small class="hsync-muted">(' + Object.keys(entries).length + ')</small></h3>'
                      + '<table class="hsync-table"><thead><tr><th>slug</th><th>op</th><th>info</th></tr></thead><tbody>'
                      + rows + '</tbody></table>'
                    : '';
            }).filter(Boolean).join('');
            out.innerHTML = '<div class="hsync-summary-foot">JSON valido — pronto per applicare.</div>'
                + (sectionRows || '<p class="hsync-muted">Nessuna entità nel documento.</p>');
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
            HSync.state.lastValidatedProject = null;
            apply.disabled = true;
        }
    };

    HSync.configApply = async function () {
        const out   = $('[data-region="config-apply-output"]');
        const prune = !!($('[data-field="config-prune"]') || {}).checked;
        const project = HSync.state.lastValidatedProject;
        if (!project) {
            out.innerHTML = '<div class="hsync-warning">Esegui prima Valida.</div>';
            return;
        }
        const confirmMsg = prune
            ? 'Modalità PRUNE attiva — le entità non presenti nel JSON verranno ELIMINATE. Continuare?'
            : 'Applicare il JSON al database? Le entità non presenti vengono lasciate intatte.';
        if (! confirm(confirmMsg)) return;

        out.innerHTML = '<p class="hsync-loading">Applicazione…</p>';
        try {
            const data = await HSync.ajax('project_apply', {
                project: project,
                prune:   prune ? '1' : '',
            });
            const counts = data.counts || {};
            const rows = Object.entries(counts).map(([section, c]) =>
                '<tr><td><strong>' + esc(section) + '</strong></td>'
                + '<td>' + (c.created || 0) + '</td>'
                + '<td>' + (c.updated || 0) + '</td>'
                + '<td>' + (c.deleted || 0) + '</td></tr>',
            ).join('');
            out.innerHTML = '<div class="hsync-summary-foot">Applicato ✓</div>'
                + '<table class="hsync-table"><thead><tr><th>Sezione</th><th>Creati</th><th>Aggiornati</th><th>Eliminati</th></tr></thead>'
                + '<tbody>' + rows + '</tbody></table>';
            // Refresh cockpit + stato per riflettere le entità nuove.
            HSync.refreshCockpit();
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    // ─── Per-tab JSON paste modal ────────────────────────────────
    //
    // Tabs (Connetti / Mappa / Componi / Regole / Automatizza) all
    // expose a "📋 Importa JSON" button that opens this modal. The
    // pasted JSON is wrapped into a minimal project doc and routed
    // through the existing project_validate + project_apply
    // endpoints. Three accepted shapes:
    //   1. Single entity     { slug: '...', ... }            → wrapped as [entity]
    //   2. Array of entities [ { ... }, { ... } ]            → wrapped as is
    //   3. Full project doc  { $schema:'…', mappings:[...] } → passed through (only
    //                                                         the active section is
    //                                                         applied, others ignored)

    HSync.JSON_PASTE_LABELS = {
        sources:   'Source-config',
        mappings:  'Mappatura',
        pipelines: 'Flusso (pipeline)',
        rules:     'Regola',
        jobs:      'Automazione',
    };

    HSync.state.jsonPaste = { section: '', validatedDoc: null };

    HSync.openJsonPaste = function (section) {
        if (!HSync.JSON_PASTE_LABELS[section]) return;
        HSync.state.jsonPaste.section = section;
        HSync.state.jsonPaste.validatedDoc = null;
        const modal = $('[data-region="json-paste-modal"]');
        $('[data-field="json-paste-section-label"]').textContent = HSync.JSON_PASTE_LABELS[section];
        $('[data-field="json-paste-input"]').value = '';
        $('[data-region="json-paste-output"]').innerHTML = '';
        $('[data-action="json-paste-apply"]').disabled = true;
        modal.classList.remove('is-hidden');
    };

    HSync.closeJsonPaste = function () {
        $('[data-region="json-paste-modal"]').classList.add('is-hidden');
        HSync.state.jsonPaste.section = '';
        HSync.state.jsonPaste.validatedDoc = null;
    };

    /**
     * Wrap whatever the user pasted into a minimal project doc whose
     * only populated section is the active one. Other sections in the
     * full project doc shape are ignored — this is a per-tab importer,
     * not a project-level apply (use the Config tab for that).
     */
    HSync.buildProjectFromPaste = function (raw, section) {
        const doc = {
            '$schema': 'hive-sync/project/v1',
            version:   1,
            sources:   [], mappings: [], pipelines: [], rules: [], jobs: [],
        };
        let entries;
        if (Array.isArray(raw)) {
            entries = raw;
        } else if (raw && typeof raw === 'object' && Array.isArray(raw[section])) {
            // Full project doc — extract only the relevant section.
            entries = raw[section];
        } else if (raw && typeof raw === 'object') {
            // Single entity object.
            entries = [raw];
        } else {
            entries = [];
        }
        doc[section] = entries;
        return doc;
    };

    HSync.jsonPasteValidate = async function () {
        const section = HSync.state.jsonPaste.section;
        if (!section) return;
        const out      = $('[data-region="json-paste-output"]');
        const ta       = $('[data-field="json-paste-input"]');
        const applyBtn = $('[data-action="json-paste-apply"]');
        const raw      = (ta.value || '').trim();
        if (!raw) {
            out.innerHTML = '<div class="hsync-warning">Incolla un JSON prima di validare.</div>';
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">JSON non parsabile: ' + esc(e.message) + '</div>';
            applyBtn.disabled = true;
            HSync.state.jsonPaste.validatedDoc = null;
            return;
        }
        const doc = HSync.buildProjectFromPaste(parsed, section);
        if (!doc[section].length) {
            out.innerHTML = '<div class="hsync-warning">Nessuna entità trovata per la sezione <code>'
                + esc(section) + '</code>. Incolla un singolo oggetto, un array, o un project.json con la sezione popolata.</div>';
            applyBtn.disabled = true;
            HSync.state.jsonPaste.validatedDoc = null;
            return;
        }
        out.innerHTML = '<p class="hsync-loading">Validazione…</p>';
        try {
            const data = await HSync.ajax('project_validate', { project: doc });
            if (!data.ok) {
                out.innerHTML = '<div class="hsync-error"><strong>'
                    + (data.errors || []).length + ' errore/i</strong><ul>'
                    + (data.errors || []).map(e => '<li><code>' + esc(e) + '</code></li>').join('')
                    + '</ul></div>';
                applyBtn.disabled = true;
                HSync.state.jsonPaste.validatedDoc = null;
                return;
            }
            const sectionDiff = (data.diff && data.diff[section]) || {};
            const rows = Object.entries(sectionDiff).map(([slug, info]) =>
                '<tr><td><code>' + esc(slug) + '</code></td>'
                + '<td><span class="hsync-status hsync-status--' + (info.op === 'create' ? 'ok' : 'info') + '">'
                + esc(info.op) + '</span></td></tr>'
            ).join('');
            out.innerHTML = '<div class="hsync-summary-foot">JSON valido. ' + Object.keys(sectionDiff).length
                + ' entità pronta/e da applicare in <code>' + esc(section) + '</code>.</div>'
                + (rows
                    ? '<table class="hsync-table"><thead><tr><th>slug</th><th>op</th></tr></thead><tbody>' + rows + '</tbody></table>'
                    : '');
            applyBtn.disabled = false;
            HSync.state.jsonPaste.validatedDoc = doc;
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
            applyBtn.disabled = true;
            HSync.state.jsonPaste.validatedDoc = null;
        }
    };

    HSync.jsonPasteApply = async function () {
        const out = $('[data-region="json-paste-output"]');
        const doc = HSync.state.jsonPaste.validatedDoc;
        const section = HSync.state.jsonPaste.section;
        if (!doc || !section) {
            out.innerHTML = '<div class="hsync-warning">Esegui prima Valida.</div>';
            return;
        }
        out.innerHTML = '<p class="hsync-loading">Applicazione…</p>';
        try {
            const data = await HSync.ajax('project_apply', { project: doc, prune: '' });
            const c = (data.counts && data.counts[section]) || { created:0, updated:0, deleted:0 };
            out.innerHTML = '<div class="hsync-summary-foot">Applicato ✓ — '
                + 'creati: <strong>' + (c.created || 0) + '</strong>, '
                + 'aggiornati: <strong>' + (c.updated || 0) + '</strong>.'
                + '</div>';
            // Refresh whichever tab is showing the section so the
            // operator sees the result immediately.
            const refreshers = {
                sources:   () => HSync.loadSources(),
                mappings:  () => HSync.loadMappings && HSync.loadMappings(),
                pipelines: () => HSync.loadPipelines && HSync.loadPipelines(),
                rules:     () => HSync.loadRules && HSync.loadRules(),
                jobs:      () => HSync.loadJobs && HSync.loadJobs(),
            };
            const refresh = refreshers[section];
            if (refresh) refresh();
            HSync.refreshCockpit();
        } catch (e) {
            out.innerHTML = '<div class="hsync-error">' + esc(e.message) + '</div>';
        }
    };

    // ─── Boot ─────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function () {
        HSync.setAdvanced(HSync.readAdvancedPref(), false);
        HSync.switchTab('home');
        HSync.refreshCockpit();
        HSync.refreshSystemStatus();
        HSync.loadSources();
        // Refresh the cockpit periodically so the operator sees jobs
        // tick in real time without having to reload the whole page.
        setInterval(HSync.refreshCockpit, 30000);
        setInterval(HSync.refreshSystemStatus, 60000);
    });
})();
