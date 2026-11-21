<?php
declare(strict_types=1);

namespace HiveSync\Workflow\Simple;

use HiveSync\Sources\CategoryFilter;
use HiveSync\Workflow\Schedule\RunState;

/**
 * The automation cards of the simple view (Panoramica), built from the
 * raw rows. Pure: the AJAX handler loads the rows, this decides what a
 * shop owner gets to see.
 *
 * What it hides, and why:
 *   - a job whose feed was never configured AND that is switched off.
 *     The seeder ships a GS and an SF sync on every install; a shop that
 *     only buys from one supplier must not stare at a dead card for the
 *     other. A job that is switched ON with its config missing stays
 *     visible — it fails on every slot, and that is exactly what the
 *     owner needs to hear about.
 *
 * What it never sends: the job config itself (an inline config carries
 * credentials), the run snapshot, the cursor.
 *
 * Example:
 *   $o = FeedOverview::build($jobs, $configsBySlug, $latestByJob,
 *            fn(string $src, array $cfg): bool => $src === 'csv');
 *   $o['cards'][0]['label'];   // "SF — Sync catalogo"
 */
final class FeedOverview
{
    /** Counters of a run summary worth showing to a human. */
    private const SUMMARY_KEYS = [
        'fetched', 'created', 'updated', 'recreated', 'stock_patched',
        'retired', 'restored', 'skipped', 'failed', 'pre_blocked', 'post_blocked',
    ];

    /**
     * @param list<array<string, mixed>>          $jobs           JobRepository::all() rows, run_state included
     * @param array<string, array<string, mixed>> $configs        source-config rows keyed by slug
     * @param array<int, array<string, mixed>>    $latest         RunRepository::latestByJob()
     * @param callable(string, array): bool       $hasCategories  (source id, config) → does the feed carry a category tree
     * @param string[]                            $ruleSlugs      rules that exist
     * @return array{cards: list<array<string, mixed>>, hidden: int}
     */
    public static function build( array $jobs, array $configs, array $latest, callable $hasCategories, array $ruleSlugs = [] ): array
    {
        $cards  = [];
        $hidden = 0;
        foreach ( $jobs as $job ) {
            $card = self::card( $job, $configs, $latest, $hasCategories, $ruleSlugs );
            if ( ! $card['configured'] && ! $card['enabled'] ) {
                $hidden++;
                continue;
            }
            $cards[] = $card;
        }
        return [ 'cards' => $cards, 'hidden' => $hidden ];
    }

    /**
     * Where a source.import job reads its feed: [source id, config slug,
     * inline config]. Mirrors JobRunner::dispatchSourceImport — the ref
     * is '<source>/<slug>', or the bare source with the slug kept in
     * config.config_slug (jobs built in the advanced editor), or the bare
     * source with an inline config.
     *
     * @param array<string, mixed> $job
     * @return array{0: string, 1: string, 2: array<string, mixed>}
     */
    public static function importTarget( array $job ): array
    {
        $ref    = (string) ( $job['runnable_ref'] ?? '' );
        $config = is_array( $job['config'] ?? null ) ? $job['config'] : [];
        [ $sourceId, $slug ] = str_contains( $ref, '/' ) ? explode( '/', $ref, 2 ) : [ $ref, '' ];
        if ( $slug === '' && ! empty( $config['config_slug'] ) ) $slug = (string) $config['config_slug'];
        $inline = is_array( $config['inline_config'] ?? null ) ? $config['inline_config'] : [];
        return [ (string) $sourceId, (string) $slug, $inline ];
    }

    /**
     * @param array<string, mixed>                $job
     * @param array<string, array<string, mixed>> $configs
     * @param array<int, array<string, mixed>>    $latest
     * @param string[]                            $ruleSlugs
     * @return array<string, mixed>
     */
    private static function card( array $job, array $configs, array $latest, callable $hasCategories, array $ruleSlugs ): array
    {
        $id      = (int) ( $job['id'] ?? 0 );
        $type    = (string) ( $job['runnable_type'] ?? '' );
        $ref     = (string) ( $job['runnable_ref'] ?? '' );
        $config  = is_array( $job['config'] ?? null ) ? $job['config'] : [];
        $options = is_array( $config['options'] ?? null ) ? $config['options'] : [];
        $kind    = match ( $type ) {
            'source.import'          => 'import',
            'kicksdb.refresh_prices' => 'prices',
            'rule'                   => 'rule',
            default                  => 'other',
        };

        $sourceId = $slug = $configName = '';
        $configured = true;
        $importable = false;
        $categories = false;
        if ( $kind === 'import' ) {
            [ $sourceId, $slug, $inline ] = self::importTarget( $job );
            if ( $slug !== '' ) {
                $row        = $configs[ $slug ] ?? null;
                $configured = $row !== null;
                $configName = $row ? (string) ( $row['name'] ?? '' ) : '';
                // Importable from the simple view = the browser can run it
                // by naming a saved config. An inline config would have to
                // travel through the browser, credentials and all.
                $importable = $configured;
                $categories = $configured && $hasCategories( $sourceId, (array) ( $row['config'] ?? [] ) );
            } else {
                $configured = $inline !== [];
            }
        } elseif ( $kind === 'prices' ) {
            // JobRunner falls back to the first saved KicksDB config when
            // the ref names none (or a missing one): any one will do.
            $configured = false;
            foreach ( $configs as $row ) {
                if ( (string) ( $row['source_kind'] ?? '' ) === 'kicksdb' ) { $configured = true; break; }
            }
        } elseif ( $kind === 'rule' ) {
            $configured = in_array( $ref, $ruleSlugs, true );
        }

        $label = '';
        foreach ( [ '_label', '_seed_label' ] as $k ) {
            if ( $label === '' && ! empty( $config[ $k ] ) && is_string( $config[ $k ] ) ) $label = $config[ $k ];
        }
        if ( $label === '' ) $label = $configName !== '' ? $configName : ( $ref !== '' ? $ref : $type );

        $cron   = (string) ( $job['cron_expr'] ?? '' );
        $filter = $options['category_filter'] ?? null;

        return [
            'id'               => $id,
            'kind'             => $kind,
            'label'            => $label,
            'source_id'        => $sourceId,
            'config_slug'      => $slug,
            'config_name'      => $configName,
            'configured'       => $configured,
            'problem'          => $configured ? '' : ( $kind === 'rule' ? 'rule_missing' : 'config_missing' ),
            'importable'       => $importable,
            'has_categories'   => $categories,
            'enabled'          => ! empty( $job['enabled'] ),
            'cron_expr'        => $cron,
            'schedule'         => SimpleSettings::presetFor( $cron ),
            'next_run_at'      => $job['next_run_at'] ?? null,
            'run'              => RunState::publicView( is_array( $job['run_state'] ?? null ) ? $job['run_state'] : null ),
            'run_control'      => (string) ( $job['run_control'] ?? '' ),
            'add_new'          => $kind === 'import' ? SimpleSettings::addsNew( $options ) : null,
            // Whether the sync hides what the supplier delisted — the card
            // says so, because it is the one thing a sync does to products
            // the owner may not expect.
            'hides_missing'    => $kind === 'import' && ! empty( $options['retire_missing'] ),
            'categories'       => array_column( CategoryFilter::parse( $filter ), 'label' ),
            'categories_label' => CategoryFilter::describe( $filter ),
            'last'             => isset( $latest[ $id ] ) ? self::lastRun( $latest[ $id ] ) : null,
        ];
    }

    /**
     * The latest wp_hsync_runs row, trimmed to what a card prints.
     *
     * @param array<string, mixed> $run
     * @return array<string, mixed>
     */
    private static function lastRun( array $run ): array
    {
        $report  = is_array( $run['report'] ?? null ) ? $run['report'] : [];
        $summary = is_array( $report['summary'] ?? null ) ? $report['summary'] : [];
        $counts  = [];
        foreach ( self::SUMMARY_KEYS as $k ) {
            if ( isset( $summary[ $k ] ) ) $counts[ $k ] = (int) $summary[ $k ];
        }
        $error = isset( $report['error'] ) && is_scalar( $report['error'] ) ? (string) $report['error'] : '';
        return [
            'id'            => (int) ( $run['id'] ?? 0 ),
            'status'        => (string) ( $run['status'] ?? '' ),
            'started_at'    => $run['started_at'] ?? null,
            'finished_at'   => $run['finished_at'] ?? null,
            'items_done'    => (int) ( $run['items_done'] ?? 0 ),
            'items_failed'  => (int) ( $run['items_failed'] ?? 0 ),
            'summary'       => $counts,
            // The slice a category import covered ('' = the whole feed).
            'categories'    => is_string( $summary['categories'] ?? null ) ? $summary['categories'] : '',
            'error'         => function_exists( 'mb_substr' ) ? mb_substr( $error, 0, 300 ) : substr( $error, 0, 300 ),
            'warnings'      => is_array( $report['warnings'] ?? null ) ? count( $report['warnings'] ) : 0,
            'skipped_slots' => (int) ( $report['schedule']['skipped_slots'] ?? 0 ),
        ];
    }
}
