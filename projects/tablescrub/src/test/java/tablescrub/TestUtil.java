package tablescrub;

import tablescrub.io.Profiler;
import tablescrub.io.ReadOptions;
import tablescrub.io.Readers;
import tablescrub.model.Table;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

public final class TestUtil {
    private TestUtil() {}

    public static List<Table> load(String filename, byte[] data) throws IOException {
        return Readers.read(filename, data, ReadOptions.DEFAULT).stream().map(Profiler::profile).toList();
    }

    public static Table loadOne(String filename, String text) throws IOException {
        return load(filename, text.getBytes(StandardCharsets.UTF_8)).getFirst();
    }

    public static String cell(Table t, int row, String col) {
        return t.rows().get(row)[t.headers().indexOf(col)];
    }
}
