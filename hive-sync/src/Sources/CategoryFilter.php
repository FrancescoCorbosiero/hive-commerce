<?php
declare(strict_types=1);

namespace HiveSync\Sources;

/**
 * "Import only these categories" — the matcher behind
 * `options.category_filter` and the category picker of the Importa tab.
 *
 * A filter is a list of entries, compared case-insensitively with the
 * whitespace collapsed:
 *
 *   "Calzature > Sneakers"   exactly that category + subcategory
 *   "Calzature > *"          the whole category, any subcategory
 *   "sneak"                  legacy form: a substring of the category
 *                            OR of the subcategory
 *
 * Why two shapes. The legacy substring form predates the picker and
 * stays exactly as loose as it always was, so a job written by hand
 * against it keeps importing the same products. The picker, though,
 * shows the operator a COUNT next to every category — and a substring
 * can't honour a count: "Borse" also catches "Accessori › Borse da
 * viaggio", "Top" catches "Laptop". The number on screen would not be
 * the number imported. So everything the UI writes is a path, and a
 * path matches the category tree exactly — the same two levels
 * gh_sf_assign_category turns into a parent/child product_cat, i.e. the
 * tree the shop owner sees in WooCommerce.
 *
 * Pure: no WordPress, no I/O. The source decides what an item's
 * (category, subcategory) pair is — see AbstractSource::categoryPath().
 *
 * Example:
 *   $f = CategoryFilter::parse(['Calzature > *', 'Borse > Zaini']);
 *   CategoryFilter::matches('Calzature', 'Stivali', $f);  // true
 *   CategoryFilter::matches('Borse', 'Pochette', $f);     // false
 */
final class CategoryFilter
{
    /** Between category and subcategory in a path entry. */
    public const SEPARATOR = ' > ';

    /** Subcategory wildcard: the whole category. */
    public const ANY = '*';

    /**
     * Parse a raw filter into match entries. Accepts a list, or a single
     * string (comma-separated, the legacy form). Unknown shapes and
     * empty entries are dropped, duplicates collapsed. [] = no filter.
     *
     * @param mixed $raw
     * @return list<array{type: 'path', cat: string, sub: ?string, label: string}|array{type: 'contains', needle: string, label: string}>
     */
    public static function parse(mixed $raw): array
    {
        if (is_string($raw)) {
            $raw = explode(',', $raw);
        }
        if (! is_array($raw)) return [];

        $out  = [];
        $seen = [];
        foreach ($raw as $value) {
            if (! is_scalar($value)) continue;
            $label = self::clean((string) $value);
            if ($label === '') continue;

            $sep = strpos($label, '>');
            if ($sep === false) {
                $entry = ['type' => 'contains', 'needle' => self::norm($label), 'label' => $label];
                $key   = 'c:' . $entry['needle'];
            } else {
                $cat = self::norm(substr($label, 0, $sep));
                $sub = self::norm(substr($label, $sep + 1));
                // A path needs its category: "> Sneakers" names no node
                // of the tree, and guessing would import the wrong slice.
                if ($cat === '') continue;
                $entry = [
                    'type'  => 'path',
                    'cat'   => $cat,
                    'sub'   => ($sub === '' || $sub === self::ANY) ? null : $sub,
                    'label' => $label,
                ];
                $key = 'p:' . $cat . "\0" . ($entry['sub'] ?? self::ANY);
            }
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $out[] = $entry;
        }
        return $out;
    }

    /**
     * Does an item with this (category, subcategory) pass the filter?
     * An empty filter keeps everything.
     *
     * @param list<array<string, mixed>> $entries  output of parse()
     */
    public static function matches(string $category, string $subcategory, array $entries): bool
    {
        if ($entries === []) return true;
        $cat = self::norm($category);
        $sub = self::norm($subcategory);
        foreach ($entries as $e) {
            if (($e['type'] ?? '') === 'path') {
                if ($cat !== '' && $cat === $e['cat'] && ($e['sub'] === null || $sub === $e['sub'])) {
                    return true;
                }
                continue;
            }
            $needle = (string) ($e['needle'] ?? '');
            if ($needle === '') continue;
            if (($cat !== '' && str_contains($cat, $needle)) || ($sub !== '' && str_contains($sub, $needle))) {
                return true;
            }
        }
        return false;
    }

    /**
     * The filter entry the picker writes for a node of the tree.
     *
     * Example: path('Calzature') → 'Calzature > *'
     *          path('Calzature', 'Sneakers') → 'Calzature > Sneakers'
     */
    public static function path(string $category, ?string $subcategory = null): string
    {
        $sub = $subcategory === null ? '' : self::clean($subcategory);
        return self::clean($category) . self::SEPARATOR . ($sub === '' ? self::ANY : $sub);
    }

    /**
     * Aggregate a feed into the picker's tree: every category with its
     * product count and its subcategories, both alphabetical. Names keep
     * the feed's first spelling; "SNEAKERS" and "Sneakers" are one node,
     * because matching is case-insensitive and two rows that import the
     * same products must not look like two choices.
     *
     * Products whose subcategory is empty count toward their category
     * (selectable through the whole category) but get no row of their
     * own. Products with no category at all are counted apart: the import
     * bridge gives them no product_cat either, so they are not a node.
     *
     * @param iterable<array{cat?: string, sub?: string, in_shop?: bool}> $rows  one per product
     * @return array{
     *     total: int, in_shop: int, uncategorized: int,
     *     categories: list<array{name: string, value: string, count: int, in_shop: int, subs: list<array{name: string, value: string, count: int, in_shop: int}>}>
     * }
     */
    public static function tree(iterable $rows): array
    {
        $cats  = [];
        $total = $inShop = $uncategorized = 0;

        foreach ($rows as $row) {
            $catName = self::clean((string) ($row['cat'] ?? ''));
            $subName = self::clean((string) ($row['sub'] ?? ''));
            $owned   = ! empty($row['in_shop']) ? 1 : 0;
            $total++;
            $inShop += $owned;

            $ck = self::norm($catName);
            if ($ck === '') {
                $uncategorized++;
                continue;
            }
            if (! isset($cats[$ck])) {
                $cats[$ck] = ['name' => $catName, 'count' => 0, 'in_shop' => 0, 'subs' => []];
            }
            $cats[$ck]['count']++;
            $cats[$ck]['in_shop'] += $owned;

            $sk = self::norm($subName);
            if ($sk === '') continue;
            if (! isset($cats[$ck]['subs'][$sk])) {
                $cats[$ck]['subs'][$sk] = ['name' => $subName, 'count' => 0, 'in_shop' => 0];
            }
            $cats[$ck]['subs'][$sk]['count']++;
            $cats[$ck]['subs'][$sk]['in_shop'] += $owned;
        }

        $byName = static fn(array $a, array $b): int => strnatcasecmp($a['name'], $b['name']);
        $out = [];
        foreach ($cats as $cat) {
            $subs = [];
            foreach ($cat['subs'] as $sub) {
                $subs[] = [
                    'name'    => $sub['name'],
                    'value'   => self::path($cat['name'], $sub['name']),
                    'count'   => $sub['count'],
                    'in_shop' => $sub['in_shop'],
                ];
            }
            usort($subs, $byName);
            $out[] = [
                'name'    => $cat['name'],
                'value'   => self::path($cat['name']),
                'count'   => $cat['count'],
                'in_shop' => $cat['in_shop'],
                'subs'    => $subs,
            ];
        }
        usort($out, $byName);

        return [
            'total'         => $total,
            'in_shop'       => $inShop,
            'uncategorized' => $uncategorized,
            'categories'    => $out,
        ];
    }

    /**
     * One line for humans: "Calzature, Borse › Zaini, «sneak»".
     * '' when the filter is empty.
     *
     * @param mixed $raw
     */
    public static function describe(mixed $raw): string
    {
        $parts = [];
        foreach (self::parse($raw) as $e) {
            if ($e['type'] === 'contains') {
                $parts[] = '«' . $e['label'] . '»';
                continue;
            }
            $sep   = strpos($e['label'], '>');
            $cat   = self::clean(substr($e['label'], 0, (int) $sep));
            $sub   = self::clean(substr($e['label'], (int) $sep + 1));
            $parts[] = ($e['sub'] === null) ? $cat : $cat . ' › ' . $sub;
        }
        return implode(', ', $parts);
    }

    /** Trim + collapse whitespace; keeps the original casing. */
    private static function clean(string $v): string
    {
        $v = preg_replace('/\s+/u', ' ', $v) ?? $v;
        return trim($v);
    }

    /** The comparison key: clean() + lowercase (Unicode-aware when mbstring is there). */
    private static function norm(string $v): string
    {
        $v = self::clean($v);
        return function_exists('mb_strtolower') ? mb_strtolower($v, 'UTF-8') : strtolower($v);
    }
}
