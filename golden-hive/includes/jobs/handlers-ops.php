<?php
/**
 * Jobs Handlers — operations (non-feed kinds).
 *
 * Registers the remaining 6 job kinds:
 *   - goldensneakers_feed  → full rp_rc_gs_fetch → diff → rp_rc_gs_apply pipeline
 *   - email_campaign       → rp_em_execute_campaign()
 *   - media_cleanup        → scan orphans + rp_mm_bulk_delete() (chunked)
 *   - bulk_action          → gh_execute_bulk_action() over a product ID list (chunked)
 *   - catalog_export       → rp_cm_export_catalog()/rp_cm_export_roundtrip() → uploads
 *   - rest_call            → rp_rc_request() generic HTTP call
 *
 * Handlers that walk lists (media_cleanup, bulk_action) use the chunking
 * contract: they honor gh_jobs_should_yield() and return status=continue
 * with a cursor {offset:int}. The runner preserves the lock and fires a
 * continuation tick +1s later with the same cursor.
 */

defined( 'ABSPATH' ) || exit;

/** Default chunk size for list-walking handlers. */
const GH_JOBS_DEFAULT_CHUNK = 50;

add_action( 'gh_jobs_register', function () {

    // ── Golden Sneakers feed ──────────────────────────────
    gh_jobs_register_kind( 'goldensneakers_feed', [
        'label'       => 'Golden Sneakers Feed',
        'description' => 'Fetch → diff → apply dal feed Golden Sneakers.',
        'params'      => [
            'url'             => [ 'type' => 'string', 'label' => 'URL API', 'required' => true ],
            'token'           => [ 'type' => 'string', 'label' => 'Bearer token', 'required' => true ],
            'cookie'          => [ 'type' => 'string', 'label' => 'Cookie (opzionale)' ],
            'format'          => [ 'type' => 'enum',   'label' => 'Formato', 'options' => [ 'hierarchical', 'flat' ], 'default' => 'hierarchical' ],
            'create_new'      => [ 'type' => 'bool',   'label' => 'Crea nuovi',      'default' => true ],
            'update_existing' => [ 'type' => 'bool',   'label' => 'Aggiorna esistenti', 'default' => true ],
            'sideload_images' => [ 'type' => 'bool',   'label' => 'Scarica immagini', 'default' => false ],
        ],
        'handler'     => 'gh_jobs_handler_gs_feed',
    ] );

    // ── Email campaign ────────────────────────────────────
    gh_jobs_register_kind( 'email_campaign', [
        'label'       => 'Email Campaign',
        'description' => 'Invia una campagna a chunk (prepare → send batched → finalize).',
        'params'      => [
            'campaign_id' => [ 'type' => 'string', 'label' => 'Campaign ID', 'required' => true ],
        ],
        'handler'     => 'gh_jobs_handler_email_campaign',
    ] );

    // ── Media cleanup ─────────────────────────────────────
    gh_jobs_register_kind( 'media_cleanup', [
        'label'       => 'Media Cleanup (orphans)',
        'description' => 'Scansiona immagini orfane ed elimina in batch (rispetta whitelist).',
        'params'      => [
            'chunk_size'     => [ 'type' => 'string', 'label' => 'Chunk size', 'default' => '50' ],
            'max_per_run'    => [ 'type' => 'string', 'label' => 'Max cancellazioni per run (0 = illimitato)', 'default' => '0' ],
            'dry_run'        => [ 'type' => 'bool',   'label' => 'Dry run (non cancella)', 'default' => false ],
        ],
        'handler'     => 'gh_jobs_handler_media_cleanup',
    ] );

    // ── Bulk action ───────────────────────────────────────
    gh_jobs_register_kind( 'bulk_action', [
        'label'       => 'Bulk Action',
        'description' => 'Esegue un\'azione bulk su una lista di product ID (chunked).',
        'params'      => [
            'action'       => [ 'type' => 'string', 'label' => 'Action slug', 'required' => true ],
            'product_ids'  => [ 'type' => 'string', 'label' => 'Product IDs (comma-separated o JSON array)', 'required' => true ],
            'action_params'=> [ 'type' => 'string', 'label' => 'Parametri azione (JSON)', 'default' => '{}' ],
            'chunk_size'   => [ 'type' => 'string', 'label' => 'Chunk size', 'default' => '50' ],
        ],
        'handler'     => 'gh_jobs_handler_bulk_action',
    ] );

    // ── Catalog export ────────────────────────────────────
    gh_jobs_register_kind( 'catalog_export', [
        'label'       => 'Catalog Export',
        'description' => 'Genera un export catalogo JSON e lo salva in uploads/gh-jobs/.',
        'params'      => [
            'mode'       => [ 'type' => 'enum',   'label' => 'Modalità', 'options' => [ 'catalog', 'roundtrip' ], 'default' => 'catalog' ],
            'filters'    => [ 'type' => 'string', 'label' => 'Filtri (JSON)', 'default' => '{}' ],
            'keep_last'  => [ 'type' => 'string', 'label' => 'Mantieni ultimi N file (0 = tutti)', 'default' => '10' ],
        ],
        'handler'     => 'gh_jobs_handler_catalog_export',
    ] );

    // ── REST call ─────────────────────────────────────────
    gh_jobs_register_kind( 'rest_call', [
        'label'       => 'REST Call',
        'description' => 'Chiamata HTTP generica (rp_rc_request).',
        'params'      => [
            'url'     => [ 'type' => 'string', 'label' => 'URL', 'required' => true ],
            'method'  => [ 'type' => 'enum',   'label' => 'Metodo', 'options' => [ 'GET', 'POST', 'PUT', 'PATCH', 'DELETE' ], 'default' => 'GET' ],
            'headers' => [ 'type' => 'string', 'label' => 'Headers (JSON)', 'default' => '{}' ],
            'body'    => [ 'type' => 'string', 'label' => 'Body (raw)',     'default' => '' ],
            'timeout' => [ 'type' => 'string', 'label' => 'Timeout (s)',    'default' => '60' ],
            'expect_status' => [ 'type' => 'string', 'label' => 'Status atteso (vuoto = 2xx)', 'default' => '' ],
        ],
        'handler'     => 'gh_jobs_handler_rest_call',
    ] );

    // ── Bulk import (background) ───────────────────────────
    gh_jobs_register_kind( 'bulk_import', [
        'label'       => 'Bulk Import (background)',
        'description' => 'Importa prodotti da un file JSON a chunk, immune al cap ~100s di Cloudflare.',
        'params'      => [
            'file'          => [ 'type' => 'string', 'label' => 'File JSON (path in uploads)', 'required' => true ],
            'mode'          => [ 'type' => 'enum',   'label' => 'Modalità', 'options' => [ 'create', 'create_or_update' ], 'default' => 'create' ],
            'weight_budget' => [ 'type' => 'string', 'label' => 'Budget scritture/tick', 'default' => '80' ],
        ],
        'handler'     => 'gh_jobs_handler_bulk_import',
    ] );

}, 5 );

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Decodes a JSON string param or returns a fallback.
 */
function gh_jobs_decode_json_param( string $raw, $fallback = [] ) {
    $raw = trim( $raw );
    if ( $raw === '' ) return $fallback;
    $d = json_decode( $raw, true );
    return is_array( $d ) ? $d : $fallback;
}

/**
 * Parses a CSV/JSON array of IDs into a list of ints.
 */
function gh_jobs_parse_id_list( string $raw ): array {
    $raw = trim( $raw );
    if ( $raw === '' ) return [];
    if ( $raw[0] === '[' ) {
        $d = json_decode( $raw, true );
        return is_array( $d ) ? array_values( array_filter( array_map( 'intval', $d ) ) ) : [];
    }
    $parts = array_map( 'trim', explode( ',', $raw ) );
    return array_values( array_filter( array_map( 'intval', $parts ) ) );
}

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────

/**
 * Handler: goldensneakers_feed.
 *
 * Full pipeline (one-shot). For very large feeds, boost max_runtime / tick_budget.
 */
function gh_jobs_handler_gs_feed( array $job, array $context ): array {
    $p = $job['params'] ?? [];
    if ( empty( $p['url'] ) || empty( $p['token'] ) ) {
        return [ 'status' => 'error', 'error' => 'url o token mancanti.' ];
    }
    if ( ! function_exists( 'rp_rc_gs_fetch' ) ) {
        return [ 'status' => 'error', 'error' => 'Golden Sneakers feed non disponibile.' ];
    }

    $products = rp_rc_gs_fetch( [
        'url'    => (string) $p['url'],
        'token'  => (string) $p['token'],
        'cookie' => (string) ( $p['cookie'] ?? '' ),
        'format' => (string) ( $p['format'] ?? 'hierarchical' ),
    ] );
    if ( is_wp_error( $products ) ) {
        return [ 'status' => 'error', 'error' => $products->get_error_message() ];
    }

    $diff = rp_rc_gs_diff( $products );

    $options = [
        'create_new'      => (bool) ( $p['create_new']      ?? true ),
        'update_existing' => (bool) ( $p['update_existing'] ?? true ),
        'sideload_images' => (bool) ( $p['sideload_images'] ?? false ),
        'force_recreate'  => (bool) ( $p['force_recreate']  ?? false ),
    ];

    $result = rp_rc_gs_apply( $diff, $options );

    return [
        'status'  => 'done',
        'summary' => $result['summary'] ?? $result,
    ];
}

/**
 * Handler: email_campaign (chunked).
 *
 * Tick 1: prepare (valida + renderizza + risolve contatti, lato email module)
 * e congela la lista contatti nel cursor — i tick successivi spediscono
 * sulla lista frozen, quindi un subscriber aggiunto a invio in corso non
 * distorce la run.
 *
 * Cursor shape: { offset, sent, failed, errors[], subject, rate_limit, contacts[] }
 *
 * Il loop di spedizione e rp_em_send_campaign_rendered() con
 * should_yield=gh_jobs_should_yield: quando il tick_budget scade ritorna
 * done=false + next_offset e il runner schedula la continuazione (+1s).
 * L'HTML renderizzato NON sta nel cursor (puo pesare centinaia di KB):
 * viene riletto da campaign.last_render, salvato dalla prepare.
 *
 * Il lock campagna (anti doppio-invio, condiviso col path sincrono) viene
 * rilasciato da rp_em_finalize_campaign_send() a fine run, o qui sui path
 * di errore.
 */
function gh_jobs_handler_email_campaign( array $job, array $context ): array {
    $p  = $job['params'] ?? [];
    $id = (string) ( $p['campaign_id'] ?? '' );
    if ( $id === '' ) {
        return [ 'status' => 'error', 'error' => 'campaign_id mancante.' ];
    }
    if ( ! function_exists( 'rp_em_prepare_campaign_send' ) ) {
        return [ 'status' => 'error', 'error' => 'Email module non disponibile.' ];
    }

    $fail = static function ( string $error ) use ( $id ): array {
        if ( function_exists( 'rp_em_release_campaign_lock' ) ) {
            rp_em_release_campaign_lock( $id );
        }
        return [ 'status' => 'error', 'error' => $error ];
    };

    $cursor = $context['cursor'];
    if ( ! is_array( $cursor ) || ! isset( $cursor['contacts'] ) ) {
        // First tick: prepare. In caso di errore la campagna e gia stata
        // marcata 'failed' (con gli errori nelle stats) dalla prepare stessa.
        $prep = rp_em_prepare_campaign_send( $id );
        if ( empty( $prep['ok'] ) ) {
            return $fail( implode( ' | ', (array) ( $prep['errors'] ?? [ 'Preparazione fallita.' ] ) ) );
        }
        $cursor = [
            'offset'     => 0,
            'sent'       => 0,
            'failed'     => 0,
            'errors'     => [],
            'subject'    => (string) $prep['subject'],
            'rate_limit' => (int) $prep['rate_limit'],
            'contacts'   => $prep['contacts'],
        ];
    }

    $campaign = rp_em_get_campaign( $id );
    if ( ! $campaign ) {
        return $fail( 'Campagna non trovata.' );
    }
    $html = (string) ( $campaign['last_render'] ?? '' );
    if ( $html === '' ) {
        return $fail( 'last_render mancante: prepare non completata?' );
    }

    $result = rp_em_send_campaign_rendered(
        $cursor['contacts'],
        $cursor['subject'],
        $html,
        $cursor['rate_limit'],
        [
            'campaign_id'   => $id,
            'campaign_name' => (string) ( $campaign['name'] ?? '' ),
        ],
        [
            'offset'       => (int) $cursor['offset'],
            'sent'         => (int) $cursor['sent'],
            'failed'       => (int) $cursor['failed'],
            'errors'       => (array) $cursor['errors'],
            'should_yield' => 'gh_jobs_should_yield',
        ]
    );

    if ( empty( $result['done'] ) ) {
        $cursor['offset'] = (int) $result['next_offset'];
        $cursor['sent']   = (int) $result['sent'];
        $cursor['failed'] = (int) $result['failed'];
        // Solo la coda degli errori: il cursor vive in un transient e non
        // deve gonfiarsi (le stats campagna tengono comunque le ultime 25).
        $cursor['errors'] = array_slice( (array) $result['errors'], -25 );
        return [
            'status'   => 'continue',
            'cursor'   => $cursor,
            'progress' => [ 'processed' => $cursor['offset'], 'of' => count( $cursor['contacts'] ) ],
        ];
    }

    rp_em_finalize_campaign_send( $id, $result );

    return [
        'status'  => 'done',
        'summary' => [
            'sent'   => (int) $result['sent'],
            'failed' => (int) $result['failed'],
            'total'  => (int) $result['total'],
        ],
    ];
}

/**
 * Handler: media_cleanup (chunked).
 *
 * Cursor shape: { offset: int, ids: int[], deleted_total: int, skipped_total: int, error_total: int }
 *
 * The list of orphan IDs is captured on the first tick and stored in the
 * cursor; subsequent continuations walk the same frozen list so concurrent
 * media uploads between ticks can't distort the run.
 */
function gh_jobs_handler_media_cleanup( array $job, array $context ): array {
    $p          = $job['params'] ?? [];
    $chunk_size = max( 1, (int) ( $p['chunk_size']  ?? GH_JOBS_DEFAULT_CHUNK ) );
    $max_per    = max( 0, (int) ( $p['max_per_run'] ?? 0 ) );
    $dry_run    = (bool) ( $p['dry_run'] ?? false );

    if ( ! function_exists( 'rp_mm_get_orphan_attachments' ) ) {
        return [ 'status' => 'error', 'error' => 'Media cleaner non disponibile.' ];
    }

    $cursor = $context['cursor'];
    if ( ! is_array( $cursor ) || ! isset( $cursor['ids'] ) ) {
        // First tick: scan + freeze the ID list.
        $orphans = rp_mm_get_orphan_attachments();
        $ids     = [];
        foreach ( (array) $orphans as $o ) {
            if ( is_array( $o ) ) {
                if ( empty( $o['is_whitelisted'] ) && ! empty( $o['id'] ) ) {
                    $ids[] = (int) $o['id'];
                }
            } elseif ( is_object( $o ) && empty( $o->is_whitelisted ) && ! empty( $o->id ) ) {
                $ids[] = (int) $o->id;
            }
        }
        $cursor = [
            'offset'        => 0,
            'ids'           => array_values( array_unique( $ids ) ),
            'deleted_total' => 0,
            'freed_bytes'   => 0,
            'error_total'   => 0,
        ];
    }

    $total = count( $cursor['ids'] );
    if ( $total === 0 ) {
        return [ 'status' => 'done', 'summary' => [ 'deleted' => 0, 'reason' => 'no_orphans' ] ];
    }

    while ( $cursor['offset'] < $total ) {
        if ( gh_jobs_should_yield() ) {
            return [
                'status'   => 'continue',
                'cursor'   => $cursor,
                'progress' => [ 'processed' => $cursor['offset'], 'of' => $total ],
            ];
        }

        $batch = array_slice( $cursor['ids'], $cursor['offset'], $chunk_size );
        if ( empty( $batch ) ) break;

        if ( ! $dry_run ) {
            $result = rp_mm_bulk_delete( $batch );
            $cursor['deleted_total'] += is_array( $result['deleted'] ?? null ) ? count( $result['deleted'] ) : 0;
            $cursor['freed_bytes']   += (int) ( $result['freed_bytes'] ?? 0 );
            $cursor['error_total']   += is_array( $result['errors']  ?? null ) ? count( $result['errors']  ) : 0;
        } else {
            $cursor['deleted_total'] += count( $batch );
        }

        $cursor['offset'] += $chunk_size;

        if ( $max_per > 0 && $cursor['deleted_total'] >= $max_per ) {
            break;
        }
    }

    return [
        'status'  => 'done',
        'summary' => [
            'scanned'      => $total,
            'deleted'      => $cursor['deleted_total'],
            'freed_bytes'  => $cursor['freed_bytes'],
            'errors'       => $cursor['error_total'],
            'dry_run'      => $dry_run,
        ],
    ];
}

/**
 * Handler: bulk_action (chunked).
 *
 * Cursor shape: { offset: int, success_total: int, failed_total: int }
 * The full ID list is stored inside the cursor on the first tick.
 */
function gh_jobs_handler_bulk_action( array $job, array $context ): array {
    $p             = $job['params'] ?? [];
    $action        = (string) ( $p['action'] ?? '' );
    $chunk_size    = max( 1, (int) ( $p['chunk_size'] ?? GH_JOBS_DEFAULT_CHUNK ) );
    $action_params = gh_jobs_decode_json_param( (string) ( $p['action_params'] ?? '{}' ), [] );

    if ( $action === '' ) {
        return [ 'status' => 'error', 'error' => 'action mancante.' ];
    }
    if ( ! function_exists( 'gh_execute_bulk_action' ) ) {
        return [ 'status' => 'error', 'error' => 'gh_execute_bulk_action non disponibile.' ];
    }

    $cursor = $context['cursor'];
    if ( ! is_array( $cursor ) || ! isset( $cursor['ids'] ) ) {
        $ids = gh_jobs_parse_id_list( (string) ( $p['product_ids'] ?? '' ) );
        if ( empty( $ids ) ) {
            return [ 'status' => 'error', 'error' => 'product_ids vuoto.' ];
        }
        $cursor = [
            'offset'        => 0,
            'ids'           => $ids,
            'success_total' => 0,
            'failed_total'  => 0,
        ];
    }

    $total = count( $cursor['ids'] );

    while ( $cursor['offset'] < $total ) {
        if ( gh_jobs_should_yield() ) {
            return [
                'status'   => 'continue',
                'cursor'   => $cursor,
                'progress' => [ 'processed' => $cursor['offset'], 'of' => $total ],
            ];
        }

        $batch = array_slice( $cursor['ids'], $cursor['offset'], $chunk_size );
        $res   = gh_execute_bulk_action( $action, $batch, $action_params );

        $cursor['success_total'] += (int) ( $res['success'] ?? 0 );
        $cursor['failed_total']  += (int) ( $res['failed']  ?? 0 );
        $cursor['offset']        += $chunk_size;
    }

    return [
        'status'  => 'done',
        'summary' => [
            'action'  => $action,
            'total'   => $total,
            'success' => $cursor['success_total'],
            'failed'  => $cursor['failed_total'],
        ],
    ];
}

/**
 * Handler: bulk_import (background, chunked).
 *
 * Reads a JSON products file from uploads and walks it in weight-bounded
 * batches (1 + variation count), calling rp_cm_bulk_apply per batch. Each tick
 * runs server-side via WP-Cron continuation — no held HTTP request — so it is
 * immune to Cloudflare's ~100s cap. Live progress is mirrored into the job's
 * last_summary so the UI/REST status poll can report it. The temp file is
 * removed when the run completes.
 *
 * Cursor shape: { offset, created, updated, errors, total }
 */
function gh_jobs_handler_bulk_import( array $job, array $context ): array {
    $p      = $job['params'] ?? [];
    $file   = (string) ( $p['file'] ?? '' );
    $mode   = (string) ( $p['mode'] ?? 'create' );
    $budget = max( 1, (int) ( $p['weight_budget'] ?? 80 ) );

    if ( ! in_array( $mode, [ 'create', 'create_or_update', 'sync' ], true ) ) {
        $mode = 'create';
    }
    if ( $file === '' || ! file_exists( $file ) ) {
        return [ 'status' => 'error', 'error' => 'File import non trovato: ' . $file ];
    }
    if ( ! function_exists( 'rp_cm_bulk_apply' ) || ! function_exists( 'rp_cm_validate_bulk_json' ) ) {
        return [ 'status' => 'error', 'error' => 'Bulk creator non disponibile.' ];
    }

    $data = json_decode( (string) file_get_contents( $file ), true );
    if ( ! is_array( $data ) ) {
        return [ 'status' => 'error', 'error' => 'File import illeggibile o non-JSON.' ];
    }
    $valid = rp_cm_validate_bulk_json( $data );
    if ( is_wp_error( $valid ) ) {
        return [ 'status' => 'error', 'error' => $valid->get_error_message() ];
    }
    $products = $valid['products'];
    $total    = count( $products );

    $cursor = $context['cursor'];
    if ( ! is_array( $cursor ) || ! isset( $cursor['offset'] ) ) {
        $cursor = [ 'offset' => 0, 'created' => 0, 'updated' => 0, 'errors' => 0, 'hidden' => 0, 'total' => $total ];
    }

    while ( $cursor['offset'] < $total ) {
        if ( gh_jobs_should_yield() ) {
            gh_jobs_bulk_import_progress( $job['id'], $cursor );
            return [
                'status'   => 'continue',
                'cursor'   => $cursor,
                'progress' => [ 'processed' => $cursor['offset'], 'of' => $total ],
            ];
        }

        // Build one weight-bounded batch (always at least 1 product).
        $batch = [];
        $w     = 0;
        while ( $cursor['offset'] < $total ) {
            $entry  = $products[ $cursor['offset'] ];
            $weight = function_exists( 'gh_cm_bulk_entry_weight' )
                ? gh_cm_bulk_entry_weight( $entry )
                : 1 + ( is_array( $entry['variations'] ?? null ) ? count( $entry['variations'] ) : 0 );
            if ( $batch && ( $w + $weight ) > $budget ) break;
            $batch[] = $entry;
            $w      += $weight;
            $cursor['offset']++;
        }

        $res = rp_cm_bulk_apply( [ 'products' => $batch ], $mode );
        $s   = $res['summary'] ?? [];
        $cursor['created'] += (int) ( $s['created'] ?? 0 );
        $cursor['updated'] += (int) ( $s['updated'] ?? 0 );
        $cursor['errors']  += (int) ( $s['errors']  ?? 0 );
        $cursor['hidden']  += (int) ( $s['hidden']  ?? 0 );
        foreach ( [ 'img_reused', 'img_downloaded', 'img_failed' ] as $k ) {
            $cursor[ $k ] = (int) ( $cursor[ $k ] ?? 0 ) + (int) ( $s[ $k ] ?? 0 );
        }
        // Dettaglio delle immagini non collegate (cap 50) — il polling UI lo
        // mostra a fine job, i soli contatori non dicono QUALE URL è fallito.
        $cursor['img_failures'] = (array) ( $cursor['img_failures'] ?? [] );
        foreach ( (array) ( $res['details'] ?? [] ) as $d ) {
            foreach ( (array) ( $d['images']['failed'] ?? [] ) as $f ) {
                if ( count( $cursor['img_failures'] ) >= 50 ) break 2;
                $cursor['img_failures'][] = [ 'sku' => (string) ( $d['sku'] ?? '' ), 'src' => (string) ( $f['src'] ?? '' ), 'reason' => (string) ( $f['reason'] ?? '' ) ];
            }
        }
    }

    gh_jobs_bulk_import_progress( $job['id'], $cursor );
    @unlink( $file );

    return [
        'status'  => 'done',
        'summary' => [
            'mode'      => $mode,
            'total'     => $total,
            'processed' => $cursor['offset'],
            'created'   => $cursor['created'],
            'updated'   => $cursor['updated'],
            'errors'    => $cursor['errors'],
            'hidden'    => $cursor['hidden'] ?? 0,
            'img_reused'     => $cursor['img_reused']     ?? 0,
            'img_downloaded' => $cursor['img_downloaded'] ?? 0,
            'img_failed'     => $cursor['img_failed']     ?? 0,
            'img_failures'   => $cursor['img_failures']   ?? [],
        ],
    ];
}

/**
 * Mirrors bulk_import progress into the job's last_summary so a status poll can
 * read live counters between ticks.
 */
function gh_jobs_bulk_import_progress( string $job_id, array $cursor ): void {
    if ( ! function_exists( 'gh_jobs_update_fields' ) ) return;
    gh_jobs_update_fields( $job_id, [ 'last_summary' => [
        'processed' => (int) ( $cursor['offset']  ?? 0 ),
        'total'     => (int) ( $cursor['total']   ?? 0 ),
        'created'   => (int) ( $cursor['created'] ?? 0 ),
        'updated'   => (int) ( $cursor['updated'] ?? 0 ),
        'errors'    => (int) ( $cursor['errors']  ?? 0 ),
        'hidden'    => (int) ( $cursor['hidden']  ?? 0 ),
        'img_reused'     => (int) ( $cursor['img_reused']     ?? 0 ),
        'img_downloaded' => (int) ( $cursor['img_downloaded'] ?? 0 ),
        'img_failed'     => (int) ( $cursor['img_failed']     ?? 0 ),
        'img_failures'   => array_slice( (array) ( $cursor['img_failures'] ?? [] ), 0, 50 ),
    ] ] );
}

/**
 * Handler: catalog_export.
 *
 * Writes the export to wp-content/uploads/gh-jobs/<job_id>/<timestamp>.json
 * so it can be fetched later. Optionally prunes old snapshots.
 */
function gh_jobs_handler_catalog_export( array $job, array $context ): array {
    $p       = $job['params'] ?? [];
    $mode    = (string) ( $p['mode']      ?? 'catalog' );
    $filters = gh_jobs_decode_json_param( (string) ( $p['filters'] ?? '{}' ), [] );
    $keep    = max( 0, (int) ( $p['keep_last'] ?? 10 ) );

    if ( $mode === 'roundtrip' ) {
        if ( ! function_exists( 'rp_cm_export_roundtrip' ) ) {
            return [ 'status' => 'error', 'error' => 'rp_cm_export_roundtrip non disponibile.' ];
        }
        $data = rp_cm_export_roundtrip( $filters );
    } else {
        if ( ! function_exists( 'rp_cm_export_catalog' ) ) {
            return [ 'status' => 'error', 'error' => 'rp_cm_export_catalog non disponibile.' ];
        }
        $data = rp_cm_export_catalog( $filters );
    }

    // Write to uploads
    $uploads = wp_get_upload_dir();
    if ( ! empty( $uploads['error'] ) ) {
        return [ 'status' => 'error', 'error' => 'Upload dir non accessibile: ' . $uploads['error'] ];
    }

    $dir = trailingslashit( $uploads['basedir'] ) . 'gh-jobs/' . sanitize_file_name( $job['id'] );
    if ( ! wp_mkdir_p( $dir ) ) {
        return [ 'status' => 'error', 'error' => "Impossibile creare {$dir}" ];
    }

    $filename = $mode . '-' . wp_date( 'Ymd-His' ) . '.json';
    $path     = trailingslashit( $dir ) . $filename;
    $json     = wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

    if ( false === file_put_contents( $path, $json ) ) {
        return [ 'status' => 'error', 'error' => "Scrittura fallita: {$path}" ];
    }

    // Prune old snapshots
    $pruned = 0;
    if ( $keep > 0 ) {
        $files = glob( $dir . '/' . $mode . '-*.json' ) ?: [];
        usort( $files, fn( $a, $b ) => filemtime( $b ) <=> filemtime( $a ) );
        $stale = array_slice( $files, $keep );
        foreach ( $stale as $f ) {
            if ( @unlink( $f ) ) $pruned++;
        }
    }

    $url = trailingslashit( $uploads['baseurl'] ) . 'gh-jobs/' . sanitize_file_name( $job['id'] ) . '/' . $filename;

    return [
        'status'  => 'done',
        'summary' => [
            'mode'       => $mode,
            'file'       => $path,
            'url'        => $url,
            'bytes'      => strlen( $json ),
            'pruned_old' => $pruned,
        ],
    ];
}

/**
 * Handler: rest_call.
 */
function gh_jobs_handler_rest_call( array $job, array $context ): array {
    $p       = $job['params'] ?? [];
    $url     = (string) ( $p['url'] ?? '' );
    if ( $url === '' ) {
        return [ 'status' => 'error', 'error' => 'url mancante.' ];
    }
    if ( ! function_exists( 'rp_rc_request' ) ) {
        return [ 'status' => 'error', 'error' => 'rp_rc_request non disponibile.' ];
    }

    $headers = gh_jobs_decode_json_param( (string) ( $p['headers'] ?? '{}' ), [] );

    $response = rp_rc_request( [
        'url'     => $url,
        'method'  => (string) ( $p['method']  ?? 'GET' ),
        'headers' => $headers,
        'body'    => (string) ( $p['body']    ?? '' ),
        'timeout' => max( 1, (int) ( $p['timeout'] ?? 60 ) ),
    ] );

    if ( ! empty( $response['error'] ) ) {
        return [ 'status' => 'error', 'error' => (string) $response['error'] ];
    }

    $status         = (int) ( $response['status'] ?? 0 );
    $expect_raw     = trim( (string) ( $p['expect_status'] ?? '' ) );
    $status_ok      = $expect_raw === ''
        ? ( $status >= 200 && $status < 300 )
        : ( $status === (int) $expect_raw );

    if ( ! $status_ok ) {
        return [ 'status' => 'error', 'error' => "HTTP {$status} (atteso: " . ( $expect_raw ?: '2xx' ) . ')' ];
    }

    return [
        'status'  => 'done',
        'summary' => [
            'http_status' => $status,
            'duration_ms' => (int) ( $response['duration_ms'] ?? 0 ),
            'body_bytes'  => strlen( (string) ( $response['body'] ?? '' ) ),
        ],
    ];
}
