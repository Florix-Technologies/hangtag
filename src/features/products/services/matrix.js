// Matrix view of a product's variants (sell picker, stock grid, stock in / adjust): rows are the combinations of every
// option but the last (e.g. colours), columns the last option's values (e.g. sizes).
import { colVals, findVariant, matrixNames, rowIsColour, rowVals } from '../../../domain/catalog/options.js';
import { swatchOf } from '../../../shared/utils/colors.js';

/* { colors: row values, sizes: column values, find(row, col) → variant, names: {row, col}, sw(row) → swatch HTML or "" } */
export function matrixOf(p){
  const colors=rowVals(p), sizes=colVals(p), find=(c,s)=>findVariant(p,c,s), names=matrixNames(p), swatches=rowIsColour(p);
  const sw=c=>swatches?`<i style="background:${swatchOf(String(c).split(" / ")[0])}"></i>`:"";
  return {colors,sizes,find,names,sw};
}
