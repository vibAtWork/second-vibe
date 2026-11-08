package tablescrub.model;

import java.util.List;

/**
 * Column metadata of the intermediate representation: original header, inferred type
 * and profiling statistics computed when the table was loaded.
 */
public record Column(
        int index,
        String name,
        ColumnType type,
        int nonNull,
        int distinct,
        boolean distinctCapped,
        List<String> samples,
        String min,
        String max,
        PiiHint pii) {

    public double fillRatio(int rowCount) {
        return rowCount == 0 ? 0 : (double) nonNull / rowCount;
    }

    /** True when every non-null value is unique, i.e. the column is a likely identifier. */
    public boolean unique() {
        return nonNull > 1 && !distinctCapped && distinct == nonNull;
    }
}
