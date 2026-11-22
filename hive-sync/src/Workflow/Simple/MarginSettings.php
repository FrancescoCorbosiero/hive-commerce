<?php
declare(strict_types=1);

namespace HiveSync\Workflow\Simple;

use HiveSync\Sources\CategoryFilter;
use HiveSync\Sources\CsvSource;
use HiveSync\Sources\MarkupResolver;

/**
 * The shop owner's view of the margins: one default "price = cost × N"
 * and, for feeds with a category tree, an optional N per category or
 * subcategory. Pure: reads and writes the source-config fields the
 * fetch already applies (markup is a property of the source-config,
 * idempotent by construction — see CLAUDE.md "Markup").
 *
 * Mapping (StockFirmati):
 *   default            → sf_markup_mode = multiplier, sf_markup_value = N
 *   "Cat > *"  ×N      → markup_rule { _sf_category equals "Cat",       percent (N-1)·100 }
 *   "Cat > Sub" ×N     → markup_rule { _sf_taxonomy equals "Cat > Sub", percent (N-1)·100 }
 * Generic JSON/CSV (GS…): default → markup_percent = (N-1)·100; no tree.
 *
 * Same rule as SimpleSettings: write only what can be read back. A rule
 * the developer wrote by hand (by brand, `contains`, …) is not a
 * category margin: it is counted, kept verbatim and FIRST — the order
 * it already had precedence in — and the editor says it exists.
 *
 * Example:
 *   $m = MarginSettings::read('csv', ['flavor' => 'stockfirmati', 'sf_markup_value' => '3.5']);
 *   $m['default'];  // 3.5
 */
final class MarginSettings
{
    public const MIN = 1.0;
    public const MAX = 20.0;

    /**
     * @param array<string, mixed> $config source-config
     * @return array{supported: bool, by_category: bool, default: float, categories: array<string, float>, custom_rules: int}
     */
    public static function read( string $sourceKind, array $config ): array
    {
        $rules = MarkupResolver::normalize( $config['markup_rules'] ?? [] );
        if ( self::isSf( $sourceKind, $config ) ) {
            $categories = [];
            $custom     = 0;
            foreach ( $rules as $rule ) {
                $value = self::categoryValue( $rule );
                if ( $value === null || isset( $categories[ $value ] ) ) { $custom++; continue; }
                $categories[ $value ] = self::round( 1 + $rule['percent'] / 100 );
            }
            return [
                'supported'    => true,
                'by_category'  => true,
                'default'      => self::round( CsvSource::resolveSfMarkupPublic( $config ) ),
                'categories'   => $categories,
                'custom_rules' => $custom,
            ];
        }
        if ( in_array( $sourceKind, [ 'json', 'csv' ], true ) ) {
            return [
                'supported'    => true,
                'by_category'  => false,
                'default'      => self::round( 1 + (float) ( $config['markup_percent'] ?? 0 ) / 100 ),
                'categories'   => [],
                'custom_rules' => count( $rules ),
            ];
        }
        // KicksDB prices itself (its own markup block): not a cost × N feed.
        return [ 'supported' => false, 'by_category' => false, 'default' => 1.0, 'categories' => [], 'custom_rules' => 0 ];
    }

    /**
     * The config with the owner's margins written in. Every other key —
     * credentials included — passes through untouched.
     *
     * @param array<string, mixed> $config
     * @param array<string, mixed> $categories  CategoryFilter path ("Cat > *" / "Cat > Sub") → N
     * @return array<string, mixed>
     * @throws \InvalidArgumentException on a margin outside MIN..MAX
     */
    public static function write( string $sourceKind, array $config, float $default, array $categories = [] ): array
    {
        $default = self::check( $default );
        $rules   = MarkupResolver::normalize( $config['markup_rules'] ?? [] );

        if ( self::isSf( $sourceKind, $config ) ) {
            $kept = array_values( array_filter( $rules, static fn( array $r ): bool => self::categoryValue( $r ) === null ) );
            $subs = $cats = [];
            foreach ( $categories as $value => $n ) {
                if ( $n === null || $n === '' ) continue;
                $n     = self::check( (float) $n );
                $entry = CategoryFilter::parse( [ (string) $value ] )[0] ?? null;
                if ( ! $entry || $entry['type'] !== 'path' ) continue;
                [ $cat, $sub ] = self::split( (string) $entry['label'] );
                $percent = round( ( $n - 1 ) * 100, 4 );
                // Subcategories first: the first matching rule wins, and a
                // subcategory must beat the category it belongs to.
                if ( $sub === '' ) {
                    $cats[] = [ 'field' => '_sf_category', 'operator' => 'equals', 'value' => $cat, 'percent' => $percent ];
                } else {
                    $subs[] = [ 'field' => '_sf_taxonomy', 'operator' => 'equals', 'value' => $cat . ' > ' . $sub, 'percent' => $percent ];
                }
            }
            $config['sf_markup_mode']  = 'multiplier';
            $config['sf_markup_value'] = self::format( $default );
            $config['markup_rules']    = array_merge( $kept, $subs, $cats );
            return $config;
        }

        $config['markup_percent'] = (int) round( ( $default - 1 ) * 100 );
        return $config;
    }

    /** "×3,5 · Sneakers ×4" — '' when unsupported. */
    public static function describe( array $read ): string
    {
        if ( empty( $read['supported'] ) ) return '';
        $parts = [ '×' . self::format( (float) $read['default'], ',' ) ];
        foreach ( (array) $read['categories'] as $value => $n ) {
            $parts[] = CategoryFilter::describe( [ (string) $value ] ) . ' ×' . self::format( (float) $n, ',' );
        }
        return implode( ' · ', $parts );
    }

    private static function isSf( string $sourceKind, array $config ): bool
    {
        return $sourceKind === 'csv' && (string) ( $config['flavor'] ?? '' ) === CsvSource::FLAVOR_SF;
    }

    /** The picker path a rule stands for, or null when it isn't a plain category margin. */
    private static function categoryValue( array $rule ): ?string
    {
        if ( $rule['operator'] !== 'equals' || ! is_string( $rule['value'] ) || trim( $rule['value'] ) === '' ) return null;
        if ( $rule['field'] === '_sf_category' ) return CategoryFilter::path( $rule['value'] );
        if ( $rule['field'] === '_sf_taxonomy' ) {
            // "Cat" alone on _sf_taxonomy matches only the products of Cat
            // WITHOUT a subcategory — not a whole-category margin.
            [ $cat, $sub ] = self::split( $rule['value'] );
            return ( $cat === '' || $sub === '' ) ? null : CategoryFilter::path( $cat, $sub );
        }
        return null;
    }

    /** @return array{0: string, 1: string} */
    private static function split( string $path ): array
    {
        $i   = strpos( $path, '>' );
        $cat = trim( (string) preg_replace( '/\s+/u', ' ', $i === false ? $path : substr( $path, 0, $i ) ) );
        $sub = $i === false ? '' : trim( (string) preg_replace( '/\s+/u', ' ', substr( $path, $i + 1 ) ) );
        return [ $cat, $sub === '*' ? '' : $sub ];
    }

    private static function check( float $n ): float
    {
        if ( ! is_finite( $n ) || $n < self::MIN || $n > self::MAX ) {
            throw new \InvalidArgumentException( sprintf(
                'Ricarico non valido: %s. Deve essere tra ×%s (prezzo = costo) e ×%s.',
                self::format( $n, ',' ), self::format( self::MIN, ',' ), self::format( self::MAX, ',' )
            ) );
        }
        return self::round( $n );
    }

    private static function round( float $n ): float
    {
        return round( $n, 3 );
    }

    private static function format( float $n, string $dec = '.' ): string
    {
        $s = rtrim( rtrim( number_format( $n, 3, '.', '' ), '0' ), '.' );
        return $dec === '.' ? $s : str_replace( '.', $dec, $s );
    }
}
