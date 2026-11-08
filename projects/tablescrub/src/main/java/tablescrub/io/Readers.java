package tablescrub.io;

import tablescrub.model.RawTable;

import java.io.IOException;
import java.util.List;
import java.util.Locale;

/** Picks a reader by file extension, falling back to content sniffing. */
public final class Readers {
    private Readers() {}

    public static final List<String> SUPPORTED = List.of(
            ".csv", ".tsv", ".tab", ".txt", ".xlsx", ".xlsm", ".xls", ".json", ".jsonl", ".ndjson");

    public static List<RawTable> read(String filename, byte[] data, ReadOptions options) throws IOException {
        if (data.length == 0) throw new UnsupportedFormatException("The file is empty.");
        return pick(filename, data).read(filename, data, options);
    }

    static TableReader pick(String filename, byte[] data) throws UnsupportedFormatException {
        String lower = filename == null ? "" : filename.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) return new ExcelReader();
        if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return new JsonReader(true);
        if (lower.endsWith(".json")) return new JsonReader(false);
        if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".tab") || lower.endsWith(".txt")) return new CsvReader();
        // Unknown extension: sniff the content.
        if (data.length >= 4 && data[0] == 'P' && data[1] == 'K') return new ExcelReader();
        if (data.length >= 4 && (data[0] & 0xff) == 0xD0 && (data[1] & 0xff) == 0xCF) return new ExcelReader();
        int i = 0;
        if (data.length >= 3 && (data[0] & 0xff) == 0xEF) i = 3;
        while (i < data.length && Character.isWhitespace(data[i])) i++;
        if (i < data.length && data[i] == '[') return new JsonReader(false);
        if (i < data.length && data[i] == '{') {
            String head = new String(data, i, Math.min(data.length - i, 64 * 1024), java.nio.charset.StandardCharsets.UTF_8);
            return head.contains("}\n{") || head.contains("}\r\n{") ? new JsonReader(true) : new JsonReader(false);
        }
        if (looksLikeText(data)) return new CsvReader();
        throw new UnsupportedFormatException("Unrecognised file format. Supported: " + String.join(", ", SUPPORTED));
    }

    private static boolean looksLikeText(byte[] data) {
        int n = Math.min(data.length, 4096), bad = 0;
        for (int i = 0; i < n; i++) {
            int b = data[i] & 0xff;
            if (b == 0) return false;
            if (b < 9 || (b > 13 && b < 32)) bad++;
        }
        return bad < n / 100 + 1;
    }
}
