package tablescrub.model;

import java.util.ArrayList;
import java.util.List;

/** What a reader produces before profiling: headers plus raw string cells. */
public record RawTable(String name, String sourceFormat, List<String> headers, List<String[]> rows, List<String> warnings) {
    public RawTable(String name, String sourceFormat, List<String> headers, List<String[]> rows) {
        this(name, sourceFormat, headers, rows, new ArrayList<>());
    }
}
