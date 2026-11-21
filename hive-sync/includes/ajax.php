<?php
/**
 * Hive Sync AJAX endpoints.
 *
 * All handlers share the same guard:
 *   1. check_ajax_referer( 'hsync_nonce', 'nonce' )
 *   2. current_user_can( 'manage_woocommerce' )
 *   3. wp_send_json_success / wp_send_json_error
 *
 * Endpoints (prefix hsync_ajax_):
 *   sources_list           → registered Sources + their config schemas
 *   source_test_fetch      → run Source::fetch with provided config; preview
 *   mappings_list          → MappingRepository::all(?source_kind)
 *   mappings_save          → MappingRepository::save
 *   mappings_delete        → MappingRepository::delete
 *   run_now                → ImportRunner::run (ad-hoc, dry-run optional)
 *   runs_recent            → RunRepository::recent
 */

defined( 'ABSPATH' ) || exit;

function hsync_ajax_guard(): void {
    check_ajax_referer( 'hsync_nonce', 'nonce' );
    if ( ! current_user_can( 'manage_woocommerce' ) ) {
        wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );
    }
}

function hsync_post_text( string $key, string $default = '' ): string {
    return isset( $_POST[ $key ] ) ? sanitize_text_field( wp_unslash( (string) $_POST[ $key ] ) ) : $default;
}

function hsync_post_json( string $key, array $default = [] ): array {
    if ( ! isset( $_POST[ $key ] ) ) return $default;
    $raw = is_string( $_POST[ $key ] ) ? wp_unslash( (string) $_POST[ $key ] ) : '';
    if ( $raw === '' ) return $default;
    $decoded = json_decode( $raw, true );
    return is_array( $decoded ) ? $decoded : $default;
}

function hsync_post_bool( string $key ): bool {
    if ( ! isset( $_POST[ $key ] ) ) return false;
    $v = strtolower( (string) wp_unslash( (string) $_POST[ $key ] ) );
    return in_array( $v, [ '1', 'true', 'on', 'yes' ], true );
}

/**
 * Arms a shutdown handler that converts PHP fatals into a JSON envelope
 * so the JS client always sees `{success:false, data:{message,...}}`
 * instead of HTML. Without this, a fatal during an AJAX tick leaks
 * WordPress's HTML error page and crashes the JS JSON parser
 * ("Unexpected token '<'") — the user reported this on tick 134 of a
 * 15k-product import.
 *
 * Idempotent — safe to call from each handler that needs the guard.
 */
function hsync_arm_fatal_guard(): void {
    static $armed = false;
    if ( $armed ) return;
    $armed = true;

    // Open our own output buffer NOW, at handler entry. The shutdown
    // cleaner below can only drop HTML it can still reach via
    // ob_end_clean() — and WordPress's own fatal handler
    // (WP_Fatal_Error_Handler, registered during core bootstrap) emits
    // its "critical error" HTML page with `exit => false`, so it writes
    // into whatever buffer is on top of the stack at shutdown. Without a
    // buffer of ours open, that HTML is flushed straight to the client
    // and our JSON envelope below just gets appended after it — which is
    // exactly the "risposta non-JSON: <p>Si è verificato un errore…"
    // the tick loop reports. With the buffer open, the HTML lands in it
    // and the cleaner discards it before we emit clean JSON.
    if ( function_exists( 'ob_start' ) ) {
        ob_start();
    }

    register_shutdown_function( static function (): void {
        $err = error_get_last();
        if ( ! $err ) return;
        $fatalTypes = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR;
        if ( ! ( $err['type'] & $fatalTypes ) ) return;

        // Drop EVERY buffer level — ours plus WordPress's HTML error
        // page — so the client gets ONLY our JSON envelope.
        while ( ob_get_level() > 0 ) {
            @ob_end_clean();
        }

        if ( ! headers_sent() ) {
            status_header( 500 );
            header( 'Content-Type: application/json; charset=utf-8' );
        }

        $payload = [
            'success' => false,
            'data'    => [
                'message' => sprintf(
                    'PHP fatal: %s @ %s:%d',
                    (string) $err['message'],
                    basename( (string) $err['file'] ),
                    (int) $err['line']
                ),
                'fatal'       => true,
                // Let the JS tick loop offer "Riprendi da qui" with the
                // cursor it already holds — same contract as the
                // handler's \Throwable catch. A deterministic fatal
                // (OOM/timeout) won't recover by retry, but the user
                // sees the real PHP message instead of an HTML wall.
                'recoverable' => true,
            ],
        ];
        echo wp_json_encode( $payload );
    } );
}

/**
 * Give heavy import ticks the headroom the legacy feed handlers had.
 *
 * The old golden-hive bridge (gh_ajax_fc_apply / rp_rc_ajax_gs_fetch)
 * opened every batch with `@set_time_limit(300)` + `wp_raise_memory_limit`.
 * The hive-sync run handler dropped both, relying solely on the 25s
 * cooperative deadline. But that deadline only bounds the per-item
 * PROCESSING loop — tick 1 fetches + transforms + diffs the ENTIRE feed
 * before the loop is reached. On a multi-thousand-row SF/GS feed that
 * one-shot phase blows the default PHP max_execution_time / memory_limit
 * and dies with an UNCATCHABLE fatal (try/catch can't trap OOM or a
 * timeout), surfacing as WordPress's HTML "critical error" page — the
 * "Tick 1 … HTTP 500 risposta non-JSON" the operator reported.
 *
 * 300s matches the proven legacy value: ample for tick 1's one-shot
 * fetch+transform+diff (tens of seconds even on a 10k-row feed) while
 * staying under typical FastCGI/reverse-proxy timeouts, so a genuinely
 * runaway tick still fails fast instead of hanging the worker. Normal
 * ticks never approach it — the 25s cooperative deadline yields the
 * processing loop long before. The memory raise lifts to
 * WP_MAX_MEMORY_LIMIT for the duration of the request.
 */
function hsync_raise_limits(): void {
    if ( function_exists( 'set_time_limit' ) ) {
        @set_time_limit( 300 );
    }
    if ( function_exists( 'wp_raise_memory_limit' ) ) {
        wp_raise_memory_limit( 'admin' );
    }
}

// ─── Sources ───────────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_sources_list', function () {
    hsync_ajax_guard();
    if ( ! \HiveSync\Core\Bootstrap::$sources ) {
        wp_send_json_success( [ 'sources' => [] ] );
    }
    $out = [];
    foreach ( \HiveSync\Core\Bootstrap::$sources->all() as $src ) {
        $cap = $src->capabilities();
        $out[] = [
            'id'           => $src->id(),
            'label'        => $src->label(),
            'capabilities' => [
                'can_fetch'        => $cap->canFetch,
                'can_diff'         => $cap->canDiff,
                'can_materialize'  => $cap->canMaterialize,
                'image_sideload'   => $cap->supportsImageSideload,
            ],
            'config_schema' => $src->configSchema(),
        ];
    }
    wp_send_json_success( [ 'sources' => $out ] );
} );

/**
 * Resolve the effective config for a source invocation: either an
 * inline config blob OR a saved config slug. The saved one always
 * takes precedence (its values include real plaintext secrets).
 */
function hsync_resolve_source_config( array $inline, string $configSlug ): array {
    if ( $configSlug !== '' ) {
        $repo = new \HiveSync\Core\Repo\SourceConfigRepository();
        $row  = $repo->find( $configSlug );
        if ( $row ) return (array) $row['config'];
    }
    return $inline;
}

add_action( 'wp_ajax_hsync_ajax_source_test_fetch', function () {
    hsync_ajax_guard();
    $sourceId   = hsync_post_text( 'source_id' );
    $configSlug = hsync_post_text( 'config_slug' );
    $config     = hsync_resolve_source_config( hsync_post_json( 'config' ), $configSlug );
    $options    = hsync_post_json( 'options' );

    if ( ! \HiveSync\Core\Bootstrap::$sources ) {
        wp_send_json_error( [ 'message' => 'Bootstrap non inizializzato.' ] );
    }
    $src = \HiveSync\Core\Bootstrap::$sources->get( $sourceId );
    if ( ! $src ) {
        wp_send_json_error( [ 'message' => "Source '{$sourceId}' non registrata." ] );
    }

    $ctx   = new \HiveSync\Core\Source\Context( runId: 'preview' );
    $req   = new \HiveSync\Core\Source\FetchRequest( $config, $options );
    try {
        $fetch = $src->fetch( $req, $ctx );
    } catch ( \Throwable $e ) {
        wp_send_json_error( [ 'message' => $e->getMessage() ] );
    }

    $preview = [];
    foreach ( array_slice( $fetch->items, 0, 10 ) as $item ) {
        $preview[] = [
            'sku'  => $item->sku,
            'data' => $item->data,
        ];
    }

    wp_send_json_success( [
        'count'    => count( $fetch->items ),
        'stats'    => $fetch->stats,
        'warnings' => $fetch->warnings,
        'preview'  => $preview,
    ] );
} );

// ─── Source configs ────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_source_configs_list', function () {
    hsync_ajax_guard();
    $kind = hsync_post_text( 'source_kind' );
    $repo = new \HiveSync\Core\Repo\SourceConfigRepository();
    wp_send_json_success( [ 'configs' => $repo->allRedacted( $kind !== '' ? $kind : null ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_source_configs_save', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    $data = [
        'slug'        => $slug,
        'name'        => hsync_post_text( 'name' ),
        'source_kind' => hsync_post_text( 'source_kind' ),
        'config'      => hsync_post_json( 'config' ),
    ];
    if ( $data['name'] === '' || $data['source_kind'] === '' ) {
        wp_send_json_error( [ 'message' => 'name e source_kind richiesti.' ] );
    }
    $repo = new \HiveSync\Core\Repo\SourceConfigRepository();
    $existing = $slug !== '' ? ( $repo->find( $slug )['config'] ?? [] ) : [];
    $stored = $repo->save( $data, $existing );
    wp_send_json_success( [ 'slug' => $stored ] );
} );

add_action( 'wp_ajax_hsync_ajax_source_configs_delete', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    if ( $slug === '' ) wp_send_json_error( [ 'message' => 'slug richiesto.' ] );
    $repo = new \HiveSync\Core\Repo\SourceConfigRepository();
    wp_send_json_success( [ 'deleted' => $repo->delete( $slug ) ] );
} );

// ─── Mappings ──────────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_mappings_list', function () {
    hsync_ajax_guard();
    $kind = hsync_post_text( 'source_kind' );
    $repo = new \HiveSync\Core\Repo\MappingRepository();
    wp_send_json_success( [ 'mappings' => $repo->all( $kind !== '' ? $kind : null ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_mappings_save', function () {
    hsync_ajax_guard();
    $data = [
        'slug'        => hsync_post_text( 'slug' ),
        'name'        => hsync_post_text( 'name' ),
        'source_kind' => hsync_post_text( 'source_kind' ),
        'config'      => hsync_post_json( 'config' ),
    ];
    if ( $data['name'] === '' || $data['source_kind'] === '' ) {
        wp_send_json_error( [ 'message' => 'name e source_kind sono richiesti.' ] );
    }
    $repo = new \HiveSync\Core\Repo\MappingRepository();
    $slug = $repo->save( $data );
    wp_send_json_success( [ 'slug' => $slug ] );
} );

add_action( 'wp_ajax_hsync_ajax_mappings_delete', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    if ( $slug === '' ) wp_send_json_error( [ 'message' => 'slug richiesto.' ] );
    $repo = new \HiveSync\Core\Repo\MappingRepository();
    wp_send_json_success( [ 'deleted' => $repo->delete( $slug ) ] );
} );

// ─── Registry (operations + checks for the pipeline composer) ─────

add_action( 'wp_ajax_hsync_ajax_registry_list', function () {
    hsync_ajax_guard();
    $ops = [];
    $importRules = [];
    $chk = [];
    $importChecks = [];
    if ( \HiveSync\Core\Bootstrap::$operations ) {
        foreach ( \HiveSync\Core\Bootstrap::$operations->all() as $op ) {
            $isImportRule = $op instanceof \HiveSync\Core\Operation\ImportRule;
            $row = [
                'id'             => $op->id(),
                'label'          => $op->label(),
                'params_schema'  => $op->paramsSchema(),
                'applies_to'     => $op->appliesTo(),
                'is_import_rule' => $isImportRule,
            ];
            // Operations split into two registries from the UI's POV: a
            // class implementing ImportRule appears in BOTH lists so the
            // composer can stack it as either a post-op or import-rule.
            $ops[] = $row;
            if ( $isImportRule ) $importRules[] = $row;
        }
    }
    if ( \HiveSync\Core\Bootstrap::$checks ) {
        foreach ( \HiveSync\Core\Bootstrap::$checks->all() as $c ) {
            $chk[] = [
                'id'              => $c->id(),
                'label'           => $c->label(),
                'params_schema'   => $c->paramsSchema(),
                'default_severity'=> $c->defaultSeverity()->value,
            ];
        }
    }
    if ( \HiveSync\Core\Bootstrap::$importChecks ) {
        foreach ( \HiveSync\Core\Bootstrap::$importChecks->all() as $c ) {
            $importChecks[] = [
                'id'              => $c->id(),
                'label'           => $c->label(),
                'params_schema'   => $c->paramsSchema(),
                'default_severity'=> $c->defaultSeverity()->value,
            ];
        }
    }
    wp_send_json_success( [
        'operations'    => $ops,
        'import_rules'  => $importRules,
        'checks'        => $chk,
        'import_checks' => $importChecks,
    ] );
} );

// ─── Pipelines ─────────────────────────────────────────────────────

function hsync_serialize_pipeline( \HiveSync\Core\Pipeline\Pipeline $p ): array {
    $steps = [];
    foreach ( $p->steps as $s ) {
        $steps[] = [
            'kind'   => $s->kind->value,
            'ref_id' => $s->refId,
            'params' => $s->params,
            'note'   => $s->note,
        ];
    }
    return [
        'slug'  => $p->id,
        'name'  => $p->name,
        'steps' => $steps,
        'meta'  => $p->meta,
    ];
}

add_action( 'wp_ajax_hsync_ajax_pipelines_list', function () {
    hsync_ajax_guard();
    $repo = new \HiveSync\Core\Pipeline\PipelineRepository();
    $out  = array_map( 'hsync_serialize_pipeline', $repo->all() );
    wp_send_json_success( [ 'pipelines' => $out ] );
} );

add_action( 'wp_ajax_hsync_ajax_pipeline_get', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    if ( $slug === '' ) wp_send_json_error( [ 'message' => 'slug richiesto.' ] );
    $repo = new \HiveSync\Core\Pipeline\PipelineRepository();
    $p    = $repo->find( $slug );
    if ( ! $p ) wp_send_json_error( [ 'message' => 'Pipeline non trovata.' ] );
    wp_send_json_success( hsync_serialize_pipeline( $p ) );
} );

add_action( 'wp_ajax_hsync_ajax_pipeline_save', function () {
    hsync_ajax_guard();
    $slug  = hsync_post_text( 'slug' );
    $name  = hsync_post_text( 'name' );
    $steps = hsync_post_json( 'steps' );
    if ( $name === '' ) wp_send_json_error( [ 'message' => 'name richiesto.' ] );

    $stepObjs = [];
    foreach ( $steps as $s ) {
        $kind = \HiveSync\Core\Pipeline\PipelineStepKind::tryFrom( (string) ( $s['kind'] ?? '' ) );
        if ( ! $kind ) continue;
        $stepObjs[] = new \HiveSync\Core\Pipeline\PipelineStep(
            kind: $kind,
            refId: (string) ( $s['ref_id'] ?? '' ),
            params: (array) ( $s['params'] ?? [] ),
            note: isset( $s['note'] ) && $s['note'] !== '' ? (string) $s['note'] : null,
        );
    }

    $repo = new \HiveSync\Core\Pipeline\PipelineRepository();
    $stored = $repo->save( new \HiveSync\Core\Pipeline\Pipeline(
        id: $slug, name: $name, steps: $stepObjs,
    ) );
    wp_send_json_success( [ 'slug' => $stored ] );
} );

add_action( 'wp_ajax_hsync_ajax_pipeline_delete', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    if ( $slug === '' ) wp_send_json_error( [ 'message' => 'slug richiesto.' ] );
    $repo = new \HiveSync\Core\Pipeline\PipelineRepository();
    wp_send_json_success( [ 'deleted' => $repo->delete( $slug ) ] );
} );

// ─── Rules ─────────────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_rules_list', function () {
    hsync_ajax_guard();
    $repo = new \HiveSync\Core\Repo\RuleRepository();
    wp_send_json_success( [ 'rules' => $repo->all() ] );
} );

add_action( 'wp_ajax_hsync_ajax_rule_get', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    if ( $slug === '' ) wp_send_json_error( [ 'message' => 'slug richiesto.' ] );
    $repo = new \HiveSync\Core\Repo\RuleRepository();
    $r    = $repo->find( $slug );
    if ( ! $r ) wp_send_json_error( [ 'message' => 'Rule non trovata.' ] );
    wp_send_json_success( $r );
} );

add_action( 'wp_ajax_hsync_ajax_rule_save', function () {
    hsync_ajax_guard();
    $data = [
        'slug'       => hsync_post_text( 'slug' ),
        'name'       => hsync_post_text( 'name' ),
        'selection'  => hsync_post_json( 'selection' ),
        'operations' => hsync_post_json( 'operations' ),
        'checks'     => hsync_post_json( 'checks' ),
        'enabled'    => hsync_post_bool( 'enabled' ),
    ];
    if ( $data['name'] === '' ) wp_send_json_error( [ 'message' => 'name richiesto.' ] );
    $repo = new \HiveSync\Core\Repo\RuleRepository();
    wp_send_json_success( [ 'slug' => $repo->save( $data ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_rule_delete', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    if ( $slug === '' ) wp_send_json_error( [ 'message' => 'slug richiesto.' ] );
    $repo = new \HiveSync\Core\Repo\RuleRepository();
    wp_send_json_success( [ 'deleted' => $repo->delete( $slug ) ] );
} );

/**
 * List taxonomy terms for the Rule-editor filter pickers (category +
 * brand). Returns slim rows ({id, name, count, parent}) so the UI can
 * render a multi-select without a per-term roundtrip.
 *
 * Always serves both `product_cat` and `product_brand` in one call —
 * cheap (a couple of `get_terms` queries, hide_empty=false so
 * just-imported drafts are visible). The Rule's filter executes via
 * `gh_filter_product_ids` which already supports both taxonomies, so
 * this endpoint is purely a UI convenience.
 *
 * Stays standalone-safe: if `product_brand` isn't registered (Woo
 * Brands plugin not active), the brands array is empty rather than
 * an error — UI hides the picker accordingly.
 */
add_action( 'wp_ajax_hsync_ajax_taxonomy_terms', function () {
    hsync_ajax_guard();

    $slim = static function ( array $terms ): array {
        $out = [];
        foreach ( $terms as $t ) {
            $out[] = [
                'id'     => (int) $t->term_id,
                'name'   => (string) $t->name,
                'slug'   => (string) $t->slug,
                'count'  => (int) $t->count,
                'parent' => (int) $t->parent,
            ];
        }
        return $out;
    };

    $args = [
        'hide_empty' => false,
        'orderby'    => 'name',
        'order'      => 'ASC',
        'number'     => 0,
    ];

    $cats = taxonomy_exists( 'product_cat' )
        ? get_terms( array_merge( $args, [ 'taxonomy' => 'product_cat' ] ) )
        : [];
    $brands = taxonomy_exists( 'product_brand' )
        ? get_terms( array_merge( $args, [ 'taxonomy' => 'product_brand' ] ) )
        : [];

    wp_send_json_success( [
        'categories' => is_wp_error( $cats   ) ? [] : $slim( $cats   ),
        'brands'     => is_wp_error( $brands ) ? [] : $slim( $brands ),
    ] );
} );

// ─── Run ───────────────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_run_now', function () {
    hsync_ajax_guard();
    hsync_arm_fatal_guard();
    hsync_raise_limits();

    $sourceId   = hsync_post_text( 'source_id' );
    $configSlug = hsync_post_text( 'config_slug' );
    $config     = hsync_resolve_source_config( hsync_post_json( 'config' ), $configSlug );
    $options    = hsync_post_json( 'options' );
    $dryRun     = hsync_post_bool( 'dry_run' );
    $cursor     = hsync_post_json( 'cursor' );

    if ( ! \HiveSync\Core\Bootstrap::$sources ) {
        wp_send_json_error( [ 'message' => 'Bootstrap non inizializzato.' ] );
    }
    $src = \HiveSync\Core\Bootstrap::$sources->get( $sourceId );
    if ( ! $src ) {
        wp_send_json_error( [ 'message' => "Source '{$sourceId}' non registrata." ] );
    }

    // Two imports of the same feed in parallel both see a new SKU as
    // `new` and both create it. Refuse to START one next to a job run
    // that is importing the same saved feed right now (a resumed tick
    // carries a cursor and is let through). Dry runs write nothing.
    if ( ! $cursor && ! $dryRun && $configSlug !== '' ) {
        $busy = hsync_job_running_feed( $sourceId, $configSlug );
        if ( $busy ) {
            wp_send_json_error( [
                'message' => sprintf(
                    'L\'automazione «%s» sta già importando questo feed (run #%d in corso). '
                    . 'Due import dello stesso feed in parallelo possono creare prodotti doppi: '
                    . 'attendi che finisca oppure fermala con «Interrompi» sulla sua scheda.',
                    hsync_job_label( $busy ),
                    \HiveSync\Workflow\Schedule\RunState::runId( $busy['run_state'] ?? null )
                ),
                'busy_job_id' => (int) $busy['id'],
            ] );
        }
    }

    $deadline = time() + 25; // soft cap so AJAX doesn't blow Apache's php-cgi limit
    $runner   = new \HiveSync\Workflow\Run\ImportRunner( new \HiveSync\Core\Repo\RunRepository() );

    try {
        $envelope = $runner->run(
            source: $src,
            config: $config,
            options: $options,
            meta: [
                'trigger' => 'adhoc',
                // Named in the Storico as the feed actually imported
                // ('json/gs-prod'), not just the source kind.
                'ref'     => $configSlug !== '' ? $sourceId . '/' . $configSlug : $sourceId,
            ],
            dryRun: $dryRun,
            deadline: $deadline,
            cursor: $cursor ?: null,
        );
        wp_send_json_success( $envelope );
    } catch ( \Throwable $e ) {
        // Preserve cursor so the client can retry/resume from where it
        // crashed instead of restarting the run from scratch.
        wp_send_json_error( [
            'message'  => 'Tick fallito: ' . $e->getMessage(),
            'cursor'   => $cursor ?: null,
            'recoverable' => true,
            'where'    => basename( $e->getFile() ) . ':' . $e->getLine(),
        ] );
    }
} );

// ─── Runs ──────────────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_runs_recent', function () {
    hsync_ajax_guard();
    $limit = max( 1, min( 200, (int) hsync_post_text( 'limit', '50' ) ) );
    $repo  = new \HiveSync\Core\Repo\RunRepository();

    // Job-linked runs are shown under the job's name.
    $labels = [];
    foreach ( ( new \HiveSync\Core\Repo\JobRepository() )->all() as $job ) {
        $labels[ (int) $job['id'] ] = hsync_job_label( $job );
    }
    wp_send_json_success( [
        'runs'       => $repo->recent( $limit ),
        'job_labels' => (object) $labels,
    ] );
} );

// ─── Jobs ──────────────────────────────────────────────────────────

/**
 * Human name of a job: its label when it has one, else type · ref.
 */
function hsync_job_label( array $job ): string {
    $config = is_array( $job['config'] ?? null ) ? $job['config'] : [];
    foreach ( [ '_label', '_seed_label' ] as $key ) {
        if ( ! empty( $config[ $key ] ) && is_string( $config[ $key ] ) ) return $config[ $key ];
    }
    return (string) ( $job['runnable_type'] ?? '' ) . ' · ' . (string) ( $job['runnable_ref'] ?? '' );
}

/**
 * The source.import job currently running (and not paused) on the saved
 * feed $sourceId/$configSlug, or null.
 */
function hsync_job_running_feed( string $sourceId, string $configSlug ): ?array {
    foreach ( ( new \HiveSync\Core\Repo\JobRepository() )->all() as $job ) {
        if ( ( $job['runnable_type'] ?? '' ) !== 'source.import' ) continue;
        $state = $job['run_state'] ?? null;
        if ( ! \HiveSync\Workflow\Schedule\RunState::isRunning( $state ) ) continue;
        if ( empty( $job['enabled'] ) && ! \HiveSync\Workflow\Schedule\RunState::isManual( $state ) ) continue; // paused

        // Compare against what the run is actually importing: its snapshot.
        $snap = is_array( $state['snapshot'] ?? null ) ? $state['snapshot'] : \HiveSync\Workflow\Schedule\RunState::snapshotOf( $job );
        $ref  = (string) ( $snap['runnable_ref'] ?? '' );
        [ $jobSource, $jobSlug ] = str_contains( $ref, '/' ) ? explode( '/', $ref, 2 ) : [ $ref, '' ];
        if ( $jobSlug === '' ) $jobSlug = (string) ( $snap['config']['config_slug'] ?? '' );

        if ( $jobSource === $sourceId && $jobSlug === $configSlug ) return $job;
    }
    return null;
}

/**
 * What the job cards need about a run in flight — never the snapshot
 * (it carries the job config, inline credentials included) or the raw
 * cursor.
 */
function hsync_job_run_public( ?array $state ): ?array {
    return \HiveSync\Workflow\Schedule\RunState::publicView( $state );
}

add_action( 'wp_ajax_hsync_ajax_jobs_list', function () {
    hsync_ajax_guard();
    $repo = new \HiveSync\Core\Repo\JobRepository();
    $jobs = $repo->all();
    foreach ( $jobs as &$job ) {
        $job['run'] = hsync_job_run_public( $job['run_state'] ?? null );
        unset( $job['run_state'] );
    }
    unset( $job );

    $latest = ( new \HiveSync\Core\Repo\RunRepository() )->latestByJob( array_column( $jobs, 'id' ) );
    $lease  = \HiveSync\Workflow\Schedule\RunnerLease::forSite()->inspect();
    $beat   = wp_next_scheduled( 'hive_sync_jobs_tick' );

    wp_send_json_success( [
        'jobs'      => $jobs,
        // job_id → its most recent wp_hsync_runs row.
        'latest'    => (object) $latest,
        // Is a drain holding the runner right now, and until when.
        'runner'    => [
            'busy'       => $lease !== null && ! $lease['expired'],
            'expires_at' => $lease ? gmdate( 'Y-m-d H:i:s', (int) $lease['expires'] ) : null,
        ],
        'heartbeat' => [
            'next_at'  => $beat ? gmdate( 'Y-m-d H:i:s', (int) $beat ) : null,
            'schedule' => wp_get_schedule( 'hive_sync_jobs_tick' ) ?: null,
        ],
        'now'       => gmdate( 'Y-m-d H:i:s' ),
    ] );
} );

/**
 * next_run_at for a job about to be saved with $cron / $enabled.
 *
 * Re-plans the slot only when the SCHEDULE changed — a new cron, or the
 * job switched on (a job paused for a week must not fire the moment it
 * is re-enabled). Saving any other field keeps the planned slot,
 * including the one a running job is measured against. Slots are read
 * in the site timezone. Shared by the job editor and the simple view's
 * automation card, so both arm the schedule the same way.
 *
 * @param array<string, mixed>|null $existing hydrated job row, null when new
 */
function hsync_plan_next_run_at( ?array $existing, string $cron, bool $enabled ): ?string {
    if ( $cron === '' ) return null;
    $next        = $existing['next_run_at'] ?? null;
    $cronChanged = (string) ( $existing['cron_expr'] ?? '' ) !== $cron;
    $switchedOn  = $enabled && empty( $existing['enabled'] );
    if ( ! $existing || $cronChanged || $switchedOn || $next === null ) {
        $next = \HiveSync\Workflow\Schedule\JobSchedule::formatUtc(
            \HiveSync\Workflow\Schedule\JobSchedule::forSite()->nextAfter( $cron, time() )
        );
    }
    return $next;
}

add_action( 'wp_ajax_hsync_ajax_job_save', function () {
    hsync_ajax_guard();
    $cron = hsync_post_text( 'cron_expr' );
    if ( $cron !== '' && \HiveSync\Workflow\Schedule\CronExpr::parse( $cron ) === null ) {
        wp_send_json_error( [ 'message' => 'Cron expression non valida.' ] );
    }

    $repo     = new \HiveSync\Core\Repo\JobRepository();
    $id       = (int) hsync_post_text( 'id' );
    $existing = $id > 0 ? $repo->find( $id ) : null;
    if ( $id > 0 && ! $existing ) {
        wp_send_json_error( [ 'message' => "Job #{$id} non trovato." ] );
    }
    $enabled = hsync_post_bool( 'enabled' );

    // Runtime state never round-trips through the editor: the browser
    // posts back the config it loaded, and a cursor in it is stale by
    // the time it lands. (Pre-1.2 runs kept one in config._resume_cursor.)
    $config = hsync_post_json( 'config' );
    foreach ( \HiveSync\Workflow\Schedule\RunState::RUNTIME_CONFIG_KEYS as $k ) unset( $config[ $k ] );

    $next = hsync_plan_next_run_at( $existing, $cron, $enabled );

    $saved = $repo->save( [
        'id'            => $id,
        'runnable_type' => hsync_post_text( 'runnable_type' ),
        'runnable_ref'  => hsync_post_text( 'runnable_ref' ),
        'cron_expr'     => $cron,
        'enabled'       => $enabled,
        'next_run_at'   => $next,
        'config'        => $config,
    ] );
    wp_send_json_success( [
        'id'          => $saved,
        'next_run_at' => $next,
        // True when the job has a run in flight: edits apply from the
        // next run (the one in flight keeps the snapshot it started with).
        'running'     => \HiveSync\Workflow\Schedule\RunState::isRunning( $existing['run_state'] ?? null ),
    ] );
} );

add_action( 'wp_ajax_hsync_ajax_job_delete', function () {
    hsync_ajax_guard();
    $id = (int) hsync_post_text( 'id' );
    if ( $id <= 0 ) wp_send_json_error( [ 'message' => 'id richiesto.' ] );
    $repo = new \HiveSync\Core\Repo\JobRepository();
    $job  = $repo->find( $id );
    // Close the run in flight first, or its row reads "continue" in the
    // Storico forever and its fetch cache lingers until it expires.
    if ( $job ) hsync_job_runner()->forgetRun( $job );
    wp_send_json_success( [ 'deleted' => $repo->delete( $id ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_job_run_now', function () {
    hsync_ajax_guard();
    hsync_arm_fatal_guard();
    hsync_raise_limits();
    $id = (int) hsync_post_text( 'id' );
    if ( $id <= 0 ) wp_send_json_error( [ 'message' => 'id richiesto.' ] );
    // One interactive slice at most; the rest of the run continues on the
    // cron heartbeat (or joins the drain already going).
    wp_send_json_success( hsync_job_runner()->runJobNow( $id, \HiveSync\Workflow\Schedule\JobRunner::INTERACTIVE_BUDGET ) );
} );

add_action( 'wp_ajax_hsync_ajax_job_stop', function () {
    hsync_ajax_guard();
    $id = (int) hsync_post_text( 'id' );
    if ( $id <= 0 ) wp_send_json_error( [ 'message' => 'id richiesto.' ] );
    wp_send_json_success( hsync_job_runner()->requestStop( $id ) );
} );

add_action( 'wp_ajax_hsync_ajax_jobs_tick_now', function () {
    hsync_ajax_guard();
    hsync_arm_fatal_guard();
    hsync_raise_limits();
    // Short budget: the request has to come back to the browser. The cron
    // heartbeat carries on from wherever this leaves off.
    wp_send_json_success( hsync_run_tick( \HiveSync\Workflow\Schedule\JobRunner::INTERACTIVE_BUDGET ) );
} );

// ─── Defaults reinstall (mappings + pipelines) ────────────────────

add_action( 'wp_ajax_hsync_ajax_install_defaults', function () {
    hsync_ajax_guard();
    // `force=1` overwrites existing mappings/pipelines that share a slug
    // with a built-in default. Used by the "Reinstalla (sovrascrivi)"
    // button to ship code-level updates to installs that already ran
    // the activation seeder.
    $force  = hsync_post_bool( 'force' );
    $result = hsync_install_defaults( $force );
    wp_send_json_success( $result + [ 'force' => $force ] );
} );

// ─── Action Scheduler health (helpful when DISABLE_WP_CRON) ───────

add_action( 'wp_ajax_hsync_ajax_as_health', function () {
    hsync_ajax_guard();
    if ( ! function_exists( 'as_get_scheduled_actions' ) ) {
        wp_send_json_error( [ 'message' => 'Action Scheduler non disponibile (WooCommerce caricato?).' ] );
    }
    $past_due = as_get_scheduled_actions( [
        'status'    => \ActionScheduler_Store::STATUS_PENDING,
        'date'      => 'now',
        'date_compare' => '<',
        'per_page'  => 1,
        'group'     => '',
    ], 'ids' );
    $total_pending = as_get_scheduled_actions( [
        'status'   => \ActionScheduler_Store::STATUS_PENDING,
        'per_page' => 1,
    ], 'ids' );

    // For an accurate count we need a SELECT COUNT, not LIMIT 1. The
    // 'ids' return is paginated; use the store directly for totals.
    global $wpdb;
    $total_pending_count = (int) $wpdb->get_var(
        "SELECT COUNT(*) FROM {$wpdb->prefix}actionscheduler_actions WHERE status = 'pending'"
    );
    $past_due_count = (int) $wpdb->get_var( $wpdb->prepare(
        "SELECT COUNT(*) FROM {$wpdb->prefix}actionscheduler_actions WHERE status = 'pending' AND scheduled_date_gmt < %s",
        gmdate( 'Y-m-d H:i:s' ),
    ) );
    $failed_count = (int) $wpdb->get_var(
        "SELECT COUNT(*) FROM {$wpdb->prefix}actionscheduler_actions WHERE status = 'failed'"
    );
    $cron_disabled = defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;

    wp_send_json_success( [
        'pending'       => $total_pending_count,
        'past_due'      => $past_due_count,
        'failed'        => $failed_count,
        'cron_disabled' => $cron_disabled,
    ] );
} );

add_action( 'wp_ajax_hsync_ajax_as_run_queue', function () {
    hsync_ajax_guard();
    if ( ! has_action( 'action_scheduler_run_queue' ) ) {
        wp_send_json_error( [ 'message' => 'Action Scheduler non disponibile.' ] );
    }
    $start = microtime( true );
    do_action( 'action_scheduler_run_queue', 'Hive Sync Manual' );
    wp_send_json_success( [ 'ok' => true, 'duration_ms' => (int) ( ( microtime( true ) - $start ) * 1000 ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_as_purge_past_due', function () {
    hsync_ajax_guard();
    global $wpdb;
    // Hard delete pending actions that were due more than 7 days ago.
    // Anything past-due that long is almost certainly stale (the
    // operator has noticed and is manually cleaning up).
    $cutoff = gmdate( 'Y-m-d H:i:s', time() - 7 * 86400 );
    $deleted = (int) $wpdb->query( $wpdb->prepare(
        "DELETE a, l
         FROM {$wpdb->prefix}actionscheduler_actions a
         LEFT JOIN {$wpdb->prefix}actionscheduler_logs l ON l.action_id = a.action_id
         WHERE a.status = 'pending' AND a.scheduled_date_gmt < %s",
        $cutoff,
    ) );
    wp_send_json_success( [ 'deleted' => max( 0, $deleted ) ] );
} );

// ─── Exports ───────────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_export_inventory', function () {
    hsync_ajax_guard();
    $format = hsync_post_text( 'format', 'csv' );
    $exporter = new \HiveSync\Workflow\Export\Exporter();
    $rows = $exporter->inventoryRows();
    if ( $format === 'json' ) {
        wp_send_json_success( [
            'filename' => 'hive-sync-inventory-' . gmdate( 'Y-m-d-His' ) . '.json',
            'mime'     => 'application/json',
            'body'     => wp_json_encode( $rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE ),
            'count'    => count( $rows ),
        ] );
    }
    wp_send_json_success( [
        'filename' => 'hive-sync-inventory-' . gmdate( 'Y-m-d-His' ) . '.csv',
        'mime'     => 'text/csv',
        'body'     => \HiveSync\Workflow\Export\Exporter::rowsToCsv( $rows ),
        'count'    => count( $rows ),
    ] );
} );

add_action( 'wp_ajax_hsync_ajax_export_catalog', function () {
    hsync_ajax_guard();
    $exporter = new \HiveSync\Workflow\Export\Exporter();
    $tree = $exporter->catalogTree();
    wp_send_json_success( [
        'filename' => 'hive-sync-catalog-' . gmdate( 'Y-m-d-His' ) . '.json',
        'mime'     => 'application/json',
        'body'     => wp_json_encode( $tree, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE ),
        'count'    => array_sum( array_map( 'count', $tree ) ),
    ] );
} );

// ─── Legacy migration ──────────────────────────────────────────────

function hsync_legacy_importer(): \HiveSync\Workflow\Migration\LegacyImporter {
    return new \HiveSync\Workflow\Migration\LegacyImporter(
        new \HiveSync\Core\Pipeline\PipelineRepository(),
        new \HiveSync\Core\Repo\MappingRepository(),
        new \HiveSync\Core\Repo\JobRepository(),
    );
}

add_action( 'wp_ajax_hsync_ajax_legacy_audit', function () {
    hsync_ajax_guard();
    wp_send_json_success( hsync_legacy_importer()->audit() );
} );

add_action( 'wp_ajax_hsync_ajax_legacy_import', function () {
    hsync_ajax_guard();
    wp_send_json_success( hsync_legacy_importer()->run() );
} );

// ─── Media management ────────────────────────────────────────────
//
// Browser, whitelist CRUD, safe cleanup preview/apply, set featured /
// gallery on a product, deletion log. The reverse usage index is built
// lazily and invalidated on attachment + product save hooks (see
// HiveSync\Media\UsageIndex).

add_action( 'wp_ajax_hsync_ajax_media_query', function () {
    hsync_ajax_guard();
    $filters = [
        'filename'  => hsync_post_text( 'filename' ),
        'usage'     => hsync_post_text( 'usage', 'all' ),
        'whitelist' => hsync_post_text( 'whitelist', 'all' ),
    ];
    $page = isset( $_POST['page'] ) ? max( 1, (int) wp_unslash( $_POST['page'] ) ) : 1;
    $perPage = isset( $_POST['per_page'] ) ? max( 10, min( 500, (int) wp_unslash( $_POST['per_page'] ) ) ) : 60;
    wp_send_json_success(
        \HiveSync\Media\Browser::query( $filters, [ 'page' => $page, 'per_page' => $perPage ] ),
    );
} );

add_action( 'wp_ajax_hsync_ajax_media_index_rebuild', function () {
    hsync_ajax_guard();
    \HiveSync\Media\UsageIndex::invalidate();
    $index = \HiveSync\Media\UsageIndex::build( true );
    wp_send_json_success( [ 'attachments_indexed' => count( $index ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_cleanup_preview', function () {
    hsync_ajax_guard();
    wp_send_json_success( \HiveSync\Media\Browser::safeCleanupPreview() );
} );

add_action( 'wp_ajax_hsync_ajax_media_cleanup_apply', function () {
    hsync_ajax_guard();
    $ids = hsync_post_json( 'ids' );
    if ( empty( $ids ) ) wp_send_json_error( [ 'message' => 'Nessun ID fornito.' ] );
    $result = \HiveSync\Media\Cleaner::bulkDelete( array_map( 'intval', $ids ) );
    wp_send_json_success( $result );
} );

add_action( 'wp_ajax_hsync_ajax_media_whitelist_list', function () {
    hsync_ajax_guard();
    wp_send_json_success( [ 'items' => \HiveSync\Media\Whitelist::all() ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_whitelist_add', function () {
    hsync_ajax_guard();
    $id     = isset( $_POST['attachment_id'] ) ? (int) wp_unslash( $_POST['attachment_id'] ) : 0;
    $url    = hsync_post_text( 'url' );
    $reason = hsync_post_text( 'reason' );
    $ok = \HiveSync\Media\Whitelist::add( $id ?: null, $url ?: null, $reason );
    if ( ! $ok ) wp_send_json_error( [ 'message' => 'Whitelist update failed (id/url mancanti?).' ] );
    wp_send_json_success( [ 'items' => \HiveSync\Media\Whitelist::all() ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_whitelist_remove', function () {
    hsync_ajax_guard();
    $id = isset( $_POST['attachment_id'] ) ? (int) wp_unslash( $_POST['attachment_id'] ) : 0;
    if ( $id <= 0 ) wp_send_json_error( [ 'message' => 'attachment_id richiesto.' ] );
    \HiveSync\Media\Whitelist::remove( $id );
    wp_send_json_success( [ 'items' => \HiveSync\Media\Whitelist::all() ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_set_featured', function () {
    hsync_ajax_guard();
    $pid = isset( $_POST['product_id'] )    ? (int) wp_unslash( $_POST['product_id'] )    : 0;
    $aid = isset( $_POST['attachment_id'] ) ? (int) wp_unslash( $_POST['attachment_id'] ) : 0;
    if ( $pid <= 0 || $aid <= 0 ) wp_send_json_error( [ 'message' => 'product_id + attachment_id richiesti.' ] );
    $r = \HiveSync\Media\Library::setProductFeaturedImage( $pid, $aid );
    if ( is_wp_error( $r ) ) wp_send_json_error( [ 'message' => $r->get_error_message() ] );
    wp_send_json_success( [ 'product_id' => $pid, 'attachment_id' => $aid ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_set_gallery', function () {
    hsync_ajax_guard();
    $pid = isset( $_POST['product_id'] ) ? (int) wp_unslash( $_POST['product_id'] ) : 0;
    $ids = hsync_post_json( 'attachment_ids' );
    if ( $pid <= 0 ) wp_send_json_error( [ 'message' => 'product_id richiesto.' ] );
    $r = \HiveSync\Media\Library::setProductGallery( $pid, array_map( 'intval', $ids ) );
    if ( is_wp_error( $r ) ) wp_send_json_error( [ 'message' => $r->get_error_message() ] );
    wp_send_json_success( [ 'product_id' => $pid, 'count' => count( $ids ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_remove_from_galleries', function () {
    hsync_ajax_guard();
    $ids = hsync_post_json( 'media_ids' );
    if ( empty( $ids ) ) wp_send_json_error( [ 'message' => 'media_ids richiesto.' ] );
    wp_send_json_success(
        \HiveSync\Media\Library::removeFromGalleries( array_map( 'intval', $ids ) ),
    );
} );

add_action( 'wp_ajax_hsync_ajax_media_deletion_log', function () {
    hsync_ajax_guard();
    $limit = isset( $_POST['limit'] ) ? max( 1, min( 500, (int) wp_unslash( $_POST['limit'] ) ) ) : 100;
    wp_send_json_success( [ 'log' => \HiveSync\Media\Cleaner::getLog( $limit ) ] );
} );

// ─── Products without a cover image: scan + repair ───────────────
//
// The Media tab is where the operator NOTICES products rendering
// without a photo, so it's where the repair belongs. Two steps,
// deliberately separate:
//
//   scan   — read-only, feed-free, instant. Answers "how many, which
//            ones, and where did they come from" without downloading
//            anything or writing a byte.
//   repair — resolves a configured import job into the source +
//            config + mapping + pipeline quadruple it already carries,
//            then hands those back to the client so it can drive the
//            ORDINARY run loop with heal_media forced on. Nothing new
//            executes here: same ImportRunner, same cursor/resume,
//            same run report in Storico.
//
// Why repair returns parameters instead of running the import itself:
// a catalog-wide repair is exactly as long as an import (multi-tick,
// cooperative deadline). Running it inside one AJAX call would blow
// the request budget on any real catalog. Handing the parameters to
// the existing tick loop keeps resumability, progress and the fatal
// guard — all of which already work.

add_action( 'wp_ajax_hsync_ajax_media_missing_scan', function () {
    hsync_ajax_guard();
    @set_time_limit( 120 );

    $sample = isset( $_POST['sample'] ) ? (int) wp_unslash( $_POST['sample'] ) : 50;
    $result = \HiveSync\Media\MissingImages::scan( $sample );

    // Ship the import jobs alongside so the UI can render the picker
    // (and pre-select the obvious one) without a second roundtrip.
    $jobs    = ( new \HiveSync\Core\Repo\JobRepository() )->all();
    $imports = \HiveSync\Media\MissingImages::importJobs( $jobs );
    $default = \HiveSync\Media\MissingImages::pickDefaultJob( $jobs );

    $slim = [];
    foreach ( $imports as $job ) {
        $slim[] = [
            'id'      => (int) ( $job['id'] ?? 0 ),
            'ref'     => (string) ( $job['runnable_ref'] ?? '' ),
            'enabled' => ! empty( $job['enabled'] ),
        ];
    }

    wp_send_json_success( $result + [
        'jobs'           => $slim,
        'default_job_id' => $default ? (int) ( $default['id'] ?? 0 ) : 0,
    ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_missing_repair_params', function () {
    hsync_ajax_guard();

    // Source + saved config + mapping resolved exactly as JobRunner does
    // (shared with the simple view's Importa — see ajax-simple.php). It
    // fails loudly on a job pointing at a deleted config: running with an
    // empty config would report a clean "done / 0 repaired" that is
    // indistinguishable from "nothing was broken".
    $target     = hsync_job_import_target( (int) hsync_post_text( 'job_id' ) );
    $sourceId   = $target['source_id'];
    $configSlug = $target['config_slug'];
    $options    = $target['options'];

    // Force the repair shape on top of the job's own options:
    //  - heal_media: the whole point.
    //  - mode=full:  a data_only/media_only job would download but never
    //                attach, leaving the products just as imageless.
    //  - buckets:    cleared. A stock-only job would otherwise filter
    //                the healed items straight back out.
    //  - limit:      cleared. A job's test cap must not silently leave
    //                part of the damage unrepaired.
    $options['heal_media'] = true;
    $options['mode']       = 'full';
    unset( $options['buckets'], $options['limit'], $options['skus'], $options['force_recreate'] );
    // ...and NOT the sweep. The operator pressed "repair images"; hiding
    // products is a different decision and must not ride along on it.
    // The restore half still runs (it runs on every sync by design), so
    // a product that came back while its images were broken is not left
    // hidden by this pass either.
    unset( $options['retire_missing'], $options['retire_mode'] );

    wp_send_json_success( [
        'source_id'   => (string) $sourceId,
        'config_slug' => (string) $configSlug,
        'options'     => $options,
    ] );
} );

// ─── Mapping probe ───────────────────────────────────────────────
//
// Fetches a single representative row from a source (using either an
// inline config or a saved source-config slug) and returns the flat
// dot-path list + the raw sample. The visual mapping editor uses this
// to populate path autocomplete and to render a side-by-side preview
// of the mapping output.

add_action( 'wp_ajax_hsync_ajax_mapping_probe', function () {
    hsync_ajax_guard();
    $sourceId   = hsync_post_text( 'source_id' );
    $configSlug = hsync_post_text( 'config_slug' );
    $config     = hsync_resolve_source_config( hsync_post_json( 'config' ), $configSlug );

    if ( ! \HiveSync\Core\Bootstrap::$sources ) {
        wp_send_json_error( [ 'message' => 'Bootstrap non inizializzato.' ] );
    }
    $src = \HiveSync\Core\Bootstrap::$sources->get( $sourceId );
    if ( ! $src ) wp_send_json_error( [ 'message' => "Source '{$sourceId}' non registrata." ] );

    $ctx = new \HiveSync\Core\Source\Context( runId: 'probe' );
    try {
        $fetch = $src->fetch(
            new \HiveSync\Core\Source\FetchRequest( $config, [] ),
            $ctx,
        );
    } catch ( \Throwable $e ) {
        wp_send_json_error( [ 'message' => $e->getMessage() ] );
    }

    $sample = $fetch->items[0] ?? null;
    if ( ! $sample ) {
        wp_send_json_success( [
            'paths_raw'  => [],
            'paths_data' => [],
            'sample_raw'  => null,
            'sample_data' => null,
            'count'    => 0,
            'warnings' => $fetch->warnings,
        ] );
    }

    // The mapping editor wants the user to map FROM the source's native
    // shape, so we expose the raw upstream payload as the primary path
    // list. Some sources (e.g. legacy GS bridge) only populate `data` —
    // we still return its paths separately so the user can see what's
    // available even when the bridge doesn't preserve raw.
    $pathsRaw  = hsync_flatten_paths( $sample->raw  );
    $pathsData = hsync_flatten_paths( $sample->data );
    sort( $pathsRaw );
    sort( $pathsData );

    wp_send_json_success( [
        'paths_raw'   => $pathsRaw,
        'paths_data'  => $pathsData,
        'sample_raw'  => $sample->raw  ?: null,
        'sample_data' => $sample->data ?: null,
        'sku'         => $sample->sku,
        'count'       => count( $fetch->items ),
        'warnings'    => $fetch->warnings,
    ] );
} );

/**
 * Walks an assoc array and returns a flat list of dot-paths to scalar
 * leaves. Lists-of-scalars become a single entry (e.g. 'tags'); lists
 * of objects expose 'list.0.field' so the user sees the shape.
 *
 * @param array<string, mixed> $row
 * @return string[]
 */
function hsync_flatten_paths( array $row, string $prefix = '' ): array {
    $out = [];
    foreach ( $row as $key => $value ) {
        $path = $prefix === '' ? (string) $key : $prefix . '.' . $key;
        if ( is_array( $value ) ) {
            // Detect "list of scalars" — surface as a single path so
            // the user can pipe-join via Mapping\Template.
            $isList = array_keys( $value ) === range( 0, count( $value ) - 1 );
            if ( $isList ) {
                $first = $value[0] ?? null;
                if ( is_scalar( $first ) || $first === null ) {
                    $out[] = $path;
                    continue;
                }
                // List of objects: expose first row paths under '.0.…'
                if ( is_array( $first ) ) {
                    $out = array_merge( $out, hsync_flatten_paths( $first, $path . '.0' ) );
                    continue;
                }
            }
            $out = array_merge( $out, hsync_flatten_paths( $value, $path ) );
        } else {
            $out[] = $path;
        }
    }
    return array_values( array_unique( $out ) );
}

// ─── Tools / Nuclear Cleanup ─────────────────────────────────────
//
// Stricter capability gate than the rest of the plugin:
// `manage_options` is a higher bar than `manage_woocommerce`, which
// matches the destructive nature of these endpoints. Every destructive
// call also requires an explicit `confirm` flag.

function hsync_ajax_admin_guard(): void {
    check_ajax_referer( 'hsync_nonce', 'nonce' );
    if ( ! current_user_can( 'manage_options' ) ) {
        wp_send_json_error( [ 'message' => 'Richiede capability manage_options.' ], 403 );
    }
}

add_action( 'wp_ajax_hsync_ajax_nuclear_preview', function () {
    hsync_ajax_admin_guard();
    $targets = hsync_post_json( 'targets' );
    // Whitelist target keys against the canonical list — accepting a
    // free-form payload here would let a misconfigured client trigger
    // unsupported branches.
    $clean = [];
    foreach ( \HiveSync\Tools\NuclearCleanup::TARGETS as $t ) {
        if ( ! empty( $targets[ $t ] ) ) $clean[ $t ] = true;
    }
    wp_send_json_success( [ 'preview' => \HiveSync\Tools\NuclearCleanup::preview( $clean ) ] );
} );

add_action( 'wp_ajax_hsync_ajax_nuclear_execute', function () {
    hsync_ajax_admin_guard();
    if ( ! hsync_post_bool( 'confirm' ) ) {
        wp_send_json_error( [ 'message' => 'Confirm flag mancante.' ] );
    }
    $targets = hsync_post_json( 'targets' );
    $clean = [];
    foreach ( \HiveSync\Tools\NuclearCleanup::TARGETS as $t ) {
        if ( ! empty( $targets[ $t ] ) ) $clean[ $t ] = true;
    }
    if ( empty( $clean ) ) {
        wp_send_json_error( [ 'message' => 'Nessun target selezionato.' ] );
    }
    @set_time_limit( 300 );
    $started = microtime( true );
    $results = \HiveSync\Tools\NuclearCleanup::execute( $clean );
    wp_send_json_success( [
        'results'    => $results,
        'duration_s' => round( microtime( true ) - $started, 2 ),
    ] );
} );

add_action( 'wp_ajax_hsync_ajax_nuclear_count_by_source', function () {
    hsync_ajax_admin_guard();
    $source = hsync_post_text( 'source' );
    if ( $source === '' ) wp_send_json_error( [ 'message' => 'source richiesto.' ] );
    wp_send_json_success( [
        'source' => $source,
        'count'  => \HiveSync\Tools\NuclearCleanup::countBySource( $source ),
    ] );
} );

add_action( 'wp_ajax_hsync_ajax_nuclear_delete_by_source', function () {
    hsync_ajax_admin_guard();
    if ( ! hsync_post_bool( 'confirm' ) ) {
        wp_send_json_error( [ 'message' => 'Confirm flag mancante.' ] );
    }
    $source = hsync_post_text( 'source' );
    if ( $source === '' ) wp_send_json_error( [ 'message' => 'source richiesto.' ] );
    @set_time_limit( 300 );
    wp_send_json_success( \HiveSync\Tools\NuclearCleanup::deleteBySource( $source ) );
} );

// ─── Variation attribute repair (GS slug bug remediation) ────────
//
// One-shot in-place fix for variations whose attribute_pa_* meta
// holds the raw feed value (e.g. "33.5") instead of the term slug
// ("33-5"). Caused by the pre-a6bd7b9 GS bridge update path that
// inlined a stripped-down variation create skipping term resolution.
// Symptom: storefront dropdown shows only integer sizes; decimal /
// letter sizes silently vanish despite existing in the DB.
//
// Preview is read-only and idempotent; apply skips already-correct
// rows. Both safe to re-run.
add_action( 'wp_ajax_hsync_ajax_repair_variation_attrs_preview', function () {
    hsync_ajax_admin_guard();
    @set_time_limit( 120 );
    wp_send_json_success( \HiveSync\Tools\VariationAttrRepair::preview() );
} );

add_action( 'wp_ajax_hsync_ajax_repair_variation_attrs_apply', function () {
    hsync_ajax_admin_guard();
    if ( ! hsync_post_bool( 'confirm' ) ) {
        wp_send_json_error( [ 'message' => 'Confirm flag mancante.' ] );
    }
    @set_time_limit( 300 );
    $started = microtime( true );
    $result  = \HiveSync\Tools\VariationAttrRepair::apply();
    wp_send_json_success( $result + [ 'duration_s' => round( microtime( true ) - $started, 2 ) ] );
} );

// ─── Feed-vs-Woo diagnostic (GS misalignment investigation) ─────
//
// Fetches the upstream feed once, groups flat rows by SKU, compares
// each product's feed sizes against the corresponding Woo product's
// variations. Output answers four questions in one pass:
//   1. Did the upstream return rows? How many? With what shape?
//   2. Did the SKU grouping work? (distinct_skus vs total rows)
//   3. For products that DO exist in Woo, do the size sets match?
//   4. Which sizes are missing from Woo vs the feed?
//
// Read-only. No writes, no cache mutation. Pure diagnostic.
add_action( 'wp_ajax_hsync_ajax_feed_diagnostic', function () {
    hsync_ajax_admin_guard();
    $configSlug = hsync_post_text( 'config_slug' );
    if ( $configSlug === '' ) {
        wp_send_json_error( [ 'message' => 'config_slug richiesto.' ] );
    }
    $sampleSize = isset( $_POST['sample_size'] ) ? max( 1, min( 500, (int) $_POST['sample_size'] ) ) : 50;
    @set_time_limit( 180 );
    wp_send_json_success( \HiveSync\Tools\FeedDiagnostic::run( $configSlug, $sampleSize ) );
} );

// ─── Usage summary ───────────────────────────────────────────────
//
// Returns a map of which entities (source-configs, mappings,
// pipelines, rules) are referenced by active jobs. The UI decorates
// each list item with an "in uso" / "non usato" pill so the operator
// can see at a glance which entries are wired up and which are
// abandoned drafts.
//
// Single source of truth = the jobs table. A pipeline that's only
// referenced by a disabled job is still "in uso" (the operator may
// flip it on later); the badge surfaces the enabled-job count
// separately so abandoned-while-disabled is detectable.

add_action( 'wp_ajax_hsync_ajax_usage_summary', function () {
    hsync_ajax_guard();
    $jobs = ( new \HiveSync\Core\Repo\JobRepository() )->all();

    $usage = [
        'source_configs' => [],
        'mappings'       => [],
        'pipelines'      => [],
        'rules'          => [],
    ];
    $bump = function ( string $kind, string $key, int $jobId, bool $enabled ) use ( &$usage ): void {
        if ( $key === '' ) return;
        if ( ! isset( $usage[ $kind ][ $key ] ) ) {
            $usage[ $kind ][ $key ] = [ 'jobs' => [], 'enabled_jobs' => 0 ];
        }
        $usage[ $kind ][ $key ]['jobs'][] = $jobId;
        if ( $enabled ) $usage[ $kind ][ $key ]['enabled_jobs']++;
    };

    foreach ( $jobs as $j ) {
        $jid     = (int) ( $j['id'] ?? 0 );
        $type    = (string) ( $j['runnable_type'] ?? '' );
        $ref     = (string) ( $j['runnable_ref']  ?? '' );
        $cfg     = (array)  ( $j['config']        ?? [] );
        $options = (array)  ( $cfg['options']     ?? [] );
        $enabled = ! empty( $j['enabled'] );

        // Source-config: extract `<config_slug>` from "<source_id>/<config_slug>"
        if ( $type === 'source.import' && str_contains( $ref, '/' ) ) {
            [ , $configSlug ] = explode( '/', $ref, 2 );
            $bump( 'source_configs', (string) $configSlug, $jid, $enabled );
        }

        // Rule reference: rule.<slug>
        if ( $type === 'rule' || str_starts_with( $ref, 'rule.' ) || str_starts_with( $type, 'rule.' ) ) {
            $slug = str_starts_with( $ref, 'rule.' ) ? substr( $ref, 5 ) : $ref;
            $bump( 'rules', (string) $slug, $jid, $enabled );
        }

        // Mapping + pipeline slugs come through options.
        $bump( 'mappings',  (string) ( $options['mapping_slug']  ?? '' ), $jid, $enabled );
        $bump( 'pipelines', (string) ( $options['pipeline_slug'] ?? '' ), $jid, $enabled );
    }

    wp_send_json_success( [ 'usage' => $usage ] );
} );

// ─── Cockpit header status ─────────────────────────────────────
//
// Lightweight aggregated status used by the page header strip:
// counts of jobs (active/total), last run summary, Woo product count.
// Single roundtrip per page load — refreshes only when the operator
// switches tabs or hits "Tick now".

add_action( 'wp_ajax_hsync_ajax_cockpit_status', function () {
    hsync_ajax_guard();
    global $wpdb;

    $jobs        = ( new \HiveSync\Core\Repo\JobRepository() )->all();
    $jobsTotal   = count( $jobs );
    $jobsActive  = 0;
    $jobsRunning = 0;
    foreach ( $jobs as $j ) {
        if ( ! empty( $j['enabled'] ) ) $jobsActive++;
        if ( \HiveSync\Workflow\Schedule\RunState::isRunning( $j['run_state'] ?? null ) ) $jobsRunning++;
    }

    // Pull the most recent FINISHED run (skip rows still in progress
    // so the header doesn't flash a stale summary mid-import).
    $runs     = ( new \HiveSync\Core\Repo\RunRepository() )->recent( 5 );
    $lastRun  = null;
    foreach ( $runs as $r ) {
        if ( ! empty( $r['finished_at'] ) ) { $lastRun = $r; break; }
    }
    if ( ! $lastRun && ! empty( $runs ) ) $lastRun = $runs[0];

    $summary = is_array( $lastRun['report']['summary'] ?? null ) ? $lastRun['report']['summary'] : [];
    $lastInfo = $lastRun
        ? [
            'id'          => (int) ( $lastRun['id'] ?? 0 ),
            'status'      => (string) ( $lastRun['status'] ?? '' ),
            'finished_at' => (string) ( $lastRun['finished_at'] ?? '' ),
            'started_at'  => (string) ( $lastRun['started_at']  ?? '' ),
            'kind'        => (string) ( $lastRun['runnable_type'] ?? '' ),
            'ref'         => (string) ( $lastRun['runnable_ref']  ?? '' ),
            'created'     => (int) ( $summary['created']       ?? 0 ),
            'updated'     => (int) ( $summary['updated']       ?? 0 ),
            'patched'     => (int) ( $summary['stock_patched'] ?? 0 ),
            'failed'      => (int) ( $summary['failed']        ?? 0 ),
        ]
        : null;

    $productCount = (int) $wpdb->get_var(
        "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status NOT IN ('trash','auto-draft')",
    );

    wp_send_json_success( [
        'jobs_active'   => $jobsActive,
        'jobs_total'    => $jobsTotal,
        'jobs_running'  => $jobsRunning,
        'last_run'      => $lastInfo,
        'product_count' => $productCount,
        'now_iso'       => gmdate( 'c' ),
    ] );
} );

// ─── Cleanup helpers (history logs, deletion log, lock release) ───
//
// Surface every plugin-owned growing log so the operator can wipe
// noise without dropping the plugin. All idempotent + reversible-
// confirmation gated client-side.

add_action( 'wp_ajax_hsync_ajax_runs_purge_all', function () {
    hsync_ajax_guard();
    $deleted = ( new \HiveSync\Core\Repo\RunRepository() )->purgeAll();
    wp_send_json_success( [ 'deleted' => $deleted ] );
} );

add_action( 'wp_ajax_hsync_ajax_runs_purge_older', function () {
    hsync_ajax_guard();
    $days = isset( $_POST['days'] ) ? max( 1, (int) wp_unslash( $_POST['days'] ) ) : 30;
    $deleted = ( new \HiveSync\Core\Repo\RunRepository() )->purgeOlderThan( $days );
    wp_send_json_success( [ 'deleted' => $deleted, 'days' => $days ] );
} );

add_action( 'wp_ajax_hsync_ajax_media_log_clear', function () {
    hsync_ajax_guard();
    delete_option( \HiveSync\Media\Cleaner::LOG_OPTION_KEY );
    wp_send_json_success( [ 'cleared' => true ] );
} );

add_action( 'wp_ajax_hsync_ajax_release_tick_lock', function () {
    hsync_ajax_guard();
    // Operator override for a lease left behind by a process that died
    // (it expires by itself after RunnerLease::DEFAULT_TTL). A drain that
    // is actually alive notices on its next renew and stops cleanly.
    \HiveSync\Workflow\Schedule\RunnerLease::forSite()->forceRelease();
    delete_transient( 'hsync_jobs_tick_lock' ); // pre-1.2 lock
    wp_send_json_success( [ 'released' => true ] );
} );

// ─── System status (production WP-Cron readiness check) ───────────
//
// Surfaces whether the operator's environment is set up for the
// recommended "real cron hits wp-cron.php" pattern. We can't
// actively probe their crontab, but we CAN tell them whether
// DISABLE_WP_CRON is set + when our event last fired + whether the
// next scheduled fire is in the past (= cron is broken).

add_action( 'wp_ajax_hsync_ajax_system_status', function () {
    hsync_ajax_guard();

    $next       = wp_next_scheduled( 'hive_sync_jobs_tick' );
    $now        = time();
    $disableWp  = defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON === true;
    $altCron    = defined( 'ALTERNATE_WP_CRON' ) && ALTERNATE_WP_CRON === true;
    $wpUrl      = site_url( 'wp-cron.php?doing_wp_cron' );
    $isOverdue  = $next && $next < ( $now - 600 ); // > 10 min overdue

    $lease = \HiveSync\Workflow\Schedule\RunnerLease::forSite()->inspect();

    wp_send_json_success( [
        'heartbeat_schedule' => wp_get_schedule( 'hive_sync_jobs_tick' ) ?: null,
        'runner_busy'      => $lease !== null && ! $lease['expired'],
        'runner_expires_at'=> $lease ? gmdate( 'c', (int) $lease['expires'] ) : null,
        'next_tick_at'     => $next ? gmdate( 'c', $next ) : null,
        'next_tick_in_sec' => $next ? ( $next - $now ) : null,
        'overdue'          => $isOverdue,
        'disable_wp_cron'  => $disableWp,
        'alternate_wp_cron'=> $altCron,
        'wp_cron_url'      => $wpUrl,
        'recommended_crontab' => '* * * * * curl -s "' . $wpUrl . '" > /dev/null 2>&1',
    ] );
} );

// ─── Source-config duplicate (server-side, preserves secrets) ─────
//
// Cloning a source-config in JS would round-trip the redacted secret
// placeholder back to the DB. The duplicate has to happen here where
// we have plaintext access — read the row, generate a new slug,
// suffix the name with " (copia)", insert. Returns the new slug.

add_action( 'wp_ajax_hsync_ajax_source_configs_duplicate', function () {
    hsync_ajax_guard();
    $slug = hsync_post_text( 'slug' );
    if ( $slug === '' ) wp_send_json_error( [ 'message' => 'slug richiesto.' ] );

    $repo = new \HiveSync\Core\Repo\SourceConfigRepository();
    $row  = $repo->find( $slug );
    if ( ! $row ) wp_send_json_error( [ 'message' => 'config non trovata: ' . $slug ] );

    $copyName = ( (string) ( $row['name'] ?? '' ) ) !== ''
        ? $row['name'] . ' (copia)'
        : $slug . ' (copia)';

    $newSlug = $repo->save( [
        // Empty slug → repo generates a fresh one.
        'slug'        => '',
        'name'        => $copyName,
        'source_kind' => (string) ( $row['source_kind'] ?? '' ),
        'config'      => (array) ( $row['config'] ?? [] ),
    ] );

    wp_send_json_success( [ 'slug' => $newSlug, 'name' => $copyName ] );
} );

// ─── Project config-as-code ──────────────────────────────────────
//
// Three endpoints back the Configurazione tab and any LLM-driven
// "paste a JSON to reshape the install" flow:
//
//   project_export    → dump every persisted entity to a single JSON
//                        document (secrets redacted to ••••XXXX)
//   project_validate  → structural + referential checks; returns
//                        { ok, errors, diff } so the operator can
//                        preview the planned changes
//   project_apply     → execute the diff. Optional `prune` flag
//                        deletes entities the document doesn't list
//                        ("declarative" mode); default is additive.

function hsync_project_repos(): array {
    return [
        new \HiveSync\Core\Repo\SourceConfigRepository(),
        new \HiveSync\Core\Repo\MappingRepository(),
        new \HiveSync\Core\Pipeline\PipelineRepository(),
        new \HiveSync\Core\Repo\RuleRepository(),
        new \HiveSync\Core\Repo\JobRepository(),
    ];
}

add_action( 'wp_ajax_hsync_ajax_project_export', function () {
    hsync_ajax_guard();
    [ $sc, $m, $p, $r, $j ] = hsync_project_repos();
    $exporter = new \HiveSync\Workflow\Config\ProjectExporter( $sc, $m, $p, $r, $j );
    wp_send_json_success( [ 'project' => $exporter->export() ] );
} );

add_action( 'wp_ajax_hsync_ajax_project_validate', function () {
    hsync_ajax_guard();
    $project = hsync_post_json( 'project' );
    if ( ! $project ) wp_send_json_error( [ 'message' => 'project JSON mancante o non parsabile.' ] );

    [ $sc, $m, $p, $r, $j ] = hsync_project_repos();
    $applier = new \HiveSync\Workflow\Config\ProjectApplier( $sc, $m, $p, $r, $j );
    $validation = $applier->validate( $project );
    $diff       = $validation['ok'] ? $applier->diff( $project ) : [];
    wp_send_json_success( [
        'ok'     => $validation['ok'],
        'errors' => $validation['errors'],
        'diff'   => $diff,
    ] );
} );

add_action( 'wp_ajax_hsync_ajax_project_apply', function () {
    hsync_ajax_guard();
    $project = hsync_post_json( 'project' );
    if ( ! $project ) wp_send_json_error( [ 'message' => 'project JSON mancante o non parsabile.' ] );
    $prune = hsync_post_bool( 'prune' );

    [ $sc, $m, $p, $r, $j ] = hsync_project_repos();
    $applier = new \HiveSync\Workflow\Config\ProjectApplier( $sc, $m, $p, $r, $j );
    $result  = $applier->apply( $project, [ 'prune' => $prune ] );

    if ( ! $result['ok'] ) {
        wp_send_json_error( [
            'message' => 'Validazione fallita.',
            'errors'  => $result['errors'],
        ], 422 );
    }
    wp_send_json_success( $result );
} );

// ─── Markup rules tester ──────────────────────────────────────────
//
// Runs source.fetch with the operator's current config (including
// markup_rules) on a small slice of the feed and returns per-product
// diagnostics: which rule matched, what value was compared, what
// multiplier resolved. Removes guessing about "did my rule fire?".

add_action( 'wp_ajax_hsync_ajax_markup_rules_test', function () {
    hsync_ajax_guard();
    $sourceId   = hsync_post_text( 'source_id' );
    $configSlug = hsync_post_text( 'config_slug' );
    $config     = hsync_resolve_source_config( hsync_post_json( 'config' ), $configSlug );

    if ( ! \HiveSync\Core\Bootstrap::$sources ) {
        wp_send_json_error( [ 'message' => 'Bootstrap non inizializzato.' ] );
    }
    $src = \HiveSync\Core\Bootstrap::$sources->get( $sourceId );
    if ( ! $src ) {
        wp_send_json_error( [ 'message' => "Source '{$sourceId}' non registrata." ] );
    }

    $ctx = new \HiveSync\Core\Source\Context( runId: 'markup-test' );
    $req = new \HiveSync\Core\Source\FetchRequest( $config, [] );
    try {
        $fetch = $src->fetch( $req, $ctx );
    } catch ( \Throwable $e ) {
        wp_send_json_error( [ 'message' => $e->getMessage() ] );
    }

    // ─── DEBUG: what the server actually saw ────────────────────
    // Lets the operator (and us) verify the rules survived JSON
    // serialization + json_decode + MarkupResolver::normalize
    // exactly as they were typed.
    $rawRules        = isset( $config['markup_rules'] ) && is_array( $config['markup_rules'] ) ? $config['markup_rules'] : [];
    $normalizedRules = \HiveSync\Sources\MarkupResolver::normalize( $rawRules );
    $flavor          = (string) ( $config['flavor'] ?? '' );
    $debug = [
        'flavor'             => $flavor,
        'raw_rules'          => $rawRules,
        'normalized_rules'   => $normalizedRules,
        'rules_dropped'      => count( $rawRules ) - count( $normalizedRules ),
    ];
    if ( $flavor === 'stockfirmati' ) {
        $debug['flat_sf_multiplier'] = \HiveSync\Sources\CsvSource::resolveSfMarkupPublic( $config );
    }

    // Surface the markup-relevant fields per product. The SF flavor
    // populates _sf_applied_multiplier on each FeedItem, so we just
    // pluck the diagnostic-ready fields directly.
    $rows = [];
    foreach ( array_slice( $fetch->items, 0, 20 ) as $item ) {
        $d = $item->data;
        $rows[] = [
            'sku'                    => (string) $item->sku,
            'name'                   => (string) ( $d['name'] ?? '' ),
            'applied_multiplier'     => isset( $d['_sf_applied_multiplier'] ) ? (float) $d['_sf_applied_multiplier'] : null,
            'markup_target'          => (string) ( $d['_sf_markup_target'] ?? '' ),
            '_sf_brand'              => (string) ( $d['_sf_brand']        ?? '' ),
            '_sf_category'           => (string) ( $d['_sf_category']     ?? '' ),
            '_sf_subcategory'        => (string) ( $d['_sf_subcategory']  ?? '' ),
            '_sf_taxonomy_any'       => trim(
                ( (string) ( $d['_sf_subcategory'] ?? '' ) ) !== ''
                    ? (string) $d['_sf_subcategory']
                    : (string) ( $d['_sf_category'] ?? '' )
            ),
            '_sf_taxonomy'           => trim( ( (string) ( $d['_sf_category'] ?? '' ) ) . ' > ' . ( (string) ( $d['_sf_subcategory'] ?? '' ) ), ' >' ),
            'variations_count'       => isset( $d['variations'] ) && is_array( $d['variations'] ) ? count( $d['variations'] ) : 0,
            'first_variation_prices' => isset( $d['variations'][0] ) && is_array( $d['variations'][0] )
                ? [
                    'regular_price'  => (string) ( $d['variations'][0]['regular_price']  ?? '' ),
                    'sale_price'     => (string) ( $d['variations'][0]['sale_price']     ?? '' ),
                    'stock_quantity' => (int)    ( $d['variations'][0]['stock_quantity'] ?? 0 ),
                ]
                : null,
        ];
    }

    wp_send_json_success( [
        'count'    => count( $fetch->items ),
        'rules'    => $rawRules,
        'rows'     => $rows,
        'warnings' => $fetch->warnings,
        '_debug'   => $debug,
    ] );
} );
