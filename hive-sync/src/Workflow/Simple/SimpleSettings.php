<?php
declare(strict_types=1);

namespace HiveSync\Workflow\Simple;

/**
 * The few knobs the simple view puts on an automation card — how often,
 * and whether new supplier products come in on their own — and how each
 * maps onto the job's real config. Pure.
 *
 * The rule that keeps the two views honest with each other: a simple
 * control only ever WRITES a shape it can also READ back. A cron or a
 * bucket set chosen by hand in the advanced editor reads as "custom"
 * (null / 'custom' below), the card shows it without a control, and
 * nothing here rewrites it. Flattening a developer's `buckets:
 * ['updateStock']` into "all" because the owner clicked a checkbox would
 * be the simple view silently undoing advanced configuration.
 *
 * Example:
 *   SimpleSettings::presetFor('0 3 * * *');              // 'daily'
 *   SimpleSettings::withAddNew(['buckets' => ['new']], false);
 *       // ['buckets' => ['update', 'updateStock']]
 */
final class SimpleSettings
{
    /**
     * Schedules offered on the card. Night-time daily slot: a full feed
     * download + diff is the heaviest thing the plugin does, so the once
     * a day option runs when the shop is quiet.
     */
    public const SCHEDULES = [
        '30m'   => [ 'cron' => '*/30 * * * *', 'label' => 'Ogni 30 minuti' ],
        '1h'    => [ 'cron' => '0 * * * *',    'label' => 'Ogni ora' ],
        '2h'    => [ 'cron' => '0 */2 * * *',  'label' => 'Ogni 2 ore' ],
        '6h'    => [ 'cron' => '0 */6 * * *',  'label' => 'Ogni 6 ore' ],
        'daily' => [ 'cron' => '0 3 * * *',    'label' => 'Una volta al giorno (alle 03:00)' ],
    ];

    /** A sync that keeps the products already in the shop current but adds none. */
    public const MAINTAIN_ONLY = [ 'update', 'updateStock' ];

    private const ALL_BUCKETS = [ 'new', 'update', 'updateStock' ];

    /**
     * '' for no cron (manual only), a SCHEDULES key, or 'custom' for any
     * other expression.
     */
    public static function presetFor( string $cron ): string
    {
        $cron = self::squash( $cron );
        if ( $cron === '' ) return '';
        foreach ( self::SCHEDULES as $key => $s ) {
            if ( $s['cron'] === $cron ) return $key;
        }
        return 'custom';
    }

    /** The cron behind a preset key, or null when the key is unknown. */
    public static function cronFor( string $preset ): ?string
    {
        return self::SCHEDULES[ $preset ]['cron'] ?? null;
    }

    /**
     * Does this sync bring in new supplier products on its own?
     *   true  → every bucket (no `buckets` key: the runner's default)
     *   false → MAINTAIN_ONLY
     *   null  → a hand-picked bucket set the simple view leaves alone
     *
     * @param array<string, mixed> $options job config.options
     */
    public static function addsNew( array $options ): ?bool
    {
        $buckets = $options['buckets'] ?? null;
        if ( $buckets === null || $buckets === [] ) return true;
        if ( ! is_array( $buckets ) ) return null;
        $set = self::set( $buckets );
        if ( $set === self::set( self::ALL_BUCKETS ) )   return true;
        if ( $set === self::set( self::MAINTAIN_ONLY ) ) return false;
        return null;
    }

    /**
     * The options with "add new products" switched on or off. Every
     * other key — mapping, pipeline, sweep, filters — passes through.
     *
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    public static function withAddNew( array $options, bool $addNew ): array
    {
        if ( $addNew ) {
            // Drop the key rather than listing all three: an absent key IS
            // the default, and [] would read as "process nothing".
            unset( $options['buckets'] );
        } else {
            $options['buckets'] = self::MAINTAIN_ONLY;
        }
        return $options;
    }

    /** @param array<int, mixed> $list */
    private static function set( array $list ): array
    {
        $out = array_values( array_unique( array_map( 'strval', array_filter( $list, 'is_scalar' ) ) ) );
        sort( $out );
        return $out;
    }

    private static function squash( string $cron ): string
    {
        return trim( (string) preg_replace( '/\s+/', ' ', $cron ) );
    }
}
