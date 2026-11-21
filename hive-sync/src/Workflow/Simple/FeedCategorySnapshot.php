<?php
declare(strict_types=1);

namespace HiveSync\Workflow\Simple;

use HiveSync\Sources\CategoryFilter;

/**
 * Which SKU of a feed sits under which (category, subcategory) — what the
 * category picker caches between two openings. Pure.
 *
 * Why SKUs and not just the counts: the picker also says how many of a
 * category's products are ALREADY in the shop, and that number changes
 * the moment an import finishes. Caching the finished tree would show
 * "Borse — 0 nel negozio" right after importing Borse. So the snapshot
 * keeps the feed side (slow: a multi-MB download) and the shop side is
 * recomputed on every request (fast: one batched SKU lookup).
 *
 * Compact on purpose — one "sku TAB cat TAB sub" line per product with
 * the names in a lookup table — because it lives in a transient and an
 * SF feed is ~15k products: as nested arrays PHP's serialize() would make
 * it several times larger.
 *
 * Example:
 *   $snap = FeedCategorySnapshot::encode([['SH-1', 'Calzature', 'Sneakers']]);
 *   FeedCategorySnapshot::tree($snap, ['SH-1' => 42])['in_shop'];  // 1
 */
final class FeedCategorySnapshot
{
    /**
     * @param iterable<array{0: string, 1: string, 2: string}> $items [sku, category, subcategory]
     * @return array{names: list<string>, rows: string, count: int}
     */
    public static function encode( iterable $items ): array
    {
        $names = [];
        $index = [];
        $lines = [];
        $id = static function ( string $name ) use ( &$names, &$index ): string {
            if ( $name === '' ) return '';
            if ( ! isset( $index[ $name ] ) ) {
                $index[ $name ] = count( $names );
                $names[] = $name;
            }
            return (string) $index[ $name ];
        };
        foreach ( $items as $item ) {
            $sku = self::field( (string) ( $item[0] ?? '' ) );
            if ( $sku === '' ) continue;
            $lines[] = $sku . "\t" . $id( self::field( (string) ( $item[1] ?? '' ) ) ) . "\t" . $id( self::field( (string) ( $item[2] ?? '' ) ) );
        }
        return [ 'names' => $names, 'rows' => implode( "\n", $lines ), 'count' => count( $lines ) ];
    }

    /**
     * @param array<string, mixed> $snapshot
     * @return \Generator<int, array{sku: string, cat: string, sub: string}>
     */
    public static function decode( array $snapshot ): \Generator
    {
        $names = is_array( $snapshot['names'] ?? null ) ? $snapshot['names'] : [];
        $rows  = (string) ( $snapshot['rows'] ?? '' );
        if ( $rows === '' ) return;
        foreach ( explode( "\n", $rows ) as $line ) {
            $f = explode( "\t", $line );
            if ( ( $f[0] ?? '' ) === '' ) continue;
            yield [
                'sku' => $f[0],
                'cat' => ( $f[1] ?? '' ) === '' ? '' : (string) ( $names[ (int) $f[1] ] ?? '' ),
                'sub' => ( $f[2] ?? '' ) === '' ? '' : (string) ( $names[ (int) $f[2] ] ?? '' ),
            ];
        }
    }

    /**
     * @param array<string, mixed> $snapshot
     * @return string[]
     */
    public static function skus( array $snapshot ): array
    {
        $out = [];
        foreach ( self::decode( $snapshot ) as $row ) $out[] = $row['sku'];
        return $out;
    }

    /**
     * The picker tree, with "already in the shop" counted against
     * $inShop (sku → product id, as SkuLookup::mapSkusToIds returns).
     *
     * @param array<string, mixed> $snapshot
     * @param array<string, int>   $inShop
     * @return array<string, mixed> CategoryFilter::tree() shape
     */
    public static function tree( array $snapshot, array $inShop ): array
    {
        $rows = ( static function () use ( $snapshot, $inShop ): \Generator {
            foreach ( self::decode( $snapshot ) as $row ) {
                yield [ 'cat' => $row['cat'], 'sub' => $row['sub'], 'in_shop' => isset( $inShop[ $row['sku'] ] ) ];
            }
        } )();
        return CategoryFilter::tree( $rows );
    }

    /** One line per product, tab-separated: neither may appear inside a field. */
    private static function field( string $v ): string
    {
        return trim( str_replace( [ "\t", "\r", "\n" ], ' ', $v ) );
    }
}
