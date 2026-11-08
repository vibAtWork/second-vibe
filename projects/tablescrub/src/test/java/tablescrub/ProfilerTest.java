package tablescrub;

import org.junit.jupiter.api.Test;
import tablescrub.model.ColumnType;
import tablescrub.model.Table;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ProfilerTest {
    @Test
    void infersTypesAndKeepsCodesAsText() throws Exception {
        Table t = TestUtil.loadOne("t.csv", """
                int,dec,code,date,dt,bool,mixed,empty
                1,1.5,0042,2024-01-31,2024-01-31T10:00:00,yes,1,
                -20,2,0100,2023-12-01,2024-02-01 08:30,no,abc,NA
                """);
        List<ColumnType> types = t.columns().stream().map(c -> c.type()).toList();
        assertEquals(List.of(ColumnType.INTEGER, ColumnType.DECIMAL, ColumnType.STRING, ColumnType.DATE,
                ColumnType.DATETIME, ColumnType.BOOLEAN, ColumnType.STRING, ColumnType.EMPTY), types);
        assertEquals("-20", t.columns().getFirst().min());
        assertEquals("1", t.columns().getFirst().max());
    }

    @Test
    void cleansHeadersAndSquaresRows() throws Exception {
        Table t = TestUtil.loadOne("t.csv", "a,,A\n1,2,3,4\n5\n");
        assertEquals(List.of("a", "column_2", "A_2", "column_4"), t.headers());
        assertEquals(4, t.rows().get(1).length);
        assertNull(t.rows().get(1)[1]);
        assertTrue(t.warnings().stream().anyMatch(w -> w.contains("padded")));
        assertTrue(t.warnings().stream().anyMatch(w -> w.contains("renamed")));
    }
}
