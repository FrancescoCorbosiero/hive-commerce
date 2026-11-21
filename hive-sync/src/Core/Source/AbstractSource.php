<?php
declare(strict_types=1);

namespace HiveSync\Core\Source;

/**
 * Base class concrete Sources extend. Provides the cross-cutting helpers
 * that previously lived (duplicated) inside each feed-*.php file.
 *
 * Implemented now (pure PHP, unit-testable):
 *   - validateConfig()        : enforces required + type from configSchema()
 *   - applyWithBinarySplit()  : retry on failure, recursively split batch
 *
 * Implemented as wrappers over the host adapter (so missing host wiring
 * becomes a default-allow no-op rather than a fatal):
 *   - recordProvenance()      : hsync_record_conflict(...)
 *   - resolveConflict()       : hsync_resolve_conflict(...)
 *
 * Concrete sources MUST extend this class, not implement Source directly.
 * That guarantees future cross-cutting concerns reach every source by
 * editing one place.
 */
abstract class AbstractSource implements Source
{
    abstract public function id(): string;

    abstract public function label(): string;

    abstract public function capabilities(): SourceCapabilities;

    abstract public function configSchema(): array;

    abstract public function fetch(FetchRequest $request, Context $ctx): FetchResult;

    abstract public function diff(array $items, Context $ctx): Diff;

    abstract public function materialize(FeedItem $item, Context $ctx): MaterializeResult;

    /**
     * Image URLs this item wants attached as featured + gallery. Used by
     * the `media_only` run mode (Importa tab → "Solo media") to pre-stage
     * downloads into the preimport map BEFORE any products exist. A later
     * products-pass then resolves URL → attachment via the same map and
     * attaches without re-downloading. Order-agnostic by construction —
     * the map IS the contract.
     *
     * Default returns []. Sources that produce images override this. The
     * base impl is a no-op so a `media_only` run against a feed that
     * doesn't expose its images at this level cleanly reports zero work
     * (rather than fataling).
     *
     * @return string[]
     */
    public function imageUrls(FeedItem $item): array
    {
        return [];
    }

    /**
     * Provenance key this source stamps on the products it creates —
     * the value that ends up in `_gh_import_source`. MissingSweeper uses
     * it to scope the "which of my products did the feed stop listing?"
     * query; nothing else reads it today.
     *
     * Return '' to opt a source OUT of the sweep entirely. That is the
     * right answer whenever the source's materialize path doesn't write
     * a provenance meta of its own (the generic hsync_upsert_product
     * flavors), because a sweep that can't prove ownership would either
     * find nothing (harmless but misleading) or, worse, match products
     * another source created.
     *
     * Config-dependent by signature because provenance follows the
     * flavor, not the class: one JsonSource serves both the GS feed
     * (whose bridge stamps 'goldensneakers') and arbitrary generic
     * feeds (which stamp nothing).
     *
     * @param array<string, mixed> $config
     */
    public function provenanceKey(array $config): string
    {
        return '';
    }

    /**
     * Whether this config's feed carries a category tree the operator
     * can pick from (Importa → "Solo alcune categorie") and that
     * `options.category_filter` narrows. Default false: the picker is
     * simply not offered, rather than listing a tree that the filter
     * would then not honour.
     *
     * @param array<string, mixed> $config
     */
    public function hasCategories(array $config): bool
    {
        return false;
    }

    /**
     * [category, subcategory] of a fetched item — the node of the tree
     * the category picker counts it under. null when the item has no
     * category concept at all. Must agree with how the source applies
     * `options.category_filter`, or the counts in the picker stop being
     * the numbers the import touches.
     *
     * @return array{0: string, 1: string}|null
     */
    public function categoryPath(FeedItem $item): ?array
    {
        return null;
    }

    // ─── Helpers ───────────────────────────────────────────────────

    /**
     * Validate a config payload against this source's configSchema().
     *
     * @return array{ok: bool, config?: array, errors?: array<string, string>}
     */
    protected function validateConfig(array $config): array
    {
        $schema = $this->configSchema();
        $clean = [];
        $errors = [];

        foreach ($schema as $field => $spec) {
            $type = (string) ($spec['type'] ?? 'text');
            $required = (bool) ($spec['required'] ?? false);
            $max = isset($spec['max']) ? (int) $spec['max'] : null;
            $value = $config[$field] ?? null;

            if ($value === null || $value === '') {
                if ($required) {
                    $errors[$field] = 'required';
                    continue;
                }
                $clean[$field] = $value === null ? '' : $value;
                continue;
            }

            switch ($type) {
                case 'url':
                    if (! is_string($value) || ! preg_match('#^https?://#i', $value)) {
                        $errors[$field] = 'invalid_url';
                        continue 2;
                    }
                    break;
                case 'enum':
                    $options = (array) ($spec['options'] ?? []);
                    if (! in_array($value, $options, true)) {
                        $errors[$field] = 'invalid_option';
                        continue 2;
                    }
                    break;
                case 'int':
                    if (! is_numeric($value)) {
                        $errors[$field] = 'invalid_int';
                        continue 2;
                    }
                    $value = (int) $value;
                    break;
                case 'bool':
                    $value = (bool) $value;
                    break;
                // Structured types — schema authors flag fields that carry
                // arrays (or other non-scalar shapes) here so the default
                // (string) cast below doesn't silently flatten them to
                // "Array". MarkupResolver::normalize handles the deeper
                // validation downstream, so we just pass the value through.
                // Without this, markup_rules typed in the UI survive AJAX
                // transport intact but get cast to "Array" inside
                // validateConfig, and the downstream `is_array` guard in
                // normalize() drops every rule — the symptom was
                // multiplier × 1.00 on every row even when the operator's
                // rule pill matched on the JS side.
                case 'markup_rules':
                    if (! is_array($value)) $value = [];
                    break;
                case 'secret':
                case 'text':
                default:
                    // Be defensive: scalar-only cast. Non-scalars (arrays
                    // for unknown structured types) pass through unchanged
                    // so future schema types don't repeat the markup_rules
                    // bug. Stringly-typed schema fields still get cast.
                    if (is_scalar($value)) $value = (string) $value;
            }

            if ($max !== null && is_string($value) && strlen($value) > $max) {
                $errors[$field] = 'too_long';
                continue;
            }

            $clean[$field] = $value;
        }

        if ($errors) {
            return ['ok' => false, 'errors' => $errors];
        }
        return ['ok' => true, 'config' => $clean];
    }

    /**
     * Apply $applyBatch to $items. If the callable throws, recursively split
     * the batch and retry — isolating bad items down to singletons before
     * giving up. A single bad record in a batch of 25 no longer poisons
     * the other 24.
     *
     * @param mixed[]                    $items
     * @param callable(mixed[]): mixed[] $applyBatch
     * @return array{ok: mixed[], failed: array<int, array{item: mixed, error: string}>}
     */
    protected function applyWithBinarySplit(
        array $items,
        callable $applyBatch,
        int $minBatch = 1,
        int $maxDepth = 8,
    ): array {
        $results = ['ok' => [], 'failed' => []];
        if (! $items) {
            return $results;
        }

        $stack = [[$items, 0]];
        while ($stack) {
            [$batch, $depth] = array_pop($stack);
            if (! $batch) {
                continue;
            }

            try {
                $batchResults = $applyBatch($batch);
                foreach ((array) $batchResults as $r) {
                    $results['ok'][] = $r;
                }
                continue;
            } catch (\Throwable $e) {
                $count = count($batch);
                if ($count <= $minBatch || $depth >= $maxDepth) {
                    foreach ($batch as $item) {
                        $results['failed'][] = ['item' => $item, 'error' => $e->getMessage()];
                    }
                    continue;
                }
                $half = (int) ceil($count / 2);
                $left = array_slice($batch, 0, $half);
                $right = array_slice($batch, $half);
                $stack[] = [$right, $depth + 1];
                $stack[] = [$left, $depth + 1];
            }
        }

        return $results;
    }

    /**
     * Retry-aware HTTP GET wrapper around wp_remote_get. Throws
     * TransientSourceException after exhausting retries on the
     * failure classes the JS tick loop knows how to re-attempt:
     *  - WP_Error (network / DNS / cURL timeout)
     *  - HTTP 5xx / 408 / 429
     *  - HTTP 200 with empty body (proxy truncation, upstream blip)
     *
     * Non-transient failures (4xx other than 408/429, success with
     * body) return normally — caller decides what to do with them.
     *
     * Why this exists: SF / GS feeds are multi-MB and a single tick
     * blip leaves the runner with `items=[]`, the for-loop iterates
     * zero times, and the run silently finishes "done" with the
     * remaining ~10k rows unaccounted (because each tick re-fetches
     * from scratch). With this helper a transient blip becomes a
     * recoverable exception → AJAX returns recoverable:true → JS
     * retries the same tick → work resumes from the cursor.
     *
     * @param array<string, mixed> $args  passed to wp_remote_get; any
     *        operator-supplied args (timeout, headers, etc.) win.
     * @return array{code:int, body:string}
     */
    protected static function httpGetWithRetries(
        string $url,
        array $args = [],
        int $maxAttempts = 3,
    ): array {
        if ($url === '' || ! function_exists('wp_remote_get')) {
            throw new TransientSourceException('URL vuoto o wp_remote_get non disponibile.');
        }
        $defaultArgs = [
            'timeout'             => 120,
            'redirection'         => 5,
            'limit_response_size' => 0,
        ];
        $args = $args + $defaultArgs;

        $lastErr = 'unknown';
        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            $resp = \wp_remote_get($url, $args);
            if (function_exists('is_wp_error') && \is_wp_error($resp)) {
                $lastErr = 'WP_Error: ' . $resp->get_error_message();
            } else {
                $code = (int) \wp_remote_retrieve_response_code($resp);
                $body = (string) \wp_remote_retrieve_body($resp);
                // Non-transient: surface to caller for normal handling.
                // 4xx (except 408/429) means "this request is wrong" —
                // retrying won't help; let fetch() format the warning.
                $isTransientCode = $code === 0 || $code === 408 || $code === 429 || $code >= 500;
                if (! $isTransientCode && $code >= 200 && $code < 400 && $body !== '') {
                    return ['code' => $code, 'body' => $body];
                }
                if (! $isTransientCode) {
                    // 200-with-empty-body counts as transient (proxy
                    // truncation). 4xx with body returns to caller.
                    if ($code >= 200 && $code < 400 && $body === '') {
                        $lastErr = "HTTP {$code} con body vuoto";
                    } else {
                        return ['code' => $code, 'body' => $body];
                    }
                } else {
                    $lastErr = "HTTP {$code}" . ($body !== '' ? ' (' . substr($body, 0, 200) . ')' : '');
                }
            }
            if ($attempt < $maxAttempts) {
                // Backoff 1s, 2s, 4s — same shape as the JS retry,
                // half the magnitude (the JS already adds its own wait
                // around the whole tick when this throws).
                $wait = (int) pow(2, $attempt - 1);
                sleep($wait);
            }
        }
        throw new TransientSourceException(
            'Lettura URL fallita dopo ' . $maxAttempts . ' tentativi: ' . $lastErr
        );
    }

    /**
     * Record provenance after a successful materialize. Routes through the
     * host adapter — when no host is wired this is a silent no-op.
     *
     * @param array<string, string> $sliceOwners e.g. ['pricing' => 'goldensneakers']
     */
    protected function recordProvenance(int $productId, string $source, array $sliceOwners = []): void
    {
        if ($productId <= 0) return;
        if (function_exists('hsync_record_conflict')) {
            \hsync_record_conflict($productId, $source, $sliceOwners);
        }
    }

    /**
     * Ask the conflict engine which slices we may write. When the host is
     * not bound, default-allow (legacy behavior preserved).
     *
     * @return array{allowed_slices: array<string,bool>, blocked: array<string,string>, applied_rule: ?string}
     */
    protected function resolveConflict(int $productId, array $incoming, string $sourceId): array
    {
        if (function_exists('hsync_resolve_conflict')) {
            $res = \hsync_resolve_conflict($productId, $incoming, $sourceId);
            return [
                'allowed_slices' => (array) ($res['allowed_slices'] ?? []),
                'blocked'        => (array) ($res['blocked'] ?? []),
                'applied_rule'   => isset($res['applied_rule']) ? (string) $res['applied_rule'] : null,
            ];
        }
        return [
            'allowed_slices' => ['catalog' => true, 'pricing' => true, 'stock' => true, 'media' => true],
            'blocked'        => [],
            'applied_rule'   => null,
        ];
    }
}
