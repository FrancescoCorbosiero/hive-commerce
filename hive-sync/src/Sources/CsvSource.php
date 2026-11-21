<?php
declare(strict_types=1);

namespace HiveSync\Sources;

use HiveSync\Core\Source\AbstractSource;
use HiveSync\Core\Source\Context;
use HiveSync\Core\Source\Diff;
use HiveSync\Core\Source\FeedItem;
use HiveSync\Core\Source\FetchRequest;
use HiveSync\Core\Source\FetchResult;
use HiveSync\Core\Source\MaterializeResult;
use HiveSync\Core\Source\SourceCapabilities;

/**
 * Generic CSV source — native PHP parser, no Hive Commerce dependency.
 *
 * Accepts a CSV either by URL or local file path. Column→Woo-field
 * mapping is provided via FetchRequest::options['mapping'] (a Mapping
 * row, persisted independently in wp_hsync_mappings). The mapping
 * names which columns become sku/name/regular_price/etc.; rows missing
 * required columns are dropped with a per-row warning.
 *
 * Materialize delegates to the host adapter (`hsync_upsert_product`)
 * which Hive Commerce's bridge wires to gh_create_simple_product.
 */
final class CsvSource extends AbstractSource
{
    public const ID = 'csv';

    public function id(): string
    {
        return self::ID;
    }

    public function label(): string
    {
        return 'CSV — Feed da URL o file (StockFirmati, ecc.)';
    }

    /**
     * Mirror of JsonSource::provenanceKey — gh_sf_create_product stamps
     * `_gh_import_source = stockfirmati`; the generic CSV path stamps
     * nothing and therefore opts out of the missing-product sweep.
     */
    public function provenanceKey(array $config): string
    {
        $flavor = (string) ($config['flavor'] ?? self::FLAVOR_GENERIC);
        return $flavor === self::FLAVOR_SF ? 'stockfirmati' : '';
    }

    public function capabilities(): SourceCapabilities
    {
        return new SourceCapabilities(
            canFetch: true,
            canDiff: true,
            canMaterialize: true,
            canSelectLocal: false,
            supportsQuickPatch: false,
            supportsImageSideload: true,
        );
    }

    public function configSchema(): array
    {
        return [
            'source_type' => [
                'type'     => 'enum',
                'label'    => 'Sorgente',
                'options'  => ['url', 'file'],
                'default'  => 'url',
                'required' => true,
            ],
            'url' => [
                'type'  => 'url',
                'label' => 'URL CSV (se source_type=url)',
                'max'   => 4096,
            ],
            'file_path' => [
                'type'  => 'text',
                'label' => 'Path file (se source_type=file)',
                'max'   => 4096,
            ],
            'delimiter' => [
                'type'    => 'enum',
                'label'   => 'Delimitatore',
                'options' => [',', ';', "\t", '|'],
                'option_labels' => [
                    ','  => 'Virgola  ,',
                    ';'  => 'Punto e virgola  ;',
                    "\t" => 'Tab',
                    '|'  => 'Pipe  |',
                ],
                'default' => ',',
                'description' => 'Quale carattere separa le colonne nel file CSV. La maggior parte dei feed italiani usa "; (punto e virgola)". Se l\'anteprima ritorna 0 righe, di solito è qui che bisogna intervenire.',
            ],
            'enclosure' => [
                'type'    => 'text',
                'label'   => 'Enclosure (carattere virgolette)',
                'default' => '"',
                'max'     => 1,
                'description' => 'Carattere usato per racchiudere i valori che contengono il delimitatore (es. virgolette doppie ").',
            ],
            'has_header' => [
                'type'    => 'bool',
                'label'   => 'Prima riga = intestazione (nomi colonne)',
                'default' => true,
                'description' => 'Lascialo attivo se la prima riga del CSV contiene i nomi delle colonne (es. "SKU,RECORD_TYPE,BRAND,...").',
            ],
            'flavor' => [
                'type'    => 'enum',
                'label'   => 'Formato del feed CSV',
                'options' => [ 'generic', 'stockfirmati' ],
                'option_labels' => [
                    'generic'      => 'Generico — 1 riga CSV = 1 prodotto',
                    'stockfirmati' => 'StockFirmati — RECORD_TYPE PRODUCT + MODEL (raggruppa per SKU)',
                ],
                'default' => 'generic',
                'description' => 'Lascia "Generico" se il tuo CSV è una lista normale di prodotti. Scegli "StockFirmati" SOLO per il feed SF, che ha due tipi di riga: PRODUCT (master) e MODEL (varianti per taglia).',
            ],
            'sf_markup_mode' => [
                'type'    => 'enum',
                'label'   => 'SF: come applicare il markup',
                'options' => [ 'multiplier', 'percent' ],
                'option_labels' => [
                    'multiplier' => 'Moltiplicatore (cost × N)',
                    'percent'    => 'Percentuale (+N% sul cost)',
                ],
                'default' => 'multiplier',
                'description' => 'Solo per il feed StockFirmati. Determina come ricavare il prezzo di vendita dal cost wholesale.',
            ],
            'sf_markup_value' => [
                'type'    => 'text',
                'label'   => 'SF: valore markup',
                'default' => '3.5',
                'max'     => 16,
                'description' => 'Esempi: "3.5" se moltiplicatore (cost × 3.5), "250" se percentuale (+250%, equivalente). Decimali con virgola o punto (3,5 o 3.5).',
            ],
            'import_status' => [
                'type'    => 'enum',
                'label'   => 'Stato iniziale dei prodotti importati',
                'options' => [ 'publish', 'draft' ],
                'option_labels' => [
                    'publish' => 'Pubblicato — visibile sul sito appena importato',
                    'draft'   => 'Bozza — invisibile finché non lo pubblichi (serve una Regola)',
                ],
                'default' => 'publish',
                'description' => 'Imposta "Bozza" se vuoi importare in staging e poi attivare i prodotti a gruppi (per categoria/brand) tramite una Regola periodica nel tab Regole. Si applica solo ai NUOVI prodotti — quelli esistenti mantengono il loro stato.',
            ],
            'markup_percent' => [
                'type'    => 'int',
                'label'   => 'Markup percentuale di fallback (solo flavor "generic")',
                'default' => 0,
                'description' => 'Applicato a TUTTI i prodotti che non matchano una regola in "Markup per categoria/brand". Il flavor StockFirmati ha la sua formula dedicata sopra (sf_markup_value).',
            ],
            'markup_rules' => [
                'type'    => 'markup_rules',
                'label'   => 'Markup per categoria/brand/etc.',
                'default' => [],
                'description' => 'Sovrascrivi il markup di fallback per sottoinsiemi. Esempio: brand "Nike" → 40%, categoria "abbigliamento" → 20%. Prima regola che matcha vince. Confronto case-insensitive, Unicode-safe.\n\n• Generic CSV → fallback su markup_percent. Campi tipici: `brand`, `category`, o qualsiasi colonna del CSV.\n• StockFirmati → fallback su sf_markup_value. **Consigliato `_sf_taxonomy_any`** (cerca in categoria OR sottocategoria — utile quando il feed mette il valore in uno dei due ma non sai quale). Altri campi: `_sf_taxonomy` (cat > sub combinato per `contains`), `_sf_brand`, `_sf_category`, `_sf_subcategory`, `_sf_sex`, `_sf_color`, `_sf_material`, `_sf_season`.',
            ],
            'markup_target' => [
                'type'    => 'enum',
                'label'   => 'Applica il markup a',
                'options' => [ 'sale', 'both' ],
                'option_labels' => [
                    'sale' => 'Solo prezzo di vendita (default — preserva l\'RRP del feed)',
                    'both' => 'Entrambi (RRP + prezzo di vendita scalano insieme)',
                ],
                'default' => 'sale',
                'description' => 'Per StockFirmati: "Solo vendita" mantiene regular_price = STREET_PRICE (l\'RRP del feed) e applica il markup a sale_price. "Entrambi" scala anche regular_price dello stesso fattore — utile se vuoi che l\'RRP visualizzato dal cliente venga gonfiato col markup. Per generic flavor è già "Entrambi" by design.',
            ],
        ];
    }

    public const FLAVOR_GENERIC = 'generic';
    public const FLAVOR_SF      = 'stockfirmati';

    public function fetch(FetchRequest $request, Context $ctx): FetchResult
    {
        $val = $this->validateConfig($request->config);
        if (! $val['ok']) {
            return new FetchResult(
                items: [],
                stats: ['errors' => $val['errors']],
                warnings: ['Config invalida.'],
            );
        }
        $cfg = $val['config'];

        $sourceType = (string) ($cfg['source_type'] ?? 'url');
        // readUrl throws TransientSourceException on retry-exhausted
        // network failures — ImportRunner re-throws it so the AJAX
        // handler returns recoverable:true and the JS tick loop
        // retries the same tick. readFile failures are local /
        // non-transient → return an empty FetchResult with a warning.
        if ($sourceType === 'file') {
            $contents = self::readFile((string) ($cfg['file_path'] ?? ''));
            if ($contents === null) {
                return new FetchResult(items: [], warnings: ['Lettura file CSV fallita: percorso non leggibile.']);
            }
        } else {
            $contents = self::readUrl((string) ($cfg['url'] ?? ''));
        }

        $delimiter = (string) ($cfg['delimiter'] ?? ',');
        $enclosure = (string) ($cfg['enclosure'] ?? '"');
        $hasHeader = (bool) ($cfg['has_header'] ?? true);
        $flavor    = (string) ($cfg['flavor']     ?? self::FLAVOR_GENERIC);
        $mapping   = (array) ($request->options['mapping'] ?? []);

        $bodyLen = strlen($contents);
        $rows = self::parseCsv($contents, $delimiter, $enclosure);
        if (! $rows) {
            return new FetchResult(
                items: [],
                stats: ['body_bytes' => $bodyLen],
                warnings: [
                    'CSV non parsabile (' . $bodyLen . ' bytes scaricati). '
                    . 'Controlla delimitatore (virgola / punto e virgola / tab / pipe) ed enclosure.',
                ],
            );
        }

        // Detect probable wrong-delimiter symptom: every row has 1 cell.
        // When a delimiter mismatch happens (e.g. file uses ; but config
        // says ,), str_getcsv collapses each row into a single string.
        // Surface this loudly because it's the #1 reason fetches return
        // 0 items.
        $diagnostic = self::diagnoseCsvShape($rows, $delimiter, $bodyLen);

        $header = $hasHeader ? array_shift($rows) : null;

        // Stock-Firmati flavor short-circuits the per-row mapping path:
        // the CSV format is two-record-types (PRODUCT + MODEL) and the
        // grouping by SKU + variant assembly is handled inline. Then
        // the normal mapping (if any) runs as an overlay on top.
        // Honor the import_status knob — same semantics as JsonSource:
        // applied on CREATE only (existing products keep their state).
        $importStatus = (string) ($cfg['import_status'] ?? 'publish');
        if (! in_array($importStatus, ['publish', 'draft'], true)) {
            $importStatus = 'publish';
        }

        // Generic-flavor markup (SF flavor uses its own dedicated
        // sf_markup_mode / sf_markup_value formula above and ignores
        // markup_percent + markup_rules). Idempotent across runs
        // because input is always the raw feed price.
        $genericMarkupFallbackPct = (float) ($cfg['markup_percent'] ?? 0);
        $genericMarkupRules       = MarkupResolver::normalize($cfg['markup_rules'] ?? []);

        if ($flavor === self::FLAVOR_SF) {
            $assocRows = [];
            foreach ($rows as $row) {
                $assocRows[] = $header !== null ? self::associate($header, $row) : $row;
            }
            // Per-rule overrides take precedence over the flat SF
            // multiplier — same posture as the generic flavor's
            // markup_rules + markup_percent split. SF's flat
            // sf_markup_value is the fallback. Idempotent: input is
            // always the raw feed cost, output is reproducible.
            $flatMultiplier = self::resolveSfMarkup($cfg);
            $sfMarkupRules  = MarkupResolver::normalize($cfg['markup_rules'] ?? []);
            $sfMarkupTarget = (string) ($cfg['markup_target'] ?? 'sale');
            if (! in_array($sfMarkupTarget, ['sale', 'both'], true)) {
                $sfMarkupTarget = 'sale';
            }
            $items = self::sfNormalizeAndTransform($assocRows, $flatMultiplier, $importStatus, $sfMarkupRules, $sfMarkupTarget);
            $catFilter   = CategoryFilter::parse($request->options['category_filter'] ?? null);
            $beforeCount = count($items);
            if ($catFilter !== []) {
                $items = self::applySfCategoryFilter($items, $catFilter);
            }
            if ($mapping) {
                $remapped = [];
                foreach ($items as $item) {
                    $mappedFields = self::applyMapping($item->data, $mapping);
                    $newData = $mappedFields + $item->data;
                    $newData['sku'] = $item->sku;
                    AttributeMerger::promoteFromDraft($newData);
                    $remapped[] = new FeedItem(sku: $item->sku, data: $newData, raw: $item->raw);
                }
                $items = $remapped;
            } else {
                // Promote any pa_* keys the SF transform surfaced even
                // without an operator mapping (mirrors JsonSource).
                $promoted = [];
                foreach ($items as $item) {
                    $data = $item->data;
                    AttributeMerger::promoteFromDraft($data);
                    $promoted[] = $data === $item->data
                        ? $item
                        : new FeedItem(sku: $item->sku, data: $data, raw: $item->raw);
                }
                $items = $promoted;
            }

            // SF-specific diagnostics: count PRODUCT vs MODEL records
            // so the operator knows where parsing actually broke down
            // (no rows / no PRODUCT records / records but no SKU / etc.).
            $sfDiag = self::diagnoseSfRows($assocRows, $header);
            // A category filter that keeps nothing is almost always a
            // category the supplier renamed. Say so: "0 products" alone
            // reads like a broken feed, and a scheduled job would go on
            // importing nothing, green run after green run.
            $filterDiag = ($catFilter !== [] && $beforeCount > 0 && count($items) === 0)
                ? sprintf(
                    'Nessuno dei %d prodotti del feed appartiene alle categorie selezionate (%s). Il fornitore potrebbe averle rinominate: riapri la scelta delle categorie.',
                    $beforeCount,
                    CategoryFilter::describe($request->options['category_filter'] ?? null)
                )
                : '';
            $warnings = array_filter([ $diagnostic, $sfDiag, $filterDiag ]);
            if (count($items) === 0 && ! $warnings) {
                $warnings[] = 'Nessun prodotto SF dopo aggregazione. Verifica colonne RECORD_TYPE / SKU / MODEL_SIZE.';
            }
            $stats = [
                'body_bytes' => $bodyLen,
                'flat_rows'  => count($assocRows),
                'products'   => count($items),
                'flavor'     => 'stockfirmati',
                'header_columns' => $header !== null ? count($header) : 0,
            ];
            if ($catFilter !== []) {
                $stats['category_filter_kept'] = count($items);
                $stats['category_filter_of']   = $beforeCount;
            }
            return new FetchResult(
                items: $items,
                stats: $stats,
                warnings: array_values($warnings),
            );
        }

        $items = [];
        $warnings = [];

        // Optional per-fetch category filter — used by SF "subset" jobs
        // where each scheduled job processes only the rows that fall
        // into a given category set (so each subset can carry its own
        // markup downstream). Match is case-insensitive substring on
        // the mapped `categories` field; empty filter = pass all.
        $catFilter = self::normalizeCategoryFilter($request->options['category_filter'] ?? null);
        $skippedByFilter = 0;

        foreach ($rows as $rowIdx => $row) {
            $assoc = $header !== null
                ? self::associate($header, $row)
                : $row;
            $mapped = self::applyMapping($assoc, $mapping);

            $sku = (string) ($mapped['sku'] ?? '');
            if ($sku === '') {
                $warnings[] = "Riga " . ( $rowIdx + 1 ) . ": SKU mancante, scartata.";
                continue;
            }
            if ($catFilter !== [] && ! self::rowMatchesCategoryFilter($mapped, $assoc, $catFilter)) {
                $skippedByFilter++;
                continue;
            }
            // Generic flavor: stamp the import_status default so the
            // bridge picks it up on create. Mapped configs that
            // explicitly set `status` win.
            if (! isset($mapped['status']) || $mapped['status'] === '') {
                $mapped['status'] = $importStatus;
            }
            // Per-rule markup against the row's data, fallback to flat
            // percent. Same idempotency story as above.
            $genericMultiplier = MarkupResolver::multiplierFor($mapped, $genericMarkupRules, $genericMarkupFallbackPct);
            if ($genericMultiplier !== 1.0) {
                foreach (['regular_price', 'sale_price', 'price'] as $field) {
                    if (isset($mapped[$field]) && is_numeric($mapped[$field])) {
                        $mapped[$field] = (string) round((float) $mapped[$field] * $genericMultiplier, 2);
                    }
                }
            }
            // Promote mapped pa_* (brand/model/gender/color/...) into
            // the canonical attributes block consumed by the bridge.
            AttributeMerger::promoteFromDraft($mapped);
            $items[] = new FeedItem(sku: $sku, data: $mapped, raw: $assoc);
        }

        $stats = [
            'body_bytes'      => $bodyLen,
            'rows_parsed'     => count($items),
            'rows_skipped'    => count($warnings),
            'header_columns'  => $header !== null ? count($header) : 0,
        ];
        if ($skippedByFilter > 0) {
            $stats['rows_filtered'] = $skippedByFilter;
            $warnings[] = "Filtrati {$skippedByFilter} prodotti fuori dalle categorie selezionate.";
        }
        // Surface the shape diagnostic FIRST in the warnings list so
        // it shows up at the top of the test-fetch output.
        if ($diagnostic !== '') array_unshift($warnings, $diagnostic);

        return new FetchResult(
            items: $items,
            stats: $stats,
            warnings: $warnings,
        );
    }

    /**
     * @param mixed $raw
     * @return string[]  lowercase trimmed list — empty list = "no filter"
     */
    private static function normalizeCategoryFilter($raw): array
    {
        if (is_string($raw)) {
            $raw = str_contains($raw, ',') ? explode(',', $raw) : [$raw];
        }
        if (! is_array($raw)) return [];
        $out = [];
        foreach ($raw as $v) {
            if (! is_scalar($v)) continue;
            $v = strtolower(trim((string) $v));
            if ($v !== '') $out[] = $v;
        }
        return array_values(array_unique($out));
    }

    /**
     * Check the mapped row against the category allowlist. Looks at the
     * `categories` mapped field first; falls back to `category` /
     * `product_cat` / a raw column matching `cat`/`category`.
     *
     * @param string[] $filter
     */
    private static function rowMatchesCategoryFilter(array $mapped, array $raw, array $filter): bool
    {
        $candidates = [];
        foreach (['categories', 'category', 'product_cat'] as $k) {
            $v = $mapped[$k] ?? null;
            if (is_string($v))      $candidates = array_merge($candidates, str_contains($v, '|') ? explode('|', $v) : [$v]);
            elseif (is_array($v))   $candidates = array_merge($candidates, $v);
        }
        // Last-resort: scan raw row for any column whose name LOOKS LIKE
        // a category. Useful when the mapping doesn't expose category.
        if (empty($candidates)) {
            foreach ($raw as $k => $v) {
                if (! is_string($k) || ! is_scalar($v)) continue;
                $kl = strtolower($k);
                if (str_contains($kl, 'categ') || $kl === 'cat') $candidates[] = (string) $v;
            }
        }
        foreach ($candidates as $c) {
            $cl = strtolower(trim((string) $c));
            if ($cl === '') continue;
            foreach ($filter as $f) {
                if ($cl === $f || str_contains($cl, $f)) return true;
            }
        }
        return false;
    }

    public function diff(array $items, Context $ctx): Diff
    {
        // StockFirmati gets its own bespoke, variation-aware diff —
        // deliberately INDEPENDENT of StockOnlyClassifier. SF is not a
        // 1-row-per-product feed: its stock and price live on per-size
        // variations, the descriptions are multi-KB HTML, and the
        // catalog is large. Forcing it through the generic classifier
        // tripped the 500-item circuit breaker (→ entire catalog
        // labelled "update" on every run) and the kses description
        // normalization (→ phantom diffs). The SF path below mirrors
        // GS's own rp_rc_gs_diff: compare only what an SF sync actually
        // maintains (per-variation price/stock + added/removed sizes),
        // bucket new/update/unchanged, and let the idempotent
        // gh_sf_update_product bridge handle every change. No ceiling,
        // no fast-patch, no description comparison.
        if (self::itemsAreSfFlavor($items)) {
            return self::sfDiff($items);
        }

        $new = $update = [];

        // Batch SKU → pid lookup; see JsonSource::diff for rationale.
        // One SQL round-trip instead of N×wc_get_product_id_by_sku.
        $skus = [];
        foreach ($items as $item) {
            if ($item instanceof FeedItem && $item->sku !== '') $skus[] = $item->sku;
        }
        $existingMap = SkuLookup::mapSkusToIds($skus);

        foreach ($items as $item) {
            if (! $item instanceof FeedItem) continue;
            if ($item->sku === '') {
                $new[] = $item;
                continue;
            }
            $existingId = (int) ($existingMap[$item->sku] ?? 0);
            if ($existingId > 0) {
                $update[] = new FeedItem(
                    sku: $item->sku,
                    data: $item->data + ['_existing_id' => $existingId],
                    raw: $item->raw,
                );
            } else {
                $new[] = $item;
            }
        }

        // 3-way split: unchanged / stock / full. The `unchanged` bucket
        // is what makes the diff idempotent — re-runs on a stable feed
        // produce zero writes instead of looping through fast-patch
        // no-ops. Deadline-aware: when budget is gone, remaining items
        // default to full-update (safe choice; we only lose the
        // optimization, never lose data).
        [ $updateFull, $updateStock, $unchanged ] = StockOnlyClassifier::split( $update, $ctx );

        return new Diff(
            new: $new,
            update: $updateFull,
            unchanged: $unchanged,
            updateStock: $updateStock,
        );
    }

    /**
     * True when this batch is StockFirmati-flavored. The SF fetch path
     * stamps every produced FeedItem with `_hsync_flavor = stockfirmati`
     * (see sfNormalizeAndTransform). Checking the first FeedItem is
     * enough — a single fetch never mixes flavors.
     *
     * @param array<int, mixed> $items
     */
    private static function itemsAreSfFlavor(array $items): bool
    {
        foreach ($items as $item) {
            if ($item instanceof FeedItem) {
                return ($item->data['_hsync_flavor'] ?? '') === self::FLAVOR_SF;
            }
        }
        return false;
    }

    /**
     * Bespoke StockFirmati diff. Variation-aware, price+stock only, no
     * 500-item ceiling, no kses normalization, no updateStock bucket.
     * Every changed SKU goes to `update` and is materialized through the
     * idempotent, variation-aware gh_sf_update_product bridge path.
     *
     * Idempotency: a re-run against an unmodified feed buckets every
     * existing SKU into `unchanged` (zero writes). That is the property
     * the generic classifier could never deliver for SF.
     *
     * @param array<int, mixed> $items
     */
    private static function sfDiff(array $items): Diff
    {
        // This path never populates the classifier histogram; clear it
        // so ImportRunner doesn't attach a stale snapshot from a prior
        // run in the same request to the SF run summary.
        StockOnlyClassifier::$lastDiagnostics = ['reasons' => [], 'examples' => []];

        $skus = [];
        foreach ($items as $item) {
            if ($item instanceof FeedItem && $item->sku !== '') {
                $skus[] = $item->sku;
            }
        }
        $existingMap = SkuLookup::mapSkusToIds($skus);

        // Two batched lookups feed the comparison — same approach the
        // classifier uses, minus the per-item kses pass that was the
        // real cost. parentScalars covers SF simple products (bags,
        // accessories); variationLookup covers the variable majority.
        $existingIds     = array_values(array_unique(array_map('intval', $existingMap)));
        $variationLookup = $existingIds ? VariationLookup::mapParentsToVariations($existingIds) : [];
        $parentScalars   = $existingIds ? ParentScalarLookup::load($existingIds) : [];

        $new = $update = $unchanged = [];
        foreach ($items as $item) {
            if (! $item instanceof FeedItem) continue;
            if ($item->sku === '') {
                $new[] = $item;
                continue;
            }
            $pid = (int) ($existingMap[$item->sku] ?? 0);
            if ($pid <= 0) {
                $new[] = $item;
                continue;
            }

            $needsUpdate = self::sfProductNeedsUpdate(
                $item->data,
                $parentScalars[$pid] ?? null,
                $variationLookup[$pid] ?? [],
            );

            // Stamp _existing_id so the bridge materialize skips its own
            // SKU re-lookup (matches the generic path's contract).
            $stamped = new FeedItem(
                sku: $item->sku,
                data: $item->data + ['_existing_id' => $pid],
                raw: $item->raw,
            );

            if ($needsUpdate) {
                $update[] = $stamped;
            } else {
                $unchanged[] = $stamped;
            }
        }

        return new Diff(new: $new, update: $update, unchanged: $unchanged);
    }

    /**
     * Pure price+stock comparison for one SF product against pre-loaded
     * Woo snapshots. No WP calls — unit-testable in isolation.
     *
     * Returns true when ANYTHING an SF sync owns differs from Woo:
     *   - variable: any per-variation regular/sale price or stock delta,
     *     a size present in the feed but not in Woo (new size), or a
     *     size present in Woo but not the feed (discontinued — the
     *     bridge zeroes its stock, so it must route to update).
     *   - simple: parent regular/sale price or stock delta.
     *
     * Deliberately ignores name / description / attributes: those are
     * not what an SF re-sync maintains, and comparing them is exactly
     * what made the generic classifier flag the whole catalog as
     * changed every run. Scope mirrors GS's rp_rc_gs_detect_changes.
     *
     * @param array<string, mixed> $data       transformed SF item (sfTransformToWoo output)
     * @param array{regular_price?:string,sale_price?:string,stock?:?int,stock_status?:string}|null $scalar parent snapshot (used for simple products)
     * @param array<string, array{regular_price:string,sale_price:string,stock:?int,stock_status:string}> $variationMap  sku → variation snapshot
     */
    public static function sfProductNeedsUpdate(array $data, ?array $scalar, array $variationMap): bool
    {
        $variations = $data['variations'] ?? null;
        $isVariable = ($data['type'] ?? '') === 'variable'
            || (is_array($variations) && $variations !== []);

        if ($isVariable) {
            if (! is_array($variations) || $variations === []) {
                // Incoming claims variable but carries no sizes — can't
                // prove equality. Conservative: route to full update.
                return true;
            }
            $incomingSkus = [];
            foreach ($variations as $var) {
                if (! is_array($var)) continue;
                $vsku = (string) ($var['sku'] ?? '');
                if ($vsku === '') continue;
                $incomingSkus[$vsku] = true;
                $existing = $variationMap[$vsku] ?? null;
                if ($existing === null) {
                    return true; // new size upstream
                }
                if (self::sfStockPriceDiffers($var, $existing)) {
                    return true;
                }
            }
            // Size discontinued upstream but still present in Woo.
            foreach ($variationMap as $existingSku => $_) {
                if (! isset($incomingSkus[$existingSku])) {
                    return true;
                }
            }
            return false;
        }

        // Simple product: compare parent price + stock. A missing
        // snapshot means the parent couldn't be read — route to update
        // rather than silently skip.
        if ($scalar === null) {
            return true;
        }
        return self::sfStockPriceDiffers($data, $scalar);
    }

    /**
     * Shared per-record price+stock comparison. `$incoming` is a feed
     * record (variation or simple parent); `$existing` is the Woo
     * snapshot. Only keys present in `$incoming` are compared, so the
     * feed never has to carry fields it doesn't own.
     *
     * @param array<string, mixed> $incoming
     * @param array{regular_price?:string,sale_price?:string,stock?:?int,stock_status?:string} $existing
     */
    private static function sfStockPriceDiffers(array $incoming, array $existing): bool
    {
        if (array_key_exists('regular_price', $incoming)
            && ! self::sfPriceEquals((string) $incoming['regular_price'], (string) ($existing['regular_price'] ?? ''))) {
            return true;
        }
        if (array_key_exists('sale_price', $incoming)
            && ! self::sfPriceEquals((string) $incoming['sale_price'], (string) ($existing['sale_price'] ?? ''))) {
            return true;
        }
        if (array_key_exists('stock_quantity', $incoming)) {
            $a = (int) $incoming['stock_quantity'];
            $b = ($existing['stock'] ?? null) === null ? -1 : (int) $existing['stock'];
            if ($a !== $b) {
                return true;
            }
        }
        if (array_key_exists('stock_status', $incoming)
            && (string) $incoming['stock_status'] !== (string) ($existing['stock_status'] ?? '')) {
            return true;
        }
        return false;
    }

    /**
     * Tolerant Woo price-string comparison. "" === "" is the no-sale
     * case; one-side-empty is a real change; otherwise compare as floats
     * with sub-cent tolerance (Woo stores at 2dp). Same semantics as
     * StockOnlyClassifier::priceEquals — kept local so the SF path has
     * zero dependency on the generic classifier.
     */
    private static function sfPriceEquals(string $a, string $b): bool
    {
        $aEmpty = $a === '';
        $bEmpty = $b === '';
        if ($aEmpty && $bEmpty) return true;
        if ($aEmpty !== $bEmpty) return false;
        return abs((float) $a - (float) $b) < 0.005;
    }

    /**
     * SF rows pack their image URLs into `_sf_images` (built in
     * transformToWoo). Surfacing them here lets the `media_only` run
     * mode pre-stage downloads into the preimport map before any
     * products exist — a later products-pass then attaches via the
     * URL → attachment lookup without re-downloading.
     */
    public function imageUrls(FeedItem $item): array
    {
        $raw = $item->data['_sf_images'] ?? [];
        if (! is_array($raw)) return [];
        $out = [];
        foreach ($raw as $url) {
            if (is_string($url) && $url !== '' && preg_match('#^https?://#i', $url)) {
                $out[] = $url;
            }
        }
        return array_values(array_unique($out));
    }

    public function materialize(FeedItem $item, Context $ctx): MaterializeResult
    {
        if ($ctx->dryRun) {
            return MaterializeResult::skipped(null, 'dry_run');
        }

        // SF flavor routes through the legacy bridge (same pattern as
        // JsonSource's goldensneakers flavor). The bridge's
        // gh_sf_create_product / gh_sf_update_product handle brand +
        // category + media + variant updates that the generic
        // hsync_upsert_product can't currently do for existing variables.
        if (! empty($item->data['_hsync_flavor']) && $item->data['_hsync_flavor'] === self::FLAVOR_SF) {
            if (! function_exists('hsync_sf_materialize')) {
                return MaterializeResult::failed('Bridge SF non disponibile (host adapter).');
            }
            $sideload = (bool) ($ctx->meta['sideload'] ?? true);
            try {
                $r = \hsync_sf_materialize($item->data, false, $sideload);
            } catch (\Throwable $e) {
                return MaterializeResult::failed($e->getMessage());
            }
            return self::interpretBridgeResponse($r);
        }

        if (! function_exists('hsync_upsert_product')) {
            return MaterializeResult::failed('host adapter non caricato (product/upsert).');
        }

        try {
            $pid = \hsync_upsert_product(
                $item->data,
                ['source' => self::ID, 'context' => $ctx->meta],
            );
        } catch (\Throwable $e) {
            return MaterializeResult::failed($e->getMessage());
        }

        if ($pid === null || $pid <= 0) {
            return MaterializeResult::failed('host_upsert_returned_null');
        }

        $existing = (int) ($item->data['_existing_id'] ?? 0);
        $action = $existing > 0 ? 'updated' : 'created';

        $this->recordProvenance($pid, self::ID, [
            'catalog' => self::ID,
            'pricing' => self::ID,
            'stock'   => self::ID,
        ]);

        return $action === 'updated'
            ? MaterializeResult::updated($pid, ['sku' => $item->sku])
            : MaterializeResult::created($pid, ['sku' => $item->sku]);
    }

    // ─── CSV parsing helpers (pure PHP, unit-testable) ─────────────

    /**
     * Read CSV body from URL. Delegates to the shared retry helper so
     * transient HTTP failures (5xx / cURL timeout / empty body on a
     * 200) surface as TransientSourceException — the runner converts
     * those into a recoverable AJAX response so the JS tick loop
     * resumes from the cursor instead of dropping the unprocessed
     * tail of the feed.
     */
    private static function readUrl(string $url): string
    {
        $r = self::httpGetWithRetries($url);
        return $r['body'];
    }

    private static function readFile(string $path): ?string
    {
        if ($path === '' || ! is_readable($path)) return null;
        $contents = @file_get_contents($path);
        return is_string($contents) && $contents !== '' ? $contents : null;
    }

    /**
     * Parse a CSV body string into rows. Pure PHP — no fopen/fclose
     * needed thanks to str_getcsv per line.
     *
     * @return array<int, array<int, string>>
     */
    public static function parseCsv(string $body, string $delimiter, string $enclosure): array
    {
        $body = preg_replace("/\r\n|\r/", "\n", $body);
        if ($body === null) return [];
        $lines = explode("\n", $body);
        $rows = [];
        foreach ($lines as $line) {
            if ($line === '') continue;
            $row = str_getcsv($line, $delimiter, $enclosure, '\\');
            if ($row !== [null]) $rows[] = $row;
        }
        return $rows;
    }

    /** @return array<string, string> */
    public static function associate(array $header, array $row): array
    {
        $assoc = [];
        foreach ($header as $i => $col) {
            $key = is_string($col) ? trim($col) : (string) $i;
            $assoc[$key] = isset($row[$i]) ? (string) $row[$i] : '';
        }
        return $assoc;
    }

    /**
     * Apply mapping to a row. Each mapping value is one of:
     *
     *   - direct field name        e.g. 'sku' → row['sku']
     *   - dot-path                 e.g. 'sizes.size_eu' → traverses + fans out
     *                              over indexed sub-arrays (returns array)
     *   - template string          e.g. '<p>{brand_name} {name}</p>' → rendered
     *                              against the row, supporting placeholder paths
     *
     * Detection: a value containing a `{...}` chunk is a template;
     * otherwise it's a path.
     */
    public static function applyMapping( array $row, array $mapping ): array
    {
        if ( ! $mapping ) return $row;
        $out = [];
        foreach ( $mapping as $target => $source ) {
            $sourceStr = (string) $source;
            $key       = (string) $target;
            if ( \HiveSync\Workflow\Mapping\Template::isTemplate( $sourceStr ) ) {
                $out[ $key ] = \HiveSync\Workflow\Mapping\Template::render( $sourceStr, $row );
                continue;
            }
            // Plain top-level key wins (preserves CSV-style flat semantics).
            if ( ! str_contains( $sourceStr, '.' ) && array_key_exists( $sourceStr, $row ) ) {
                $out[ $key ] = $row[ $sourceStr ];
                continue;
            }
            // Otherwise treat as a dot-path traversal.
            $resolved = \HiveSync\Workflow\Mapping\PathResolver::resolve( $row, $sourceStr );
            if ( $resolved !== null ) $out[ $key ] = $resolved;
        }
        return $out;
    }

    // ─── Stock-Firmati flavor helpers ────────────────────────────
    //
    // Port of golden-hive's gh_sf_normalize + gh_sf_transform_to_woo.
    // SF CSV has two RECORD_TYPEs sharing one SKU:
    //   - PRODUCT row → master fields (brand, name, prices, images)
    //   - MODEL row   → one variant (size + per-size quantity + barcode)
    //
    // Output: one FeedItem per SKU, data already in the
    // (type / attributes / variations) shape the bridge's gh_sf_create
    // /update_product expects.

    /**
     * @param array<int, array<string, mixed>> $assocRows
     * @param array<int, array>                $markupRules  optional per-rule
     *        overrides resolved against each grouped product's
     *        SF-prefixed fields (`_sf_brand`, `_sf_category`, etc.).
     *        First match wins; no match → fall back to $multiplier.
     * @param string $markupTarget  'sale' (default — only sale_price
     *        gets the multiplier; regular_price = STREET_PRICE) OR
     *        'both' (regular_price ALSO scales by the resolved
     *        multiplier). Mirrors the source-config knob.
     * @return FeedItem[]
     */
    private static function sfNormalizeAndTransform(array $assocRows, float $multiplier, string $importStatus = 'publish', array $markupRules = [], string $markupTarget = 'sale'): array
    {
        $products = [];
        foreach ($assocRows as $row) {
            $type = strtoupper(trim((string) ($row['RECORD_TYPE'] ?? '')));
            if ($type !== 'PRODUCT') continue;
            $sku = trim((string) ($row['SKU'] ?? $row['ORDERCODE'] ?? ''));
            if ($sku === '') continue;
            $products[$sku] = [
                'sku'             => $sku,
                'ordercode'       => trim((string) ($row['ORDERCODE'] ?? $sku)),
                'product_id'      => trim((string) ($row['PRODUCT_ID'] ?? '')),
                'brand'           => self::sfClean((string) ($row['BRAND']      ?? '')),
                'model_name'      => self::sfClean((string) ($row['MODEL_NAME'] ?? '')),
                'name'            => self::sfClean((string) ($row['Titel_ITA']       ?? '')),
                'description'     => self::sfClean((string) ($row['Description_ITA'] ?? '')),
                'street_price'    => (float) ($row['STREET_PRICE'] ?? 0),
                'cost_price'      => (float) ($row['PRICE']        ?? 0),
                'weight'          => (float) ($row['WEIGHT']       ?? 0),
                // PRODUCT-row QUANTITY: real stock for items WITHOUT
                // MODEL rows (bags, wallets, accessories — anything
                // without sizes). Without this, simple SF items land
                // as "Esaurito" with qty=0. The MODEL pass below
                // overwrites this with the SUM of size quantities
                // when sizes ARE present, matching legacy behavior.
                'total_quantity'  => (int) ($row['QUANTITY'] ?? 0),
                'images'          => array_values(array_filter([
                    trim((string) ($row['PICTURE_1'] ?? '')),
                    trim((string) ($row['PICTURE_2'] ?? '')),
                    trim((string) ($row['PICTURE_3'] ?? '')),
                ])),
                'sex'             => self::sfClean((string) ($row['SEX']      ?? '')),
                'category'        => self::sfClean((string) ($row['CAT']      ?? '')),
                'subcategory'     => self::sfClean((string) ($row['SUBCAT']   ?? '')),
                'color_code'      => trim((string) ($row['COLOR_CODE'] ?? '')),
                'color'           => self::sfClean((string) ($row['COLOR']    ?? '')),
                'material'        => self::sfClean((string) ($row['MATERIAL'] ?? '')),
                'made_in'         => trim((string) ($row['MADE_IN']  ?? '')),
                'season'          => trim((string) ($row['STAGIONE'] ?? '')),
                'source_url'      => trim((string) ($row['Product_url'] ?? '')),
                'sizes'           => [],
                '_raw_rows'       => [ $row ],
            ];
        }

        // Second pass: MODEL rows become variants of the matching SKU.
        foreach ($assocRows as $row) {
            $type = strtoupper(trim((string) ($row['RECORD_TYPE'] ?? '')));
            if ($type !== 'MODEL') continue;
            $parentSku = trim((string) ($row['SKU'] ?? ''));
            if ($parentSku === '' || ! isset($products[$parentSku])) continue;
            $size = self::sfClean((string) ($row['MODEL_SIZE'] ?? ''));
            if ($size === '') continue;
            $products[$parentSku]['sizes'][] = [
                'size'     => $size,
                'quantity' => (int) ($row['QUANTITY'] ?? 0),
                'barcode'  => trim((string) ($row['BARCODE'] ?? '')),
                'ean'      => trim((string) ($row['EAN']     ?? '')),
                'model_id' => trim((string) ($row['MODEL_ID'] ?? '')),
                'price'    => (float) ($row['PRICE'] ?? $products[$parentSku]['cost_price']),
            ];
            $products[$parentSku]['_raw_rows'][] = $row;
            // Aggregate stock: the FIRST size row replaces the
            // PRODUCT-row QUANTITY claim, the rest accumulate — same
            // outcome as legacy gh_sf_normalize's full re-sum, but O(S)
            // instead of O(S²) per product (the old array_sum ×
            // array_column pass over the growing sizes array copied
            // S(S+1)/2 elements — ~1.2M redundant copies on a 150k-row
            // SF feed).
            if (count($products[$parentSku]['sizes']) === 1) {
                $products[$parentSku]['total_quantity'] = 0;
            }
            $products[$parentSku]['total_quantity'] += (int) ($row['QUANTITY'] ?? 0);
        }

        $items = [];
        foreach ($products as $sku => $p) {
            $rawRows = $p['_raw_rows'];
            unset($p['_raw_rows']);

            // Per-product markup: rule lookup against SF-prefixed
            // fields, fall back to the flat sf_markup_value multiplier
            // when no rule matches. Field-name convention
            // (`_sf_brand`, `_sf_category`, …) matches the description
            // text the operator sees in the source-config UI and the
            // datalist suggestions on the markup_rules editor. The
            // grouped product carries unprefixed keys, so we project
            // them under the `_sf_` namespace just for the rule check.
            $perProductMultiplier = $multiplier;
            if ($markupRules !== []) {
                $catLevel = self::sfClean((string) ($p['category']    ?? ''));
                $subLevel = self::sfClean((string) ($p['subcategory'] ?? ''));
                // Virtual fields covering common gotchas:
                //   _sf_taxonomy        → "category > subcategory" combined,
                //                         match anywhere with `contains`.
                //   _sf_taxonomy_any    → category OR subcategory, whichever
                //                         the operator's rule expects, so
                //                         `_sf_taxonomy_any equals pantaloni`
                //                         matches whether the feed puts
                //                         "Pantaloni" in CAT or SUBCAT.
                $ruleData = [
                    '_sf_brand'           => $p['brand']       ?? '',
                    '_sf_category'        => $catLevel,
                    '_sf_subcategory'     => $subLevel,
                    '_sf_taxonomy'        => trim($catLevel . ' > ' . $subLevel, ' >'),
                    '_sf_taxonomy_any'    => $subLevel !== '' ? $subLevel : $catLevel,
                    '_sf_sex'             => $p['sex']         ?? '',
                    '_sf_color'           => $p['color']       ?? '',
                    '_sf_material'        => $p['material']    ?? '',
                    '_sf_made_in'         => $p['made_in']     ?? '',
                    '_sf_season'          => $p['season']      ?? '',
                ];
                $matched = MarkupResolver::ruleMultiplier($ruleData, $markupRules);
                if ($matched !== null) $perProductMultiplier = $matched;
            }

            $woo = self::sfTransformToWoo($p, $perProductMultiplier, $importStatus, $markupTarget);
            $woo['_hsync_flavor'] = self::FLAVOR_SF;
            // Diagnostic: surface the multiplier ACTUALLY APPLIED to
            // this product so test-fetch can show whether a rule
            // matched. `_sf_applied_multiplier` shows up in the
            // shape preview — operator can compare across products
            // to verify rules fire correctly without reading the run
            // log. Read-only meta, ignored by the bridge.
            $woo['_sf_applied_multiplier'] = $perProductMultiplier;
            $woo['_sf_markup_target']      = $markupTarget;
            $items[] = new FeedItem(sku: (string) $sku, data: $woo, raw: $rawRows);
        }
        return $items;
    }

    /**
     * Port of gh_sf_transform_to_woo. Produces the exact shape the
     * legacy bridge's gh_sf_create_product / gh_sf_update_product
     * expect: type + status + meta (`_sf_*`) + variations[].
     *
     * @param array<string, mixed> $product
     * @return array<string, mixed>
     */
    private static function sfTransformToWoo(array $product, float $multiplier, string $importStatus = 'publish', string $markupTarget = 'sale'): array
    {
        $sizes    = $product['sizes'] ?? [];
        $hasSizes = count($sizes) > 0;
        $type     = $hasSizes ? 'variable' : 'simple';

        $streetPrice = (float) ($product['street_price'] ?? 0);
        $costPrice   = (float) ($product['cost_price']   ?? 0);
        $salePrice   = round($costPrice * $multiplier);
        // 'sale' (default) → regular_price tracks STREET_PRICE (RRP)
        //                    untouched. Markup affects sale_price only.
        // 'both'           → regular_price ALSO scales by the same
        //                    multiplier — useful when the operator
        //                    wants the displayed RRP to inflate
        //                    proportionally with the rule (e.g. show
        //                    a higher "list" price next to the sale).
        $regPrice    = $markupTarget === 'both'
            ? round($streetPrice * $multiplier)
            : round($streetPrice);

        $name = ($product['name'] !== '')
            ? $product['name']
            : trim(($product['brand'] ?? '') . ' ' . ($product['model_name'] ?? ''));

        $woo = [
            'name'              => $name,
            'sku'               => $product['sku'],
            'type'              => $type,
            'status'             => $importStatus,
            'description'       => $product['description'] ?? '',
            'weight'            => ($product['weight'] ?? 0) > 0 ? (string) $product['weight'] : '',
            // SF-specific meta read by the legacy bridge for taxonomy +
            // image sideload during create/update.
            '_sf_brand'         => $product['brand']       ?? '',
            '_sf_category'      => $product['category']    ?? '',
            '_sf_subcategory'   => $product['subcategory'] ?? '',
            '_sf_sex'           => $product['sex']         ?? '',
            '_sf_color'         => $product['color']       ?? '',
            '_sf_material'      => $product['material']    ?? '',
            '_sf_made_in'       => $product['made_in']     ?? '',
            '_sf_season'        => $product['season']      ?? '',
            '_sf_images'        => $product['images']      ?? [],
            '_sf_source_url'    => $product['source_url']  ?? '',
            '_sf_cost_price'    => $costPrice,
        ];

        if ($type === 'simple') {
            // Same fallback as variable variants: when STREET_PRICE is
            // absent, promote the markup-adjusted cost to regular_price
            // so the product isn't a $0 ghost.
            if ($regPrice <= 0 && $salePrice > 0) {
                $regPrice  = $salePrice;
                $salePrice = 0;
            }
            $woo['regular_price']  = (string) $regPrice;
            $woo['sale_price']     = $salePrice > 0 ? (string) $salePrice : '';
            $woo['manage_stock']   = true;
            // Stock for simple SF items (bags, wallets, anything
            // without size variants) comes from the PRODUCT row's
            // QUANTITY column — captured into total_quantity by
            // sfNormalizeAndTransform. The previous hardcoded 0
            // landed every simple product as "Esaurito" regardless
            // of feed reality. Mirrors legacy gh_sf_transform_to_woo.
            $totalQty = (int) ($product['total_quantity'] ?? 0);
            $woo['stock_quantity'] = $totalQty;
            $woo['stock_status']   = $totalQty > 0 ? 'instock' : 'outofstock';
            $brand = (string) ($product['brand'] ?? '');
            if ($brand !== '') {
                $woo['attributes'] = [
                    'pa_brand' => ['options' => [$brand], 'visible' => true, 'variation' => false],
                ];
            }
            return $woo;
        }

        $allSizes = array_column($sizes, 'size');
        $woo['attributes'] = [
            'pa_taglia' => [
                'options'   => array_values(array_unique($allSizes)),
                'visible'   => true,
                'variation' => true,
            ],
        ];
        // Brand as a non-variation taxonomy attribute so the front-end
        // attribute filter can target it (Woo's product_brand alone
        // covers Woo Brands plugin filters; pa_brand covers the
        // built-in attribute filter widget). Mirrors JsonSource's
        // approach so SF and GS imports look identical in admin.
        $brand = (string) ($product['brand'] ?? '');
        if ($brand !== '') {
            $woo['attributes']['pa_brand'] = [
                'options'   => [$brand],
                'visible'   => true,
                'variation' => false,
            ];
        }

        $variations = [];
        $totalQty   = 0;
        foreach ($sizes as $size) {
            $varCost   = (float) ($size['price']    ?: $costPrice);
            $varSale   = round($varCost * $multiplier);
            // Mirror the parent's markup_target semantics on each
            // variant: 'both' scales regular_price together with
            // sale_price; 'sale' (default) keeps regular at the raw
            // STREET_PRICE.
            $varReg    = $markupTarget === 'both'
                ? round($streetPrice * $multiplier)
                : round($streetPrice);
            $qty       = (int) ($size['quantity'] ?? 0);
            $totalQty += $qty;
            // Fallback: STREET_PRICE column is optional in many SF
            // feed exports. Without it $varReg is 0 → Woo treats the
            // variant as a free / hidden product. Use the markup-
            // adjusted cost as the regular price so the variant is
            // visible and priced sanely. Drop sale_price in that case
            // (no separate "sale" without an RRP to compare against).
            if ($varReg <= 0 && $varSale > 0) {
                $varReg  = $varSale;
                $varSale = 0;
            }
            $variations[] = [
                'attributes'     => [ 'pa_taglia' => (string) $size['size'] ],
                'sku'            => (string) $product['sku'] . '-' . self::sfSlug((string) $size['size']),
                'regular_price'  => (string) $varReg,
                'sale_price'     => $varSale > 0 ? (string) $varSale : '',
                'manage_stock'   => true,
                'stock_quantity' => $qty,
                'stock_status'   => $qty > 0 ? 'instock' : 'outofstock',
                // ALWAYS publish — `product_variation` post type rejects
                // 'draft' (only publish/private/trash are valid). With
                // status=draft the WC data store silently fails to
                // persist the variation, leaving the variable parent
                // with zero children. The user's draft preference
                // applies to the PARENT only; visibility on the
                // storefront is gated by the parent's status, not
                // the variation's. Mirrors legacy gh_sf_transform_to_woo.
                'status'         => 'publish',
            ];
        }
        $woo['variations']     = $variations;
        $woo['manage_stock']   = false;
        $woo['stock_quantity'] = $totalQty;
        $woo['stock_status']   = $totalQty > 0 ? 'instock' : 'outofstock';
        return $woo;
    }

    /**
     * SF subset filter: keep the items whose CAT / SUBCAT pass the
     * operator's `category_filter` — the Importa tab's "solo alcune
     * categorie", or a job that syncs a slice of the catalog. Matching
     * rules (exact paths vs the legacy substring form) live in
     * CategoryFilter.
     *
     * @param FeedItem[]                 $items
     * @param list<array<string, mixed>> $filter  CategoryFilter::parse() output
     * @return FeedItem[]
     */
    private static function applySfCategoryFilter(array $items, array $filter): array
    {
        if ($filter === []) return $items;
        $out = [];
        foreach ($items as $item) {
            $path = self::sfCategoryPath($item);
            if ($path !== null && CategoryFilter::matches($path[0], $path[1], $filter)) $out[] = $item;
        }
        return $out;
    }

    /**
     * Only the StockFirmati flavor carries a category tree (CAT →
     * SUBCAT); a generic CSV maps whatever it has into `categories`,
     * which is a flat list, not a tree.
     */
    public function hasCategories(array $config): bool
    {
        return (string) ($config['flavor'] ?? self::FLAVOR_GENERIC) === self::FLAVOR_SF;
    }

    public function categoryPath(FeedItem $item): ?array
    {
        return self::sfCategoryPath($item);
    }

    /**
     * [CAT, SUBCAT] of an SF item as the transform stored them; null for
     * anything that isn't an SF item.
     *
     * @return array{0: string, 1: string}|null
     */
    private static function sfCategoryPath(FeedItem $item): ?array
    {
        if (($item->data['_hsync_flavor'] ?? '') !== self::FLAVOR_SF) return null;
        return [
            (string) ($item->data['_sf_category']    ?? ''),
            (string) ($item->data['_sf_subcategory'] ?? ''),
        ];
    }

    /**
     * Resolve the effective price multiplier from the source-config.
     * Supports two operator-facing modes:
     *
     *   - 'multiplier' (default) — value is the literal factor. 3.5
     *                              means cost × 3.5. Decimals + commas
     *                              accepted (3.5 / 3,5 / 2.0 / 1).
     *   - 'percent'              — value is a markup percent applied
     *                              ABOVE the cost. 250 → +250% → cost × 3.5.
     *                              0 means no markup.
     *
     * Backward compat: if sf_markup_value is empty but the legacy
     * sf_markup_multiplier (int × 10) is present, fall through to it
     * so existing source-configs keep working without manual edit.
     */
    /** Public diagnostic wrapper. The markup-rules tester needs the
     *  flat multiplier without re-running the whole fetch. */
    public static function resolveSfMarkupPublic(array $cfg): float
    {
        return self::resolveSfMarkup($cfg);
    }

    private static function resolveSfMarkup(array $cfg): float
    {
        $rawValue = trim((string) ($cfg['sf_markup_value'] ?? ''));
        if ($rawValue === '') {
            // Legacy field: int × 10 (e.g. 35 → 3.5).
            $legacy = (int) ($cfg['sf_markup_multiplier'] ?? 35);
            return max(0.01, $legacy / 10.0);
        }
        // Accept European decimal separator (3,5 → 3.5).
        $value = (float) str_replace(',', '.', $rawValue);
        $mode  = (string) ($cfg['sf_markup_mode'] ?? 'multiplier');
        if ($mode === 'percent') {
            // 250 → cost × 3.5. Negative percents are clamped to a
            // floor so we never invert the sign of a price.
            return max(0.01, 1.0 + ($value / 100.0));
        }
        return max(0.01, $value);
    }

    /**
     * Build a human-readable warning when the parsed CSV looks
     * suspicious. Most common failure: every row has exactly 1
     * column → delimiter mismatch. Returns '' when shape looks fine.
     */
    private static function diagnoseCsvShape(array $rows, string $delimiter, int $bodyBytes): string
    {
        if (empty($rows)) return '';
        $firstRow = $rows[0];
        $cols     = is_array($firstRow) ? count($firstRow) : 0;

        // Heuristic: if the first row is exactly 1 cell AND the body
        // contains a different common separator, the delimiter is
        // probably wrong.
        if ($cols === 1 && $bodyBytes > 0) {
            $cell = is_array($firstRow) ? (string) ($firstRow[0] ?? '') : '';
            $candidates = [];
            foreach ([ ';' => 'punto e virgola (;)', ',' => 'virgola (,)', "\t" => 'tab', '|' => 'pipe (|)' ] as $char => $label) {
                if ($char === $delimiter) continue;
                if (substr_count($cell, $char) >= 3) $candidates[] = $label;
            }
            $hint = $candidates
                ? ' La prima riga sembra contenere ' . implode(' / ', $candidates) . ' — prova quel delimitatore.'
                : '';
            return 'Le righe sembrano composte da una sola colonna: il delimitatore "' . self::renderDelimiter($delimiter) . '" probabilmente non combacia con il file.' . $hint;
        }
        return '';
    }

    /**
     * SF-specific shape check: how many PRODUCT vs MODEL records are
     * in the body. Mismatch warnings give the operator a clear path
     * back to the source.
     */
    private static function diagnoseSfRows(array $assocRows, ?array $header): string
    {
        if (empty($assocRows)) return '';
        if ($header !== null && ! in_array('RECORD_TYPE', array_map('strval', $header), true)) {
            return 'Header CSV non contiene la colonna RECORD_TYPE — il flavor StockFirmati richiede questa colonna.';
        }
        $product = 0; $model = 0; $other = 0;
        foreach ($assocRows as $r) {
            $t = strtoupper(trim((string) ($r['RECORD_TYPE'] ?? '')));
            if ($t === 'PRODUCT') $product++;
            elseif ($t === 'MODEL') $model++;
            else                   $other++;
        }
        if ($product === 0) {
            return 'Nessuna riga PRODUCT trovata (ne servono per definire i prodotti master). Trovate ' . $model . ' MODEL e ' . $other . ' altre.';
        }
        return '';
    }

    private static function renderDelimiter(string $d): string
    {
        return match ($d) {
            ','  => ',',
            ';'  => ';',
            "\t" => '\\t',
            '|'  => '|',
            default => $d,
        };
    }

    private static function sfClean(string $v): string
    {
        // Strip control chars + collapse whitespace (matches gh_sf_clean).
        $v = preg_replace('/[\x00-\x1F\x7F]/u', ' ', $v) ?? $v;
        $v = preg_replace('/\s+/', ' ', $v) ?? $v;
        return trim($v);
    }

    private static function sfSlug(string $v): string
    {
        if (function_exists('sanitize_title')) return \sanitize_title($v);
        return strtolower(preg_replace('/[^a-z0-9]+/i', '-', $v) ?? $v);
    }

    /**
     * @param mixed $r
     */
    private static function interpretBridgeResponse($r): MaterializeResult
    {
        if (! is_array($r)) {
            return MaterializeResult::failed('host_returned_non_array');
        }
        $action = (string) ($r['action'] ?? 'error');
        $pid    = (int) ($r['id'] ?? 0);
        if ($action === 'error' || $pid <= 0) {
            return MaterializeResult::failed(
                error: (string) ($r['reason'] ?? 'unknown_error'),
                productId: $pid > 0 ? $pid : null,
            );
        }
        return match ($action) {
            'updated'   => MaterializeResult::updated($pid, $r),
            'recreated' => MaterializeResult::recreated($pid, $r),
            default     => MaterializeResult::created($pid, $r),
        };
    }
}
