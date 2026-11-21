# CLAUDE.md — Hive Sync

> Stai lavorando su **hive-sync**. Root: `/hive-sync/`.
>
> Ordine di lettura obbligatorio:
> 1. Questo file
> 2. `../CONVENTIONS.md` — convenzioni condivise
> 3. `../golden-hive/CLAUDE.md` — solo per capire il bridge legacy che
>    hive-sync chiama via `hive_sync/host/*` filter

---

## Contesto del Plugin

**Hive Sync** è il sostituto produzione-ready dell'import pipeline che
viveva in `golden-hive/includes/feeds/*`. Sostituisce GS / SF / CSV /
KicksDB feeds con una architettura a 3 buckets (new / update / patch)
che riduce drasticamente i tempi di sync. Standalone — funziona senza
Hive Commerce — ma quando GH è attivo delega `materialize` al bridge
legacy che ha tutta la logica varianti + sideload media.

Stato attuale (branch `claude/stabilize-hive-sync-plugin-FZjmQ`):

- ✅ Import GS end-to-end con varianti, stock per-size, media sideload
- ✅ 2 job default (uno per source) idempotenti — lo stesso job gestisce import iniziale + mantenimento, markup preservato
- ✅ **Scheduler 1.2** — heartbeat ogni minuto che *drena* i run (blocchi da 25s concatenati), slot ancorati al cron nel fuso del sito, lease atomica, stato del run fuori dalla config, Storico con totali dell'intero run. Vedi "Lessons learned / Lo scheduler"
- ✅ Source generico `JsonSource` con `flavor` knob
- ✅ Mapping editor visuale spina-fissa Woo + sezione Attributi + Avanzati + Custom
- ✅ Attributi globali (pa_brand, pa_model, pa_gender, pa_color, pa_material) mappabili
- ✅ Auto-create delle tassonomie `pa_*` mancanti (ResolveTaxonomy + wc_create_attribute)
- ✅ **Configurazione come codice** — un solo `project.json` esportabile/applicabile (sources + mappings + pipelines + rules + jobs), schema documentato per LLM
- ✅ Cockpit dashboard header con tile live-status
- ✅ Media management completo (browser, whitelist, safe cleanup)
- ✅ Strumenti / Nuclear Cleanup con typed-confirmation gate
- ✅ Markup per-rule sulla source-config (per categoria/brand/feed-field)
- ✅ `import_status` knob (publish/draft) per il workflow staged
- ✅ Resilienza tick-loop: retry-with-backoff + cursor-resume su errori transienti
- ✅ Limite "Max prodotti" sul Run tab per testare su feed grandi
- ✅ **Oscuramento dei prodotti spariti dal feed** (`options.retire_missing`) — il 5° bucket, reversibile e con freno anti-feed-troncato
- ✅ **Vista semplice per il cliente** (default) — Panoramica · Importa prodotti · Storico; tutto il resto dietro "Modalità avanzata". Vedi "Lessons learned / La vista semplice lavora per automazioni"
- ✅ **Import per categoria** (StockFirmati) — picker CAT → SUBCAT con conteggi dal feed e "già nel negozio"; `category_filter` con path esatti. Vedi "Lessons learned / Import per categoria"

---

## Stack

| Layer | Tecnologia |
|---|---|
| CMS / Commerce | WordPress 6.x + WooCommerce 8.x |
| PHP | 8.1+ (typed properties, `match`, readonly classes) |
| Autoload | Composer PSR-4 `HiveSync\` → `src/` |
| Storage | 8 tabelle dedicate `wp_hsync_*` (no CPT, no options-as-list) |
| Schedule | WP-Cron heartbeat ogni minuto → drain dei job dovuti (budget 240s), runner lease atomica in `wp_options` |
| UI | Vanilla JS + CSS scopati sotto `.hsync-wrap` (no React, no jQuery) |

---

## Struttura

```
hive-sync/
├── hive-sync.php             Entry. Activation seeds defaults, plugins_loaded boots.
├── composer.json             PSR-4 HiveSync\ → src/
├── includes/
│   ├── admin-page.php        Cockpit header + tab shells (3 semplici + 10 avanzati, data-advanced).
│   ├── ajax.php              ~30 wp_ajax_hsync_* handlers, all guarded.
│   ├── ajax-simple.php       Endpoint della vista semplice: overview, feed_settings_save,
│   │                           feed_categories, import_params, run_cancel + hsync_job_import_target().
│   ├── assets.php            Localize ajaxUrl + nonce + version.
│   ├── cron.php              Heartbeat 'hive_sync_jobs_tick' every minute + drain budget + daily upkeep.
│   ├── cron-fallback.php     admin_init throttled fallback (DISABLE_WP_CRON).
│   ├── host-adapter.php      Filter contract → bridge in golden-hive.
│   ├── migrate.php           dbDelta schema + GS→JSON one-shot data migration.
│   └── registrations.php     Self-register sources / operations / checks on boot.
├── src/
│   ├── Core/
│   │   ├── Bootstrap.php             Wires registries on hive_sync/core_booted.
│   │   ├── Source/                   Source contract + value objects.
│   │   ├── Operation/                Operation + ImportRule interfaces + registry.
│   │   ├── Check/                    Check + ImportCheck + registries.
│   │   ├── Pipeline/                 Pipeline + Step + Repository + Executor.
│   │   ├── Selection/                Selection mode (Ids / Filter / All).
│   │   └── Repo/                     DAOs over wp_hsync_* tables.
│   ├── Sources/
│   │   ├── JsonSource.php            ★ Generic JSON feed with `flavor` knob:
│   │   │                               'generic' = 1 row = 1 product
│   │   │                               'goldensneakers' = group by SKU + transform
│   │   ├── CsvSource.php             URL or local-file CSV w/ category_filter.
│   │   ├── StockOnlyClassifier.php   Splits update bucket → updateFull/updateStock.
│   │   ├── AttributeMerger.php       Promotes mapped pa_* keys into $data['attributes'].
│   │   ├── MissingMediaLookup.php    Batch "which pids have no usable featured image?".
│   │   ├── OwnedProductLookup.php    Batch "which products in Woo belong to this feed?".
│   │   ├── CategoryFilter.php        ★ `category_filter`: path esatti ("Cat > Sub" / "Cat > *")
│   │   │                               + forma legacy a sottostringa; albero del picker. Pura.
│   │   └── MarkupResolver.php        Per-rule markup evaluation (used by both sources).
│   ├── Operations/
│   │   ├── Status/SetStatus.php
│   │   ├── Pricing/AdjustPrice.php  + MarkupPercent.php (ImportRule)
│   │   ├── Stock/SetStockStatus.php + SetStockQuantity.php
│   │   ├── Media/DownloadMedia.php           ImportRule, parallel sideload via host.
│   │   └── Taxonomy/AutoCategorize.php       ImportRule, sneakers/abbigliamento heuristic.
│   │       /ResolveTaxonomy.php              ImportRule, name → term_id w/ create.
│   ├── Checks/
│   │   ├── Import/HasRequiredFields.php  + HasMediaUrl.php   (pre-import, FeedItem)
│   │   ├── Media/HasImages.php           (post-import, productId)
│   │   └── Taxonomy/HasCategory.php      (post-import, productId)
│   ├── Media/                              Media management module
│   │   ├── Whitelist.php                   Protezione attachment dall'eliminazione.
│   │   ├── UsageIndex.php                  Reverse map attachment → [{pid,role}], 10m cache.
│   │   ├── Browser.php                     Paginated query w/ filters + Safe Cleanup preview.
│   │   ├── Cleaner.php                     Bulk delete con whitelist + log FIFO 500.
│   │   ├── MissingImages.php               Scan catalog-wide dei prodotti senza copertina
│   │   │                                     + scelta del job per la riparazione.
│   │   └── Library.php                     set featured / gallery + reverse "used by".
│   ├── Tools/
│   │   └── NuclearCleanup.php              SQL-direct cleanup (products, media, tax, transients, orphans).
│   └── Workflow/
│       ├── Run/ImportRunner.php            ★ Orchestratore con buckets[new/update/updateStock]
│       │                                     + fast-stock-patch path + cooperative deadline.
│       ├── Run/RunTotals.php               Contatori dell'intero run portati dal cursor.
│       ├── Run/RunCache.php                fetch+diff tra i tick, TTL scorrevole (touch).
│       ├── Run/MediaHealer.php             Ri-bucketizza in `update` i prodotti senza
│       │                                     featured image (options.heal_media).
│       ├── Run/SkuFilter.php               Restringe il run a una lista di SKU
│       │                                     (options.skus) + promote a `update`.
│       ├── Run/MissingSweeper.php         ★ Il 5° bucket: prodotti che il feed ha
│       │                                     smesso di elencare (options.retire_missing).
│       │                                     Pura — guard matrix unit-testata.
│       ├── Run/ProductRetirer.php         Scrive l'oscuramento e lo annulla
│       │                                     (snapshot stato precedente → restore).
│       ├── Schedule/CronExpr.php           Parser 5-field cron, no shortcuts. Wall-clock in un fuso (DST-safe).
│       ├── Schedule/JobRunner.php          ★ tick = drain dei job dovuti; Run / Interrompi; slice per tipo.
│       ├── Schedule/Drainer.php            Il loop del drain (puro): budget, round-robin, stop.
│       ├── Schedule/DuePolicy.php          Chi è dovuto e in che ordine (puro).
│       ├── Schedule/JobSchedule.php        Slot: planAfter (ancorato) / afterRun (salta e conta).
│       ├── Schedule/RunState.php           Forma di wp_hsync_jobs.run_state (+ snapshot del job).
│       ├── Schedule/RunnerLease.php        Mutex CAS su una riga wp_options (OptionsLeaseStore).
│       ├── Schedule/SchedulerMigration.php One-shot 1.1 → 1.2 (cursor legacy, label, slot).
│       ├── Mapping/PathResolver.php        Dot-path traversal ('sizes.size_eu').
│       ├── Mapping/Template.php            {placeholder} substitution.
│       ├── Migration/LegacyImporter.php    Dormant — Migrazione tab removed.
│       ├── Export/Exporter.php             Inventory CSV/JSON + catalog-by-taxonomy.
│       ├── Config/ProjectExporter.php      ★ Dumps DB → project.json (secrets redacted).
│       ├── Config/ProjectApplier.php       ★ Validate/diff/apply project.json (atomic, prune-optional).
│       ├── Seed/Defaults.php               ★ Seeds 2 mappings + 6 pipelines + 2 default jobs.
│       └── Simple/                         Vista semplice (tutto puro, unit-testato):
│           ├── FeedOverview.php              job → card della Panoramica (cosa mostrare/nascondere).
│           ├── SimpleSettings.php            preset frequenza + "aggiungi nuovi" ↔ buckets.
│           └── FeedCategorySnapshot.php      cache compatta SKU → categoria del feed.
└── assets/
    ├── css/admin.css                       Cockpit styling, sticky tabs, HUD stats.
    └── js/admin.js                         Single HSync namespace, no jQuery, ~2700 LOC.
```

★ = files where most of the architecture lives.

---

## Pipeline lifecycle

Ogni Run passa per:

```
Source::fetch
  → Source::diff             { new, update, updateStock, unchanged }
  → MissingSweeper           { + missing }   (solo con options.retire_missing)
  → ImportRunner loop:
      per ciascun item nel processing pool (filtrato da options.buckets):
      ├─ if bucket === 'missing':
      │   └─ ProductRetirer::retire / ::restore (no pipeline, no materialize)
      ├─ if bucket === 'updateStock':
      │   └─ ImportRunner::fastStockPatch (no pipeline, no materialize)
      │       set_regular_price + set_sale_price + set_stock_quantity + save
      └─ else:
          ├─ pipeline.preCheckSteps  (block-severity skips item)
          ├─ pipeline.importRuleSteps (mutate the FeedItem.data draft)
          │   - markup_percent (con override per-job)
          │   - media.download
          │   - taxonomy.auto_categorize
          │   - taxonomy.resolve
          ├─ Source::materialize  (delegated to host bridge for GS)
          └─ pipeline.checkSteps     (productId-scoped, post-create)
```

`options.buckets = ['new'|'update'|'updateStock']` filtra cosa entra
nel pool. Così un job "refresh-stocks" processa SOLO updateStock con
il fast-patch path. È la chiave perf-critica del sistema.

---

## Buckets — la chiave architetturale

Il `Diff` ha 5 buckets. I primi quattro sono costruiti camminando le
righe del feed; il quinto è l'unico costruito guardando il catalogo.

| Bucket | Significato | Path |
|---|---|---|
| `new` | SKU non esiste in Woo | Pipeline completa + create |
| `update` | SKU esiste, campi non-stock cambiati | Pipeline completa + materialize |
| `updateStock` | SKU esiste, SOLO prezzo/stock cambiati | Fast-patch (no pipeline, no media) |
| `unchanged` | Nessuna differenza | Skip totale |
| `missing` | Prodotto in Woo che il feed **non elenca più** | `ProductRetirer` (no pipeline, no materialize) |

> ⚠ **Il confronto NON guarda le assenze** — a meno di
> `options.retire_missing`. I primi quattro bucket rispondono tutti alla
> domanda "il feed ha nominato questo SKU?". Uno SKU che il fornitore
> **toglie dal listino** non è nominato da niente: non finisce in nessun
> bucket, nessun codice lo tocca più, e resta pubblicato e acquistabile
> per sempre. `MissingSweeper` è l'unica cosa che chiude il buco.
> Vedi "Lessons learned / Il diff è cieco sulle assenze".

`StockOnlyClassifier::split()` decide tra `update` e `updateStock`
confrontando ogni campo non-stock incoming vs il prodotto Woo
esistente. Se TUTTI i campi non-stock combaciano → `updateStock`.

> ⚠ **Il confronto NON guarda i media.** Un prodotto rimasto senza
> immagine (sideload fallito, URL upstream rotto, attachment
> cancellato) combacia col feed su tutto ciò che il diff ispeziona e
> resta in `unchanged` per sempre — nessuna sync lo ripara. È per
> questo che esiste `options.heal_media`, che lo rimette in `update`.
> Vedi "Lessons learned / Il diff è cieco sui media".

Un import "rinfresca tutto" tipico su un catalog di 5K prodotti:
- ~20 `new` → pipeline completa, ~2-4s ciascuno
- ~30 `update` → pipeline completa
- ~4900 `updateStock` → fast-patch, ~10-30ms ciascuno

Tempo totale: 2-3 minuti invece di 4-5 ore.

---

## JsonSource — `flavor` knob

```php
configSchema():
  - url             (required)
  - token           (Bearer, optional)
  - cookie          (optional)
  - flavor          enum: 'generic' | 'goldensneakers'  DEFAULT: 'generic'
  - import_status   enum: 'publish' | 'draft'           DEFAULT: 'publish'
  - markup_percent  int (fallback %)                    DEFAULT: 0
  - markup_rules    list[ {field, operator, value, percent} ]  DEFAULT: []
```

Comportamento per flavor:

| Flavor | Fetch | Materialize |
|---|---|---|
| `generic` | 1 row response = 1 product, pass-through to mapping | `hsync_upsert_product` host adapter |
| `goldensneakers` | Group flat rows by SKU, run `transformToWoo()` | Bridge `hsync_gs_materialize` (varianti + sideload) |

GS-specific code (transformToWoo, _gs_brand, EU size pattern) gira
SOLO quando `flavor=goldensneakers`. Per altri JSON feed → `flavor=generic`
e l'utente mappa i campi liberamente.

Migration `hsync_migrate_gs_to_json()` ha già spostato tutti i
`source_kind='goldensneakers'` esistenti a `'json'` con
`config.flavor='goldensneakers'`. Idempotente, runs once.

---

## Configurazione come codice — `project.json`

Tutto lo stato persistente del plugin (source-configs, mappings,
pipelines, rules, jobs) è esportabile come **un solo documento JSON
versionato** (`hive-sync/project/v1`) e ri-applicabile incollandolo
nel tab **Config**. Pensato per:

- generare/modificare configurazioni con un LLM (paste-edit-paste)
- versionare la config in git separatamente dal DB
- replicare un'installazione da un cliente all'altro
- ridurre la dipendenza dal mapping editor visuale

### Schema

Il contratto è in `docs/project.schema.json` (JSON Schema 2020-12).
LLM-friendly: descrizioni inline per ogni campo, esempi end-to-end,
enum dichiarati per kind / pipeline-step / runnable-type.

```
project.v1 = {
  $schema:   "hive-sync/project/v1",
  version:   1,
  sources:   [{ slug, name, kind, config:{...} }],
  mappings:  [{ slug, name, source_kind, config:{ <woo>: <feed-path>|<template> } }],
  pipelines: [{ slug, name, steps:[{ kind, ref_id, params, note }] }],
  rules:     [{ slug, name, enabled, selection, operations, checks }],
  jobs:      [{ slug, runnable_type, runnable_ref, cron, enabled, options:{...} }],
}
```

### AJAX endpoints

| Action | Verb | Effetto |
|---|---|---|
| `hsync_ajax_project_export` | GET-style | Dump dello stato corrente. Secrets redatti `••••XXXX`. |
| `hsync_ajax_project_validate` | POST `project=<json>` | Valida + ritorna `{ ok, errors[], diff{} }`. |
| `hsync_ajax_project_apply` | POST `project=<json>&prune=0|1` | Esegue il diff. Atomic per-entità (ogni save() è già una upsert). |

### Strategia secrets

L'export sostituisce token/cookie/api_key con `••••XXXX` (last-4 form
gestita da `SourceConfigRepository::redact`). L'applier (vedi
`ProjectApplier::stripRedactedSecrets`) **droppa silenziosamente**
ogni valore secret che inizia con `•`. La save() del repo riceve
`$existingConfig` e ri-pesca il valore stored. Risultato: **paste del
JSON esportato → token preservato senza re-typing**.

### Stable identity per i job

`wp_hsync_jobs` non ha colonna `slug`. Il convention shipped dal
seeder è `config._seed_id`. L'exporter:
1. Usa `_seed_id` quando presente.
2. Fallback: deriva slug da `lower(runnable_type-runnable_ref)` +
   hash 6-char di `(type|ref|cron)`. Stabile across export.

L'applier upserta per slug e re-stamp `_seed_id` sul row salvato.

### Modalità prune

Default = additive. `prune=true` cancella le entità presenti nel DB
ma assenti dal documento — modalità "fonte di verità". Confermata
con `confirm()` lato JS perché distruttiva.

### Limiti noti

- Le `wp_hsync_runs` (audit log) NON sono nel project doc — sono dati
  operativi, non config.
- L'auto-incremento `wp_hsync_jobs.id` non è preservato across export
  (l'applier ricicla l'id esistente quando trova il match per slug).

---

## Attributi globali (pa_*) — promozione dal mapping

Il mapping editor espone una sezione **Attributi** con cinque slot
canonici (`pa_brand`, `pa_model`, `pa_gender`, `pa_color`, `pa_material`)
+ `pa_taglia` (variazione, già usato per le size). Ogni slot accetta
o un campo del feed (`brand_name`, `_sf_color`, ...) o un template
`{placeholder}`. L'operatore può dichiarare ulteriori `pa_*` nella
sezione Personalizzati — il pipeline li tratta esattamente come quelli
canonici.

Pipeline di propagazione:

```
fetch():
  source-transform crea $woo['attributes'][pa_taglia|pa_brand]   (legacy)
  + il mapping overlay aggiunge $data['pa_<slug>'] = '<valore>'   (post-fetch)
AttributeMerger::promoteFromDraft($data):
  per ogni pa_* in $data:
    se $data['attributes'][pa_*] esiste → unione options
    altrimenti → nuovo slot {options:[v], visible:true, variation:false}
materialize:
  bridge legge $data['attributes'] e wira gli attributi Woo
ResolveTaxonomy::applyDuringImport():
  per ogni pa_* (top-level OR dentro attributes.options):
    if ! taxonomy_exists(pa_<slug>) AND create_missing: wc_create_attribute()
    risolve / crea termini → $data['attribute_terms'][pa_<slug>] = int[]
```

**Idempotenza:** il merger è una funzione pura della draft input, e
`wc_create_attribute()` è no-op quando la tassonomia esiste già
(memoizzato in static cache per request).

**Solo `pa_taglia` resta variation=true** — generato dal source
transform su `sizes[]`. Tutti gli altri attributi mappati sono
facet-only (visible=true, variation=false) by design: il modello
varianti è flat `pa_taglia` per non rompere il bridge legacy.

**Default mappings:**

| Slug | Attributi forniti dal seeder |
|---|---|
| `gs-default` | `pa_brand` ← `brand_name`, `pa_model` ← `product_name`, `pa_taglia` ← `sizes.size_eu` |
| `sf-default` | `pa_brand` ← `_sf_brand`, `pa_model` ← `name`, `pa_gender` ← `_sf_sex`, `pa_color` ← `_sf_color`, `pa_material` ← `_sf_material` |

GS espone meno campi (no gender/color/material): l'operatore può
arricchire il mapping a mano se l'upstream aggiunge quelle colonne.
Il riferimento canonico per il "complete product" rimane il
normalizer KicksDB in `golden-hive/includes/feeds/kicksdb/normalizer.php`.

---

## Markup — architettura idempotente

**Markup è una proprietà della source-config, non un'Operation
periodica.** Decisione critica perché le Operation periodiche
applicate a prodotti esistenti compongono il prezzo (1.20× → 1.44× →
1.73× ...). Vedi sezione "Lessons learned".

Schema sulla source-config:

| Campo | Tipo | Comportamento |
|---|---|---|
| `markup_percent` | int | Fallback % applicato a tutti i prodotti che non matchano una regola |
| `markup_rules` | list | Regole ordinate `{field, operator, value, percent}` |

**Risoluzione** (`HiveSync\Sources\MarkupResolver`):

```
Per ogni FeedItem nel fetch():
  multiplier = first_match_or_fallback(markup_rules, item.data, markup_percent)
  item.data[regular_price] = feed_price × multiplier
  item.data[sale_price]    = feed_sale  × multiplier  (se presente)
```

**Operatori supportati:** `equals`, `not_equals`, `in`, `not_in`,
`contains`, `starts_with`. `field` supporta dot-path (`meta.brand`).
Match contro feed-fields, NON contro tassonomie Woo (vedi sotto).

**Perché feed-fields invece di tassonomie Woo:**

- 10k prodotti × WP taxonomy lookup at fetch time = N+1 lento
- Il feed è la source of truth per le tassonomie (mapping → product_cat /
  product_brand). Matchare la stringa di partenza è equivalente.
- Funziona per prodotti NEW che ancora non esistono in Woo.

**Idempotenza per costruzione:**

- `multiplier = f(feed_row)` — funzione pura della riga feed
- `Woo_price emesso = feed_price × multiplier` — output deterministico
- Re-run N volte produce lo stesso `Woo_price` di un run singolo
- Nessun "skip if already marked-up" check, nessuna finestra di compounding

**Comportamento attraverso i bucket:**

- `new`: pipeline + create con `regular_price` già markato
- `update`: pipeline + materialize stesso valore markato
- `updateStock`: fast-patch usa `item.data['regular_price']` che è
  già markato → idempotente
- Cambio prezzo upstream: `feed=100 → marked=120 → Woo=120` →
  `feed=110 → marked=132 → diff vs Woo=120 → updateStock → Woo=132`

**SF flavor (CsvSource):** ignora `markup_percent` + `markup_rules` —
ha la sua formula dedicata `sf_markup_mode` + `sf_markup_value`
(moltiplicatore o percentuale sul cost wholesale). Stesso principio
di idempotenza, formula diversa.

**Config UI:** field type `markup_rules` rendera un repeater con
`field` / `operator` / `value` / `%` per riga + `[+ Aggiungi regola]`.
Hidden `<input>` carrier porta il JSON. Hydration in
`loadSourceConfigEditor` re-renderizza le righe da array salvato.

---

## Default jobs (2 jobs — uno per source, idempotente)

Tutti seeded DISABLED. L'operatore configura le source-config
(`json/gs-prod`, `csv/sf-prod`) nel tab Connetti, poi accende i
job in Automatizza.

| Slug | Label | Cron | Buckets | Scopo |
|---|---|---|---|---|
| `gs-sync` | GS — Sync catalogo | `0 */2 * * *` | tutti (default) | Importa + mantiene il catalogo GS. Self-rebalancing. |
| `sf-sync` | SF — Sync catalogo | `0 */2 * * *` | tutti (default) | Stesso modello per StockFirmati. |

Le label dicono **cosa** fa il job, mai **ogni quanto**: la cadenza è il
cron, e l'operatore la cambia. Una label "ogni 2h" accanto a un cron
`*/30` è esattamente come lo scheduler ha cominciato a sembrare rotto.

Entrambi shippano con **`retire_missing: true`, modo `hidden`** — è
l'unico default seeded che tocca prodotti esistenti, e ci sta perché
un job di sync che solo aggiunge e aggiorna non è un default prudente,
è un default sbagliato: lo SKU delistato resta in vendita e il negozio
prende ordini che non può evadere. Vedi "Lessons learned / Il diff è
cieco sulle assenze" per i guard che lo rendono sicuro da lasciare su
un cron. Per spegnerlo: Automatizza → job → Opzioni di run.

**Default Rules:** nessuna. La tabella `wp_hsync_rules` ships vuota —
vedi sezione "Lessons learned" sul perché.

`runnable_ref = '<kind>/<config_slug>'`. JobRunner risolve
`options.mapping_slug` → mapping config a dispatch time.

### Perché un solo job per source (non 2, non 6)

- **Il diff è idempotente.** ImportRunner ricomputa `new`/`update`/
  `updateStock` ad ogni tick. Prima esecuzione su catalogo vuoto →
  tutto in `new`. Esecuzioni successive → quasi tutto noop, qualche
  `updateStock`, occasionale `update`. Stesso job, stesso codice,
  shape diversa in base allo stato. Nessuna ragione architetturale
  per separare il "first-time" dal "maintenance".
- **La pipeline è idempotente by design.** `media.download` ha
  `skip_if_set: true`, `taxonomy.auto_categorize` ha `override:
  false`, `taxonomy.resolve` usa `create_missing`. Re-eseguire su
  uno SKU "settled" è quasi un noop.
- **Markup preservato.** Nessuno step `pricing.markup_percent` nella
  pipeline. Il markup è applicato a monte da `JsonSource::fetch` /
  `CsvSource::fetch` via `markup_percent` + `markup_rules` della
  source-config — il prezzo che arriva alle scritture è già
  post-markup. Né fast-stock-patch né full pipeline lo toccano.
- **First-run lunghi sono safe.** ImportRunner ha cooperative
  deadline 25s + cursor resume; il heartbeat concatena i blocchi
  senza pause (drain) finché il cursor non si esaurisce — un primo
  import da N migliaia di SKU avanza in continuo, un giro al minuto
  da fino a ~4 minuti. Una volta a regime, ogni run dura un attimo.
- **Splittare è MENO corretto.** Se un job ad-hoc gestisce solo
  `[new]` e un cron gestisce `[update,updateStock]`, gli SKU nuovi
  che il fornitore aggiunge tra trigger manuali NON entrano fino al
  prossimo trigger manuale. Combinare i bucket nello stesso job
  cattura tutto in modo deterministico.
- **Controllo editoriale sui nuovi prodotti.** Risolto da
  `import_status: draft` sulla source-config — i nuovi entrano come
  bozze, l'operatore pubblica quando vuole. Non serve un secondo
  job per "trattenere" i nuovi.

L'operatore può comunque eseguire on-demand via "Esegui adesso" sul
pannello del job (es. per testare dopo aver wired le credenziali).
Il cron automatizza esattamente quello che fa il bottone manuale.

### Reseed pulito (force=true)

Il bottone "Aggiorna default" (Mappa tab) chiama
`Defaults::install( force=true )`. In questa modalità il seeder:

1. Upserta i mapping/pipeline/job correnti (slug match).
2. **Cancella i job seeded il cui `_seed_id` non è più nella lineup
   canonica** — auto-derivato da `defaultJobs()`.
3. **Cancella mapping/pipeline il cui slug è in
   `obsoleteSeedSlugs()`** — lista hard-coded perché
   mapping/pipeline non hanno marker `_seed_id` (la lookup è per
   slug nudo). Trade-off: un user mapping che si chiama come uno
   storicamente seeded VERREBBE eliminato. Per evitarlo, mai
   chiamare un proprio mapping come `csv-minimal` o un proprio
   pipeline come `import-sf-with-markup`.

Job creati a mano (no `_seed_id`) sono sempre intoccati.

**Lo schedule di un job seeded esistente è dell'operatore:** con
`force` il seeder aggiorna runnable + config + label, ma **conserva**
`cron_expr`, `enabled` e `next_run_at`. Prima li resettava: un
"Aggiorna default" cliccato per avere un mapping nuovo spegneva tutte
le sync di produzione e le riportava alla cadenza di default.

---

## Tab UI — vista semplice + modalità avanzata

Il cliente finale non è un tecnico: di default vede **tre tab**. Lo
switch "Modalità avanzata" nell'header (preferenza per browser,
`localStorage['hsync.advanced']`) mostra anche i dieci tab tecnici.
Ogni elemento tecnico porta `data-advanced` ed è nascosto via CSS
finché `#hsync-app` non ha `.is-advanced`; il markup parte in modalità
semplice, così niente di tecnico lampeggia prima del JS.

| Vista | Tab | data-tab | Scopo |
|---|---|---|---|
| sempre | Panoramica | `home` | Riga di stato ("Tutto in ordine" / cosa controllare) + una card per automazione: accesa/spenta, frequenza (preset), "aggiungi da sola i nuovi prodotti", Sincronizza ora / Interrompi, ultimo esito in parole |
| sempre | Importa prodotti | `import` | Fornitore → tutto il catalogo **o solo alcune categorie** (picker) → un bottone; progresso, Interrompi, Riprendi |
| sempre | Storico | `runs` | In semplice: quando / cosa (+ "solo Calzature") / esito / risultato in parole. In avanzata: le colonne tecniche + pulizia |
| avanzata | 1 Connetti | `sources` | Saved source-configs (URL + auth) per sorgente |
| avanzata | 2 Mappa | `mappings` | Visual mapping spina-Woo + Avanzati + Custom |
| avanzata | 3 Componi | `pipelines` | CRUD pipeline (pre-check / import-rule / post-check) |
| avanzata | 4 Regole | `rules` | Scoped operations su prodotti esistenti |
| avanzata | 5 Import manuale | `run` | Esecuzione ad-hoc con tutte le opzioni (dry-run, limiti, SKU, modi, spazzata) |
| avanzata | 6 Automatizza | `jobs` | Schedule cron + Action Scheduler health |
| avanzata | Media | `media` | Browser + Safe Cleanup orfani + **Prodotti senza immagine** (scan + ripara) |
| avanzata | Esporta | `exports` | Inventario CSV/JSON + catalog by taxonomy |
| avanzata | Strumenti | `tools` | Nuclear Cleanup (manage_options gate) |
| avanzata | Config | `config` | project.json: esporta / valida / applica |

`HSync.switchTab()` riporta alla Panoramica qualunque tab tecnico
richiesto in modalità semplice (link vecchi, "goto", switch appena
spento): mai un pannello nascosto attivo.

---

## Cockpit header

Live-status strip sopra i tab. AJAX `hsync_ajax_cockpit_status`
ritorna in una call:

- Jobs: `enabled / total`
- Last run: `created + updated + patched` con timestamp e `failed` callout
- Catalog: `count(post_type=product, status NOT IN trash/auto-draft)`

Refresh automatico ogni 30s. Bottone "Esegui ciclo automatizzazioni"
forza un dispatch immediato senza attendere il cron.

Tile e bottone esistono **solo in modalità avanzata**. In quella
semplice l'header è nome + switch, e lo stato vive nella riga in cima
alla Panoramica (che legge lo stesso `cockpit_status` + `system_status`).
Il banner rosso WP-Cron dell'header è anch'esso solo avanzato: la
Panoramica ne mostra la versione a parole ("le sincronizzazioni non
stanno partendo…", con il crontab in "Dettagli per il tecnico"), e solo
se almeno un'automazione è accesa. Problema = nessun heartbeat
pianificato **o** in ritardo di oltre 10 minuti: un tick in ritardo di
pochi secondi è normale (WP-Cron scatta alla richiesta successiva) e
prima veniva segnalato come "nessun evento pianificato".

---

## Tabelle (8)

```
wp_hsync_mappings        external→Woo field maps
wp_hsync_pipelines       lifecycle compositions
wp_hsync_rules           scoped operations + selection
wp_hsync_jobs            scheduled or ad-hoc Runnable refs
                         + run_state (JSON, run in volo) + run_control ('run'|'stop')
wp_hsync_runs            execution audit (per Runnable invocation)
wp_hsync_checks          saved Check definitions
wp_hsync_source_configs  per-source credential bundles, secrets cleartext
                         (autoload=false), redacted in UI on read
```

Nessuna option-as-list. Tutto in tabelle dedicate con index +
slug-or-id addressing.

---

## Host adapter contract

Filtri che il bridge in golden-hive può binding-are. Default = stub /
no-op quando il bridge non è caricato (usabile standalone).

| Filter | Chi lo chiama | Cosa fa |
|---|---|---|
| `hive_sync/host/taxonomy/resolve` | ResolveTaxonomy | name → term_id, crea se manca |
| `hive_sync/host/media/preimport_batch` | DownloadMedia | parallel curl_multi sideload |
| `hive_sync/host/product/upsert` | JsonSource generic mat. | create/update Woo product |
| `hive_sync/host/source/gs/materialize` | JsonSource gs mat. | rp_rc_gs_create/update_product |
| `hive_sync/host/conflict/resolve` | (TODO wired) | per-slice write veto |

Contract version: `HSYNC_HOST_CONTRACT_VERSION = 1`.

---

## WP-Cron in produzione (CRITICAL)

L'intera catena di automazione (ogni job, refresh stocks, cleanup
periodico) gira su `wp_schedule_event` con hook `hive_sync_jobs_tick`
**ogni minuto** (schedule `hsync_1min`; un'installazione aggiornata
che ha ancora l'evento sul vecchio `hsync_5min` viene rischedulata
da sola all'`init`). Ogni giro:

- se niente è dovuto esce subito — due letture, **zero scritture**;
- altrimenti prende la runner lease e **drena**: blocchi da 25s
  concatenati finché niente è dovuto o finisce il budget
  (`hsync_cron_drain_budget()`: default 240s, costante
  `HSYNC_CRON_DRAIN_BUDGET` o filtro `hive_sync/cron/drain_budget`,
  sempre ≤ 80% del `max_execution_time` in vigore).

Un giro lungo non affama gli altri hook: dopo 60s WP-Cron lascia
partire una nuova richiesta, che esegue il resto della coda WP e
rimbalza sulla lease di Hive Sync.

**Il default WordPress** fa scattare gli eventi cron sul page-load di
un visitatore — fragile su siti a basso traffico, spesso la causa di
"i job non partono".

**Setup raccomandato in produzione:**

1. In `wp-config.php`:
   ```php
   define( 'DISABLE_WP_CRON', true );
   ```
2. Cron di sistema (Linux) — `crontab -e`:
   ```
   * * * * * curl -s "https://example.com/wp-cron.php?doing_wp_cron" > /dev/null 2>&1
   ```
   (o `wp cron event run --due-now` via WP-CLI se presente.)

Senza questo setup, gli eventi possono restare "in coda" finché un
admin non visita una pagina del sito. Il cockpit header espone uno
status banner rosso quando `hive_sync_jobs_tick` è in ritardo di
oltre 10 minuti — cattura i casi in cui WP-Cron è broken.

L'AJAX `hsync_ajax_system_status` ritorna i dati grezzi
(`next_tick_at`, `disable_wp_cron`, `recommended_crontab`, `overdue`)
per debug rapido.

## Pulizia + lifecycle (no junk)

Il plugin è progettato per non lasciare tracce su disk/DB se si
disinstalla. Cosa scrive e come si pulisce:

| Cosa | Dove | Pulizia |
|---|---|---|
| 8 tabelle `wp_hsync_*` | DB | DROP in `uninstall.php` |
| 6 options (`hsync_db_version`, `hsync_migrated_gs_to_json`, `hsync_migrated_scheduler_v2`, `hsync_media_whitelist`, `hsync_media_deletion_log`, `hsync_runner_lease`) | `wp_options` | `delete_option` in `uninstall.php` (la lease anche in deactivation) |
| transients (usage index, RunCache `hsync_run_cache_<id>`, tick lock pre-1.2) | `wp_options` (transient_*) | `delete_transient` / wildcard in `uninstall.php` + deactivation |
| `hsync_runs_pruned_today` | transient | Auto-expires DAY_IN_SECONDS |
| `hsync_feed_cats_<md5(sorgente/config)>` | transient (snapshot SKU → categoria del picker) | Scade da sola (`HSYNC_FEED_CATS_TTL`, 30 min) + wildcard in `uninstall.php` |
| WP-Cron event `hive_sync_jobs_tick` | `cron` option | `wp_clear_scheduled_hook` in deactivation + uninstall |
| File su disk | nessuno | n/a — non scriviamo file standalone (le immagini sideloaded vivono nella WP media library standard) |

**Crescita controllata:**

- `wp_hsync_runs` viene auto-prunata ogni 24h dal cron tick:
  - `hsync_runs_retention_days` (default 30) — DELETE finished runs older than N days
  - `hsync_runs_keep_max` (default 5000) — safety cap, trim a tutti tranne i più recenti N
  - run `running`/`continue` fermi da 24h che nessuno farà più avanzare
    (un Importa col tab chiuso) → `abandoned`. I run dei job — anche in
    pausa — sono esclusi.
- `hsync_media_deletion_log` capped FIFO a 500 entries da `Cleaner::LOG_MAX`
- Action Scheduler (se Woo lo usa) ha la propria gestione retention separata — vedi tab Automatizza → Stato del motore

**Bottoni di pulizia manuale (UI):**

| Tab | Bottone | Effetto |
|---|---|---|
| Storico | Cancella più vecchi di 7/30 giorni | `runs_purge_older` AJAX |
| Storico | Cancella tutto lo storico | `runs_purge_all` AJAX |
| Media | Svuota log eliminazioni | `media_log_clear` AJAX (delete_option) |
| Automatizza | Stato del motore → Purge past-due | Action Scheduler retention |
| Strumenti | Nuclear Cleanup | Bulk delete per scelta operatore |

## Idempotency / migration markers

| Option | Scope | Reset condition |
|---|---|---|
| `hsync_db_version` | Schema migration tracker | `!== HSYNC_VERSION` runs `hsync_migrate_schema()` |
| `hsync_migrated_gs_to_json` | One-shot data migration done | Set to `'done'`, never re-runs |
| `hsync_migrated_scheduler_v2` | 1.1 → 1.2: cursor legacy → run_state, label senza cadenza, slot ripianificati nel fuso del sito | Set to `'done'` solo dopo che dbDelta ha aggiunto le colonne |

Defaults seeder (`Defaults::install()`) is **additive idempotent** by
default — won't overwrite existing slugs. Pass `force=true` to
overwrite (UI: "Aggiorna default" button in Mappa tab).

---

## Convenzioni

1. **PSR-4** stretto: file path = class FQN. `src/Sources/JsonSource.php` → `HiveSync\Sources\JsonSource`.
2. **AJAX nonce**: `hsync_nonce`. `hsync_ajax_guard()` enforces it + `manage_woocommerce`. Strumenti tab usa `hsync_ajax_admin_guard()` con `manage_options`.
3. **Strict types** ovunque (`declare(strict_types=1);`).
4. **Readonly classes** per value objects (FeedItem, Diff, MaterializeResult, ...).
5. **ID enum** sulle Operation / Check classes (`public const ID = 'taxonomy.resolve'`) — registrate via `Bootstrap::$operations->register(new ...)`.
6. **CSS scopato sotto `.hsync-wrap`** — niente regole globali.
7. **JS estende `HSync.*`** — no jQuery, no global window pollution oltre `HSync` + `HSyncBoot`.

---

## Smoke test (after fresh install)

1. Mappa → "Aggiorna default" — pulls latest seeded mappings/pipelines/jobs.
2. Connetti → JSON card → compila URL+token, salva come `gs-prod`, premi "Test fetch".
3. (Opz.) Aggiungi `markup_percent: 25` + una regola `_gs_brand equals Nike → 35`.
4. Importa → seleziona `json` source, `gs-prod` config, `gs-default` mapping, `import-default` pipeline → "Max prodotti: 5" → uncheck Solo prova → "Importa adesso".
5. Verify: prodotti creati come `variable` con `pa_taglia` + variants per ogni size + stock per variant + media sideloaded. Prezzi = `feed × multiplier` per regola matchata.
6. Storico → vedi run con `created: N / stock_patched: M` reconciliation.
7. Re-run senza modificare il feed → tutti i prodotti finiscono in `unchanged` (idempotency check).
8. Automatizza → accendi `GS — Sync catalogo` → entro un minuto la card mostra "In corso" con il progresso, poi "Ultimo run: Completato … · N scritti" e la prossima esecuzione sulla griglia del cron (orari nel fuso del sito). Price/stock sincronizzati senza compounding.

---

## Branch + commits

Lavoro produzione: branch `claude/migrate-hive-sync-features-dkJLJ`.
Commit atomici con messaggio che spiega *why* non solo *what*. Ogni
PR/merge passa per main attraverso review umano.

Storico commits significativi (più recenti in cima):

- `4141f79` — per-taxonomy markup rules sulla source-config (MarkupResolver)
- `117bf67` — markup rifattorizzato: source-config field, non Rule periodica
- `04c6f8e` — Rule editor filtra ImportRule ops + error_samples nei run
- `51e9376` — staged-publish workflow (import_status + Rule pickers)
- `d137432` — `options.limit` per cap dei run su feed grandi
- `f20c3b6` — resilienza tick-loop: retry-with-backoff + cursor-resume
- `932cb79` — cockpit header + sticky tabs + HUD stats
- `a77470b` — generic JsonSource + cron-IT translator
- `03d09cb` — JS sums result counters across ticks
- `632e9e4` — GS produces bridge-ready Woo shape (variants + stock)
- `2d164ab` — GS aggregates flat rows by SKU
- `46dbc00` — Auto-categorize Sneakers / Abbigliamento
- `300c265` — three-bucket sync (new / refresh / re-update)
- `13d8bde` — credential save in Sources tab + visual mapping editor + nuclear cleanup
- `ab88bbf` — media management + tab intros + skip-reason fix

`git log --oneline claude/migrate-hive-sync-features-dkJLJ` per il
log completo.

---

## Lessons learned

Decisioni di design che è facile rifare male senza memoria del perché.

### Markup non è una Rule periodica

**Tentazione:** "applica +20% periodicamente alla categoria X" come
Rule schedulata. **Trappola:** Rules operano su prodotti esistenti
moltiplicando il prezzo Woo corrente — esecuzioni ripetute compongono
(`120 → 144 → 173 ...`).

**Soluzione:** markup è proprietà della source-config, applicato
durante `fetch()` al prezzo del FEED (non a quello Woo). Output
deterministico dall'input grezzo → idempotente per costruzione.
Vedi sezione "Markup — architettura idempotente".

Operations come `pricing.adjust_price_percent` sono state cancellate
per lo stesso motivo. La Operation `pricing.adjust_price` (valore
assoluto, +5€) resta perché composta in modo diverso e ha use-case
chirurgici legittimi.

### ImportRule operations non vanno nel Rule editor

`pricing.markup_percent`, `media.download`, `taxonomy.auto_categorize`,
`taxonomy.resolve` implementano `ImportRule` — il loro `apply()` su un
productId è uno stub che fallisce. Sono pensate per mutare il draft
durante import, NON per girare su prodotti esistenti.

Il Rule editor (admin.js) le filtra via `o.is_import_rule`. Il
Pipeline editor ha un dropdown separato per loro. Non rimettere queste
op nel Rule dropdown — fallirebbero al 100% per ogni prodotto.

### Default Rules ships vuoto

Tentammo di seedare un `publish-batch` Rule per il workflow
"import-as-draft → pubblica a gruppi". Footgun: un "Aggiorna default"
inavvertito su un install con products in produzione poteva mass-
pubblicare draft. **Decisione:** `Defaults::defaultRules()` ritorna
`[]`. L'operatore compone Rules deliberatamente.

### Markup match: feed-field, non tassonomia Woo

Le `markup_rules` matchano contro la riga feed (`_gs_brand`,
`_sf_category`, ecc.), non contro le tassonomie Woo (`product_cat`,
`product_brand`). Tre ragioni:

1. **Performance:** 10k items × `wp_get_object_terms` a fetch time è N+1.
2. **Source of truth:** la tassonomia Woo è derivata dal feed via
   mapping. Matchare il feed è equivalente.
3. **NEW products:** non esistono ancora in Woo al momento del fetch,
   quindi una query Woo non li troverebbe.

Tradeoff accettato: una categoria modificata manualmente in Woo non
cambia il markup di quel prodotto — solo il feed lo fa. Per un
catalog feed-driven è il comportamento corretto.

### Resilienza tick-loop

Run su 15k+ prodotti soffrono di errori transienti (PHP fatal mid-tick,
502 reverse-proxy, Chrome che kills idle tab). Soluzione su due livelli:

1. **PHP shutdown handler** (`hsync_arm_fatal_guard`) — wrappa fatal
   in JSON envelope. Il client non riceve mai HTML in mezzo a JSON.
2. **JS retry-with-backoff** (2/4/8s) sul tick loop. Dopo 3 retry
   esaurite, surface un button "Riprendi da qui" che re-entra nel
   loop con il cursor preservato. Il run riprende dall'item dove
   crashava, non da zero.

Errori sono classificati come `transient` (5xx / 0 / parse-failure /
`recoverable: true` dal server) vs definitivi.

### StockFirmati ha un diff dedicato — NON passarlo dal classifier

**Sintomo storico:** ad ogni sync l'INTERO catalogo SF finiva in
`update` (mai `unchanged`), riscrivendo tutto ogni ciclo.

**Causa:** SF veniva forzato dentro `StockOnlyClassifier::split()`,
costruito per feed generici 1-riga-1-prodotto. Due meccanismi
all-or-nothing lo rompevano: (1) il **circuit breaker a 500 item**
(`split()`) che sopra soglia bucket-izza tutto come `updateFull`; (2)
la **normalizzazione `wp_kses_post` della description** su feed con
copy HTML multi-KB, che produceva phantom-diff su ogni item. GS non
soffriva perché ha sempre avuto il suo diff bespoke
(`rp_rc_gs_detect_changes`).

**Soluzione:** `CsvSource::diff()` instrada il flavor `stockfirmati`
verso `sfDiff()` / `sfProductNeedsUpdate()` — un diff dedicato,
variation-aware, che confronta SOLO prezzo+stock (per-variante per i
variable, parent per i simple) + taglie aggiunte/rimosse. Niente
soglia, niente kses, niente bucket `updateStock`: ogni cambiamento va
in `update` e passa dal bridge idempotente `gh_sf_update_product`.
Mirror esatto dello scope di GS. Coperto da `tests/Unit/Sources/SfDiffTest.php`
(il test canonico `testUnchangedVariableProductIsNotFlagged` fallirebbe
col vecchio comportamento).

> **Non** ri-collegare SF al classifier generico per "uniformità". SF
> è fuori dallo scope generico by design — è una categoria a parte,
> come lo è GS.

### Il diff è cieco sui media — serve `heal_media`

**Sintomo:** durante una finestra in cui il feed mandava URL immagine
rotti, alcuni prodotti sono stati creati **senza immagine**. Da lì in
poi nessuna sync li ripara e dall'UI sembra impossibile ri-popolarli.

**Causa — tre strati che si sommano:**

1. `StockOnlyClassifier::split()` confronta name / description /
   status / prezzo / stock. **Mai i media.** `CsvSource::sfProductNeedsUpdate()`
   confronta solo prezzo + stock. Un prodotto senza immagine combacia
   col feed su *tutto quello che il diff guarda* → finisce in
   `unchanged`, per sempre.
2. Gli item in `updateStock` passano dal `fastStockPatch`, che **non
   chiama mai materialize** → il bridge non gira nemmeno per loro.
3. La logica di heal **esiste già** (`rp_rc_gs_image_update_action`:
   "nessuna featured → attach"), ma vive dentro
   `rp_rc_gs_update_product`, raggiungibile solo dal bucket `update`.

Risultato: la riparazione è scritta e testata ma **irraggiungibile**
da una sync normale. L'unica via era `force_recreate`, che però è
all-or-nothing su tutto il feed e **ricrea tutte le varianti** (gli
ID cambiano) — riscrivere 5k prodotti per riparare 30 immagini.

**Soluzione:** `options.heal_media` (`MediaHealer` + `MissingMediaLookup`).
Una query batch trova i prodotti senza featured image usabile
(meta assente / 0 / attachment cancellato) e li sposta da
`unchanged` / `updateStock` a `update` — solo quelli. Percorso di
update normale: varianti e ID intatti.

**Due invarianti da non rompere:**

- **Guard anti-lavoro-perpetuo:** un item viene ri-accodato SOLO se
  `Source::imageUrls()` restituisce almeno un URL usabile. Senza
  questo, i prodotti per cui l'upstream non ha proprio un'immagine
  rientrerebbero nel pool a ogni run all'infinito — l'heal non può
  riuscire, quindi non convergerebbe mai. Con il guard l'operazione
  si esaurisce da sola ed è **safe da lasciare accesa su un cron job**.
- **`Source::imageUrls()` deve essere implementata dalla source.**
  Il default di `AbstractSource` è `[]`: finché `JsonSource` non l'ha
  overridata, oltre a bloccare l'heal rendeva la modalità **"Solo
  media" un no-op silenzioso su tutto il feed GS** (contava ogni
  prodotto in `items_without_images` e non pre-scaricava nulla).

Gli item riparati portano il marker `MediaHealer::MARKER`, girano
**per primi** nella coda (così un run con "Max prodotti" spende il
budget sulla riparazione) e girano **anche se `buckets` esclude
`update`** — altrimenti un job `buckets: ['updateStock']` con l'heal
acceso li filtrerebbe via, ri-creando esattamente il no-op silenzioso
che l'opzione esiste per eliminare. Coperto da
`tests/Unit/Workflow/Run/MediaHealerTest.php` e
`tests/Unit/Sources/JsonSourceImageUrlsTest.php`.

### `options.skus` — il ri-importa mirato (ex force re-import)

`heal_media` è automatico ("ripara ciò che è rotto"). Quando invece
l'operatore sa **quali** SKU rifare, `options.skus` restringe l'intero
run a quella lista — il sostituto scoped di
`gh_reimport_run( $feed_type, $skus, ... )`.

`SkuFilter` (parse → filterItems → promote):

| Fase | Cosa fa | Perché |
|---|---|---|
| `parse` | Accetta array o stringa separata da newline/virgola/`;`/spazio. Dedup case-insensitive, conserva la grafia originale. | Gli operatori incollano da un foglio di calcolo, il separatore è quello che capita. |
| `filterItems` | Filtra i FeedItem **PRIMA del diff**. | Il feed è un endpoint bulk (il download avviene comunque, come nel vecchio `gh_reimport_fetch`), ma diffare 10k righe per tenerne 12 è puro spreco: lookup batch + intero passaggio del classifier. |
| `promote` | Sposta tutto ciò che esiste già (`unchanged` + `updateStock`) in `update`. | **Non opzionale.** Su un catalogo assestato uno SKU nominato è quasi sempre `unchanged` (skippato) o `updateStock` (fast-patch, che non chiama mai materialize). Senza promote l'operatore chiede un ri-import e non succede nulla — di nuovo il no-op silenzioso. |

Due invarianti:

- **`buckets` viene ignorato** quando `skus` è valorizzato: la selezione
  *è* la restrizione, e onorare `buckets` scarterebbe l'intera selezione
  (finisce tutta in `update`).
- **Gli SKU non trovati nel feed vengono elencati**, non solo contati
  (`summary.sku_missing_list`). "10 su 12 importati" è inutile se non
  sai quali due mancano — ed è tipicamente un typo o un delisting
  upstream, cioè proprio l'informazione che serve.

`skus` + `force_recreate` = l'equivalente esatto del vecchio force
re-import, ma scoped: wipe varianti + riscrittura da feed **solo** per
quegli SKU. A differenza del vecchio, l'ID del prodotto non cambia
(il vecchio faceva `rp_delete_product` + create, portandosi via i
riferimenti negli ordini storici).

`skus` + `heal_media` è ridondante: `promote` svuota già i bucket da
cui l'healer pesca, quindi l'heal viene soppresso (niente lookup
garantito vuoto, niente `healed_media: 0` fuorviante nel report).
Coperto da `tests/Unit/Workflow/Run/SkuFilterTest.php`.

### Il diff è cieco sulle assenze — serve `retire_missing`

**Sintomo (segnalato dal cliente, non da noi):** un prodotto che il
fornitore ha tolto dal listino resta **pubblicato e acquistabile** sul
sito. Per sempre. Nessuna sync lo tocca, nessun contatore lo nomina,
nessun warning lo segnala. Chi guarda i log vede solo run verdi.

**Causa — un buco strutturale, non un bug:** tutti e quattro i bucket
storici sono costruiti **camminando le righe del feed**:

| Bucket | La domanda a cui risponde |
|---|---|
| `new` | il feed ha nominato questo SKU e in Woo non c'è |
| `update` | il feed l'ha nominato e qualcosa è cambiato |
| `updateStock` | il feed l'ha nominato e sono cambiati solo prezzo/stock |
| `unchanged` | il feed l'ha nominato e combacia |

Tutte e quattro presuppongono *"il feed ha nominato questo SKU"*. Uno
SKU **delistato** non è nominato da niente — quindi non finisce in
nessun bucket, e il loop del runner itera solo su ciò che sta nei
bucket. Il prodotto è **irraggiungibile**, esattamente come lo erano i
prodotti senza immagine prima di `heal_media` (stessa forma di bug:
il diff è cieco su una dimensione, e ciò che il diff non vede il
runner non tocca mai).

**Soluzione:** il 5° bucket `missing`, popolato da `MissingSweeper`
sotto `options.retire_missing`. Una query catalog-side
(`OwnedProductLookup`) risponde alla domanda speculare — "quali
prodotti in Woo appartengono a questo feed?" — e la differenza
insiemistica con gli SKU del fetch è il bucket.

**Perché set-difference e non `_hsync_last_seen`:** stampare un
"visto il" su ogni item restituito dal feed costerebbe ~5k scritture
di meta per run su un catalogo assestato, distruggendo la proprietà
che l'intera architettura a bucket esiste per comprare (*un feed
stabile produce zero scritture*). La differenza insiemistica costa
**una** query in più e lascia lo stato stazionario a zero scritture.

**I guard sono la parte importante.** È l'unica operazione del runner
che agisce sull'**assenza** di dati, quindi ogni modo in cui il feed
può restituire meno del vero è un modo di spegnere un catalogo vivo:

| Guard | Cosa blocca |
|---|---|
| feed vuoto | token scaduto / 200-empty-body / manutenzione upstream leggono tutti come "è sparito tutto" |
| ratio > `retire_max_ratio` (default 35%) | feed troncato a metà. Sotto 20 prodotti posseduti non si applica: il churn assoluto piccolo è normale |
| `options.skus` | il run vede solo gli SKU incollati: tutto il resto sarebbe "assente" per definizione |
| `options.limit` | è un run di prova. Oscurare migliaia di prodotti partendo da "provane 50" è l'opposto di ciò che il cap chiede |
| `options.category_filter` | **il caso che il ratio guard NON copre.** Il job scarica una fetta del catalogo di proposito (la forma SF "un job per categoria"): tutto ciò che sta fuori dalla fetta risulta sparito, e due job con filtri diversi che condividono una provenance si oscurerebbero i prodotti a vicenda ad ogni tick. Una fetta che tiene il 70% del catalogo oscura il restante 30%, comodamente sotto soglia |
| `mode = media_only` | quel branch non scrive sui prodotti |
| provenance vuota | la source non marca ciò che crea → non si può dimostrare la proprietà → non si tocca niente |

**Nessun guard è silenzioso, e nemmeno cieco.** Ognuno emette un
warning nel run, e il freno sul ratio porta con sé **il riscontro e un
campione degli SKU** che avrebbe toccato (`summary.retire_sample`, più
`retire_owned` / `retire_would` / `retire_matched` accanto a `fetched`).
Senza, un guard che dice "565 prodotti su 1023" e non dice *quali* non
lascia all'operatore nessun modo di distinguere un feed troncato da un
arretrato vero se non disattivando il guard e scoprendolo — cioè
l'unica cosa che il guard esiste per impedire. Stesso ragionamento di
`sku_missing_list`: un numero che non puoi verificare è un numero su cui
non puoi decidere. Il riscontro da leggere è
`fetched` vs `retire_matched`: se tornano, il feed è integro e la
sparizione è reale; se il feed porta molti più SKU di quanti ne
combaciano, è un problema di corrispondenza degli SKU e oscurare farebbe
danni.

**`retire_max_ratio` ha un controllo nell'UI** (Importa → "Soglia di
sicurezza", e nell'editor del job). Il warning diceva all'operatore di
alzare una soglia che non esisteva come campo: un messaggio che chiede
un'azione impossibile è peggio di nessun messaggio.

Una spazzata che si rifiuta di partire senza dirlo è indistinguibile dal
bug che è nata per risolvere — ed è esattamente così che l'operatore
si ritrova a spiegare al cliente perché il prodotto è ancora lì.

**Reversibile per costruzione.** Prima della prima scrittura su un
prodotto, `ProductRetirer` snapshotta stato + visibilità in
`_hsync_missing_prev`. Se lo SKU **ritorna** nel feed, lo stesso
passaggio lo ripristina — *prima* che l'import lo ri-rifornisca, nello
stesso run.

> ⚠ **La metà dei ripristini gira SEMPRE**, anche quando la spazzata è
> spenta e anche quando un guard l'ha bloccata (`MissingSweeper::decide`
> con `$retireEnabled = false`, alimentata dalla query stretta
> `OwnedProductLookup::retiredForProvenance`). Non è una versione
> degradata: è ciò che impedisce a una retire di diventare una porta a
> senso unico. Senza, spegnere l'opzione lascia una trappola silenziosa
> e permanente — lo SKU torna, l'import lo ri-rifornisce e gli risincronizza
> `post_status` dal payload del feed, ma `catalog_visibility = hidden`
> resta lì perché niente nel percorso del feed lo tocca. Prodotto vivo,
> in stock, invisibile nello shop, e nessun report che lo nomini.
> Su un negozio che non ha mai acceso la spazzata la query ritorna zero
> righe: costa una lookup indicizzata per run. Senza l'inverso, una rottura di stock di due giorni
diventerebbe un prodotto morto per sempre, e l'operatore lo scoprirebbe
mesi dopo. Le **quantità** delle varianti non sono snapshottate di
proposito: le riscrive il feed corrente, e rimettere le giacenze di
settimane fa pubblicherebbe per qualche istante stock inesistente.

**Tre invarianti da non rompere:**

- **Gli item swept girano per primi, non vengono mai troncati da
  `options.limit`, e girano anche se `buckets` li escluderebbe** — sono
  tenuti in una coda separata (`$sweepQueue`) che viene concatenata DOPO
  lo slice del limite. Stessa esenzione degli item riparati da
  `heal_media`, stessa ragione: chi accende l'opzione lo fa perché i
  prodotti delistati sono live *adesso*. Un run cappato a 50 che ne
  oscura 800 e ne ripristina 40 direbbe di fare un test e starebbe
  facendo una migrazione.
- **Il bucket `missing` NON viene strippato dalla `RunCache`** (a
  differenza di `unchanged`). È calcolato una volta sola al tick 1 e i
  tick successivi ci indicizzano dentro **posizionalmente**: strapparlo
  farebbe ricostruire al resume una coda *più corta* di quella su cui è
  stato coniato il cursor, saltando le retire e chiudendo il run `done`
  senza aver oscurato niente.
- **`Diff::totalCount()` NON conta `missing`.** Gli altri quattro
  contano righe del feed; questo conta righe del catalogo che il feed
  *non* ha restituito. Sommarlo romperebbe la riconciliazione
  "fetched vs classified" su cui si regge la contabilità del runner.

**La proprietà va dimostrata, mai dedotta.** `OwnedProductLookup`
scopa su `_gh_import_source` / `_feed_source` **e** pretende che
`_gh_primary_source` non dica il contrario. Senza la seconda clausola
un prodotto creato da KicksDB e poi solo prezzato da GS (il bridge
condiviso stampa comunque `_gh_import_source = goldensneakers`)
verrebbe considerato di GS e oscurato appena GS smette di listare quel
SKU. I prodotti senza `_sku` sono fuori scope per costruzione: senza
SKU non c'è confronto possibile col feed, e un'oscuramento che non
sappiamo giustificare non si fa.

Coperto da `tests/Unit/Workflow/Run/MissingSweeperTest.php` — i test
che contano sono quelli che dimostrano che **non** agisce
(`testEmptyFeedAbortsInsteadOfRetiringTheWholeCatalog`,
`testMassDelistingTripsTheRatioGuard`,
`testHandRolledDraftWithNoMarkerIsNeverTouched`).

### Il feed GS mescola URL assoluti e path relativi

**Sintomo:** una parte dei prodotti arriva senza immagine, mentre altri
nella STESSA risposta la prendono senza problemi.

**Causa:** `image_full_url` non ha un formato unico. Convivono

```
"image_full_url": "https://media.goldensneakers.net/products/images/1520_JI2626/raw/b086c2487cf4.png"
"image_full_url": "/images/IH6001/main/"
```

La seconda è il vecchio formato cartella (da joinare con `image_name`)
a cui è stata tolta l'origine. Senza schema né host l'allowlist la
rifiutava — correttamente, ma il risultato era `''` = "nessuna immagine
dal feed" e il prodotto restava senza foto per sempre (il diff è cieco
sui media, vedi sopra).

**Soluzione:** `JsonSource::resolveImageUrl()` = join → **absolutize** →
allowlist. L'absolutize completa i path relativi con l'origine dell'URL
API configurato (`https://www.goldensneakers.net` come fallback,
filtrabile via `hive_sync/source/json/image_origin`). Sempre `https`,
perché l'allowlist esige https.

Due paletti deliberati:

- **l'allowlist resta l'ultimo step**, dopo l'absolutize: un feed
  ospitato su un host di terze parti non può far scaricare immagini da
  quell'host tramite un path relativo;
- **un nome nudo senza directory (`foto.png`) NON viene completato**:
  non si sa in che cartella viva e `<origine>/foto.png` farebbe
  sideloadare una pagina 404 come immagine prodotto. Meglio `''`, che
  non tocca mai l'immagine esistente.

Coperto da `tests/Unit/Sources/GsImageUrlTest.php`.

> Il provider non normalizzerà il formato: la resolve chain deve
> continuare ad accettare **tutte** le forme viste finora (URL file
> completo, cartella assoluta + filename, cartella relativa + filename,
> protocol-relative).

### Il punto d'ingresso sta nel tab Media, non in Importa

`heal_media` come checkbox nel tab Importa è corretto ma nel posto
sbagliato: l'operatore si accorge del problema **guardando le
immagini**, e da lì per ripararle doveva cambiare tab, ricordarsi
sorgente + config + mappatura + flusso, e spuntare la casella giusta.

Il tab Media ha quindi una card **"Prodotti senza immagine"** con due
passi deliberatamente separati:

1. **Analizza** (`MissingImages::scan`) — read-only e **senza feed**.
   Rispondere a "quanto è grave?" non deve richiedere di scaricare un
   feed da svariati MB né di scrivere nulla. Ritorna totale + istogramma
   per sorgente + un campione.
2. **Ripara** — risolve un **job di import esistente** nella quadrupla
   (source, config, mapping, pipeline) che già contiene, e restituisce
   quei parametri al client, che li passa al **normale tick-loop** con
   `heal_media` forzato.

Tre decisioni non ovvie:

- **Il repair riusa un job invece di far ri-scegliere l'operatore.** Un
  job porta già la quadrupla giusta e resta allineato quando la si
  modifica. Farla ri-scegliere significa poter scegliere *diversamente*
  dall'import vero, e riscrivere i prodotti con il mapping sbagliato.
  `pickDefaultJob()` sceglie da solo quando c'è un solo import job (o
  un solo abilitato), altrimenti l'UI chiede — **non indovina mai** fra
  due feed vivi: sceglierne uno a caso significherebbe riparare i
  prodotti con le immagini di un altro fornitore.
- **L'AJAX ritorna parametri, non esegue l'import.** Una riparazione
  catalog-wide è lunga quanto un import (multi-tick, deadline
  cooperativa): eseguirla dentro una singola chiamata AJAX brucerebbe
  il budget di richiesta su qualsiasi catalogo reale. Passando i
  parametri al loop esistente si ereditano resume, progresso, fatal
  guard e la riga in Storico — tutte cose che già funzionano.
- **L'istogramma per sorgente è il triage, non decorazione.** Un
  prodotto senza `_gh_import_source` è stato creato a mano: **nessun
  import lo riparerà mai**. Dire "47 rotti" senza lo split creerebbe
  l'aspettativa sbagliata sulla riparazione.

> ⚠ La join di provenienza usa una **derived table** con `GROUP BY
> post_id`. Una `LEFT JOIN postmeta ON meta_key IN ('_gh_import_source',
> '_feed_source')` matcha ENTRAMBE le chiavi quando ci sono, duplicando
> la riga del prodotto: stesso prodotto due volte nella tabella campione
> e — se le due chiavi divergono — contato sotto due sorgenti diverse,
> con l'istogramma che somma a più del totale che gli sta accanto.


### Lo scheduler: perché lo Storico non combaciava col cron

**Sintomo (segnalato dal cliente, con screenshot):** un job GS su
`*/30 * * * *` compariva nello Storico alle 09:30, 11:00, 12:30, 14:00…
e poi ogni ora; il job SF giornaliero era ancora `CONTINUE` tre ore dopo
la partenza; la card diceva `next: 03:05:55` (un orario che nessun cron
produce) e la colonna "Done" mostrava 12 per un run che aveva scritto
centinaia di prodotti.

**Cause — si sommavano:**

1. **Duty cycle dell'8%.** Il tick WP-Cron scattava ogni 5 minuti e dava
   a ogni job UN blocco da 25s. Un run da 3 minuti di lavoro vero ne
   durava 40-60. Finché un run è in corso il job non ne parte un altro,
   quindi gli slot `:30` passavano a vuoto → i buchi nello Storico.
2. **`next_run_at` = "adesso" durante il run.** Il runner lo usava per
   dire "riprendimi al prossimo tick": la card lo mostrava come prossima
   esecuzione (il famoso 03:05:55) e lo slot vero spariva.
3. **Cache del fetch+diff con TTL fisso di 2h dal tick 1.** Il run SF
   notturno la superava: ri-download del feed, ri-diff dell'intero
   catalogo, coda ripartita da zero a metà run.
4. **"Done" = l'ultimo blocco.** `items_done` e il summary del run
   venivano sovrascritti a ogni tick con i numeri del SOLO blocco.
5. **Cron letto in UTC, Storico stampato in UTC.** "Ogni giorno alle
   00:00" girava alle 02:00 ora italiana; coerente con lo Storico solo
   perché anche lo Storico era in UTC.
6. **Label con la cadenza dentro** ("ogni 2h") accanto a un cron cambiato
   dall'operatore.

**Soluzione (1.2) — un'invariante per causa:**

| # | Invariante | Dove |
|---|---|---|
| 1 | Il heartbeat è ogni minuto e **drena**: blocchi concatenati finché c'è lavoro o finisce il budget. Round-robin tra i run in corso (un import SF enorme non affama la sync GS). | `Drainer`, `DuePolicy`, `includes/cron.php` |
| 2 | `next_run_at` è **sempre** il prossimo slot. Lo si pianifica all'AVVIO del run, ancorato allo slot servito (non a "adesso"). Gli slot che passano mentre il run lavora vengono **saltati e contati** (`report.schedule.skipped_slots`), mai recuperati uno dopo l'altro fuori griglia. | `JobSchedule::planAfter` / `afterRun` |
| 3 | La cache scade per **inattività**: ogni tick che la usa la rinnova (`RunCache::touch`, un UPDATE della riga `_transient_timeout_` — non riscrive il blob). | `RunCache` |
| 4 | Il cursor porta i **totali dell'intero run** (`cursor.totals`); la riga di `wp_hsync_runs` è sempre whole-run. L'envelope resta per-blocco (lo somma il JS di Importa). | `RunTotals` |
| 5 | Il cron si legge nel **fuso del sito**; il DB resta UTC; la UI converte (`HSync.fmtWhen`, `HSync.tzLabel`). DST: uno slot nel buco primaverile salta quel giorno; l'ora ripetuta d'autunno non fa scattare due volte lo stesso slot. | `CronExpr::nextRun`, `assets.php` |
| 6 | Le label non contengono cadenze; la migrazione le ha ripulite. | `Defaults`, `SchedulerMigration` |

**Stato del run fuori dalla config.** Il cursor viveva in
`config._resume_cursor`: il "Salva" dell'editor rimanda al server tutta
la config caricata minuti prima — cursor vecchio compreso — e lo
sovrascriveva. Ora c'è `run_state` (JSON) scritto **solo** dal titolare
della lease, e `run_control` ('run' / 'stop') per le richieste AJAX, con
UPDATE condizionali. Ogni UPDATE elenca solo le proprie colonne
(proprietà delle colonne documentata in `JobRepository`).

**Lo snapshot.** `run_state.snapshot` congela runnable + config
all'avvio: ogni blocco esegue ciò con cui il run è partito. Modificare
un job a metà run non produce un run mezzo di una config e mezzo
dell'altra; le modifiche valgono dal run successivo ("Interrompi" per
applicarle subito).

**La lease, non un transient.** Il vecchio lock era `get_transient` +
`set_transient`: due richieste cron dentro quella finestra "prendevano"
entrambe il lock e facevano avanzare lo stesso cursor in parallelo —
ognuna creando gli stessi SKU `new`. `RunnerLease` è CAS fino in fondo
(INSERT IGNORE / UPDATE … WHERE value = atteso), TTL 15 min come
orizzonte di recovery (rinnovata prima di ogni blocco), rilasciata anche
da uno shutdown handler se il processo muore di fatal. Il bottone "Run"
e "Esegui ora" passano dalla stessa lease; se è occupata la richiesta
resta sul job e la raccoglie il drain in corso.

**Invarianti da non rompere:**

- **Il heartbeat idle non scrive nulla.** Gira ogni minuto: due SELECT
  e basta. Prendere la lease "per sicurezza" a ogni giro sono 2 scritture
  al minuto su `wp_options` per sempre.
- **Mai un burst di recupero.** Uno slot perso è saltato e contato, non
  rieseguito. Un run che dura più dell'intervallo non deve diventare un
  job che gira in continuo.
- **Disattivare = pausa, non annullamento.** Un run schedulato di un job
  spento tiene il suo `run_state` e riparte da lì alla riattivazione.
  Un run avviato con "Run" finisce anche su un job spento.
- **I job `rule` non si concatenano.** La selezione viene risolta a ogni
  chiamata: un cursor posizionale su una lista che cambia salterebbe
  prodotti. Un run di regola non finito chiude `partial`; il prossimo
  slot ricomincia.
- **KicksDB ha una quota.** Un run concatena blocchi finché ha
  rinfrescato `max_per_tick` SKU o ha usato 12 blocchi. Senza tetto, con
  un'API lenta, il drain la chiamerebbe per tutto il budget, ogni minuto.
- **Un run = una riga di Storico**, collegata al job (`job_id`,
  `runnable_ref` = `sorgente/config`), per quanti blocchi duri.

Verificato una tantum end-to-end contro MariaDB con un harness fuori
repo (runner reale + source finta lenta, `$wpdb` minimale): drain multi-blocco in un giro, resume tra giri e tra
processi diversi, stop a metà blocco, pausa/ripresa, slot saltati
contati, migrazione di un run legacy in volo, e tre heartbeat
concorrenti per 8 round — 400 SKU, 400 scritture, zero doppioni.
Coperto da `tests/Unit/Workflow/Schedule/*` (lease, drain, due policy,
slot, DST) e `RunTotalsTest`, `RunCacheTest` (touch).

### La vista semplice lavora per automazioni

**Richiesta:** il cliente finale non è uno sviluppatore. Dieci tab con
sorgenti, mappature, flussi, bucket, cron e JSON gli servono a nulla e
lo espongono a errori. Serve "poco ma efficace".

**Decisione: non si è tolto niente, si è nascosto.** Tutto ciò che
esisteva resta identico dietro "Modalità avanzata" (lo sviluppatore lo
usa ancora); la vista di default ne è un sottoinsieme in parole.

**Il punto non ovvio: la vista semplice non chiede mai sorgente,
mappatura o flusso.** Lavora per *automazioni*: un job `source.import`
porta già la quadrupla giusta (sorgente, config salvata, mapping,
pipeline) e il server la risolve (`hsync_job_import_target()`, stessa
risoluzione di `JobRunner::dispatchSourceImport`, `config.config_slug`
compreso). Stessa ragione della riparazione immagini del tab Media: chi
ri-sceglie i parametri può sceglierli *diversamente* dalla sync vera e
riscrivere i prodotti con il mapping sbagliato.

Invarianti:

- **Una card mostra un controllo solo per una forma che sa rileggere.**
  `SimpleSettings`: la frequenza è un preset (`presetFor`), "aggiungi da
  sola i nuovi prodotti" è `buckets` assente ↔ `['update','updateStock']`.
  Un cron scritto a mano si vede come "personalizzata" e resta com'è
  finché il cliente non sceglie un preset; un set di bucket fatto a mano
  (`['updateStock']`) viene **rifiutato** dal server, mai appiattito.
- **Le card nascondono i job non configurati e spenti** (il seeder crea
  GS + SF su ogni installazione: chi compra da un solo fornitore non deve
  vedere una card morta), ma **mostrano** quelli non configurati e accesi:
  falliscono a ogni slot ed è proprio ciò che il cliente deve sapere.
- **Mai credenziali al browser.** `FeedOverview` non manda la config del
  job; un job con config *inline* non è importabile dalla vista semplice
  (le credenziali dovrebbero viaggiare a ogni tick).
- **"Aggiungi da sola i nuovi prodotti" spento è il modello per un
  catalogo curato:** la sync mantiene prezzi/stock e nasconde i delistati
  (la spazzata gira sul feed **intero**, quindi resta sicura), e i nuovi
  prodotti entrano solo da "Importa prodotti", anche per categoria. Per
  questo la vista semplice **non** offre il filtro categorie sui job: un
  job con `category_filter` disattiva la spazzata (vedi sotto) e lo SKU
  delistato tornerebbe acquistabile — il bug che il cliente ci ha già
  segnalato una volta.

**Il tick loop ha un listener, non un fork.** "Importa prodotti" usa lo
stesso `HSync.runImportTicked` di Import manuale e della riparazione
immagini (retry/backoff/resume restano in un posto solo) e ne disegna il
progresso tramite `HSync.runListener(phase, payload)` con fasi
`start` / `tick` / `end`. Regola di proprietà come `runOutputSel`: chi
*avvia* un run lo imposta o lo azzera. "Interrompi" alza
`HSync.state.runAbort`, letto **tra due tick** e durante il backoff dei
retry; il run viene chiuso subito con `run_cancel` (solo run del browser:
quello di un job appartiene allo scheduler e si ferma con `job_stop`),
altrimenti la riga resterebbe "In corso" per un giorno.

### Import per categoria — path esatti, non sottostringhe

**Richiesta:** importare (StockFirmati) solo i prodotti di una categoria.
Il motore aveva già `options.category_filter`, ma senza UI e con una
semantica a **sottostringa** su CAT *o* SUBCAT: "Borse" prendeva anche
"Accessori › Borse da viaggio", "Top" ogni "Laptop". Con un picker che
mostra un **conteggio** accanto a ogni categoria è inaccettabile: il
numero sullo schermo non sarebbe il numero importato.

**Soluzione (`CategoryFilter`):** due forme in un'unica opzione.

| Voce | Significato |
|---|---|
| `"Calzature > Sneakers"` | esattamente quella coppia categoria/sottocategoria |
| `"Calzature > *"` | tutta la categoria, qualunque sottocategoria (anche vuota) |
| `"sneak"` | legacy: sottostringa della categoria **o** della sottocategoria |

Il picker scrive solo path; la forma legacy resta identica, quindi un
job scritto a mano continua a importare gli stessi prodotti (nessun
filtro legacy funzionante poteva contenere `>`, che non compare mai in
un singolo livello). Confronto case-insensitive, Unicode-aware, spazi
collassati. È lo stesso albero a due livelli che `gh_sf_assign_category`
trasforma in product_cat padre/figlio: ciò che il cliente vede in Woo.

**Il picker:** `feed_categories` scarica e trasforma il feed (stesso
costo del tick 1 di un import, quindi fatal guard + limiti alzati) e ne
salva uno snapshot compatto SKU → (CAT, SUBCAT) (`FeedCategorySnapshot`,
transient per feed, 30 min). "Già nel negozio" **non** è in cache: è ciò
che cambia appena finisce un import, e si ricalcola a ogni richiesta con
una lookup batch (`SkuLookup`). Così dopo aver importato Borse il picker
dice subito "Borse — già tutti nel negozio" senza riscaricare il feed.

Invarianti:

- **Il conteggio è il numero importato.** `SfCategoryFilterTest::testThePickerTreeAndTheFilterAgreeOnEveryNode`
  rimanda ogni nodo dell'albero dentro `fetch()` e confronta: se i due
  divergono, il test fallisce. `categoryPath()` (AbstractSource, default
  `null`; CsvSource la implementa per il flavor SF) e il filtro devono
  leggere gli stessi campi.
- **Un filtro che non trova niente lo dice.** Zero prodotti su N è quasi
  sempre una categoria rinominata dal fornitore: warning esplicito,
  altrimenti un job filtrato importerebbe zero per sempre con run verdi.
- **Un import per categoria non chiede la spazzata.** Su una fetta del
  feed `MissingSweeper` si rifiuterebbe comunque (tutto il resto
  risulterebbe sparito): `import_params` toglie `retire_*` così il
  cliente non legge un avviso incomprensibile. I *ripristini* girano
  comunque, su ogni sync.
- **Lo Storico dice la fetta.** `summary.categories` (diff-level, viaggia
  su ogni tick) → "importazione manuale · solo Calzature".

Solo StockFirmati ha un albero di categorie nel feed: GS ha solo
l'euristica sneakers/abbigliamento, e il picker non viene offerto
(`hasCategories()` false). Il CSV generico mantiene il filtro legacy sui
`categories` mappati.

**Verificato** end-to-end fuori repo: pagina admin reale + handler AJAX
reali su MariaDB (`$wpdb` minimale su mysqli, bridge SF finto che scrive
`wp_posts`/`wp_postmeta`), seeder vero, `ImportRunner` vero, guidati da
Playwright — picker, import per categoria (conteggi = prodotti creati),
"già nel negozio" aggiornato, Interrompi tra tick e durante i retry,
502 iniettati + Riprendi (totali sommati sui due segmenti), Sincronizza
ora via scheduler + lease, switch di modalità, larghezza telefono. Coperto
da `CategoryFilterTest`, `SfCategoryFilterTest`, `Workflow/Simple/*`.

---

## What NOT to add

- Migrazione tab UI (rimossa — il plugin sostituisce GH, non coesiste).
- Visual variant editor nel mapping (i variants sono flat-by-design,
  uscire dalla path `pa_taglia ← sizes.size_eu` rompe la semplicità).
- Per-variant pricing API custom (la materialize del bridge legacy lo
  copre già; aggiungerlo qui duplicherebbe logica).
- Multi-tenant / multi-site config (il plugin gira dentro UN sito
  brandizzato — same posture as golden-hive).
- React/Vue (vanilla JS è sufficiente, build step è zero).
- **Operation periodiche di pricing percentuale su prodotti esistenti**
  — compongono. Vedi "Lessons learned / Markup non è una Rule periodica".
- **Default Rules con effetti distruttivi/visibili** (mass-publish,
  mass-status-change). Operatore compone deliberatamente.
- **Match tassonomia Woo nelle markup_rules** — match feed-field è
  più veloce, equivalente per catalog feed-driven, e funziona per
  prodotti non ancora in Woo.
- **Filtro categorie sui job nella vista semplice** — un job con
  `category_filter` disattiva la spazzata dei delistati (il feed visto è
  una fetta): lo SKU tolto dal fornitore tornerebbe acquistabile. Il
  catalogo curato si fa con "aggiungi da sola i nuovi prodotti" spento +
  import per categoria. Vedi "Lessons learned / La vista semplice lavora
  per automazioni".
- **Controlli tecnici nella vista semplice** (cron, bucket, limiti,
  dry-run, mapping, JSON): vanno nei tab avanzati. Ogni controllo in più
  per il cliente è un modo in più di rompere la sync.
