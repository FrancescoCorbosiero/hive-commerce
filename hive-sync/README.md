# Hive Sync

WooCommerce import + sync engine. Standalone WordPress plugin —
installable independently of the rest of the Hive Commerce suite. When
Hive Commerce is active, Hive Sync delegates `materialize` to the legacy
bridge (`hive_sync/host/*` filters) for variant + media sideload
logic; without it falls back to a generic Woo upsert.

## Per il cliente (vista semplice, default)

Quattro tab, nient'altro:

- **Panoramica** — "Tutto in ordine" (o cosa controllare) e una scheda per
  fornitore: accesa/spenta, ogni quanto, *aggiungi da sola i nuovi prodotti*,
  **Sincronizza ora**, ultimo risultato in parole.
- **Catalogo e prezzi** — per ogni fornitore: *prezzo di vendita = costo ×
  N*, cosa sincronizzare (tutto il catalogo o solo le categorie spuntate) e,
  se serve, un ricarico diverso per categoria o sottocategoria. La sync
  automatica importa e aggiorna solo quello, a quei prezzi; i prodotti tolti
  dal fornitore vengono comunque nascosti.
- **Importa prodotti** — scegli il fornitore e **tutto il catalogo o solo
  alcune categorie** (StockFirmati: elenco categoria → sottocategoria con
  quanti prodotti ha il fornitore e quanti sono già nel negozio), poi un
  bottone. Progresso, Interrompi, Riprendi.
- **Storico** — quando, cosa (anche "solo Calzature"), esito, risultato.

Catalogo curato: in **Catalogo e prezzi** scegli *solo le categorie
spuntate* (la sync importa e mantiene solo quelle), oppure spegni *aggiungi
da sola i nuovi prodotti* sulla scheda e porta dentro tu le categorie da
**Importa prodotti**.

## Quickstart (sviluppatore, Modalità avanzata)

1. Install + activate the plugin. Defaults are seeded automatically.
2. Header → accendi **Modalità avanzata**.
3. **Connetti** → card della sorgente → compila URL + token, salva con lo
   slug che il job default si aspetta (`gs-prod` per JSON/GS, `sf-prod`
   per CSV/StockFirmati), premi **Test fetch**.
4. **Mappa** → premi **Aggiorna default** se hai installato prima del
   commit `46dbc00` (porta in-line le ultime modifiche al codice).
5. **Import manuale** → scegli sorgente / mapping / pipeline → tieni acceso
   *Solo prova* per la prima run, controlla lo Storico, poi togli e
   lancia per davvero.
6. Spegni la Modalità avanzata: il cliente accende la sincronizzazione
   dalla Panoramica.

## Cosa fa, in due righe

Mantiene il catalogo Woo in sync con uno o più feed esterni (JSON o CSV)
con tre stagioni di update:

- **Add new** — crea i nuovi SKU, scarica le foto, assegna varianti
- **Refresh stocks** — aggiorna prezzo + stock per i prodotti già in Woo
  (sub-second per prodotto via fast-patch, no media, no taxonomy)
- **Re-update** — re-import completo per i prodotti dove sono cambiati
  campi non-stock (descrizione, brand, ecc.)

## Architettura — i buckets

`Source::diff()` divide ogni fetch in 4 buckets, e la spazzata
opzionale ne aggiunge un quinto:

| Bucket | Significato | Path |
|---|---|---|
| `new` | SKU non in Woo | Pipeline completa + create |
| `update` | SKU in Woo, campi non-stock cambiati | Pipeline + materialize |
| `updateStock` | SKU in Woo, solo prezzo/stock | Fast-patch direct setters |
| `unchanged` | Nessuna differenza | Skip |
| `missing` | In Woo ma **il feed non lo elenca più** | Oscuramento reversibile |

I primi quattro rispondono tutti alla domanda "il feed ha nominato
questo SKU?", quindi uno SKU che il fornitore **toglie dal listino**
non finisce in nessuno di essi e nessuna sync lo tocca più: resta
pubblicato e acquistabile per sempre. `options.retire_missing` (on di
default sui job di sync seeded) chiude il buco confrontando il
catalogo con il feed e mettendo i prodotti spariti fuori stock +
fuori catalogo. È reversibile — se lo SKU torna nel feed il prodotto
viene ripristinato nello stesso run — e si annulla da sola se il feed
è vuoto o se sparisce più del 35% del catalogo in un colpo.

Su un catalog di 5K prodotti con 50 nuovi e 4950 da rinfrescare:
- 50 prodotti × ~3s = 2.5 minuti
- 4950 stock-patches × ~20ms = 100 secondi

Tempo totale ~4 minuti vs ~5 ore per un re-import completo.

## Tab UI

| Vista | Tab | Cosa contiene |
|---|---|---|
| sempre | Panoramica | Stato + una scheda per automazione (on/off, frequenza, nuovi prodotti, Sincronizza ora) |
| sempre | Importa prodotti | Tutto il catalogo o solo alcune categorie, con progresso |
| sempre | Storico | Esecuzioni in parole (avanzata: colonne tecniche + pulizia) |
| avanzata | 1 Connetti | Saved source-configs (URL + auth) per sorgente |
| avanzata | 2 Mappa | Mapping editor visuale: spina-Woo + Avanzati + Custom |
| avanzata | 3 Componi | CRUD pipeline (pre-check / import-rule / post-check) |
| avanzata | 4 Regole | Operazioni scoped su prodotti esistenti |
| avanzata | 5 Import manuale | Esecuzione ad-hoc con tutte le opzioni (dry-run, limiti, SKU…) |
| avanzata | 6 Automatizza | Schedule cron + Action Scheduler health |
| avanzata | Media | Browser + whitelist + Safe Cleanup orfani |
| avanzata | Esporta | Inventario CSV/JSON + catalog by taxonomy |
| avanzata | Strumenti | Nuclear Cleanup (richiede `manage_options`) |
| avanzata | Config | project.json: esporta / valida / applica |

La Modalità avanzata è uno switch nell'header, ricordato per browser.
Solo in avanzata: il "cockpit" con tile live-status (automazioni attive /
ultimo import / catalogo Woo / quick-tick button, refresh ogni 30s).

### `category_filter` (job e Import manuale)

```
"category_filter": ["Calzature > Sneakers", "Borse > *"]   // path esatti (ciò che scrive il picker)
"category_filter": "sneak"                                  // legacy: sottostringa di CAT o SUBCAT
```

Solo il flavor StockFirmati ha un albero di categorie. Il runner filtra
dopo aver visto il feed intero, quindi la spazzata dei delistati resta
attiva anche su una sync per categoria (delistato = assente da tutto il
feed); i ripristini si limitano alla fetta.

## Sources

Solo **due classi**, ognuna con config flessibile:

- **`JsonSource`** — feed JSON da URL con auth Bearer / Cookie. Knob
  `flavor`:
  - `generic` (default) — 1 row response = 1 product, pass-through alla
    mapping
  - `goldensneakers` — gruppa flat rows per SKU + applica
    `transformToWoo` per la shape varianti del bridge legacy
- **`CsvSource`** — CSV da URL o file locale, supporta `category_filter`
  per i sub-import per subset

## Mappings

Editor visuale con la **schema Woo come spina fissa** (non si tocca).
L'utente sceglie solo cosa farci entrare a destra:

- Sezione **Essenziali** — sku / name / regular_price (richiesti) +
  description / image / categories / brand / stock_quantity
- Sezione **Avanzati** (collapsible) — sale_price / SEO meta /
  gallery_urls / tags / status / manage_stock / short_description
- Sezione **Personalizzati** — chiavi non-standard (meta extra)

Bottoni **Anteprima sorgente** + **Inserisci placeholder** + snippets
predefiniti per template HTML / SEO.

## Pipelines (default seeded)

- **`import-default`** — la pipeline standard: HasRequiredFields +
  HasMediaUrl → DownloadMedia + AutoCategorize + ResolveTaxonomy →
  HasImages + HasCategory
- **`import-sf-with-markup`** — pipeline con MarkupPercent override
  per-job (subset SF / generic CSV con margini diversi)
- **Plus** — set-draft, set-publish, mark-out-of-stock, validate-basics,
  audit-with-blocking

## Operations (registered)

Post-import operations (su productId):
- `status.set`, `pricing.adjust_price`, `stock.set_status`, `stock.set_quantity`

Import-rules (mutate FeedItem.data during import):
- `media.download` — parallel sideload
- `taxonomy.auto_categorize` — Sneakers / Abbigliamento heuristic
- `taxonomy.resolve` — name → term_id with create-if-missing
- `pricing.markup_percent` — % markup with floor + rounding modes

## Default jobs (3, all DISABLED on seed)

| Slug | Cron | Runnable ref | Opzioni |
|---|---|---|---|
| `gs-sync` | `0 */2 * * *` | `json/gs-prod` | tutti i bucket + `retire_missing` |
| `sf-sync` | `0 */2 * * *` | `csv/sf-prod` | tutti i bucket + `retire_missing` |
| `kicksdb-refresh-prices` | `0 */6 * * *` | (prima config kicksdb) | `max_per_tick: 500` |

Un solo job per source: il diff è idempotente, quindi lo stesso job
gestisce il primo import e il mantenimento. Per altri feed clona uno
di questi e cambia `runnable_ref` + opzioni.

Cron expression vengono tradotte in italiano live nel job editor:
`*/15 * * * *` → "Ogni 15 minuti", `0 2 * * 1-5` → "Da lunedì a
venerdì alle 02:00", ecc.

## Tabelle (8)

```
wp_hsync_mappings        external→Woo field maps
wp_hsync_pipelines       lifecycle compositions
wp_hsync_rules           scoped operations + selection
wp_hsync_jobs            scheduled or ad-hoc Runnable refs
wp_hsync_runs            execution audit (per Runnable invocation)
wp_hsync_checks          saved Check definitions
wp_hsync_source_configs  per-source credential bundles, autoload=false
                         secrets stored cleartext, redacted in UI on read
```

## Host adapter contract

Filter contract that the host (Hive Commerce bridge) can bind. Standalone
fallbacks exist for every filter so the plugin works without GH.

| Filter | Caller | Purpose |
|---|---|---|
| `hive_sync/host/taxonomy/resolve` | ResolveTaxonomy | name → term_id, create when missing |
| `hive_sync/host/media/preimport_batch` | DownloadMedia | parallel curl_multi sideload |
| `hive_sync/host/product/upsert` | JsonSource generic mat. | create/update Woo product |
| `hive_sync/host/source/gs/materialize` | JsonSource gs flavor | bridge to rp_rc_gs_create/update |

`HSYNC_HOST_CONTRACT_VERSION = 1`.

## Standalone vs with Hive Commerce

| Capability | Standalone | + Hive Commerce |
|---|---|---|
| Import JSON / CSV | ✓ | ✓ |
| Variant explosion (GS flavor) | ✓ (built-in transformToWoo) | ✓ (bridge) |
| Parallel media sideload | sequential single-URL fallback | ✓ curl_multi sliding-window |
| Taxonomy auto-create | `wp_insert_term` | ✓ same path via filter |
| Conflict resolution | default-allow | ✓ rule-based |

## Smoke test

1. Mappa → "Aggiorna default"
2. Connetti → JSON card → URL+token → save as `gs-prod` → Test fetch
3. Importa → `json` source / `gs-prod` config / `gs-default` mapping /
   `import-default` pipeline → Solo prova OFF → Importa adesso
4. Verify a few imported products: should be `variable` with
   `pa_taglia` attribute, per-EU-size variants, real stock per variant,
   featured image sideloaded.
5. Storico → run row should show `created: N / stock_patched: M`
6. Automatizza → toggle on i 3 jobs default

## Coexistence with Hive Commerce

Hive Sync is **not** a partial-coexistence module. It's the production
replacement for `golden-hive/includes/feeds/`. The Migrazione tab was
removed in commit `c9398e7` because fresh installs don't need to
import legacy `gh_pipelines` / `gh_jobs` / `gh_mapper_rules` — Hive
Sync starts clean.

The legacy `golden-hive` plugin is still referenced for the
materialize bridge (variant + sideload logic). Eventually that gets
absorbed into hive-sync directly; until then the bridge contract
keeps the dependency one-way and explicit.

## WP-Cron in produzione

Il plugin schedule un evento `hive_sync_jobs_tick` **ogni minuto**. Se
nessun job è dovuto esce subito (zero scritture); altrimenti prende la
runner lease e *drena*: blocchi da 25s concatenati finché c'è lavoro,
fino a ~4 minuti per giro (`HSYNC_CRON_DRAIN_BUDGET` /
filtro `hive_sync/cron/drain_budget`). Le espressioni cron sono lette
nel **fuso del sito** (Impostazioni → Generali); se un run dura più
dell'intervallo, gli orari che passano mentre lavora vengono saltati
e segnalati sulla card, non accodati.

Il default WordPress fa scattare gli eventi sul page-load di un
visitatore — fragile su siti a basso traffico.

**Setup raccomandato in produzione:**

```php
// wp-config.php
define( 'DISABLE_WP_CRON', true );
```

```sh
# crontab -e
* * * * * curl -s "https://example.com/wp-cron.php?doing_wp_cron" > /dev/null 2>&1
```

Il cockpit header mostra un banner rosso quando l'evento è in
ritardo di oltre 10 minuti — diagnosi rapida quando WP-Cron è broken.

## No junk

Il plugin non scrive file su disk fuori dalla media library WP
standard. Su uninstall (delete dalla schermata Plugin di WP):
`uninstall.php` droppa le 8 tabelle `wp_hsync_*`, cancella le
options (lease dello scheduler compresa) + i transients, e clear-a
tutti gli scheduled cron events.

Lo storico run è auto-prunato ogni 24h (default: > 30 giorni o > 5000
record). Il log eliminazioni media è FIFO capped a 500. Tutti i
bottoni di pulizia manuale stanno nei tab Storico / Media /
Strumenti.

## Tech

- PHP 8.1+ — strict types, readonly value objects, `match` expressions
- WordPress 6.0+
- WooCommerce 8.x
- Composer PSR-4 autoload (`HiveSync\` → `src/`)
- WP-Cron heartbeat ogni minuto con drain a budget + runner lease atomica
- Vanilla JS (no React, no jQuery, no build step) + CSS scopato a
  `.hsync-wrap`

## Branch

Production work happens on `claude/migrate-hive-sync-features-dkJLJ`.
See `git log --oneline` for the full history; key checkpoints:

- `932cb79` — cockpit dashboard header
- `a77470b` — generic JsonSource + cron-IT translator
- `03d09cb` — JS sums result counters across ticks
- `632e9e4` — GS produces bridge-ready Woo shape
- `2d164ab` — GS aggregates flat rows by SKU
- `300c265` — three-bucket sync architecture

## License

Proprietary.
