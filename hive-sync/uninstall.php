<?php
/**
 * Hive Sync — uninstall handler.
 *
 * Fired by WordPress when the operator deletes the plugin from the
 * Plugins screen (NOT on simple deactivate). Owns every byte the
 * plugin ever wrote so deletion leaves zero trace:
 *
 *   - 8 wp_hsync_* tables (DROP)
 *   - 6 wp_options rows (delete)
 *   - 2 transients (delete)
 *   - 1 cron event hook (clear all schedules)
 *
 * Safe to run multiple times — every operation is idempotent.
 *
 * Note: deletion is intentional and total. The operator who hits
 * "Elimina" on the WP plugins screen has chosen to walk away. If
 * they want to deactivate without losing data, that's the
 * Deactivate button (handled by register_deactivation_hook in
 * includes/cron.php — which only unschedules cron events).
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;

// 1. Drop tables.
$tables = [
    'mappings',
    'pipelines',
    'rules',
    'jobs',
    'runs',
    'checks',
    'source_configs',
    'kicksdb_cache',
];
foreach ( $tables as $name ) {
    $wpdb->query( "DROP TABLE IF EXISTS `{$wpdb->prefix}hsync_{$name}`" );
}

// 2. Delete plugin options.
$options = [
    'hsync_db_version',
    'hsync_migrated_gs_to_json',
    'hsync_migrated_scheduler_v2',
    'hsync_media_whitelist',
    'hsync_media_deletion_log',
    'hsync_runner_lease',          // scheduler mutex (OptionsLeaseStore)
];
foreach ( $options as $opt ) {
    delete_option( $opt );
    delete_site_option( $opt );  // multisite safety
}

// 2b. Delete dynamically-keyed cursor options from KicksDB woo_catalog
// discovery. Keys are `hsync_kicksdb_catalog_cursor_<12-char-md5>` —
// one per (market, sku_pattern) combination — so they can't be
// enumerated up front.
$wpdb->query( "DELETE FROM `{$wpdb->options}` WHERE option_name LIKE 'hsync_kicksdb_catalog_cursor_%'" );

// 3. Delete transients (caches + cron lock).
$transients = [
    'hsync_media_usage_index_v1',
    'hsync_jobs_tick_lock',
    'hsync_runs_pruned_today',
];
foreach ( $transients as $key ) {
    delete_transient( $key );
    delete_site_transient( $key );
}

// 3b. Wildcard-delete dynamically-keyed RunCache transients
// (`hsync_run_cache_<runId>` + the matching `_timeout_*`). Without
// this they survive uninstall and collide with run_id=1, 2, … minted
// by a fresh re-install (wp_hsync_runs.AUTO_INCREMENT restarts at 1
// when the table is dropped above) — producing a phantom Importa run
// where ImportRunner reads a stale Diff from the previous install,
// skips fetch+diff, and the item loop processes garbage data with
// silent 0 counters. Same fix posture as the kicksdb-catalog-cursor
// wildcard above.
$wpdb->query( "DELETE FROM `{$wpdb->options}` WHERE option_name LIKE '\\_transient\\_hsync\\_run\\_cache\\_%' ESCAPE '\\\\'" );
$wpdb->query( "DELETE FROM `{$wpdb->options}` WHERE option_name LIKE '\\_transient\\_timeout\\_hsync\\_run\\_cache\\_%' ESCAPE '\\\\'" );

// 3c. The category picker's per-feed snapshots (`hsync_feed_cats_<md5>`,
// see includes/ajax-simple.php). They expire on their own within the
// hour; deleting them here just keeps uninstall leaving nothing behind.
$wpdb->query( "DELETE FROM `{$wpdb->options}` WHERE option_name LIKE '\\_transient\\_hsync\\_feed\\_cats\\_%' ESCAPE '\\\\'" );
$wpdb->query( "DELETE FROM `{$wpdb->options}` WHERE option_name LIKE '\\_transient\\_timeout\\_hsync\\_feed\\_cats\\_%' ESCAPE '\\\\'" );

// 4. Clear the cron hook entirely (handles edge cases where
//    deactivation didn't fire — e.g. WP-CLI uninstall on a
//    deactivated plugin). 'hive_sync_jobs_tick' is the real hook;
//    'hsync_cron_tick' was a wrong name this file used to clear, kept
//    in case an early build ever scheduled it.
wp_clear_scheduled_hook( 'hive_sync_jobs_tick' );
wp_clear_scheduled_hook( 'hsync_cron_tick' );
