<?php
declare(strict_types=1);

namespace HiveSync\Tests\Unit\Sources;

use HiveSync\Sources\CategoryFilter;
use PHPUnit\Framework\TestCase;

/**
 * Pins the category filter contract.
 *
 * The property that matters most: a PATH entry (what the picker writes)
 * matches the category tree exactly, so the count the operator saw next
 * to a category is the number of products the import touches. The
 * legacy substring form must keep matching exactly what it always did.
 */
final class CategoryFilterTest extends TestCase
{
    // ─── parse ───────────────────────────────────────────────────────

    public function testParseReadsPathsWildcardsAndLegacyNeedles(): void
    {
        $f = CategoryFilter::parse(['Calzature > Sneakers', 'Borse > *', 'sneak']);

        $this->assertSame('path', $f[0]['type']);
        $this->assertSame('calzature', $f[0]['cat']);
        $this->assertSame('sneakers', $f[0]['sub']);
        $this->assertNull($f[1]['sub'], '"*" means the whole category');
        $this->assertSame('contains', $f[2]['type']);
        $this->assertSame('sneak', $f[2]['needle']);
    }

    public function testParseAcceptsTheLegacyCommaSeparatedString(): void
    {
        $f = CategoryFilter::parse('Borse, Calzature > Stivali');

        $this->assertCount(2, $f);
        $this->assertSame('contains', $f[0]['type']);
        $this->assertSame('path', $f[1]['type']);
    }

    public function testParseTreatsATrailingSeparatorAsTheWholeCategory(): void
    {
        $this->assertNull(CategoryFilter::parse(['Borse >'])[0]['sub']);
    }

    public function testParseDropsEmptiesDuplicatesAndPathsWithoutACategory(): void
    {
        $f = CategoryFilter::parse(['', '  ', '> Sneakers', 'Borse > *', 'BORSE  >  *', 'borse >', null, ['x']]);

        $this->assertCount(1, $f, 'one whole-category entry survives: the rest are empty, malformed or the same node');
        $this->assertSame([], CategoryFilter::parse(null));
        $this->assertSame([], CategoryFilter::parse([]));
        $this->assertSame([], CategoryFilter::parse(''));
    }

    // ─── matches: paths ──────────────────────────────────────────────

    public function testPathMatchesExactlyThatSubcategory(): void
    {
        $f = CategoryFilter::parse(['Calzature > Sneakers']);

        $this->assertTrue(CategoryFilter::matches('Calzature', 'Sneakers', $f));
        $this->assertFalse(CategoryFilter::matches('Calzature', 'Stivali', $f));
        $this->assertFalse(CategoryFilter::matches('Calzature', 'Sneakers alte', $f), 'a path is not a substring');
        $this->assertFalse(CategoryFilter::matches('Outlet', 'Sneakers', $f), 'same subcategory name, other category');
    }

    public function testWholeCategoryMatchesEverySubcategoryIncludingNone(): void
    {
        $f = CategoryFilter::parse(['Calzature > *']);

        $this->assertTrue(CategoryFilter::matches('Calzature', 'Sneakers', $f));
        $this->assertTrue(CategoryFilter::matches('Calzature', '', $f));
        $this->assertFalse(CategoryFilter::matches('Accessori', 'Lacci per calzature', $f));
    }

    public function testPathDoesNotLeakIntoNamesThatMerelyContainIt(): void
    {
        // The exact failure the legacy substring form has, and the reason
        // the picker writes paths: "Borse" would also take the travel bags
        // filed under Accessori, and "Top" every laptop sleeve.
        $f = CategoryFilter::parse(['Borse > *', 'Abbigliamento > Top']);

        $this->assertFalse(CategoryFilter::matches('Accessori', 'Borse da viaggio', $f));
        $this->assertFalse(CategoryFilter::matches('Accessori', 'Laptop', $f));
        $this->assertTrue(CategoryFilter::matches('Abbigliamento', 'Top', $f));
    }

    public function testMatchingIgnoresCaseAndWhitespace(): void
    {
        $f = CategoryFilter::parse(['  calzature >   SNEAKERS ']);

        $this->assertTrue(CategoryFilter::matches('CALZATURE', 'Sneakers', $f));
        $this->assertTrue(CategoryFilter::matches(' Calzature ', "Sneakers\t", $f));
    }

    public function testMatchingIsUnicodeAware(): void
    {
        $this->assertTrue(CategoryFilter::matches('ÉLITE', 'Più venduti', CategoryFilter::parse(['élite > più VENDUTI'])));
    }

    public function testAnItemWithoutACategoryNeverMatchesAPath(): void
    {
        $this->assertFalse(CategoryFilter::matches('', 'Sneakers', CategoryFilter::parse(['Calzature > *'])));
    }

    // ─── matches: legacy ─────────────────────────────────────────────

    public function testLegacyNeedleKeepsItsSubstringSemanticsOnBothLevels(): void
    {
        // Unchanged from CsvSource::applySfCategoryFilter before paths
        // existed: a job written by hand against it imports the same set.
        $f = CategoryFilter::parse(['sneak']);

        $this->assertTrue(CategoryFilter::matches('Sneakers', '', $f));
        $this->assertTrue(CategoryFilter::matches('Calzature', 'Sneakers', $f));
        $this->assertFalse(CategoryFilter::matches('Calzature', 'Stivali', $f));
    }

    public function testEmptyFilterKeepsEverything(): void
    {
        $this->assertTrue(CategoryFilter::matches('Anything', 'At all', []));
    }

    // ─── tree ────────────────────────────────────────────────────────

    public function testTreeCountsProductsPerCategoryAndSubcategory(): void
    {
        $t = CategoryFilter::tree([
            ['cat' => 'Calzature', 'sub' => 'Sneakers', 'in_shop' => true],
            ['cat' => 'Calzature', 'sub' => 'Sneakers'],
            ['cat' => 'Calzature', 'sub' => 'Stivali'],
            ['cat' => 'Borse',     'sub' => 'Zaini',    'in_shop' => true],
            ['cat' => 'Calzature', 'sub' => ''],
        ]);

        $this->assertSame(5, $t['total']);
        $this->assertSame(2, $t['in_shop']);
        $this->assertSame(0, $t['uncategorized']);
        $this->assertSame(['Borse', 'Calzature'], array_column($t['categories'], 'name'), 'alphabetical');

        $calz = $t['categories'][1];
        $this->assertSame(4, $calz['count'], 'the product without subcategory still counts toward its category');
        $this->assertSame(1, $calz['in_shop']);
        $this->assertSame('Calzature > *', $calz['value']);
        $this->assertSame(['Sneakers', 'Stivali'], array_column($calz['subs'], 'name'));
        $this->assertSame([2, 1], array_column($calz['subs'], 'count'));
        $this->assertSame('Calzature > Sneakers', $calz['subs'][0]['value']);
    }

    public function testTreeMergesSpellingsOfTheSameNodeKeepingTheFirst(): void
    {
        $t = CategoryFilter::tree([
            ['cat' => 'Calzature', 'sub' => 'Sneakers'],
            ['cat' => 'CALZATURE', 'sub' => 'SNEAKERS'],
        ]);

        $this->assertCount(1, $t['categories']);
        $this->assertSame('Calzature', $t['categories'][0]['name']);
        $this->assertSame(2, $t['categories'][0]['subs'][0]['count']);
    }

    public function testTreeCountsUncategorizedApart(): void
    {
        $t = CategoryFilter::tree([['cat' => '', 'sub' => 'Orfano'], ['cat' => 'Borse', 'sub' => '']]);

        $this->assertSame(1, $t['uncategorized']);
        $this->assertSame(['Borse'], array_column($t['categories'], 'name'));
    }

    public function testEveryTreeValueSelectsExactlyTheProductsItCounts(): void
    {
        // The picker's promise, end to end: feed the value of each node
        // back through matches() and count — it must equal the node count.
        $rows = [
            ['cat' => 'Calzature', 'sub' => 'Sneakers'],
            ['cat' => 'Calzature', 'sub' => 'Sneakers alte'],
            ['cat' => 'Calzature', 'sub' => ''],
            ['cat' => 'Accessori', 'sub' => 'Calzature e lacci'],
            ['cat' => 'Borse',     'sub' => 'Zaini'],
        ];
        $t = CategoryFilter::tree($rows);

        $count = static function (string $value) use ($rows): int {
            $f = CategoryFilter::parse([$value]);
            return count(array_filter($rows, static fn(array $r): bool => CategoryFilter::matches($r['cat'], $r['sub'], $f)));
        };
        foreach ($t['categories'] as $cat) {
            $this->assertSame($cat['count'], $count($cat['value']), $cat['value']);
            foreach ($cat['subs'] as $sub) {
                $this->assertSame($sub['count'], $count($sub['value']), $sub['value']);
            }
        }
    }

    // ─── path / describe ─────────────────────────────────────────────

    public function testPathBuildsTheEntriesThePickerWrites(): void
    {
        $this->assertSame('Calzature > *', CategoryFilter::path('Calzature'));
        $this->assertSame('Calzature > *', CategoryFilter::path(' Calzature ', ''));
        $this->assertSame('Calzature > Sneakers', CategoryFilter::path('Calzature', 'Sneakers'));
    }

    public function testDescribeReadsLikeASentence(): void
    {
        $this->assertSame(
            'Calzature, Borse › Zaini, «sneak»',
            CategoryFilter::describe(['Calzature > *', 'Borse > Zaini', 'sneak'])
        );
        $this->assertSame('', CategoryFilter::describe(null));
    }
}
