package tablescrub;

import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import tablescrub.io.UnsupportedFormatException;
import tablescrub.model.ColumnType;
import tablescrub.model.Table;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static tablescrub.TestUtil.cell;

class ReadersTest {

    @Test
    void csvSemicolonWithDecimalCommaAndBom() throws Exception {
        byte[] bom = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};
        byte[] body = "id;weight;note\n1;68,5;\"a;b\"\n2;70,25;x\n".getBytes(StandardCharsets.UTF_8);
        byte[] data = new byte[bom.length + body.length];
        System.arraycopy(bom, 0, data, 0, 3);
        System.arraycopy(body, 0, data, 3, body.length);
        Table t = TestUtil.load("w.csv", data).getFirst();
        assertEquals(List.of("id", "weight", "note"), t.headers());
        assertEquals("68.5", cell(t, 0, "weight"));
        assertEquals(ColumnType.DECIMAL, t.columns().get(1).type());
        assertEquals("a;b", cell(t, 0, "note"));
        assertEquals("csv (semicolon)", t.sourceFormat());
    }

    @Test
    void commaCsvKeepsCommaValuesAsText() throws Exception {
        Table t = TestUtil.loadOne("a.csv", "a,b\n\"1,5\",2\n");
        assertEquals("1,5", cell(t, 0, "a"));
        assertEquals(ColumnType.STRING, t.columns().getFirst().type());
    }

    @Test
    void tsvAndWindows1252Fallback() throws Exception {
        byte[] data = "navn\tby\nSøren\tKøge\n".getBytes(Charset.forName("windows-1252"));
        Table t = TestUtil.load("x.tsv", data).getFirst();
        assertEquals("Søren", cell(t, 0, "navn"));
        assertTrue(t.warnings().stream().anyMatch(w -> w.contains("Windows-1252")));
        assertEquals("tsv", t.sourceFormat());
    }

    @Test
    void excelAllSheetsWithTypedCells() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (XSSFWorkbook wb = new XSSFWorkbook()) {
            CellStyle ds = wb.createCellStyle();
            ds.setDataFormat(wb.getCreationHelper().createDataFormat().getFormat("dd/mm/yyyy"));
            Sheet s = wb.createSheet("visits");
            wb.createSheet("empty");
            Sheet s2 = wb.createSheet("labs");
            Row h = s.createRow(2); // header not on first row
            h.createCell(0).setCellValue("name");
            h.createCell(1).setCellValue("visit");
            h.createCell(2).setCellValue("score");
            h.createCell(3).setCellValue("double");
            Row r = s.createRow(3);
            r.createCell(0).setCellValue("Anna");
            r.createCell(1).setCellValue(LocalDate.of(2024, 3, 9));
            r.getCell(1).setCellStyle(ds);
            r.createCell(2).setCellValue(12);
            r.createCell(3).setCellFormula("C4*2.5");
            Row r2 = s.createRow(4);
            r2.createCell(0).setCellValue("Bo");
            r2.createCell(1).setCellValue(LocalDateTime.of(2024, 3, 10, 14, 30));
            r2.getCell(1).setCellStyle(ds);
            r2.createCell(2).setCellValue(7.25);
            s2.createRow(0).createCell(0).setCellValue("x");
            s2.createRow(1).createCell(0).setCellValue(true);
            wb.getCreationHelper().createFormulaEvaluator().evaluateAll();
            wb.write(out);
        }
        List<Table> tables = TestUtil.load("book.xlsx", out.toByteArray());
        assertEquals(2, tables.size(), "empty sheet skipped");
        Table t = tables.getFirst();
        assertEquals("book / visits", t.name());
        assertEquals("2024-03-09", cell(t, 0, "visit"));
        assertEquals("2024-03-10T14:30", cell(t, 1, "visit"));
        assertEquals(ColumnType.DATETIME, t.columns().get(1).type());
        assertEquals("12", cell(t, 0, "score"));
        assertEquals("7.25", cell(t, 1, "score"));
        assertEquals("30", cell(t, 0, "double"));
        assertEquals(ColumnType.BOOLEAN, tables.get(1).columns().getFirst().type());
    }

    @Test
    void jsonNestedAndWrapped() throws Exception {
        Table t = TestUtil.loadOne("d.json", """
                {"meta": {"v": 1}, "data": [
                  {"id": 1, "person": {"age": 40, "sex": "F"}, "tags": ["a","b"], "score": 1.50},
                  {"id": 2, "person": {"age": 51}, "extra": null}
                ]}""");
        assertEquals(List.of("id", "person.age", "person.sex", "tags", "score", "extra"), t.headers());
        assertEquals("[\"a\",\"b\"]", cell(t, 0, "tags"));
        assertEquals("1.5", cell(t, 0, "score"));
        assertNull(cell(t, 1, "person.sex"));
        assertEquals(ColumnType.INTEGER, t.columns().get(1).type());
    }

    @Test
    void jsonArrayOfArraysAndJsonLines() throws Exception {
        Table a = TestUtil.loadOne("a.json", "[[\"x\",\"y\"],[1,\"q\"],[2,null]]");
        assertEquals(List.of("x", "y"), a.headers());
        assertEquals(2, a.rowCount());
        Table l = TestUtil.loadOne("l.jsonl", "{\"a\":1}\n\n{\"a\":2,\"b\":true}\n");
        assertEquals(List.of("a", "b"), l.headers());
        assertEquals("true", cell(l, 1, "b"));
    }

    @Test
    void sniffsUnknownExtension() throws Exception {
        assertEquals("jsonl", TestUtil.loadOne("export.dat", "{\"a\":1}\n{\"a\":2}\n").sourceFormat());
        assertEquals("csv", TestUtil.loadOne("export", "a,b\n1,2\n").sourceFormat());
        assertThrows(UnsupportedFormatException.class, () -> TestUtil.load("x.bin", new byte[]{0, 1, 2, 0, 5}));
    }
}
