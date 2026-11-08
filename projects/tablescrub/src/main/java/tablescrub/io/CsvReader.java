package tablescrub.io;

import org.apache.commons.csv.CSVFormat;
import org.apache.commons.csv.CSVParser;
import org.apache.commons.csv.CSVRecord;
import tablescrub.model.RawTable;

import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Delimited text reader. Sniffs the encoding (BOM, strict UTF-8, Windows-1252 fallback)
 * and the delimiter (comma, semicolon, tab, pipe). When the delimiter is not a comma,
 * columns written with a decimal comma ("3,14") are normalised to "3.14".
 */
public class CsvReader implements TableReader {
    private static final char[] CANDIDATES = {',', ';', '\t', '|'};
    private static final Pattern DECIMAL_COMMA = Pattern.compile("-?\\d+,\\d+");

    @Override
    public List<RawTable> read(String filename, byte[] data, ReadOptions options) throws IOException {
        List<String> warnings = new ArrayList<>();
        String text = decode(data, warnings);
        char delimiter = sniffDelimiter(text);
        String fmt = switch (delimiter) {
            case '\t' -> "tsv";
            case ';' -> "csv (semicolon)";
            case '|' -> "csv (pipe)";
            default -> "csv";
        };
        CSVFormat format = CSVFormat.RFC4180.builder()
                .setDelimiter(delimiter)
                .setIgnoreEmptyLines(true)
                .setTrim(true)
                .get();
        List<String> headers = null;
        List<String[]> rows = new ArrayList<>();
        try (CSVParser parser = CSVParser.parse(new StringReader(text), format)) {
            for (CSVRecord rec : parser) {
                if (headers == null) {
                    headers = new ArrayList<>();
                    for (String h : rec) headers.add(h);
                    if (headers.size() > options.maxColumns())
                        throw new IOException("Too many columns (" + headers.size() + " > " + options.maxColumns() + ")");
                    continue;
                }
                if (rows.size() >= options.maxRows()) {
                    warnings.add("Row limit reached; only the first " + options.maxRows() + " rows were loaded.");
                    break;
                }
                String[] row = new String[rec.size()];
                for (int i = 0; i < rec.size(); i++) row[i] = rec.get(i);
                rows.add(row);
            }
        } catch (java.io.UncheckedIOException e) {
            throw new IOException("Could not parse delimited text: " + e.getCause().getMessage(), e);
        }
        if (headers == null) throw new IOException("No rows found in " + filename);
        if (delimiter != ',') normaliseDecimalComma(headers.size(), rows);
        return List.of(new RawTable(baseName(filename), fmt, headers, rows, warnings));
    }

    static String decode(byte[] data, List<String> warnings) {
        if (data.length >= 3 && (data[0] & 0xff) == 0xEF && (data[1] & 0xff) == 0xBB && (data[2] & 0xff) == 0xBF)
            return new String(data, 3, data.length - 3, StandardCharsets.UTF_8);
        if (data.length >= 2 && (data[0] & 0xff) == 0xFF && (data[1] & 0xff) == 0xFE)
            return new String(data, 2, data.length - 2, StandardCharsets.UTF_16LE);
        if (data.length >= 2 && (data[0] & 0xff) == 0xFE && (data[1] & 0xff) == 0xFF)
            return new String(data, 2, data.length - 2, StandardCharsets.UTF_16BE);
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data)).toString();
        } catch (CharacterCodingException e) {
            warnings.add("File is not valid UTF-8; decoded as Windows-1252. Check special characters.");
            return new String(data, Charset.forName("windows-1252"));
        }
    }

    /** Chooses the candidate whose per-line count is most consistent over the first lines. */
    static char sniffDelimiter(String text) {
        List<String> lines = new ArrayList<>();
        int start = 0;
        while (lines.size() < 30 && start < text.length()) {
            int nl = text.indexOf('\n', start);
            if (nl < 0) nl = text.length();
            String line = text.substring(start, nl).strip();
            if (!line.isEmpty()) lines.add(line);
            start = nl + 1;
        }
        char best = ',';
        double bestScore = 0;
        for (char c : CANDIDATES) {
            int[] counts = lines.stream().mapToInt(l -> countOutsideQuotes(l, c)).toArray();
            if (counts.length == 0 || counts[0] == 0) continue;
            int first = counts[0];
            long consistent = java.util.Arrays.stream(counts).filter(x -> x == first).count();
            double score = (double) consistent / counts.length * 1000 + first;
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
        return best;
    }

    private static int countOutsideQuotes(String line, char c) {
        boolean quoted = false;
        int n = 0;
        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            if (ch == '"') quoted = !quoted;
            else if (ch == c && !quoted) n++;
        }
        return n;
    }

    private static void normaliseDecimalComma(int width, List<String[]> rows) {
        for (int col = 0; col < width; col++) {
            boolean any = false, all = true;
            for (String[] r : rows) {
                if (col >= r.length || r[col] == null || r[col].isEmpty()) continue;
                if (DECIMAL_COMMA.matcher(r[col]).matches()) any = true;
                else { all = false; break; }
            }
            if (any && all) {
                for (String[] r : rows)
                    if (col < r.length && r[col] != null) r[col] = r[col].replace(',', '.');
            }
        }
    }

    static String baseName(String filename) {
        if (filename == null || filename.isBlank()) return "table";
        String n = filename.replaceAll(".*[/\\\\]", "");
        int dot = n.lastIndexOf('.');
        return dot > 0 ? n.substring(0, dot) : n;
    }
}
