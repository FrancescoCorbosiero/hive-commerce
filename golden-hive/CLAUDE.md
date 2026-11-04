# CLAUDE.md — Hive Commerce

> Stai lavorando su **golden-hive**. La root del tuo lavoro è `/golden-hive/`.
>
> Ordine di lettura obbligatorio:
> 1. Questo file (CLAUDE.md)
> 2. `../CONVENTIONS.md` — convenzioni condivise tra tutti i plugin

---

## Contesto del Plugin

**Hive Commerce** (ex "Golden Hive") è una suite WooCommerce unificata in un'unica interfaccia admin con sidebar a tab. Ha assorbito le funzionalità degli ex plugin standalone `rp-*` (product-manager, media-cleaner, rest-caller, catalog-manager, email-marketing), ormai rimossi dal monorepo.

> **Naming legacy:** la directory `golden-hive/`, l'entry point `golden-hive.php`,
> i prefix (`gh_`/`rp_*`), le option keys, i cron hook e il namespace `GH\`
> mantengono il vecchio nome per compatibilità con i dati persistiti delle
> installazioni live. Vedi la nota "Rebrand" in `../CONVENTIONS.md`.

---

## Stack Tecnico

| Layer | Tecnologia |
|---|---|
| CMS | WordPress 6.x |
| E-commerce | WooCommerce 8.x |
| SEO | Rank Math PRO |
| Email | wp_mail() → WP Mail SMTP → AWS SES |
| PHP | 8.0+ |
| Admin UI | Vanilla JS + CSS custom (dark theme) |
| Font stack | JetBrains Mono + DM Sans (Google Fonts) |

---

## Struttura del Plugin

```
golden-hive/
├── golden-hive.php              ← Entry point. Solo require_once.
├── CLAUDE.md                    ← Questo file.
├── assets/                      ← CSS/JS SERVITI (enqueued, cacheabili). Sorgente unica.
│   ├── css/gh-admin.css         ← Design system + .gh-card + .gh-status-* + color alpha tokens + @media mobile
│   ├── css/gh-kicksdb.css       ← Stili del pannello KicksDB (griglia Discover)
│   ├── js/gh-core.js            ← IIFE `const GH = (…)()`: ajax, ajaxWithToast, toast (sticky), confirm, emptyState, statusChip, markDirty/clearDirty/isDirty, registerShortcuts, registerDeepOpener, updateHash, copyJSON, copyToClipboard, wireDirtyInputs, switchTab (hash-aware)
│   └── js/gh-*.js               ← moduli che estendono GH: operations, inline, smart, navigation, media, mapper, jobs, email, email-campaigns, email-transactional, kicksdb, history, workflow, termpicker, settings
└── includes/
    ├── core/                    ← Foundation helpers riutilizzabili (prefix: gh_)
    │   ├── product-factory.php  ← gh_create_simple_product, gh_create_variable_product (NON gestisce immagini: i feed hanno la loro pipeline media)
    │   ├── product-images.php   ← gh_img_* — immagini dell'Import JSON: riusa media esistenti (ID / preimport map / URL della media library di questo sito, anche miniature e -scaled / file già negli uploads ma non registrato) altrimenti sideload. gh_img_plan (preview senza effetti) + gh_img_apply_to_product (featured + gallery + immagini variante)
    │   ├── option-store.php     ← gh_option_list_all/_find/_upsert/_remove (CRUD generico wp_options-as-list)
    │   ├── ajax-helpers.php     ← gh_ajax_guard + gh_ajax_{text,textarea,key,email,int,bool,json,int_array}
    │   └── ui-helpers.php       ← gh_empty_state, gh_status_chip (HTML snippet standardizzati)
    ├── product/                 ← Da rp-product-manager (prefix: rp_) + Inline Editor AJAX (prefix: gh_)
    │   ├── crud.php             ← rp_get_product, rp_create_product, rp_update_product, rp_delete_product
    │   ├── variations.php       ← rp_search_products, rp_get_product_variations, rp_update_variation, rp_bulk_update_variations
    │   └── ajax.php             ← gh_ajax_product_search, _load, _save, _variations_save
    ├── catalog/                 ← Da rp-catalog-manager (prefix: rp_cm_)
    │   ├── reader.php           ← rp_cm_get_all_products (accetta filters[include_ids] per subset export) + rp_cm_get_product_ids (lista ID per export a chunk)
    │   ├── aggregator.php       ← rp_cm_aggregate_product, rp_cm_extract_sizes, rp_cm_calculate_pricing
    │   ├── tree-builder.php     ← rp_cm_build_tree, rp_cm_get_product_tree_path
    │   ├── exporter.php         ← rp_cm_export_catalog, rp_cm_export_roundtrip
    │   ├── importer.php         ← rp_cm_import_preview, rp_cm_import_apply
    │   ├── taxonomy-manager.php ← rp_cm_get_taxonomy_tree, rp_cm_create_category, rp_cm_assign_product_categories
    │   ├── taxonomy-query.php   ← rp_cm_query_taxonomies (filter/sort/top-N), rp_cm_get_products_for_terms
    │   ├── smart-taxonomy.php   ← gh_smart_* (regole condizionali, STESSO schema conditions di Filter)
    │   ├── bulk-creator.php     ← rp_cm_bulk_preview, rp_cm_bulk_apply (mode create|create_or_update|sync), gh_cm_dispatch_bulk_import (background job CDN-proof). Mode 'sync' nasconde le varianti assenti dal JSON (0 stock + disabilitate via gh_cm_hide_missing_variations), non le elimina. Immagini via gh_cm_bulk_apply_images (vedi "Import JSON — Immagini"); gh_cm_bulk_entry_weight = peso batch (1 + varianti + 4 per immagine), speculare a bulkWeight in gh-core.js
    │   └── ajax.php             ← AJAX bridge (export_roundtrip supporta include_ids; export_roundtrip_ids = lista ID per chunking client-side)
    ├── navigation/              ← (prefix: gh_nav_)
    │   ├── manager.php          ← gh_nav_get_menus, _get_menu_items, _upsert_item, _populate_from_terms, _clear_managed_children
    │   └── ajax.php             ← gh_ajax_taxonomy_query, gh_ajax_products_for_terms (hand-off TaxQuery→Bulk), gh_ajax_nav_{...}
    ├── media/                   ← Da rp-media-cleaner (prefix: rp_mc_ / rp_mm_)
    │   ├── scanner.php, browser.php, library.php, whitelist.php, cleaner.php
    │   └── ajax.php              ← include rp_mm_ajax_set_featured (usato da hand-off Media row → Featured)
    ├── feeds/                   ← Da rp-rest-caller (prefix: rp_rc_ / gh_*)
    │   ├── http-client.php, response-parser.php, saved-endpoints.php
    │   ├── feed-credentials.php ← gh_feed_credentials_* (storage CENTRALIZZATO con whitelist+sanitize+redact per credenziali GS/SF)
    │   ├── feed-goldensneakers.php, feed-stockfirmati.php, feed-csv.php
    │   ├── csv-presets.php, feed-config-engine.php, media-preimport.php
    │   ├── scheduler.php, reimport.php
    │   ├── ajax.php
    │   └── kicksdb/             ← KicksDB lookup/enrichment + discovery (NON un feed push)
    │       ├── client.php       ← gh_kicksdb_request + _request_multi (curl_multi sliding-window 8x), get_product_full / _multi, search_products, get_prices_batch
    │       ├── settings.php     ← gh_kicksdb_get_settings/_save_settings/_get_settings_redacted (api_key redatta + pricing formula)
    │       ├── cache.php        ← gh_kicksdb_cache_get/_set/_purge + gh_kicksdb_get_product_cached (transient 24h, no-cache su 404)
    │       ├── pricing.php      ← gh_kicksdb_extract_standard_prices (filter type=='standard' + MIN per size), gh_kicksdb_apply_markup (margin/floor/round)
    │       ├── normalizer.php   ← gh_kicksdb_normalize → WC shape (EU sizes only) + post_process (taxonomy, meta, sideload), legge active mapping profile
    │       ├── profiles.php     ← gh_kicksdb_profiles_* (mapping profiles con required_fields + description_template + gallery_opts)
    │       ├── feed.php         ← orchestrator: fetch_skus → diff → apply (passa per conflict engine), refresh_pricing path dedicato (batch endpoint)
    │       └── ajax.php         ← gh_kicksdb_settings/_test_connection/_lookup/_search/_apply/_refresh_pricing/_profiles_*
    ├── conflict/                ← Cross-feed provenance + conflict resolution (prefix: gh_conflict_)
    │   ├── provenance.php       ← gh_conflict_get_sources/_record_source/_set_primary_source (read/write _gh_sources, _gh_field_sources, _gh_primary_source meta)
    │   ├── storage.php          ← gh_conflict_rules_all/_find/_upsert/_remove + gh_conflict_default_rules (manual_sacred + gs_owns_pricing)
    │   ├── engine.php           ← gh_conflict_resolve(product_id, incoming, source) → { allowed_slices, blocked, applied_rule } | gh_conflict_dry_run
    │   ├── migrate.php          ← gh_conflict_migrate_run (batched 200/tick, idempotente; backfilla _gh_import_source legacy → _gh_sources)
    │   └── ajax.php             ← gh_conflict_rules_* / _migrate_tick / _migrate_status / _product_provenance / _dry_run
    ├── jobs/                    ← Scheduler unificato (prefix: gh_jobs_)
    │   ├── cron-expr.php, registry.php, storage.php, log.php, runner.php, migrate.php
    │   ├── handlers-feeds.php   ← job kinds: csv_feed, config_feed, force_reimport, kicksdb_refresh_pricing
    │   ├── handlers-ops.php     ← job kinds: gs_feed, email_campaign, media_cleanup, bulk_action, catalog_export, rest_call, bulk_import (background CDN-proof)
    │   └── ajax.php
    ├── filter/                  ← (prefix: gh_)
    │   ├── conditions.php       ← gh_get_condition_definitions, gh_evaluate_condition (23 tipi, include kicksdb_*/provenance_*)
    │   ├── query-engine.php     ← gh_filter_products (options[include_ids] bypassa condition builder), gh_filter_product_ids
    │   └── ajax.php             ← gh_ajax_filter_* (supporta include_ids per subset/hand-off)
    ├── bulk/                    ← (prefix: gh_)
    │   ├── actions.php          ← include kicksdb_refresh_pricing (batch dispatcher: 1 call HTTP per 50 SKU)
    │   ├── sorter.php, ajax.php
    ├── mapper/                  ← Visual field mapper (prefix: gh_mp_)
    │   ├── engine.php, storage.php, ajax.php
    ├── email/                   ← Multi-layer email + transactional (prefix: rp_em_)
    │   ├── placeholders.php     ← _extract_namespace (BRAND|CAMPAIGN|PRODUCT|ORDER|RECIPIENT|META), _order_item_{index,field}
    │   ├── brand.php            ← rp_em_get_brand/_save_brand/_reset_brand
    │   ├── templates.php        ← CRUD templates + _install_demo_template / _install_weekend_2products_template / _install_order_shipped_template + auto-install admin_init
    │   ├── renderer.php         ← rp_em_render_campaign, _render_raw, _merge_layers, _resolve_product_fields
    │   ├── validator.php        ← rp_em_validate_campaign (ORDER_* in campaign template → NAMESPACE_VIOLATION)
    │   ├── campaigns.php        ← CRUD campagne + _schedule_campaign + _execute_campaign + cron handler
    │   ├── contacts.php         ← rp_em_get_hustle_subscribers, rp_em_parse_csv_contacts
    │   ├── mailer.php           ← rp_em_send_test_email, rp_em_send_campaign_rendered
    │   ├── log.php              ← rp_em_log_email (type: test | campaign | transactional)
    │   ├── order-resolver.php   ← rp_em_resolve_order_fields: WC order → ORDER_* map (40+ campi + ORDER_ITEM_N_*)
    │   ├── transactional.php    ← Event-driven: _transactional_events, _get/save_binding, _render/fire_transactional + hook WP/Woo
    │   ├── order-meta-box.php   ← WC order screen (legacy + HPOS): form tracking + "Salva & invia notifica"
    │   ├── demo-render.php      ← _render_template_with_demo + _build_demo_values (euristica per CAMPAIGN_*)
    │   ├── _seed/               ← demo-template, weekend-2products, order-shipped, seeder
    │   ├── ajax.php             ← rp_em_ajax_* (campaigns/templates/brand/test/demo render/preview-product-in-email)
    │   └── transactional-ajax.php ← rp_em_ajax_trx_list/_save/_test_fire, rp_em_ajax_save_tracking (metabox)
    ├── tools/
    │   ├── nuclear-cleanup.php, ajax.php
    ├── views/                   ← SOLO MARKUP. Niente <style>, niente <script>.
    │   └── panels*.php          ← panels, panels-operations, panels-navigation, panels-mapper, panels-jobs, panels-email, panels-kicksdb, panels-history, panels-workflow
    ├── assets.php               ← admin_enqueue_scripts: enqueue di assets/css + assets/js, versioning via filemtime, wp_localize_script('GHBoot')
    └── admin-page.php           ← add_menu_page + sidebar a tab (solo markup)
```

---

## Layer Applicativi

```
product/crud.php, variations.php   → "Prodotti" (CRUD singolo, varianti)
catalog/reader.php, aggregator.php → "Catalogo" (lettura aggregata, albero)
filter/conditions.php, query-engine.php → "Filtra" (query composabile, 2 fasi DB+memoria)
bulk/actions.php, sorter.php       → "Agisci" (operazioni bulk, ordinamento)
email/contacts.php, mailer.php     → "Email" (contatti, campagne, wp_mail)
*/ajax.php                         → "Bridge" (sanitize → chiama funzione → json)
views/*.php, admin-page.php        → "UI" (zero logica business)
```

---

## Asset Loading — `includes/assets.php`

CSS e JS sono **file enqueued**, non più inline. Prima la pagina admin
spediva ~726 KB ad **ogni** load (505 KB di JS + 80 KB di CSS stampati
inline, non cacheabili); ora il markup pesa ~141 KB e il resto lo serve il
browser dalla cache, rivalidando per versione.

- **Sorgente unica**: `assets/css/*.css` e `assets/js/*.js`. I vecchi
  `views/css.php`, `views/js*.php` sono stati rimossi — `views/` contiene
  ormai solo markup. Non reintrodurre `<style>`/`<script>` inline nei panel.
- **Versioning**: `filemtime()` per file, quindi un deploy invalida la cache
  da solo, senza bump manuale di `GH_VERSION`.
- **Bootstrap**: gli unici due valori che il JS prendeva da PHP (ajax url +
  nonce) arrivano su `window.GHBoot` via `wp_localize_script()`.
- **`gh-core.js` è indivisibile**: `js.php` + `js2.php` erano due metà di una
  sola IIFE (`const GH = (function(){` … `})();`), nessuna delle due
  sintatticamente valida da sola. Stanno in un unico file.
- **I moduli dipendono solo da `gh-core`**: l'ordine di caricamento non è più
  load-bearing. Prima lo era — `gh-operations`, `gh-media` e `gh-jobs`
  wrappavano `GH.switchTab` a catena — ma ora si registrano via
  `GH.onTabChange()` (vedi sotto) e caricarli in ordine inverso non produce
  errori. WordPress li stampa comunque nell'ordine di enqueue; nessuno ci fa
  affidamento. Un modulo che in futuro avesse bisogno di un altro a load time
  deve dichiararlo come dipendenza esplicita, non contare sulla posizione.
- **Niente `defer`/`async`**: il core registra un handler `DOMContentLoaded`
  per l'hash routing, che verrebbe perso se lo script girasse dopo l'evento.

---

## Tab UI nella Sidebar

| Sezione | Tab | Pannello |
|---|---|---|
| OPERAZIONI | Filtra & Agisci | Query builder + tabella + inline edit + bulk actions (default) |
| | Inline Editor | Single-product: Form + JSON + Variations editing |
| | Ordinamento | Sort preview + apply menu_order |
| | Tassonomie | CRUD albero `product_cat` e `product_brand` |
| | Tax Query | Lista filtrabile (search, parent, depth, count range, top-N) con selezione &rarr; Navigazione |
| | Navigazione | Gestione WP nav menus + auto-populate di un item da un set di termini |
| MEDIA | Media Library | Browser unificato con filtri, bulk ops, Safe Cleanup |
| | Whitelist | Protezione immagini, inline add form |
| FEED *(nascosta)* | GS Feed | Golden Sneakers feed (con UI Salva credenziali con redazione token) |
| | SF Feed | StockFirmati CSV feed (URL salvabile) |
| | CSV Feed | Generic CSV feed via config-engine |
| | KicksDB | Lookup/enrichment service + Discover search browser. 6 sub-section: Discover, Lookup, Refresh Pricing, Field Mapping, Provenance, Conflict Rules, Settings |
| CATALOGO | Import JSON | Import prodotti da file .json (ex "Bulk JSON"). Modi: crea / crea-o-aggiorna (SKU) / sincronizza. Preview + apply, o Background come job CDN-proof. Immagini: riuso dalla media library o sideload, colonna "Immagini" in preview e risultato |
| | Roundtrip | Export snapshot filtrato &rarr; edit &rarr; re-import dello stesso envelope JSON |
| | Catalog History | Snapshot + diff del catalogo (monitoring) |
| TOOLS | HTTP Client | Test API generiche |

> **Rimossi**: Overview (lenta), Catalog (JSON senza azioni), Browse (ricerca
> WP-like inutile), Mapping (assorbito in Media Library), Safe Cleanup
> (assorbito come shortcut in Media Library). La logica PHP sottostante
> (exporter, scanner) resta disponibile per Jobs/altri moduli.

> **Nascosti (non rimossi) — sezione FEED**: i tab GS Feed / SF Feed /
> CSV Feed / KicksDB non compaiono nella sidebar. **Feed e sincronizzazione
> sono scope di Hive Sync, non di Hive Commerce**: è lì che si configurano
> sorgenti, mapping e job ricorrenti. È SOLO UI-hiding in `admin-page.php`:
> tutto il PHP resta caricato e funzionante — AJAX handler, bridge hive-sync
> (`rp_rc_gs_*`/`gh_sf_*`), REST `gh/v1`, job kinds del runner, cron
> scheduler — perché altri plugin/tool chiamano questo codice. I pannelli
> restano nel DOM e i deep-link (`#/gsfeed`, `#/csvfeed`, …) funzionano come
> scorciatoia d'emergenza. Ri-mostrare la sezione:
> `define( 'GH_SHOW_FEED_UI', true )` in wp-config.php oppure
> `add_filter( 'gh_feed_ui_visible', '__return_true' )`.
>
> Il nome storico `GH_SHOW_IMPORT_UI` / `gh_import_ui_visible` (di quando il
> flag copriva feed **e** tool JSON insieme) è deprecato ma ancora onorato.

> **Sempre visibili — sezione CATALOGO**: Import JSON, Roundtrip e Catalog
> History NON sono feed e restano nella sidebar. Lavorano su un file che
> carichi tu, senza sorgente remota né scheduling: sono strumenti di catalogo
> di Hive Commerce, non pipeline di sync. Nota: `Bulk JSON` è stato
> rietichettato `Import JSON` — il panel id (`panel-bulkimport`), il deep-link
> `#/bulkimport` e gli action AJAX (`rp_cm_ajax_bulk_*`) sono invariati.

---

## Import JSON — Immagini

`includes/core/product-images.php`, chiamato SOLO da `catalog/bulk-creator.php`
(non dal product factory: GS/SF/CSV/KicksDB hanno già la loro pipeline media
e un hook nel factory causerebbe doppi download).

**Formati** (il primo presente vince): `images: [{id?, src?, name?, alt?, position?} | "url" | 123]`
(shape WC REST) · `featured_image_url` + `gallery_image_urls` (shape catalog export) ·
`image`. Varianti: `image` (oppure la prima di `images`).

**Semantica** (array_key_exists): chiave assente → immagini invariate · `[]` →
featured + gallery rimosse (attachment NON eliminati) · lista → prima = featured,
resto = gallery, ordinate per `position`, deduplicate. Se nessuna immagine di
una lista non vuota si risolve, le immagini attuali restano.

**Risoluzione** per immagine: `id` attachment → preimport map (URL già scaricato)
→ URL della media library di questo sito (host senza www/schema, filtro
`gh_img_local_hosts` per un CDN; match su `_wp_attached_file` anche da miniatura
`-WxH` o originale `-scaled`/`-rotated`) → file presente negli uploads ma non
registrato (registrato in place, senza copia) → download. Il download passa per
`wp_http_validate_url` (niente host privati, porte 80/443/8080) e per
`gh_preimport_download_batch( $items, 6, [ 'thumbnails' => true ] )`: miniature
generate, nome file dal `name`/`alt`, URL salvato nella preimport map → un
re-import dello stesso JSON non duplica nulla.

**Metadati**: attachment nuovi → titolo da `name` (o nome prodotto), alt da
`alt`. Attachment già esistenti → alt scritto solo se vuoto, parent solo se non
assegnato (possono essere usati da altri prodotti).

**Report**: `details[].images = { touched, featured, gallery, variations, reused,
downloaded, registered, cleared, failed[{src, reason}] }`; summary
`img_reused/img_downloaded/img_failed`; il job background porta anche
`img_failures` (cap 50). Un errore immagini non fa mai fallire il prodotto.

---

## Inline Editor — Architettura

Complementa Filtra & Agisci: quello e per bulk, questo per lavoro
chirurgico su un singolo prodotto. Cross-linked: "Edit" nella tabella
dei risultati apre il prodotto nell'Inline Editor.

**Tre sub-tabs:**
- **Form** — campi validati (name, sku, status, prezzi, stock, SEO).
  Dirty tracking: solo i campi modificati vengono inviati al server.
- **JSON** — textarea editabile con il payload completo del prodotto
  (identico shape a `rp_get_product()`). Dev-first: copia, modifica,
  applica. I campi read-only (`id`, `type`, `price`, `dates`,
  `permalink`, `attributes`) vengono strippati silenziosamente lato
  server cosi incollare un JSON intero e sempre safe.
- **Variations** — tabella inline (solo per prodotti variable): taglia,
  sku, prezzi, stock, stato. Dirty tracking indipendente con batch save
  via `rp_bulk_update_variations()`. Supporta **bulk operations** su righe
  selezionate (checkbox per riga + select-all): set regular/sale price,
  clear sale, adjust regular ±%, set stock qty/status, set publish status.
  Le azioni bulk popolano i campi dirty delle righe selezionate senza
  salvare immediatamente — l'utente conferma col bottone "Salva varianti"
  (permette undo prima del commit).

**AJAX endpoints (product/ajax.php):**
- `gh_ajax_product_search` — typeahead (auto-detect: ID → SKU esatto → fulltext → SKU LIKE)
- `gh_ajax_product_load` — payload completo + variations + brands + gallery
- `gh_ajax_product_save` — batch update via JSON (delega a `rp_update_product`)
- `gh_ajax_product_variations_save` — batch save varianti

---

## Media Library — Architettura

Browser unificato della media library con product awareness.
Sostituisce le vecchie tab Mapping + Safe Cleanup.

**Usage index inverso** (cached in transient 10 min):
`gh_media_build_usage_index()` → `attachment_id → [{pid, role}]`
dove role ∈ {featured, variation, post_featured, gallery, content}.
Invalidato da hook `add/delete_attachment` e `save_post_product`.

**Query paginaged** `gh_media_query($filters, $pagination)`:
- Filtri DB-level: filename LIKE (post_title + guid), mime
- Filtri memory-level: usage (mapped/unmapped), whitelist (yes/no)
- Hydration batch per pagina: metadata attachment + product name/sku/permalink

**Safe Cleanup** (shortcut button nel toolbar):
`gh_media_safe_cleanup_preview()` → split: `to_delete_ids` (unmapped
non-whitelisted) + `whitelist_details` (id + url + reason). L'UI mostra
un pannello di conferma in-panel con la lista dei whitelisted esclusi
prima di procedere.

---

## Media Safe Cleanup — Architettura

**Flusso a due fasi visibile all'utente:**

1. **Mapping phase** — `rp_mm_build_usage_map()` scansiona tutte le sorgenti
   che referenziano media e ritorna un breakdown ispezionabile:
   - `featured_products` — featured image di prodotti simple/variable
   - `featured_variations` — thumbnail di `product_variation`
   - `gallery_products` — ID in `_product_image_gallery` (CSV meta)
   - `featured_posts` — featured image di post/page
   - `inline_content` — URL in `<img src>` / `<a href>` nel content/excerpt
   - `all_used` — unione deduplicata delle precedenti
2. **Diff phase** — `rp_mm_get_orphan_attachments($usage_map)` sottrae
   `all_used` dall'elenco completo degli attachment mime=image. Gli orfani
   restituiti sono "100% sicuri" rispetto alle sorgenti coperte.

**Safety net:**
- La whitelist (`rp_mm_whitelist` option) blocca l'eliminazione anche se
  un attachment risulta orfano dal diff.
- `rp_mm_delete_attachment()` ricontrolla whitelist + `rp_mm_is_used()`
  puntuale prima di ogni cancellazione.
- Ogni cancellazione e loggata in `rp_mm_deletion_log` (FIFO max 500).

---

## Filter Engine — Architettura

**2 fasi:**
1. **Fase DB** — `WC_Product_Query` per status, tipo, categoria, tag (veloce, SQL)
2. **Fase memoria** — `gh_evaluate_condition()` per attributi, varianti, SEO, regex (flessibile, PHP)

**23 tipi di condizione:** category, brand, tag, attribute, status, type, price_range, has_sale, stock_status, stock_qty, sku_pattern, name_contains, date_created, date_modified, seo_field, has_image, gallery_count, variant_count, has_size, menu_order, import_source, **kicksdb_tracked**, **kicksdb_last_sync_age**, **provenance_source**, **provenance_multi_source**

> `brand` opera sulla tassonomia `product_brand` (WooCommerce Brands). Se la
> tassonomia non e registrata la condizione ritorna `true` (no-op) per evitare
> falsi negativi, e il selettore UI mostra "Nessun brand".

> Le 4 condizioni del gruppo `kicksdb` leggono i meta scritti dal feed
> KicksDB (`_gh_kicksdb_tracked`, `_gh_kicksdb_last_sync`, `_gh_kicksdb_last_price_sync`)
> e dal conflict engine (`_gh_sources`, `_gh_primary_source`). Tutte
> memory-phase. Operatore speciale `never` su `kicksdb_last_sync_age`
> matcha prodotti tracked-ma-mai-sincronizzati. `provenance_source` ha
> operatori `contains`/`not_contains`/`primary_is`/`primary_is_not`.
> `provenance_multi_source` (boolean) = piu di 1 source registrata —
> bersaglio naturale di conflict rules.

**Inline editing:** double-click su cella → input/select inline → AJAX save → aggiornamento in-place

---

## Bulk Actions

| Gruppo | Azioni |
|---|---|
| Taxonomy | assign_categories, remove_categories, set_categories, assign_brands, remove_brands, set_brands, assign_tags, remove_tags |
| Status | set_status |
| Price | set_sale_percent, remove_sale, adjust_price, markup_percent, discount_percent, artificial_sale (prezzo corrente → sale_price + regular gonfiato per mostrare lo sconto %), collapse_sale (sale_price → nuovo regular, inverso di artificial_sale), round_prices (normalizza i prezzi con un preset di arrotondamento: .99/.00/multipli) |
| Stock | set_stock_status, set_stock_quantity |
| SEO | set_seo_template (con placeholder {name}, {sku}, {price}, {brand}, {type}) |
| Media | remove_first_gallery_image, clear_gallery |
| Order | set_menu_order |
| Delete | delete_product, delete_with_media |
| **KicksDB** | **kicksdb_refresh_pricing** (batch dispatcher: 1 call HTTP per 50 SKU, gated da _gh_kicksdb_tracked='1', rispetta conflict rules slice 'pricing') |

> `kicksdb_refresh_pricing` non passa dal per-product loop. `gh_execute_bulk_action`
> intercetta l'azione e delega a `gh_bulk_dispatch_kicksdb_refresh()` che
> raccoglie gli SKU dei prodotti selezionati, chiama `gh_kicksdb_refresh_pricing()`
> UNA volta sola, mappa i risultati per-prodotto. 500 prodotti = 10 call HTTP
> invece di 500.

> Le azioni `assign_brands` / `remove_brands` / `set_brands` sono implementate
> riutilizzando `rp_cm_{assign,remove,set}_product_categories` col parametro
> `$taxonomy = 'product_brand'`. Stesso codice, diversa tassonomia.
>
> Il placeholder `{brand}` in `set_seo_template` risolve prima da
> `product_brand` (Woo Brands) e in fallback dal primo `product_cat`.

---

## Sorting — 11 Regole

name_asc/desc, price_asc/desc, date_newest/oldest, stock_first/last, sku_asc, variant_count_desc, sale_first

Scrive `menu_order` incrementale (10, 20, 30...) rispettato da WooCommerce nel catalogo.

---

## Co-esistenza con Plugin Standalone

I file condivisi (product, email) hanno guard di double-loading:
```php
if ( function_exists( 'rp_get_product' ) ) return;
if ( defined( 'RP_EM_CAMPAIGNS_KEY' ) ) return;
```
Questo permette di avere golden-hive + rp-product-manager attivi insieme senza fatal error.

---

## Taxonomy Query + Navigation — Architettura

Due moduli strettamente accoppiati che condividono lo stesso query engine.

### Tax Query (catalog/taxonomy-query.php)

Una sola funzione parametrica:

```php
rp_cm_query_taxonomies([
    'taxonomy'         => 'product_cat',   // product_cat | product_brand
    'search'           => 'abbigl',        // substring su name/slug
    'parent'           => -1,              // -1=root only, int=parent diretto, null=any
    'ancestor'         => 123,             // tutti i discendenti di #123
    'depth_min'        => 1, 'depth_max' => 2,
    'min_count'        => 5, 'max_count' => 500,
    'has_products'     => true,            // shortcut per min_count>=1
    'in_product_cat'   => [ 123 ],         // cross-filter: solo termini con prodotti in queste cat
    'in_product_brand' => [ 77, 78 ],      // cross-filter: solo termini con prodotti in questi brand
    'orderby'          => 'count',         // name|count|id|depth|path
    'order'            => 'desc',
    'limit'            => 15, 'offset' => 0,
]);
// => [ 'items' => Term[], 'total' => int ]
```

Ogni Term contiene `id, name, slug, parent, count, depth, path, permalink`.
Compute `depth` e `path` sono memoizzati per singola chiamata.

**Cross-taxonomy filter** (`in_product_cat` / `in_product_brand`) — risolve
query tipo "dammi i brand dei prodotti che stanno sotto la categoria
Abbigliamento":

```php
// "Brand presenti nella categoria #123"
rp_cm_query_taxonomies([
    'taxonomy'       => 'product_brand',
    'in_product_cat' => [ 123 ],
    'orderby'        => 'count', 'order' => 'desc',
]);
```

Implementato via `rp_cm_cross_taxonomy_counts()` con SQL diretto (join su
`term_relationships` e GROUP BY) — niente hydration di oggetti prodotto.
Se il cross-filter e attivo, `count` di ciascun term viene sovrascritto
col conteggio **filtrato** (solo i prodotti che matchano entrambi i set).
I filtri `min_count`/`max_count` si applicano poi sul count filtrato.

Helper complementare `rp_cm_get_products_for_terms($term_ids, $taxonomy, $extra)`
restituisce gli ID prodotto assegnati a un set di termini — utile per bulk ops
sui prodotti di una query tassonomica.

### Navigation Manager (navigation/manager.php)

Thin wrapper sulla Nav Menu API di WordPress con due garanzie in piu:

1. **Marker `_gh_nav_managed`** — ogni item creato da
   `gh_nav_populate_from_terms()` riceve post meta
   `_gh_nav_managed=1` (costante `GH_NAV_MANAGED_META`).
2. **Clear non distruttivo** — `gh_nav_clear_managed_children($menu_id,
   $parent_item_id)` elimina SOLO gli item marker'ati. Gli item aggiunti a
   mano dall'admin WP restano intatti anche se sono figli dello stesso parent.

Flusso "Populate now":
- L'UI mostra un preview dei termini (una query via `rp_cm_query_taxonomies`).
- L'utente clicca *Populate now* → l'AJAX riceve `term_ids` espliciti.
- Il layer PHP: (opz.) clear managed → insert con marker, `menu_order += 10`
  partendo dall'item sibling con ordine piu alto.
- Ritorna `{ created: int[], removed: int, skipped: int, errors: string[] }`.

> Non esiste persistenza di "regole" (niente tabella salvata). E una azione
> one-shot: esegui quando serve. Il preview mostra esattamente cosa verra
> scritto prima del commit.

### AJAX endpoints

Tutti sotto prefix `gh_ajax_` con nonce `gh_nonce`:

| Azione | Descrizione |
|---|---|
| `gh_ajax_taxonomy_query` | Query parametrica sulla tassonomia (ritorna items+total) |
| `gh_ajax_nav_menus` | Lista menu WP registrati |
| `gh_ajax_nav_items` | Item del menu (con flag `managed`) |
| `gh_ajax_nav_populate` | Popola sotto `parent_item_id` da `term_ids` espliciti |
| `gh_ajax_nav_clear_managed` | Elimina solo i figli managed di un parent |
| `gh_ajax_nav_delete_item` | Elimina un singolo item (manuale o managed) |

### UI

- **Tab Tax Query** (`panel-tax-query`) — toolbar di filtri + preset "Top 15"
  + tabella con checkbox. Bottone *Invia a Navigazione* cambia tab e
  pre-compila il preview del populator con gli ID selezionati.
- **Tab Navigazione** (`panel-navigation`) — selettore menu, selettore item
  target (flat con indentazione), criteri tassonomici, preview, *Populate
  now*, *Clear managed children*. Lato destro: lista completa item correnti
  con badge `GH` sugli item managed.

---

## Email — Multi-Layer Template System

Sistema di template email con placeholder namespaced in 5 layer. Il brand e
globale (il plugin gira dentro un sito brandizzato — una sola config per sito,
non multi-tenant).

### 6 namespace di placeholder

Regex unica: `/\{([A-Z][A-Z0-9_]*)\}/`. Tutto UPPERCASE.

| Namespace     | Sorgente                                     | Esempio                       | Contesto       |
|---------------|----------------------------------------------|-------------------------------|----------------|
| `BRAND_*`     | `wp_option['rp_em_brand']`                   | `{BRAND_LOGO_URL}`            | tutti          |
| `CAMPAIGN_*`  | payload della campagna (wizard)              | `{CAMPAIGN_HERO_TITLE}`       | campaigns      |
| `PRODUCT_N_*` | `product_ids` → WC (risolto dal renderer)    | `{PRODUCT_1_PRICE}`           | campaigns      |
| `ORDER_*`     | WC order via `rp_em_resolve_order_fields`    | `{ORDER_TRACKING_CODE}`       | transazionali  |
| `RECIPIENT_*` | ESP merge-tag (letterale per campaigns)      | `{RECIPIENT_FIRST_NAME}`      | tutti          |
| `META_*`      | auto: YEAR, DATE, DATETIME                   | `{META_YEAR}`                 | tutti          |

I `{RECIPIENT_*}` restano **letterali** nei rendering delle campagne
(sostituiti dall'ESP per-destinatario al send-time). Nei rendering
transazionali invece vengono sostituiti direttamente — il destinatario
e noto (il cliente dell'ordine).

**Validator strict:** il validator campagne flagga `ORDER_*` in un
template campagna come `NAMESPACE_VIOLATION` (gli ORDER vanno nei
template transazionali, non nelle campagne marketing) e viceversa.

**ORDER_* fields** (vedi `order-resolver.php` per la lista completa):
- Top-level: `ORDER_NUMBER`, `ORDER_DATE`, `ORDER_STATUS_LABEL`, `ORDER_URL`, `ORDER_TOTAL`, `ORDER_SUBTOTAL`, `ORDER_SHIPPING_TOTAL`, `ORDER_PAYMENT_METHOD`
- Customer: `ORDER_CUSTOMER_{FIRST,LAST,FULL}_NAME`, `_EMAIL`, `_PHONE`
- Billing/Shipping: `ORDER_{BILLING,SHIPPING}_{FIRST_NAME, ADDRESS_1, CITY, POSTCODE, STATE, COUNTRY, FULL_ADDRESS}`
- Shipment: `ORDER_TRACKING_CODE`, `ORDER_TRACKING_URL`, `ORDER_CARRIER`, `ORDER_SHIPPING_METHOD`
- Line items: `ORDER_ITEM_N_{NAME, SIZE, COLOR, SKU, QUANTITY, PRICE, SUBTOTAL, TOTAL, IMAGE_URL, URL, VARIATION_LABEL}`

### Flusso render

```
render_campaign(id):
  brand    = rp_em_get_brand()                 → {BRAND_*}
  payload  = rp_em_build_campaign_payload(id)  → {CAMPAIGN_*} + {PRODUCT_N_*}
  meta     = rp_em_auto_meta()                 → {META_*}
  merged   = rp_em_merge_layers(brand, payload, meta)
  return rp_em_render_raw(template.html, merged, preserve_recipient=true)
```

### Validator

`rp_em_validate_campaign(id)` ritorna `{errors[], warnings[], ok}`.

**Errori bloccanti:** `MISSING_VALUE`, `NAMESPACE_VIOLATION`,
`UNSUBSTITUTED`, `TEMPLATE_NOT_FOUND`, `INVALID_HEX`, `EMPTY_URL`.

**Warnings:** `ORPHAN_KEY`, `SUBJECT_TOO_LONG` (>60), `PREHEADER_TOO_LONG`
(>110), `LAYER_COLLISION`.

### Schema dati (tutto su wp_options, zero CPT)

- `rp_em_brand`      — single-row associative array con chiavi BRAND_*
- `rp_em_templates`  — array di `{id, name, description, html, placeholders_cache, created_at, updated_at}`
- `rp_em_campaigns`  — array di `{id, name, subject, preheader, template_id, payload, product_ids[], source_type, module_ids, csv_contacts, rate_limit, scheduled_at, status, stats, last_render, last_validation}`
- `rp_em_email_log`  — history capped a 500 entries

### Tab UI in sidebar

EMAIL: Brand / Templates / Campagne (wizard 6-step) / **Transazionali** / Contatti / Test Email / Storico.

### Smoke test

Tab Test Email → bottone "Popola demo": seeder crea template "Demo Weekend
Coupon", campagna "Weekend Coupon Demo", pesca 2 prodotti WooCommerce reali.
Poi tab Campagne → apri la campagna demo → Valida → Preview → Invia test.

---

## Core — Foundation Helpers

Utility in `includes/core/` riutilizzabili da ogni modulo. Additive: il
codice esistente non e stato migrato (guard `function_exists()`), ma i
moduli nuovi dovrebbero usarli di default.

### `option-store.php` — CRUD generico per wp_options-as-list

Sostituisce il pattern `get_option → validate → loop → update_option`
duplicato in 7+ moduli (brand, templates, campaigns, transactional,
jobs storage, mapper storage, saved-endpoints, whitelist).

```php
gh_option_list_all( $key );                    // sempre array
gh_option_list_find( $key, $id, $id_key='id' );
gh_option_list_upsert( $key, $data, $id_key='id', $id_prefix='tpl_', ?callable $sanitize=null, $timestamps=true );
gh_option_list_remove( $key, $id, $id_key='id' );
gh_option_list_replace( $key, $items );
```

Gestisce automaticamente `created_at`/`updated_at`, ID generator con
prefix, sanitize callback opzionale.

### `ajax-helpers.php` — Guard + input sanitization canonici

```php
gh_ajax_guard( $cap='manage_woocommerce' );    // nonce (gh_nonce OR rp_em_nonce) + capability, 403 su fail
gh_ajax_text( $key, $default='' );
gh_ajax_textarea( $key, $default='' );
gh_ajax_key( $key, $default='' );
gh_ajax_email( $key, $default='' );            // '' se invalida
gh_ajax_int( $key, $default=0 );
gh_ajax_bool( $key );                          // truthy: '1', 'true', 'on', non-empty
gh_ajax_json( $key, $default=[] );             // JSON → array, [] se malformato
gh_ajax_int_array( $key );                     // accetta JSON/CSV/array, dedupe, positivi
```

### `ui-helpers.php` — HTML snippet standardizzati

```php
gh_empty_state( $icon, $text, $extraClass='' );   // icon non escaped, text escaped
gh_status_chip( $label, $variant='dim' );         // 'ok'|'err'|'warn'|'info'|'dim'
```

---

## UX Infrastructure — GH module API (js.php + js2.php)

Foundation JS riutilizzabile da tutti i tab. Esposta via il module IIFE
come `GH.xxx`.

### AJAX + feedback

```javascript
GH.ajax(action, body)                          // raw, ritorna { success, data }
GH.ajaxWithToast(action, body, { okMsg, errPrefix, stickyErr })
                                               // wrapper con toast automatico su error
GH.toast(msg, type='ok', ms=3000)              // ms<=0 = sticky con X dismiss
```

### Dirty tracking + unsaved-changes guard

```javascript
GH.markDirty()       // setta flag, switchTab chiedera conferma
GH.clearDirty()      // reset (chiamalo dopo save)
GH.isDirty()         // lettura
GH.wireDirtyInputs(containerId)  // idempotente: aggancia markDirty a ogni input/textarea/select
```

`switchTab` consulta `isDirty()` e mostra `GH.confirm(...)`.
`window.beforeunload` warna su refresh/chiusura scheda se dirty.

### Reagire all'apertura di un tab

```javascript
GH.onTabChange((tab, el) => { if (tab === 'jobs') jobsReload(); })
```

Registra un listener invece di wrappare `GH.switchTab`. Il wrapping era il
pattern precedente e aveva tre difetti: il comportamento dipendeva
dall'ordine di caricamento degli script; chi teneva un riferimento a una
definizione precedente saltava silenziosamente tutti gli hook successivi; e
un hook che lanciava rompeva la catena per tutti gli altri. I listener sono
indipendenti, girano in ordine di registrazione, e un throw viene isolato
(`console.error`) senza fermare gli altri.

`switchTab` ritorna `true` se il tab è cambiato davvero, `false` se l'utente
ha annullato al prompt "modifiche non salvate" — e in quel caso **non** fa
partire i listener (ricaricare i dati di un tab su cui hai scelto di NON
andare non è mai stato l'intento).

### Keyboard shortcuts + hash router

```javascript
GH.registerShortcuts({ close: ()=>{...}, save: ()=>{...} })
                     // Esc→close, Cmd/Ctrl+S→save. Clear su switchTab.
GH.clearShortcuts()
GH.registerDeepOpener(tabName, (entityId) => {...})
                     // #/<tab>/<id> apre l'entita al load/hashchange
GH.updateHash(tab, entityId?)   // aggiorna URL senza reload
```

`/` (slash) focus sulla prima search/filter input del pannello attivo
(handler globale in js.php).

### Modal + clipboard

```javascript
GH.confirm(msg, { title, okLabel, cancelLabel, danger })  // Promise<bool>
GH.copyJSON(data, label='JSON')         // stringify + clipboard + toast
GH.copyToClipboard(text)                // Promise (fallback execCommand)
```

### UI snippet

```javascript
GH.emptyState(icon, text, extraClass)
GH.statusChip(label, variant)           // 'ok'|'err'|'warn'|'info'|'dim'
```

### Term Picker — multi-select ricercabile (js-termpicker.php)

Sostituisce i `<select multiple>` nativi per liste lunghe (brand, categorie,
tag). Stile Shopify: control con chips + dropdown con search testuale
(diacritics-insensitive), navigazione tastiera (frecce/Enter/Esc), "Pulisci",
drop-up automatico se manca spazio sotto.

```javascript
GH.termPicker(containerEl, {
    items: [{id, name, parent}],   // parent > 0 → riga indentata
    selected: [12, 34],
    placeholder: 'Cerca brand...',
    onChange: ids => { ... },      // opzionale
});
// La selezione e sempre leggibile da containerEl._ghTpSelected (int[]).
```

Usato in Filtra & Agisci (condition builder term_ids + bulk param selectors
via placeholder `<div class="gh-tp-mount" data-tp-kind="brand|category|tag">`).
Riusabile in qualunque altra sezione. CSS: blocco `.gh-tp-*` in css.php.

### Convenzioni editor wiring

Pattern consolidato (applicato a Template / Campaign wizard / Brand
form / Jobs editor / Inline Editor):

```javascript
// On open:
GH.wireDirtyInputs(containerId);
GH.clearDirty();
GH.registerShortcuts({ close: () => backToList(), save: () => save() });
GH.updateHash(tabName, entityId);
GH.registerDeepOpener(tabName, (id) => openEntity(id));  // 1x a init

// On save success:
GH.clearDirty();
GH.updateHash(tabName, entity.id);

// On close/cancel:
GH.clearShortcuts();
GH.clearDirty();
GH.updateHash(tabName);
```

Altri editor (Mapper, Transactional bindings) NON sono ancora wirati —
aggiungibili in 3-4 righe seguendo lo stesso pattern.

---

## Email — Transactional Layer

Parallelo alle campagne marketing. Dove le campagne inviano a una lista
con contenuti uguali, i transazionali inviano a un singolo destinatario
in risposta a un evento ordine, con placeholder `{ORDER_*}` risolti
dall'ordine specifico.

### Event registry — `transactional.php`

Hook WP/Woo auto-registrati al `init` priority 5. 5 eventi out-of-box:

| Slug              | Hook                                     | Descrizione                                        |
|-------------------|------------------------------------------|----------------------------------------------------|
| `order_processing`| `woocommerce_order_status_processing`    | Pagamento ricevuto, ordine preso in carico          |
| `order_completed` | `woocommerce_order_status_completed`     | Ordine completato (Woo default per "shipped")       |
| `order_shipped`   | `rp_em_order_shipped` (custom)           | Fired dal metabox quando il tracking viene salvato  |
| `order_cancelled` | `woocommerce_order_status_cancelled`     | Cancellato da admin o cliente                       |
| `order_refunded`  | `woocommerce_order_status_refunded`      | Rimborso totale/parziale                            |

### Storage — `wp_option['rp_em_transactional']`

```php
[
  'order_shipped' => [
    'enabled'     => true,
    'template_id' => 'tpl_xxx',
    'subject'     => 'Il tuo ordine {ORDER_NUMBER} e in viaggio',
    'preheader'   => 'Traccia la spedizione {ORDER_CARRIER} in tempo reale',
  ],
  ...
]
```

Subject e preheader supportano anche `{BRAND_*}` / `{META_*}` oltre che
`{ORDER_*}`.

### Flusso fire

```
woocommerce_order_status_shipped (hook) → rp_em_fire_transactional('order_shipped', $order_id):
  binding = rp_em_get_transactional_binding('order_shipped')
  if ! binding.enabled || template_id vuoto → skip
  render = rp_em_render_transactional(event, order_id):
      brand  + meta + order_fields (via rp_em_resolve_order_fields)
      → rp_em_render_raw(template.html, values, preserve_recipient=false)
  wp_mail( order.customer_email, subject, html ) → rp_em_log_email( type='transactional' )
```

### Metabox WC order edit screen — `order-meta-box.php`

Registra su entrambi gli screen (`shop_order` legacy + `woocommerce_page_wc-orders`
HPOS). Form con carrier selector (DHL/BRT/SDA/Poste/UPS/FedEx/…), tracking code,
tracking URL. Due bottoni:
- **Salva solo** — persiste `_rp_em_tracking_{code,url,carrier}` sull'order meta
- **Salva & invia notifica** — salva meta + chiama `rp_em_fire_transactional('order_shipped', $order_id)` direttamente (non via `do_action` per evitare double-send)

Il metabox mostra un warning giallo se il binding `order_shipped` non e attivo.

### Admin UI — tab Transazionali

Lista eventi con toggle attivo, template selector, subject/preheader editabili,
bottone "Rendi & invia" per test su un order ID reale.

---

## Cross-Module Hand-Off Map

Pattern "Invia a X": un tab risolve i suoi dati nativi (prodotti, termini,
preview HTML, ordini) e li passa al tab target via metodi `GH.*` pubblici.
Niente storage persistente — solo passaggio in-memory.

| Sorgente               | Target                 | Trigger                                              | Meccanismo                                                        |
|------------------------|------------------------|------------------------------------------------------|-------------------------------------------------------------------|
| Filter selection       | Campaign wizard        | "✉ Invia a Campagna" button                          | `GH.emCampaignOpenWithProducts(ids)`                              |
| Filter selection       | Roundtrip JSON export  | "↓ Export JSON" button                               | `rp_cm_ajax_export_roundtrip` con `include_ids`                   |
| Filter conditions      | Smart Taxonomy rule    | "Salva come Smart Rule"                              | `GH.smartOpenWithConditions(conds)` + staging in termine selez.    |
| Smart Rule conditions  | Filter builder         | "⇄ Apri in Filter"                                   | `GH.filterLoadConditions(conds)` + auto-run                       |
| Tax Query selection    | Navigation populator   | "Invia a Navigazione →"                              | `GH.tqSendToNav()` + `navPreviewTerms`                            |
| Tax Query selection    | Bulk on products       | "✎ Invia a Bulk →"                                   | `gh_ajax_products_for_terms` → `GH.openBulkOnProducts(ids)`       |
| Inline Editor product  | Email test body        | "✉ Preview email" button                             | `rp_em_ajax_preview_product_in_email` → Test Email body           |
| Campaign preview       | Test Email body        | "✉ Test da qui" button                               | in-memory `lastPreview` → Test Email fields                       |
| Media Library row      | Product featured image | "✦ Feat." button                                     | `prompt(SKU/ID)` → `rp_mm_ajax_set_featured`                      |
| CSV Feed row           | Jobs scheduler         | "⏱ Schedula" button                                  | `GH.jobsNewWithPreset({ kind:'csv_feed', params:{feed_id} })`     |
| Filter selection       | KicksDB Refresh        | Bulk action picker → "Refresh prezzi KicksDB"        | `kicksdb_refresh_pricing` action → `gh_bulk_dispatch_kicksdb_refresh()` |
| Any row con SKU        | KicksDB Refresh sub-tab| (futuro) call diretto                                | `GH.kdbRefreshSelected(skus)` (esposta, switcha tab + popola textarea + run) |

**Regola di design:** il tab target espone una funzione `GH.xxxOpenWith*(data)`
che accetta i dati, switcha tab, apre editor, popola state. Il tab sorgente
non conosce i dettagli del target — chiama solo la funzione esposta.

---

## Unified Visual Components

### `.gh-card` — base class per card cliccabili

```html
<div class="gh-card gh-card--clickable" onclick="...">...</div>
<div class="gh-card gh-card--compact">...</div>
```

Sostituira progressivamente `.rpem-tpl-card`, `.rpem-camp-card`,
`.rpem-trx-card`, `.gh-job-card` (che oggi hanno stile identico dopo
l'hover-consistency pass del Batch 5).

### `.gh-status` — chip di stato unificato

```html
<span class="gh-status gh-status--ok">Sent</span>
<span class="gh-status gh-status--err">Failed</span>
<span class="gh-status gh-status--warn">Pending</span>
<span class="gh-status gh-status--info">Scheduled</span>
<span class="gh-status gh-status--dim">Draft</span>
```

Le classi legacy `.em-st-*` e `.st-*` sono repaintate per matchare lo
stesso visual language (background 15% alpha + colored text + border
30% alpha) — nessun rename HTML necessario.

### Color alpha tokens

```css
--acc-10, --acc-15, --acc-30    /* --acc al 10%/15%/30% alpha */
--grn-10, --grn-15, --grn-30
--red-10, --red-15, --red-30
--amb-15, --amb-30
--pur-15, --pur-30
```

Da usare invece di literal `rgba(...)` per mantenere coerenza con la palette.

---

## KicksDB Integration — Architettura

KicksDB NON e un feed push: e un servizio di **lookup/enrichment** + **search/discovery**
sull'universo StockX. La selezione SKU arriva da:
- **Lookup** — paste manuale di N SKU
- **Discover** — search browser (query/brand/sort) → cherry-pick → bulk import
- **Refresh Pricing** — batch endpoint /stockx/prices su SKU gia tracked
- **Catalog viewer** — Filter & Agisci con condizioni `kicksdb_*` + bulk action

Tutte e quattro le sorgenti convergono nella stessa pipeline:
**fetch → normalize → diff → apply (con conflict engine)**.

### Layout file `/feeds/kicksdb/`

| File | Responsabilita |
|---|---|
| `client.php` | HTTP client. `gh_kicksdb_request` (sync, 3x backoff su 429/5xx, Retry-After honored) + `gh_kicksdb_request_multi` (sliding-window curl_multi 8 concurrent, identico pattern di `media-preimport.php`). High-level wrappers per `/stockx/products/{sku}` (con `display[variants\|traits\|identifiers]=true`), `/stockx/products` (search), `/stockx/prices` (batch chunked 50 SKU per call, 200ms gap tra chunk). |
| `settings.php` | `gh_kicksdb_get_settings/_save_settings/_get_settings_redacted`. Storage single-row in `gh_kicksdb_settings`. Pricing formula (`margin_pct` / `floor_price` / `rounding_mode` / `rounding_step` / `currency`), gallery defaults, concurrency, cache_ttl. **api_key sempre redatta** in output AJAX (`••••XXXX`). |
| `cache.php` | Transient cache 24h (TTL configurabile). `gh_kicksdb_get_product_cached(sku, force=false)`. Solo response 2xx cachate (404 non-cachato per evitare sticky-missing). |
| `pricing.php` | `gh_kicksdb_extract_standard_prices(prices_response, size_remap)` — **GOTCHA**: filtra `type === 'standard'` (skip `express_*`) E prende `MIN(price)` per size (lowest ask reale). `gh_kicksdb_apply_markup` con formula `round(max(market * (1+margin), floor))`. |
| `normalizer.php` | `gh_kicksdb_normalize($response, $opts)` → WC shape compatibile con `gh_create_variable_product()`. **Solo EU sizes**. Brand → `product_brand` (gerarchico: brand root + model child). Category heuristic → `sneakers`/`abbigliamento`. `gh_kicksdb_post_process()` consuma `_kdb_gallery_opts` e `_kdb_gallery_candidates` per il sideload immagini con cap 5 + dedup first-frame. Legge l'**active mapping profile** per: required-field check (WP_Error fail-fast), description template override. |
| `profiles.php` | Mapping profiles. `gh_kicksdb_profile_active()` ritorna l'unica profile attiva. Schema: `{ required_fields[], description_template, gallery_opts: { include_main, include_360, every_nth_360 } }`. Storage via `gh_option_list_*`. |
| `feed.php` | Orchestrator. `gh_kicksdb_fetch_skus(skus, opts)` → cache-aware parallel fetch. `gh_kicksdb_diff(woo_products)` → new/update/unchanged. `gh_kicksdb_apply(diff, opts)` → routing per conflict engine. `gh_kicksdb_refresh_pricing(skus)` → path dedicato batch endpoint (gated da `_gh_kicksdb_tracked='1'`). |
| `ajax.php` | `gh_kicksdb_settings_get/_save/_test_connection/_lookup/_search/_apply/_refresh_pricing/_profiles_*/_profile_sample_paths/_profile_preview_description`. |

### Meta scritti sul prodotto

| Meta | Tipo | Significato |
|---|---|---|
| `_gh_kicksdb_id` | string | UUID KicksDB del prodotto |
| `_gh_kicksdb_slug` | string | StockX slug |
| `_gh_kicksdb_gender` / `_colorway` / `_release_date` | string | Attributi opachi |
| `_gh_kicksdb_tracked` | `'1'` | **Gate per refresh-pricing**. Settato a create. Senza questo flag il refresh skippa silenziosamente. |
| `_gh_kicksdb_last_sync` | mysql datetime | Ultimo full enrichment |
| `_gh_kicksdb_last_price_sync` | mysql datetime | Ultimo refresh batch pricing |

### UI — un solo tab top-level "KicksDB" con 6 sub-section

| Sub-section | Funzione |
|---|---|
| **Discover** (default) | Search browser, grid responsive di card con thumbnail + state badge (`new`/`in_catalog`/`tracked`). Selezione + "Importa selezionati" che rispetta conflict rules. Paginazione con selection persistente. |
| **Lookup** | Paste N SKU → diff cards (new/update/unchanged) → "Applica". |
| **Refresh Pricing** | Paste SKU → batch refresh. Mostra per-SKU action + reason + sizes touched. |
| **Field Mapping** | CRUD mapping profiles con tree view del sample KicksDB (via `gh_mapper_extract_paths`), required field checkboxes, description template editor con placeholder chips + live preview, gallery opts. |
| **Provenance** | Backfill migration runner + per-product provenance lookup. |
| **Conflict Rules** | CRUD conflict rules (vedi sezione successiva). |
| **Settings** | API key + base URL + market + concurrency + pricing formula. "Test connection" smoke test. |

### Smoke test sequence

1. Settings → paste API key → Test connection → expect HTTP 200 + duration.
2. Discover → query "Nike Dunk Low" → seleziona 2 card "Nuovo" → Importa →
   confirm. Verify nuovo prodotto WC creato con `_gh_kicksdb_tracked='1'`,
   `_gh_sources=[{source:'kicksdb',...}]`, brand+model in `product_brand`,
   `pa_taglia` con varianti EU.
3. Filter & Agisci → condition `kicksdb_tracked = yes` → run → conferma il
   prodotto appare. Bulk picker → "Refresh prezzi KicksDB" → conferma update.
4. Per-row "↻ KDB" su una riga della tabella GS/SF (se presente in KicksDB)
   → switcha tab e refresha la singola SKU.
5. Field Mapping → New profile → sample SKU `DD1873-102` → tree appare →
   spunta brand/sku come required → template `{brand} {model} - {colorway}`
   → Preview → set active → save. Re-import → description applicata.

---

## Cross-Feed Conflict Resolution — Architettura

Resolve "chi vince su quale slice" quando piu source toccano lo stesso prodotto.
Ship con due rule di default che proteggono i prodotti esistenti senza
configurazione manuale.

### Provenance meta per-prodotto

| Meta | Shape | Scopo |
|---|---|---|
| `_gh_sources` | `[{ source, first_seen, last_seen }]` | Audit log: quali source hanno mai toccato il prodotto |
| `_gh_field_sources` | `{ catalog: src, pricing: src, stock: src, media: src }` | Owner per slice |
| `_gh_primary_source` | `string` | Tiebreaker (sticky al first-in) |
| `_gh_import_source` | `string` | **LEGACY** — preservato per backward compat con feed esistenti |

Source canoniche: `manual`, `kicksdb`, `goldensneakers`, `stockfirmati`, `csv`.

### Slice & rule schema

4 slice: `catalog` (name/desc/attrs), `pricing` (regular/sale), `stock`,
`media`. Per ogni slice una rule puo dichiarare:
- `allow` — il source incoming scrive (default)
- `block` — skip
- `<source_name>` — scrivi solo se incoming === quel source

### Default rules (shipped)

| Pri | Label | When | Then |
|---|---|---|---|
| 10 | Manual is sacred | sources contains `manual` | tutto block |
| 20 | GS owns pricing+stock, KicksDB owns catalog+media | sources contains `goldensneakers` AND incoming `kicksdb` | catalog=allow, pricing=block, stock=block, media=allow |

> La rule #1 e la **garanzia di sicurezza** per prodotti gia presenti sul sito
> PRIMA di KicksDB. Senza una conflict rule esplicita aggiuntiva, KicksDB non
> scrive nulla su un prodotto manuale.

### Activation migration

`gh_conflict_on_activate()` (hook activation):
1. `gh_conflict_install_default_rules()` se non gia presenti
2. `gh_conflict_migrate_run()` — prima passata di backfill 200 prodotti

`gh_conflict_migrate_run(batch_size=200)`:
- SQL diretto su `wp_posts` (no WC hydration) → batch di 200 ID
- Per ciascuno: skip se `_gh_sources` gia popolato (idempotente)
- Mappa `_gh_import_source` legacy → source canonico (`gh_conflict_map_legacy_source`)
- Source default `manual` se nessun import_source → la rule manual_sacred li protegge
- Cursore persistente in `gh_conflict_migration_cursor` option

L'UI sub-tab Provenance mostra cursor/total + bottone "Esegui batch" per
catalog grandi (> 200).

### Engine

`gh_conflict_resolve(product_id, incoming, incoming_src, opts)` ritorna:
```
{ allowed_slices: [slice => bool],
  blocked:        [slice => reason],
  applied_rule:   string|null,
  current_sources: string[] }
```

Algoritmo: itera rule in ordine `priority asc`. Prima rule che matcha
(`when.sources_contains` ⊆ current AND `when.incoming` ⊆ incoming AND
`when.sources_any` ∩ current non vuoto) applica `then`. Se `stop_on_match`
(default true), fine. Altrimenti continua.

`opts.overwrite_manual = true` bypassa la rule `manual_sacred` per quella
specifica chiamata (mai esposto in UI; per uso programmatic).

### Wiring nei feed esistenti

GS / SF / CSV chiamano `gh_conflict_record_source(pid, source, slice_owners)`
DOPO il loro `update_post_meta('_gh_import_source', ...)` esistente. Modifiche
non-breaking: il legacy meta resta scritto, il nuovo meta si accumula.

KicksDB feed (`feed.php`): TUTTE le scritture su prodotti esistenti passano
per `gh_conflict_resolve()`. Slice bloccate vengono droppate silenziosamente
(loggate in `details[].blocked` per audit).

---

## Feed Credentials Storage — `feeds/feed-credentials.php`

Storage centralizzato per le credenziali dei feed (URL, Bearer token,
cookie). Sostituisce la coppia `gh_ajax_feed_save_settings` / `_load_settings`
originale che accettava qualsiasi `feed_key` / qualsiasi campo / nessuna
sanitizzazione / nessuna redaction.

### 8 layer di difesa

1. **Whitelist feed_key** — solo `goldensneakers` e `stockfirmati`. Tutto altro → 400.
2. **Schema per-feed** — type (`url` / `secret` / `text` / `enum`) + max length + allow_empty. Campi extra droppati silenziosamente.
3. **Sanitize per-tipo** — `esc_url_raw` con whitelist `http|https`, control-char strip su secret, `sanitize_text_field` su text, options membership su enum.
4. **Redact in output** — i campi `secret` nelle response GET sono mascherati a `••••XXXX` (last 4). Plaintext non lascia mai il server.
5. **Placeholder reject** — valori `^•+` su campi secret → trattati come "unchanged", il valore stored e preservato. Permette di salvare il form dopo un load round-trip senza ri-incollare il token.
6. **autoload=false** — credenziali read-on-demand, non ad ogni request WP.
7. **Length cap** — defensive (DB bloat) anche con auth admin.
8. **No logging** — questo modulo non logga; HTTP client redige header sensibili (`Authorization` / `Cookie` / `X-API-Key`) negli output AJAX.

> **Storage cleartext in DB e voluto.** Encryption con key in wp-config NON
> aggiunge sicurezza significativa (DB-attacker tipicamente ha anche wp-config)
> e rompe i backup standard. Difese reali: filesystem perms su wp-config,
> DB user perms, capability gating UI (qui), redaction consistente in OGNI
> output (qui).

### Schema corrente

```php
'goldensneakers' => [
    'url'    => [ type => url,    max => 4096, allow_empty => false ],
    'token'  => [ type => secret, max => 8192, allow_empty => false ],
    'cookie' => [ type => secret, max => 16384 ],
    'format' => [ type => enum,   options => [ 'hierarchical', 'flat' ] ],
],
'stockfirmati' => [
    'url' => [ type => url, max => 4096 ],
],
```

### Hidratation upstream

`rp_rc_ajax_gs_fetch` chiama `gh_feed_credentials_get('goldensneakers')` e
**riempie** i campi del config che il client ha mandato vuoti o redatti (`^•+`)
PRIMA di passare a `rp_rc_gs_fetch()`. Il placeholder redatto non raggiunge
mai l'API upstream. SF non ha secret quindi non serve hydration.

### UI

GS panel: Save button + token/cookie type=password con `autocomplete=new-password`
e `spellcheck=false` (defense in depth: no salvataggio password browser, no
spell-check service exfiltration). SF panel: Save button per URL.

Auto-load on tab open: i tab GS Feed / SF Feed nel sidebar chainano
`GH.gsLoadSettings()` / `GH.sfLoadSettings()` dopo `switchTab`. Il form si
popola con i valori salvati (token redatto) appena l'utente entra nel tab.

---

## Regole di Sviluppo per Claude Code

1. **Prefix corretto:** `gh_` per moduli nuovi (filter, bulk, jobs, mapper, core), prefix originale per moduli mergiati (rp_, rp_cm_, rp_em_, rp_mm_).
2. **Nonce:** `gh_nonce` per tutti gli AJAX di golden-hive. `gh_ajax_guard()` accetta anche `rp_em_nonce` per coesistenza.
3. **CSS scopato sotto `#gh`** — mai stili globali.
3b. **Accessibilità — non regredire**: ogni controllo cliccabile è un
   elemento nativo (`<button type="button">`, `<a>`), mai un `<div onclick>`:
   i div non prendono focus, non rispondono a Invio/Spazio e non vengono
   annunciati come controlli. La sidebar è un `<nav>` con heading `<h2>` per
   sezione; il tab attivo porta `aria-current="page"` (gestito da
   `switchTab`); le icone decorative sono `aria-hidden="true"`; il
   contenitore dei toast è `role="status" aria-live="polite"`. Gli stati di
   focus usano `:focus-visible` (non `:focus`, che lascerebbe l'anello anche
   dopo un click col mouse). Testo solo per screen reader: `.gh-sr-only`.
   I dialog (`GH.confirm`) fanno focus trap, `aria-labelledby`/`describedby`
   e **restituiscono il focus** all'elemento che li ha aperti.
4. **JS estende GH** — i moduli aggiuntivi (js-operations, js-email, ...) aggiungono metodi a `GH` dall'esterno e usano gli helper del Batch 1-2.
5. **Desktop-first, mobile secondario** — il titolare usa lo strumento prevalentemente da desktop. Le regole base devono assumere una larghezza ampia (≥1024px) e sfruttarla (layout a 2 colonne, liste a tutta larghezza, toolbar orizzontali). Sotto `@media(max-width:768px)` i layout collassano in flex-column come fallback, ma non e la priorita visuale. Niente `max-width` arbitrarie sui container principali (`.content`, `.panel`, liste/editor) che impediscano di usare lo spazio orizzontale.
6. **Double-load guard** obbligatoria su ogni file condiviso con plugin standalone.
7. **Editor wiring standard:** nuovi editor agganciano `GH.wireDirtyInputs + registerShortcuts + updateHash + registerDeepOpener` (vedi section "Convenzioni editor wiring").
8. **Cross-module hand-offs:** espongono `GH.xxxOpenWith*(data)` sul tab target; il sorgente non conosce i dettagli del target.
9. **Helper core:** moduli nuovi preferiscono `gh_option_list_*` / `gh_ajax_guard` / `gh_ajax_*` invece di re-inline del boilerplate. Il codice esistente stabile non viene migrato.
