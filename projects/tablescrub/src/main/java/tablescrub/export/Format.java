package tablescrub.export;

import tablescrub.redact.RedactedTable;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/** All output formats, each re-created from the common intermediate representation. */
public enum Format {
    CSV("csv", "CSV", "csv", "text/csv; charset=utf-8", "Comma separated, UTF-8, RFC 4180", Writers::csv),
    TSV("tsv", "TSV", "tsv", "text/tab-separated-values; charset=utf-8", "Tab separated, UTF-8", Writers::tsv),
    XLSX("xlsx", "Excel", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Typed cells + data dictionary + provenance sheets", Writers::xlsx),
    JSON("json", "JSON", "json", "application/json", "Typed records with schema and provenance", Writers::json),
    JSONL("jsonl", "JSON Lines", "jsonl", "application/x-ndjson", "One typed JSON object per line", Writers::jsonl),
    SQL("sql", "SQL", "sql", "application/sql; charset=utf-8", "CREATE TABLE + INSERT statements (ANSI SQL)", Writers::sql),
    HTML("html", "HTML", "html", "text/html; charset=utf-8", "Standalone page with dictionary and table", Writers::html),
    MARKDOWN("md", "Markdown for AI", "md", "text/markdown; charset=utf-8",
            "Context + data dictionary + CSV block: paste straight into an LLM chat", Writers::markdown),
    DATAPACKAGE("datapackage", "Data Package (zip)", "zip", "application/zip",
            "Frictionless Data Package: datapackage.json + data.csv + README.md", Writers::dataPackage);

    @FunctionalInterface
    public interface Writer { void write(RedactedTable t, OutputStream out) throws IOException; }

    public final String id;
    public final String label;
    public final String extension;
    public final String mime;
    public final String help;
    private final Writer writer;

    Format(String id, String label, String extension, String mime, String help, Writer writer) {
        this.id = id;
        this.label = label;
        this.extension = extension;
        this.mime = mime;
        this.help = help;
        this.writer = writer;
    }

    public void write(RedactedTable t, OutputStream out) throws IOException { writer.write(t, out); }

    public static Optional<Format> byId(String id) {
        return Arrays.stream(values()).filter(f -> f.id.equalsIgnoreCase(id == null ? "" : id.strip())).findFirst();
    }

    public static List<Format> all() { return List.of(values()); }
}
