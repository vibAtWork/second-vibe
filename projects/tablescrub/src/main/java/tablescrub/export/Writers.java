package tablescrub.export;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.csv.CSVFormat;
import org.apache.commons.csv.CSVPrinter;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.streaming.SXSSFSheet;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import tablescrub.model.ColumnType;
import tablescrub.redact.RedactedTable;
import tablescrub.redact.RedactedTable.OutColumn;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Serialisers for every {@link Format}. */
final class Writers {
    static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(SerializationFeature.INDENT_OUTPUT)
            .disable(JsonGenerator.Feature.AUTO_CLOSE_TARGET);
    private static final JsonNodeFactory NF = JsonNodeFactory.instance;

    private Writers() {}

    // ---------- delimited ----------

    static void csv(RedactedTable t, OutputStream out) throws IOException {
        delimited(t, out, CSVFormat.RFC4180.builder().setRecordSeparator("\r\n").get());
    }

    static void tsv(RedactedTable t, OutputStream out) throws IOException {
        delimited(t, out, CSVFormat.TDF.builder().setRecordSeparator("\n").get());
    }

    private static void delimited(RedactedTable t, OutputStream out, CSVFormat format) throws IOException {
        Writer w = new OutputStreamWriter(out, StandardCharsets.UTF_8);
        CSVPrinter p = new CSVPrinter(w, format);
        p.printRecord(t.headers());
        for (String[] r : t.rows()) p.printRecord((Object[]) r);
        p.flush();
    }

    // ---------- JSON ----------

    static void json(RedactedTable t, OutputStream out) throws IOException {
        ObjectNode root = NF.objectNode();
        root.put("name", t.name());
        root.set("provenance", Documentation.provenance(t));
        root.set("schema", Documentation.tableSchema(t));
        ArrayNode rows = root.putArray("rows");
        for (String[] r : t.rows()) rows.add(record(t.columns(), r));
        MAPPER.writeValue(out, root);
    }

    static void jsonl(RedactedTable t, OutputStream out) throws IOException {
        ObjectMapper compact = new ObjectMapper().disable(JsonGenerator.Feature.AUTO_CLOSE_TARGET);
        for (String[] r : t.rows()) {
            compact.writeValue(out, record(t.columns(), r));
            out.write('\n');
        }
    }

    static ObjectNode record(List<OutColumn> cols, String[] r) {
        ObjectNode o = NF.objectNode();
        for (int i = 0; i < cols.size(); i++) {
            String v = r[i];
            String k = cols.get(i).name();
            if (v == null) { o.putNull(k); continue; }
            try {
                switch (cols.get(i).type()) {
                    case INTEGER -> o.put(k, new BigInteger(v.startsWith("+") ? v.substring(1) : v));
                    case DECIMAL -> o.put(k, new BigDecimal(v));
                    case BOOLEAN -> o.put(k, bool(v));
                    default -> o.put(k, v);
                }
            } catch (NumberFormatException e) {
                o.put(k, v);
            }
        }
        return o;
    }

    static boolean bool(String v) {
        String s = v.toLowerCase(Locale.ROOT);
        return s.equals("true") || s.equals("yes");
    }

    // ---------- Excel ----------

    static void xlsx(RedactedTable t, OutputStream out) throws IOException {
        try (SXSSFWorkbook wb = new SXSSFWorkbook(500)) {
            Font bold = wb.createFont();
            bold.setBold(true);
            CellStyle head = wb.createCellStyle();
            head.setFont(bold);
            CellStyle date = wb.createCellStyle();
            date.setDataFormat(wb.getCreationHelper().createDataFormat().getFormat("yyyy-mm-dd"));
            CellStyle dateTime = wb.createCellStyle();
            dateTime.setDataFormat(wb.getCreationHelper().createDataFormat().getFormat("yyyy-mm-dd hh:mm:ss"));

            SXSSFSheet data = wb.createSheet("data");
            data.trackAllColumnsForAutoSizing();
            Row hr = data.createRow(0);
            for (int i = 0; i < t.columns().size(); i++) {
                Cell c = hr.createCell(i);
                c.setCellValue(t.columns().get(i).name());
                c.setCellStyle(head);
            }
            data.createFreezePane(0, 1);
            int rn = 1;
            for (String[] r : t.rows()) {
                Row row = data.createRow(rn++);
                for (int i = 0; i < r.length; i++) {
                    if (r[i] == null) continue;
                    Cell c = row.createCell(i);
                    ColumnType type = t.columns().get(i).type();
                    try {
                        switch (type) {
                            case INTEGER, DECIMAL -> c.setCellValue(new BigDecimal(r[i]).doubleValue());
                            case BOOLEAN -> c.setCellValue(bool(r[i]));
                            case DATE -> { c.setCellValue(LocalDate.parse(r[i])); c.setCellStyle(date); }
                            case DATETIME -> {
                                String s = r[i].replace(' ', 'T');
                                if (s.endsWith("Z")) s = s.substring(0, s.length() - 1);
                                c.setCellValue(LocalDateTime.parse(s));
                                c.setCellStyle(dateTime);
                            }
                            default -> c.setCellValue(r[i]);
                        }
                    } catch (RuntimeException e) {
                        c.setCellValue(r[i]);
                    }
                }
            }
            for (int i = 0; i < Math.min(t.columns().size(), 50); i++) {
                data.autoSizeColumn(i);
                data.setColumnWidth(i, Math.min(data.getColumnWidth(i) + 512, 60 * 256));
            }

            Sheet dict = wb.createSheet("data_dictionary");
            String[] dh = {"column", "type", "description", "original column", "treatment", "flagged as", "non-empty", "distinct", "GDPR category"};
            Row dr = dict.createRow(0);
            for (int i = 0; i < dh.length; i++) { Cell c = dr.createCell(i); c.setCellValue(dh[i]); c.setCellStyle(head); }
            int dn = 1;
            for (OutColumn c : t.columns()) {
                Row row = dict.createRow(dn++);
                row.createCell(0).setCellValue(c.name());
                row.createCell(1).setCellValue(c.type().frictionless());
                row.createCell(2).setCellValue(c.description());
                row.createCell(3).setCellValue(c.originalName());
                row.createCell(4).setCellValue(Documentation.treatment(c));
                row.createCell(5).setCellValue(c.piiCategory() == null ? "" : c.piiCategory());
                row.createCell(6).setCellValue(c.nonNull());
                row.createCell(7).setCellValue(c.distinct());
                row.createCell(8).setCellValue(c.special() == null ? "" : c.special().tag());
            }

            Sheet gs = wb.createSheet("gdpr");
            tablescrub.redact.GdprAssessment g = t.gdpr();
            int gn = 0;
            Row gr = gs.createRow(gn++);
            gr.createCell(0).setCellValue("status");
            gr.createCell(1).setCellValue(g.status().label + ". " + g.summary());
            for (String f : g.findings()) { Row r = gs.createRow(gn++); r.createCell(0).setCellValue("finding"); r.createCell(1).setCellValue(f); }
            for (String c : g.checklist()) { Row r = gs.createRow(gn++); r.createCell(0).setCellValue("checklist"); r.createCell(1).setCellValue(c); }
            Row disc = gs.createRow(gn);
            disc.createCell(0).setCellValue("note");
            disc.createCell(1).setCellValue(tablescrub.redact.GdprAssessment.DISCLAIMER);
            gs.setColumnWidth(0, 12 * 256);
            gs.setColumnWidth(1, 120 * 256);

            Sheet prov = wb.createSheet("provenance");
            int pn = 0;
            for (String[] kv : Documentation.provenancePairs(t)) {
                Row row = prov.createRow(pn++);
                row.createCell(0).setCellValue(kv[0]);
                row.createCell(1).setCellValue(kv[1]);
            }
            pn++;
            Row lh = prov.createRow(pn++);
            Cell lc = lh.createCell(0);
            lc.setCellValue("Redaction log");
            lc.setCellStyle(head);
            for (String l : t.log()) prov.createRow(pn++).createCell(0).setCellValue(l);
            wb.write(out);
            wb.dispose();
        }
    }

    // ---------- SQL ----------

    static void sql(RedactedTable t, OutputStream out) throws IOException {
        Writer w = new OutputStreamWriter(out, StandardCharsets.UTF_8);
        String table = ident(Documentation.slug(t.name()).replace('-', '_'));
        w.write("-- " + t.name() + "\n-- Generated by tablescrub. Redaction log:\n");
        for (String l : t.log()) w.write("--   " + l.replace("\n", " ") + "\n");
        w.write("\nCREATE TABLE " + table + " (\n");
        for (int i = 0; i < t.columns().size(); i++) {
            OutColumn c = t.columns().get(i);
            w.write("  " + ident(c.name()) + " " + sqlType(c.type()) + (i < t.columns().size() - 1 ? ",\n" : "\n"));
        }
        w.write(");\n\n");
        String cols = String.join(", ", t.columns().stream().map(c -> ident(c.name())).toList());
        int batch = 0;
        for (String[] r : t.rows()) {
            if (batch == 0) w.write("INSERT INTO " + table + " (" + cols + ") VALUES\n  ");
            else w.write(",\n  ");
            w.write("(");
            for (int i = 0; i < r.length; i++) {
                if (i > 0) w.write(", ");
                w.write(sqlLiteral(r[i], t.columns().get(i).type()));
            }
            w.write(")");
            if (++batch == 500) { w.write(";\n"); batch = 0; }
        }
        if (batch > 0) w.write(";\n");
        w.flush();
    }

    static String ident(String s) { return "\"" + s.replace("\"", "\"\"") + "\""; }

    static String sqlType(ColumnType t) {
        return switch (t) {
            case INTEGER -> "BIGINT";
            case DECIMAL -> "NUMERIC";
            case BOOLEAN -> "BOOLEAN";
            case DATE -> "DATE";
            case DATETIME -> "TIMESTAMP";
            default -> "TEXT";
        };
    }

    static String sqlLiteral(String v, ColumnType t) {
        if (v == null) return "NULL";
        return switch (t) {
            case INTEGER, DECIMAL -> v.matches("[-+]?[0-9.eE+-]+") ? v : "'" + v.replace("'", "''") + "'";
            case BOOLEAN -> bool(v) ? "TRUE" : "FALSE";
            case DATE -> "DATE '" + v.replace("'", "''") + "'";
            case DATETIME -> "TIMESTAMP '" + v.replace('T', ' ').replace("Z", "").replace("'", "''") + "'";
            default -> "'" + v.replace("'", "''") + "'";
        };
    }

    // ---------- HTML ----------

    static void html(RedactedTable t, OutputStream out) throws IOException {
        Writer w = new OutputStreamWriter(out, StandardCharsets.UTF_8);
        w.write("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>" + esc(t.name()) + "</title>\n"
                + "<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#1d2433}table{border-collapse:collapse;font-size:14px}"
                + "th,td{border:1px solid #d5d9e2;padding:4px 8px;text-align:left}th{background:#f2f4f8}"
                + "td.num{text-align:right;font-variant-numeric:tabular-nums}.null{color:#9aa3b5}</style></head><body>\n");
        w.write("<h1>" + esc(t.name()) + "</h1>\n");
        if (t.plan().description() != null && !t.plan().description().isBlank())
            w.write("<p>" + esc(t.plan().description()) + "</p>\n");
        w.write("<h2>Provenance</h2><table>");
        for (String[] kv : Documentation.provenancePairs(t))
            w.write("<tr><th>" + esc(kv[0]) + "</th><td>" + esc(kv[1]) + "</td></tr>");
        w.write("</table>\n<h2>Data dictionary</h2><table><tr><th>Column</th><th>Type</th><th>Description</th><th>Treatment</th></tr>");
        for (OutColumn c : t.columns())
            w.write("<tr><td>" + esc(c.name()) + "</td><td>" + c.type().frictionless() + "</td><td>" + esc(c.description())
                    + "</td><td>" + esc(Documentation.treatment(c)) + "</td></tr>");
        w.write("</table>\n");
        tablescrub.redact.GdprAssessment g = t.gdpr();
        w.write("<h2>GDPR notes</h2><p><b>" + esc(g.status().label) + ".</b> " + esc(g.summary()) + "</p><ul>");
        for (String f : g.findings()) w.write("<li>" + esc(f) + "</li>");
        w.write("</ul><p><small>" + esc(tablescrub.redact.GdprAssessment.DISCLAIMER) + "</small></p>\n");
        if (!t.log().isEmpty()) {
            w.write("<h2>Redaction log</h2><ul>");
            for (String l : t.log()) w.write("<li>" + esc(l) + "</li>");
            w.write("</ul>\n");
        }
        w.write("<h2>Data (" + t.rows().size() + " rows)</h2><table><thead><tr>");
        for (OutColumn c : t.columns()) w.write("<th>" + esc(c.name()) + "</th>");
        w.write("</tr></thead><tbody>\n");
        for (String[] r : t.rows()) {
            w.write("<tr>");
            for (int i = 0; i < r.length; i++) {
                boolean num = t.columns().get(i).type().numeric();
                w.write(r[i] == null ? "<td class=\"null\"></td>" : (num ? "<td class=\"num\">" : "<td>") + esc(r[i]) + "</td>");
            }
            w.write("</tr>\n");
        }
        w.write("</tbody></table></body></html>\n");
        w.flush();
    }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    // ---------- Markdown for LLMs ----------

    static void markdown(RedactedTable t, OutputStream out) throws IOException {
        Writer w = new OutputStreamWriter(out, StandardCharsets.UTF_8);
        w.write(Documentation.readme(t, false));
        w.write("\n## Data\n\n" + t.rows().size() + " rows, CSV (RFC 4180). Empty field = missing value.\n\n```csv\n");
        w.flush();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        delimited(t, buf, CSVFormat.RFC4180.builder().setRecordSeparator("\n").get());
        out.write(buf.toByteArray());
        w.write("```\n");
        w.flush();
    }

    // ---------- Frictionless Data Package ----------

    static void dataPackage(RedactedTable t, OutputStream out) throws IOException {
        ZipOutputStream zip = new ZipOutputStream(out);
        zip.putNextEntry(new ZipEntry("datapackage.json"));
        MAPPER.writeValue(zip, Documentation.dataPackage(t));
        zip.closeEntry();
        zip.putNextEntry(new ZipEntry("data.csv"));
        csv(t, zip);
        zip.closeEntry();
        zip.putNextEntry(new ZipEntry("README.md"));
        zip.write(Documentation.readme(t, true).getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
        zip.finish();
    }
}
