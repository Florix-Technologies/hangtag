# Plan: updating products from a file, stock, and units

Written 2026-10-12 from the fifth audit session (`AUDIT.md`, items 50–62). The audit read the product import and export,
supplier bills, stock records, serials, batches and units, and checked its findings in the code. Only one part is built:
the database now keeps quantities in the shop's own units to their decimals (item 50, in section 3z). Everything below is
still to do, one increment at a time.

## Rules for every increment
- **One increment per commit**, with its tests. The full suite (`npm test`, which includes the PostgreSQL 17 run) is green before the next one starts.
- **Database changes go in new sections** after 3z (3za, 3zb, …), each with its exact migration file:
  - a function is re-created as an exact copy of its latest body plus the change;
  - running `schema.sql` again stays safe;
  - no new value is added to a CHECK that `schema.sql` re-adds on every run (`hangtag_stock_imports.kind`, for one).
- **Stock, cost and unit never change as a side effect.** Every stock change is an explicit record that was previewed, and the server checks it.
- **Old app versions keep working.** New columns are nullable, RPC arguments stay the same or become optional, and the integer cost columns stay.
- **Before the first database increment,** the report-row count becomes one shared constant (it is asserted 27 times in 17 suites).

## The increments
S, M, L: small, medium, large. "Needs": increments that must land first.

| # | Size | What | Needs | Database |
|---|------|------|-------|----------|
| I1 | S | A product's unit is pinned once it has stock records, bills, orders or purchase orders. The stock box, Stock in and Adjust refuse a quantity with too many decimals instead of rounding it | — | none |
| I2 | M | Stock-write guards:<br>- a new serial can't take one another device has just added;<br>- a bill import locks on its file and invoice before the duplicate check;<br>- products made from a bill keep their field values.<br>The shop-unit decimals originally in this increment are done (3z, item 50) | — | 3za: two functions re-created |
| I3 | S | Products and variants keep a trustworthy `updated_at`: a trigger sets it, and leaves it alone on an identical resend. The database refuses a unit change once a product has history | I1 | 3zb: two triggers |
| I4 | M | The database refuses stock records of the wrong shape for tracked products on every path: serials for serial tracking, batch and expiry for batch tracking. Older records and exact resends pass | — | a nullable `tracked_since` column, a trigger, a backfill |
| I5 | S | The product export carries "Hangtag ID" and "Hangtag version" columns. Stock is left out of the version, so a sale doesn't make a file stale | — | none |
| I6 | M | Match file rows to products: by Hangtag ID, then SKU, then barcode, then name with option values. An ambiguous match is an error, never a guess, and a rename is matched only by ID | I5 | none |
| I7 | M | The update plan:<br>- only cells that differ change;<br>- an empty cell keeps its value and "(clear)" clears it;<br>- variants are never removed, and stock and unit never change | I6, I1 | none |
| I8 | S | Stale checks:<br>- a row changed elsewhere since the export becomes a decision, kept by default;<br>- a catalog change between the preview and Confirm refuses | I5, I7 | none |
| I9 | S | Appending option values uploads only the new variants | — | none |
| I10 | M | Checked upload:<br>- a queued product edit compares the cloud with its expected old values before writing;<br>- a conflict goes to sync review;<br>- a product deleted elsewhere stays deleted | I3 | none |
| I11 | L | "Update your products" from a file:<br>- the preview shows old → new, with decisions;<br>- one local save;<br>- uploads only through I10 | I7, I8, I9, I10 | none |
| I12 | S | Opening stock from a file carries its cost. History labels and "Received today" go by the kind of stock record | — | none |
| I13 | M | Tracking columns in the product file (Track stock by, Batch, Expiry date, Serial numbers), checked across the whole file | — | none |
| I14 | L | A server-checked, repeat-safe function for stock from product files:<br>- opening lines are insert-only;<br>- "set to" lines carry the quantity expected now, and are refused when stock has moved since | I2 | one function |
| I15 | M | New products with opening stock, serials and batches, through I14. Online only: names aren't unique, and two offline phones would double the stock | I4, I12, I13, I14 | none beyond I14 |
| I16 | M | Existing tracked products get new batches and serials from a file. Nothing is written off without an explicit choice and a reason | I6, I15 | none |
| I17 | M | "Set stock to" for products the shop already has. The preview shows system, file and difference, and the server checks the expected quantity | I6, I14 | none |
| I18 | S | An export that round-trips tracked stock: one row per batch, the serials in stock, the real on-hand quantity | I16, I17 | none |
| I19 | S | Supplier bills keep the printed unit. A line in another unit ("5 box") needs its base quantity before it can be saved | — | none |
| I20 | S | Repacking never creates stock. An output off the target unit's grid is refused, and the nearest valid quantity suggested | — | none |
| I21 | S | Bill and return lines carry the unit sold | — | two functions re-created |
| I22 | M | Quantity and money tidiness:<br>- purchase line money rounded as sales are;<br>- low-stock levels keep their decimals;<br>- a shop unit's GST code is locked once lines use it | — | `low_stock` to `NUMERIC(12,3)`; unit guard extended |
| I23 | L | Exact cost per base unit (4 decimals), next to the integer cost columns, which stay | I3 | additive columns, a trigger for old apps, functions |
| I24 | M | Same-dimension conversions (kg = 1000 g, l = 1000 ml, m = 100 cm, dozen = 12 pcs). Each is made once, at entry, with the factor kept on the line | I3, I19, I23 | functions check the factor when present |
| I25 | L | Pack definitions per product (box of 12, carton of 24): a pack's factor never changes, and all codes sit in one registry | I3, I24 | `packs` column, `hangtag_codes` table |
| I26 | L | Buying in packs. Purchase, Stock in, purchase-order and bill lines can be in packs; the base quantity is packs × factor, computed once | I23, I24, I25 | a pack snapshot on stock records |
| I27 | S | Optional: big catalogs, with filtered and split exports | I5, I11 | none |
| I28 | L | Optional: selling packs | I21, I25 | pack on bill, return and order lines |
| I29 | S | Optional: packs in product import and export, and in reorder suggestions | I11, I25 | none |
| I30 | M | Optional: an atomic per-product update function, and price checks | I10 | one function, two checks |

## The order to build them
1. **Stop today's corruption** (small, no database change): I1, I19, I20.
2. **Database guards:** I2 (3za) and I3 (3zb). They can share a section if they are released together.
3. **Updating products from a file:** I5, I6, I7, I9, I10, I8, I11.
4. **Stock from files:** I12, I13, I4, I14, I15, I17, I16, I18.
5. **Units and costing:** I21, I22, I23, I24, I25, I26.
6. **Optional,** each when its prerequisites are in: I27–I30.

Every increment with a database change needs 3u–3z on the live database first (`AUDIT.md`, release order).

## The highest risks, and where the plan meets them
| Risk | Where it's handled |
|------|--------------------|
| Compare-and-set on a timestamp nothing maintains (the audit's first design assumed one; its verifier refuted it) | I3 adds the trigger before I10 relies on it |
| Upserts rewriting saved stock records, which the serial and batch registers don't follow | New stock paths insert only (I14). The outbox path keeps its upsert for old apps |
| Two devices at once (the same new serial, the same bill) | Locks and status checks (I2); expected quantities (I14, I17) |
| A product's unit drifting under its history | I1 and I3 pin it before any conversion work (I23–I26) |
| Stale counts across devices | "Set to" carries the expected quantity, and the server refuses when stock has moved (I17) |
| `schema.sql` re-adding a CHECK on every run | No new kinds: product-file imports use the existing kind `import` (I14) |
| The wrong product matched by name | No guessing: an ambiguous match is an error, and a rename is matched only by ID (I6) |
| Old app versions | Nullable columns, integer cost columns kept (I23), the factor optional on lines (I24) |

## Unit conversions (box to piece, kilogram to gram)
- **One base unit per product, pinned** (I1, I3). Stock, cost and every line quantity are in it.
- **Converted once, at entry.** The factor goes on the line, so a re-upload, a purchase-order receipt or a return never converts again.
- **Never rounded.** A quantity off the base unit's grid is refused, and the nearest valid one suggested. For example, 0.5 g into a kg product with 3 decimals, or 13 pcs into dozens.
- **Same dimension: a fixed table** (I24): kg = 1000 g, l = 1000 ml, m = 100 cm (cm for entry only), dozen = 12 pcs. The arithmetic is done in integers.
- **Box to piece: per-product packs** (I25, I26). A box of 12 is a pack with factor 12. A new size is a new pack, so history stays meaningful.
- **Cost:** money entered is kept as entered. Cost per base unit is rate ÷ factor, to 4 decimals (I23), so ₹100 for a box of 12 gives 8.3333 a piece, not 8.
- **Not planned:** conversions between dimensions (kg to l needs a density), re-reading stored quantities in another unit, or changing a unit after history. For that last one, make a new product and repack.

## Next: I1 in detail
- **Scope:**
  - `saveProduct` refuses a unit change while any variant has history, inactive variants included. This sits next to the tracking guard (`save-product.js:54`).
  - Open purchase orders and orders naming the product also lock its unit.
  - The editor disables "Sold by" and says why.
  - The stock box, Stock in and Adjust refuse a quantity with more decimals than the unit allows; today they call `roundQty`.
  - A product with no history can still change unit.
- **Safety:**
  - A refused change writes nothing. Today, switching 12.5 kg to pcs writes an ADJUST of +0.5 (`save-product.js:60-62`).
  - Existing quantities are never re-read in another unit.
  - The message points to "make a new product and repack".
- **Tests:**
  - A kg product holding 12.5: the unit change is refused, with no stock record and nothing queued.
  - A product without history can change unit.
  - "12.5" typed for a pcs product is refused, not saved as 13.
  - Stock in of 2.5 pcs is refused.
  - The save-product, product-editor and units-weighing suites stay green.
