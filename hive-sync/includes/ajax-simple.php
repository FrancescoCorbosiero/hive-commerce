<?php
/**
 * AJAX endpoints behind the simple view (Panoramica / Importa / Storico).
 *
 * The simple view never asks the owner for a source, a mapping or a
 * pipeline: it works in AUTOMATIONS. A source.import job already carries
 * the right (source, saved config, mapping, pipeline) quadruple, so every
 * action here starts from a job id and resolves the rest server-side —
 * the same posture as the Media tab's image repair, and for the same
 * reason: an owner who re-picks the parameters can pick them differently
 * from the real sync and rewrite products with the wrong mapping.
 *
 * Endpoints (prefix hsync_ajax_), all behind hsync_ajax_guard():
 *   overview            → automation cards (FeedOverview) + schedule presets
 *   feed_settings_save  → on/off, schedule preset, "add new products"
 *   feed_categories     → the feed's category tree with product counts
 *   import_params       → a job's run parameters for the browser tick loop,
 *                         optionally narrowed to some categories
 *   run_cancel          → close a browser-driven run the owner stopped
 */

defined( 'ABSPATH' ) || exit;

use HiveSync\Core\Bootstrap;
use HiveSync\Core\Repo\JobRepository;
use HiveSync\Core\Repo\MappingRepository;
use HiveSync\Core\Repo\RuleRepository;
use HiveSync\Core\Repo\RunRepository;
use HiveSync\Core\Repo\SourceConfigRepository;
use HiveSync\Core\Source\AbstractSource;
use HiveSync\Core\Source\Context;
use HiveSync\Core\Source\FetchRequest;
use HiveSync\Core\Source\TransientSourceException;
use HiveSync\Sources\CategoryFilter;
use HiveSync\Sources\SkuLookup;
use HiveSync\Workflow\Run\RunCache;
use HiveSync\Workflow\Schedule\RunnerLease;
use HiveSync\Workflow\Schedule\RunState;
use HiveSync\Workflow\Simple\FeedCategorySnapshot;
use HiveSync\Workflow\Simple\FeedOverview;
use HiveSync\Workflow\Simple\SimpleSettings;

// How long a feed's category snapshot is reused before the picker
// downloads the feed again. Overridable from wp-config.php.
defined( 'HSYNC_FEED_CATS_TTL' ) || define( 'HSYNC_FEED_CATS_TTL', 30 * MINUTE_IN_SECONDS );

/**
 * The (source, saved config, options) a source.import job runs with,
 * resolved like JobRunner::dispatchSourceImport — mapping_slug included —
 * for the endpoints that hand a job's parameters to the browser instead
 * of re-asking for them. Sends a JSON error (and exits) when the job
 * can't be run from the browser.
 *
 * @return array{job: array<string, mixed>, source: AbstractSource, source_id: string, config_slug: string, config: array<string, mixed>, options: array<string, mixed>}
 */
function hsync_job_import_target( int $jobId ): array {
    if ( $jobId <= 0 ) {
        wp_send_json_error( [ 'message' => 'job_id richiesto.' ] );
    }
    $job = ( new JobRepository() )->find( $jobId );
    if ( ! $job ) {
        wp_send_json_error( [ 'message' => "Job #{$jobId} non trovato." ] );
    }
    if ( (string) ( $job['runnable_type'] ?? '' ) !== 'source.import' ) {
        wp_send_json_error( [ 'message' => 'Il job selezionato non è un import.' ] );
    }

    [ $sourceId, $configSlug ] = FeedOverview::importTarget( $job );
    if ( $configSlug === '' ) {
        // An inline config would have to travel through the browser on
        // every tick, credentials included.
        wp_send_json_error( [ 'message' => 'Questa automazione contiene la configurazione del feed al suo interno (inline): avviala dalla modalità avanzata.' ] );
    }
    // Fail loudly on a job pointing at a deleted config: running with an
    // empty config would report a clean "done / 0" that is
    // indistinguishable from "nothing to do".
    $stored = ( new SourceConfigRepository() )->find( $configSlug );
    if ( ! $stored ) {
        wp_send_json_error( [ 'message' => "Configurazione '{$configSlug}' non trovata (il job punta a una config cancellata)." ] );
    }
    $src = Bootstrap::$sources ? Bootstrap::$sources->get( $sourceId ) : null;
    if ( ! $src instanceof AbstractSource ) {
        wp_send_json_error( [ 'message' => "Source '{$sourceId}' non registrata." ] );
    }

    $options = (array) ( $job['config']['options'] ?? [] );
    // Resolve mapping_slug → the mapping config, exactly as JobRunner
    // does, so the browser run writes with the mapping the sync uses.
    if ( empty( $options['mapping'] ) && ! empty( $options['mapping_slug'] ) ) {
        $mapping = ( new MappingRepository() )->find( (string) $options['mapping_slug'] );
        if ( $mapping ) {
            $options['mapping'] = (array) $mapping['config'];
        }
    }

    return [
        'job'         => $job,
        'source'      => $src,
        'source_id'   => (string) $sourceId,
        'config_slug' => (string) $configSlug,
        'config'      => (array) $stored['config'],
        'options'     => $options,
    ];
}

// ─── Overview ──────────────────────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_overview', function () {
    hsync_ajax_guard();

    $jobs    = ( new JobRepository() )->all();
    $configs = [];
    foreach ( ( new SourceConfigRepository() )->all() as $row ) {
        $configs[ (string) $row['slug'] ] = $row;
    }
    $latest  = ( new RunRepository() )->latestByJob( array_column( $jobs, 'id' ) );
    $rules   = array_column( ( new RuleRepository() )->all(), 'slug' );
    $sources = Bootstrap::$sources;
    $hasCats = static function ( string $sourceId, array $config ) use ( $sources ): bool {
        $src = $sources ? $sources->get( $sourceId ) : null;
        return $src instanceof AbstractSource && $src->hasCategories( $config );
    };

    $schedules = [];
    foreach ( SimpleSettings::SCHEDULES as $key => $s ) {
        $schedules[] = [ 'key' => $key, 'label' => $s['label'] ];
    }
    $lease = RunnerLease::forSite()->inspect();

    wp_send_json_success( FeedOverview::build( $jobs, $configs, $latest, $hasCats, $rules ) + [
        'schedules' => $schedules,
        'runner'    => [ 'busy' => $lease !== null && ! $lease['expired'] ],
        'now'       => gmdate( 'Y-m-d H:i:s' ),
    ] );
} );

// ─── Automation card settings ──────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_feed_settings_save', function () {
    hsync_ajax_guard();

    $id   = (int) hsync_post_text( 'job_id' );
    $repo = new JobRepository();
    $job  = $id > 0 ? $repo->find( $id ) : null;
    if ( ! $job ) {
        wp_send_json_error( [ 'message' => 'Automazione non trovata.' ] );
    }

    // Edit the stored config, never one posted by the browser: the card
    // only sends the knob that changed, and a config round-tripped
    // through the page would carry whatever it was minutes ago.
    $config = is_array( $job['config'] ?? null ) ? $job['config'] : [];
    foreach ( RunState::RUNTIME_CONFIG_KEYS as $k ) unset( $config[ $k ] );
    $enabled = ! empty( $job['enabled'] );
    $cron    = (string) ( $job['cron_expr'] ?? '' );

    if ( isset( $_POST['schedule'] ) ) {
        $preset = hsync_post_text( 'schedule' );
        $next   = SimpleSettings::cronFor( $preset );
        if ( $next === null ) {
            wp_send_json_error( [ 'message' => 'Frequenza non valida.' ] );
        }
        $cron = $next;
    }
    if ( isset( $_POST['enabled'] ) ) {
        $enabled = hsync_post_bool( 'enabled' );
    }
    if ( isset( $_POST['add_new'] ) ) {
        if ( (string) ( $job['runnable_type'] ?? '' ) !== 'source.import' ) {
            wp_send_json_error( [ 'message' => 'Questa automazione non importa prodotti.' ] );
        }
        $options = is_array( $config['options'] ?? null ) ? $config['options'] : [];
        // A hand-picked bucket set is the developer's: the simple card
        // shows it but must not flatten it.
        if ( SimpleSettings::addsNew( $options ) === null ) {
            wp_send_json_error( [ 'message' => 'Questa automazione ha una configurazione personalizzata: modificala in modalità avanzata.' ] );
        }
        $config['options'] = SimpleSettings::withAddNew( $options, hsync_post_bool( 'add_new' ) );
    }
    if ( $enabled && $cron === '' ) {
        wp_send_json_error( [ 'message' => 'Scegli prima ogni quanto deve partire.' ] );
    }

    $next = hsync_plan_next_run_at( $job, $cron, $enabled );
    $repo->save( [
        'id'            => $id,
        'runnable_type' => (string) $job['runnable_type'],
        'runnable_ref'  => (string) $job['runnable_ref'],
        'cron_expr'     => $cron,
        'enabled'       => $enabled,
        'next_run_at'   => $next,
        'config'        => $config,
    ] );

    wp_send_json_success( [
        'id'          => $id,
        'enabled'     => $enabled,
        'next_run_at' => $next,
        // The run in flight keeps the snapshot it started with.
        'running'     => RunState::isRunning( $job['run_state'] ?? null ),
    ] );
} );

// ─── Category tree of a feed ───────────────────────────────────────

add_action( 'wp_ajax_hsync_ajax_feed_categories', function () {
    hsync_ajax_guard();
    // Reading the categories means downloading + transforming the whole
    // feed — the same one-shot cost as tick 1 of an import.
    hsync_arm_fatal_guard();
    hsync_raise_limits();

    $t   = hsync_job_import_target( (int) hsync_post_text( 'job_id' ) );
    $src = $t['source'];
    if ( ! $src->hasCategories( $t['config'] ) ) {
        wp_send_json_success( [ 'supported' => false ] );
    }

    // Keyed by feed, not by job: two automations on one feed share it.
    $key  = 'hsync_feed_cats_' . md5( $t['source_id'] . '/' . $t['config_slug'] );
    $snap = hsync_post_bool( 'refresh' ) ? false : get_transient( $key );
    $cached = is_array( $snap );

    if ( ! $cached ) {
        try {
            $fetch = $src->fetch( new FetchRequest( $t['config'], [] ), new Context( runId: 'categories' ) );
        } catch ( TransientSourceException $e ) {
            wp_send_json_error( [ 'message' => 'Il fornitore non risponde in questo momento: riprova tra qualche minuto. (' . $e->getMessage() . ')' ] );
        } catch ( \Throwable $e ) {
            wp_send_json_error( [ 'message' => 'Lettura del feed fallita: ' . $e->getMessage() ] );
        }
        if ( ! $fetch->items ) {
            wp_send_json_error( [ 'message' => $fetch->warnings ? implode( ' ', $fetch->warnings ) : 'Il feed non ha restituito prodotti.' ] );
        }
        $snap = FeedCategorySnapshot::encode( ( static function () use ( $fetch, $src ): \Generator {
            foreach ( $fetch->items as $item ) {
                $path = $src->categoryPath( $item ) ?? [ '', '' ];
                yield [ $item->sku, $path[0], $path[1] ];
            }
        } )() );
        $snap['fetched_at'] = gmdate( 'Y-m-d H:i:s' );
        set_transient( $key, $snap, HSYNC_FEED_CATS_TTL );
    }

    // The shop side is never cached: it is what changes after an import.
    $inShop = SkuLookup::mapSkusToIds( FeedCategorySnapshot::skus( $snap ) );

    wp_send_json_success( FeedCategorySnapshot::tree( $snap, $inShop ) + [
        'supported'  => true,
        'fetched_at' => (string) ( $snap['fetched_at'] ?? '' ),
        'cached'     => $cached,
    ] );
} );

// ─── Run parameters for the browser tick loop ──────────────────────

add_action( 'wp_ajax_hsync_ajax_import_params', function () {
    hsync_ajax_guard();

    $t       = hsync_job_import_target( (int) hsync_post_text( 'job_id' ) );
    $options = $t['options'];

    // An import from the Importa tab ADDS products — that is what the
    // owner asked for, whatever the automation's own routine is: every
    // bucket (a maintain-only sync must not filter the new products back
    // out), no test cap, no SKU list, the normal full write path.
    unset( $options['buckets'], $options['limit'], $options['skus'], $options['force_recreate'], $options['mode'] );

    $picked = CategoryFilter::parse( hsync_post_json( 'categories' ) );
    if ( $picked ) {
        if ( ! $t['source']->hasCategories( $t['config'] ) ) {
            wp_send_json_error( [ 'message' => 'Questo fornitore non ha categorie: si può importare solo il catalogo intero.' ] );
        }
        $options['category_filter'] = array_column( $picked, 'label' );
        // The runner sees a slice of the feed, so the sweep of delisted
        // products would refuse to run anyway (everything outside the
        // slice would read as delisted) — asking for it only puts a
        // warning about it in front of the owner. Not asking changes
        // nothing else: the RESTORE half runs on every sync regardless.
        unset( $options['retire_missing'], $options['retire_mode'], $options['retire_max_ratio'] );
    }

    wp_send_json_success( [
        'source_id'        => $t['source_id'],
        'config_slug'      => $t['config_slug'],
        'options'          => $options,
        'categories_label' => CategoryFilter::describe( $options['category_filter'] ?? null ),
    ] );
} );

// ─── Stop a run the browser is driving ─────────────────────────────

add_action( 'wp_ajax_hsync_ajax_run_cancel', function () {
    hsync_ajax_guard();

    $runId = (int) hsync_post_text( 'run_id' );
    $repo  = new RunRepository();
    $run   = $runId > 0 ? $repo->find( $runId ) : null;
    if ( ! $run ) {
        wp_send_json_error( [ 'message' => 'Esecuzione non trovata.' ] );
    }
    // Only a run the browser drives (Importa). A job's run belongs to the
    // scheduler — its run_state points at this row — and stops through
    // job_stop, or the two would disagree about whether it is running.
    if ( $run['job_id'] !== null ) {
        wp_send_json_error( [ 'message' => 'Questa esecuzione appartiene a un\'automazione: fermala con «Interrompi» sulla sua scheda.' ] );
    }
    // The tick that was in flight may have finished the run meanwhile.
    if ( ! in_array( $run['status'], [ 'running', 'continue' ], true ) ) {
        wp_send_json_success( [ 'cancelled' => false, 'status' => $run['status'] ] );
    }
    // Without this the row reads "In corso" for a day, until the daily
    // upkeep files it as abandoned.
    $repo->cancel( $runId, 'operator' );
    RunCache::clear( $runId );
    wp_send_json_success( [ 'cancelled' => true, 'status' => 'cancelled' ] );
} );
