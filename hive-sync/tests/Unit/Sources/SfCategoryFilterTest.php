<?php
declare(strict_types=1);

namespace HiveSync\Tests\Unit\Sources;

use HiveSync\Core\Source\Context;
use HiveSync\Core\Source\FetchRequest;
use HiveSync\Core\Source\FetchResult;
use HiveSync\Sources\CategoryFilter;
use HiveSync\Sources\CsvSource;
use PHPUnit\Framework\TestCase;

/**
 * The SF category filter through the real fetch path — CSV on disk,
 * PRODUCT + MODEL rows, the transform, then `options.category_filter`.
 *
 * What it guards: the tree the picker builds from categoryPath() and the
 * slice fetch() keeps are the same set. If they ever drift apart, the
 * count on the operator's screen stops being the count imported.
 */
final class SfCategoryFilterTest extends TestCase
{
    private string $file = '';

    protected function setUp(): void
    {
        $rows = [
            ['RECORD_TYPE', 'SKU', 'BRAND', 'Titel_ITA', 'STREET_PRICE', 'PRICE', 'QUANTITY', 'CAT', 'SUBCAT', 'MODEL_SIZE'],
            ['PRODUCT', 'SH-1', 'Nike',  'Sneaker uno',  '120', '50', '0', 'Calzature', 'Sneakers', ''],
            ['MODEL',   'SH-1', '',      '',             '',    '50', '2', '',          '',         '42'],
            ['PRODUCT', 'SH-2', 'Nike',  'Sneaker due',  '120', '50', '3', 'Calzature', 'Sneakers', ''],
            ['PRODUCT', 'ST-1', 'Geox',  'Stivale',      '200', '80', '1', 'Calzature', 'Stivali',  ''],
            ['PRODUCT', 'BG-1', 'Guess', 'Zaino',        '90',  '30', '4', 'Borse',     'Zaini',    ''],
            ['PRODUCT', 'TR-1', 'Guess', 'Trolley',      '150', '60', '2', 'Accessori', 'Borse da viaggio', ''],
            ['PRODUCT', 'NC-1', 'Anon',  'Senza cat',    '10',  '5',  '1', '',          '',         ''],
        ];
        $this->file = (string) tempnam(sys_get_temp_dir(), 'hsync-sf-');
        file_put_contents($this->file, implode("\n", array_map(static fn(array $r): string => implode(';', $r), $rows)) . "\n");
    }

    protected function tearDown(): void
    {
        if ($this->file !== '' && is_file($this->file)) unlink($this->file);
    }

    private function fetch(array $options = []): FetchResult
    {
        $config = [
            'source_type'     => 'file',
            'file_path'       => $this->file,
            'delimiter'       => ';',
            'enclosure'       => '"',
            'has_header'      => true,
            'flavor'          => 'stockfirmati',
            'sf_markup_value' => '2',
        ];
        return (new CsvSource())->fetch(new FetchRequest($config, $options), new Context(runId: 'test'));
    }

    /** @return string[] */
    private static function skus(FetchResult $r): array
    {
        $skus = array_map(static fn($i): string => $i->sku, $r->items);
        sort($skus);
        return $skus;
    }

    public function testNoFilterKeepsTheWholeFeed(): void
    {
        $r = $this->fetch();

        $this->assertSame(['BG-1', 'NC-1', 'SH-1', 'SH-2', 'ST-1', 'TR-1'], self::skus($r));
        $this->assertArrayNotHasKey('category_filter_kept', $r->stats);
    }

    public function testWholeCategoryKeepsExactlyThatCategory(): void
    {
        $r = $this->fetch(['category_filter' => ['Calzature > *']]);

        $this->assertSame(['SH-1', 'SH-2', 'ST-1'], self::skus($r));
        $this->assertSame(3, $r->stats['category_filter_kept']);
        $this->assertSame(6, $r->stats['category_filter_of']);
        $this->assertSame([], $r->warnings);
    }

    public function testSubcategoryPathKeepsOnlyThatSubcategory(): void
    {
        $r = $this->fetch(['category_filter' => ['Calzature > Sneakers']]);

        $this->assertSame(['SH-1', 'SH-2'], self::skus($r));
    }

    public function testPathsDoNotPickUpLookalikeNamesElsewhereInTheTree(): void
    {
        // "Borse" the category, not "Accessori › Borse da viaggio".
        $r = $this->fetch(['category_filter' => ['Borse > *']]);

        $this->assertSame(['BG-1'], self::skus($r));
    }

    public function testLegacySubstringFilterStillMatchesBothLevels(): void
    {
        // The pre-picker behaviour, kept for jobs written by hand: the
        // substring hits the Borse category AND the travel-bags subcategory.
        $r = $this->fetch(['category_filter' => 'borse']);

        $this->assertSame(['BG-1', 'TR-1'], self::skus($r));
    }

    public function testAFilterThatMatchesNothingSaysWhy(): void
    {
        $r = $this->fetch(['category_filter' => ['Profumi > *']]);

        $this->assertSame([], $r->items);
        $this->assertCount(1, $r->warnings);
        $this->assertStringContainsString('Nessuno dei 6 prodotti', $r->warnings[0]);
        $this->assertStringContainsString('Profumi', $r->warnings[0]);
    }

    public function testThePickerTreeAndTheFilterAgreeOnEveryNode(): void
    {
        $src  = new CsvSource();
        $rows = [];
        foreach ($this->fetch()->items as $item) {
            $path = $src->categoryPath($item);
            $this->assertNotNull($path, 'every SF item has a category path, even an empty one');
            $rows[] = ['cat' => $path[0], 'sub' => $path[1]];
        }
        $tree = CategoryFilter::tree($rows);

        $this->assertSame(1, $tree['uncategorized']);
        foreach ($tree['categories'] as $cat) {
            $this->assertCount($cat['count'], $this->fetch(['category_filter' => [$cat['value']]])->items, $cat['value']);
            foreach ($cat['subs'] as $sub) {
                $this->assertCount($sub['count'], $this->fetch(['category_filter' => [$sub['value']]])->items, $sub['value']);
            }
        }
    }

    public function testOnlyTheStockFirmatiFlavorOffersCategories(): void
    {
        $src = new CsvSource();

        $this->assertTrue($src->hasCategories(['flavor' => 'stockfirmati']));
        $this->assertFalse($src->hasCategories(['flavor' => 'generic']));
        $this->assertFalse($src->hasCategories([]));
    }
}
