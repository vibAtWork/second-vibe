package tablescrub;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import tablescrub.export.Format;
import tablescrub.model.Column;
import tablescrub.model.Table;
import tablescrub.redact.ColumnRule;
import tablescrub.redact.Plan;
import tablescrub.redact.RedactedTable;
import tablescrub.redact.Redactor;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

/** Every re-creatable format, read back, must give the same intermediate representation. */
class RoundTripTest {
    static final String CSV = """
            id,name,when,at,n,x,ok,note
            1,Åse,2024-01-02,2024-01-02T03:04:05,10,1.25,true,"comma, quote "" and
            newline"
            2,Bo,2023-12-31,2023-12-31T23:59:59,-3,0.5,false,
            3,,2020-02-29,2020-02-29T12:00,0,100,true,plain
            """;

    static Table source() throws Exception { return TestUtil.loadOne("src.csv", CSV); }

    static RedactedTable keepAll(Table t) {
        List<ColumnRule> rules = new ArrayList<>();
        for (int i = 0; i < t.columnCount(); i++) rules.add(ColumnRule.KEEP);
        return Redactor.apply(t, new Plan(rules, new byte[]{1}, 5, false, "Round trip", "desc", "CC0-1.0"));
    }

    static byte[] write(Format f, RedactedTable rt) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        f.write(rt, out);
        return out.toByteArray();
    }

    static void assertSameTable(Table a, Table b, String fmt) {
        assertEquals(a.headers(), b.headers(), fmt + " headers");
        assertEquals(a.rowCount(), b.rowCount(), fmt + " rows");
        for (int r = 0; r < a.rowCount(); r++) {
            String[] x = a.rows().get(r), y = b.rows().get(r);
            assertEquals(x.length, y.length);
            for (int c = 0; c < x.length; c++) {
                if (a.columns().get(c).type().numeric() && x[c] != null && y[c] != null) {
                    // Typed formats (xlsx, json) store numbers, not text: 26.0 comes back as 26.
                    assertEquals(0, new java.math.BigDecimal(x[c]).compareTo(new java.math.BigDecimal(y[c])),
                            fmt + " row " + r + " col " + c + ": " + x[c] + " vs " + y[c]);
                } else {
                    assertEquals(x[c], y[c], fmt + " row " + r + " col " + c);
                }
            }
        }
        for (int c = 0; c < a.columnCount(); c++)
            assertEquals(a.columns().get(c).type(), b.columns().get(c).type(), fmt + " type of " + a.headers().get(c));
    }

    @Test
    void csvTsvXlsxJsonJsonlRoundTrip() throws Exception {
        Table src = source();
        RedactedTable rt = keepAll(src);
        for (Format f : List.of(Format.CSV, Format.TSV, Format.XLSX, Format.JSONL)) {
            Table back = TestUtil.load("back." + f.extension, write(f, rt)).getFirst();
            assertSameTable(src, back, f.id);
        }
        // JSON wraps rows with schema/provenance; the reader finds the "rows" array.
        Table json = TestUtil.load("back.json", write(Format.JSON, rt)).getFirst();
        assertSameTable(src, json, "json");
    }

    @Test
    void jsonIsTyped() throws Exception {
        JsonNode n = new ObjectMapper().readTree(write(Format.JSON, keepAll(source())));
        JsonNode row = n.get("rows").get(0);
        assertTrue(row.get("n").isIntegralNumber());
        assertTrue(row.get("x").isNumber());
        assertTrue(row.get("ok").isBoolean());
        assertTrue(row.get("when").isTextual());
        assertTrue(n.get("rows").get(2).get("name").isNull());
        assertEquals("integer", n.get("schema").get("fields").get(0).get("type").asText());
    }

    @Test
    void dataPackageContainsMetadataCsvAndReadme() throws Exception {
        byte[] zip = write(Format.DATAPACKAGE, keepAll(source()));
        Map<String, byte[]> files = new HashMap<>();
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip))) {
            for (ZipEntry e; (e = z.getNextEntry()) != null; ) files.put(e.getName(), z.readAllBytes());
        }
        assertEquals(java.util.Set.of("datapackage.json", "data.csv", "README.md"), files.keySet());
        JsonNode dp = new ObjectMapper().readTree(files.get("datapackage.json"));
        assertEquals("tabular-data-package", dp.get("profile").asText());
        assertEquals("round-trip", dp.get("name").asText());
        assertEquals("CC0-1.0", dp.get("licenses").get(0).get("title").asText());
        JsonNode fields = dp.get("resources").get(0).get("schema").get("fields");
        assertEquals(8, fields.size());
        assertEquals("datetime", fields.get(3).get("type").asText());
        assertSameTable(source(), TestUtil.load("data.csv", files.get("data.csv")).getFirst(), "datapackage");
        assertTrue(new String(files.get("README.md"), StandardCharsets.UTF_8).contains("## Data dictionary"));
    }

    @Test
    void markdownSqlHtml() throws Exception {
        RedactedTable rt = keepAll(source());
        String md = new String(write(Format.MARKDOWN, rt), StandardCharsets.UTF_8);
        assertTrue(md.startsWith("# Round trip"));
        assertTrue(md.contains("```csv\nid,name,when"));
        String sql = new String(write(Format.SQL, rt), StandardCharsets.UTF_8);
        assertTrue(sql.contains("CREATE TABLE \"round_trip\""));
        assertTrue(sql.contains("\"at\" TIMESTAMP"));
        assertTrue(sql.contains("(1, 'Åse', DATE '2024-01-02', TIMESTAMP '2024-01-02 03:04:05', 10, 1.25, TRUE,"));
        assertTrue(sql.contains("NULL"));
        String html = new String(write(Format.HTML, rt), StandardCharsets.UTF_8);
        assertTrue(html.contains("<td>comma, quote &quot; and\nnewline</td>"));
    }

    @Test
    void sampleCohortSurvivesEveryReadableFormat() throws Exception {
        Table src = TestUtil.load("cohort.csv", Files.readAllBytes(Path.of("samples/cohort.csv"))).getFirst();
        RedactedTable rt = keepAll(src);
        for (Format f : List.of(Format.CSV, Format.TSV, Format.XLSX, Format.JSON, Format.JSONL))
            assertSameTable(src, TestUtil.load("b." + f.extension, write(f, rt)).getFirst(), f.id);
        for (Column c : src.columns()) assertNotNull(c.type());
    }
}
