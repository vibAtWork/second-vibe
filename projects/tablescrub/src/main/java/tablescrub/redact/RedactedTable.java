package tablescrub.redact;

import tablescrub.model.ColumnType;

import java.util.List;

/** Output of {@link Redactor}: the shareable table plus documentation of what was done. */
public record RedactedTable(
        String name,
        String sourceName,
        String sourceFormat,
        int sourceRows,
        List<OutColumn> columns,
        List<String[]> rows,
        List<String> log,
        KStats kStats,
        Plan plan) {

    /** A column of the redacted output. */
    public record OutColumn(String name, String originalName, ColumnType type, Action action, String param,
                            String description, String piiCategory, int nonNull, int distinct) {}

    /** k-anonymity summary over the quasi-identifier columns (after redaction). */
    public record KStats(List<String> quasiIdentifiers, int k, int classes, int classesBelow, int rowsBelow,
                         int threshold, int rowsSuppressed) {
        public boolean enabled() { return !quasiIdentifiers.isEmpty(); }
        public boolean ok() { return !enabled() || k >= threshold; }
    }

    public List<String> headers() {
        return columns.stream().map(OutColumn::name).toList();
    }
}
