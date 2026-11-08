package tablescrub.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The common intermediate representation every input format is converted into.
 * A rectangular grid of nullable strings plus profiled column metadata. Values are kept
 * as normalised strings (ISO-8601 dates, '.' decimal separator) so that every reader
 * produces identical output for the same logical data.
 */
public final class Table {
    private final String name;
    private final String sourceFormat;
    private final List<Column> columns;
    private final List<String[]> rows;
    private final List<String> warnings;

    public Table(String name, String sourceFormat, List<Column> columns, List<String[]> rows, List<String> warnings) {
        this.name = name;
        this.sourceFormat = sourceFormat;
        this.columns = List.copyOf(columns);
        this.rows = Collections.unmodifiableList(new ArrayList<>(rows));
        this.warnings = List.copyOf(warnings);
    }

    public String name() { return name; }
    public String sourceFormat() { return sourceFormat; }
    public List<Column> columns() { return columns; }
    public List<String[]> rows() { return rows; }
    public List<String> warnings() { return warnings; }
    public int rowCount() { return rows.size(); }
    public int columnCount() { return columns.size(); }

    public List<String> headers() {
        return columns.stream().map(Column::name).toList();
    }
}
