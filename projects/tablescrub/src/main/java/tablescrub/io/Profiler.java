package tablescrub.io;

import tablescrub.model.Column;
import tablescrub.model.ColumnType;
import tablescrub.model.PiiHint;
import tablescrub.model.RawTable;
import tablescrub.model.Table;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Turns a {@link RawTable} into the normalised {@link Table}: cleans headers, squares
 * ragged rows, converts blanks to null, infers column types and runs PII detection.
 */
public final class Profiler {
    private static final int DISTINCT_CAP = 100_000;
    private static final Pattern INT = Pattern.compile("[-+]?\\d+");
    private static final Pattern DEC = Pattern.compile("[-+]?(\\d+\\.\\d*|\\.\\d+|\\d+)([eE][-+]?\\d+)?");
    private static final Set<String> NULLS = Set.of("", "na", "n/a", "null", "nan", "none", "#n/a", "-", "nil");
    private static final Set<String> BOOLS = Set.of("true", "false", "yes", "no");

    private Profiler() {}

    public static Table profile(RawTable raw) {
        List<String> warnings = new ArrayList<>(raw.warnings());
        List<String> headers = cleanHeaders(raw.headers(), raw.rows(), warnings);
        int width = headers.size();
        int ragged = 0;
        List<String[]> rows = new ArrayList<>(raw.rows().size());
        for (String[] r : raw.rows()) {
            if (r.length != width) ragged++;
            String[] row = new String[width];
            for (int i = 0; i < width && i < r.length; i++) row[i] = normaliseNull(r[i]);
            rows.add(row);
        }
        if (ragged > 0)
            warnings.add(ragged + " row(s) had a different number of cells than the header and were padded/truncated.");

        List<Column> columns = new ArrayList<>(width);
        for (int c = 0; c < width; c++) columns.add(profileColumn(c, headers.get(c), rows));
        return new Table(raw.name(), raw.sourceFormat(), columns, rows, warnings);
    }

    static String normaliseNull(String v) {
        if (v == null) return null;
        String s = v.strip();
        return NULLS.contains(s.toLowerCase(Locale.ROOT)) ? null : s;
    }

    static List<String> cleanHeaders(List<String> raw, List<String[]> rows, List<String> warnings) {
        int width = raw.size();
        for (String[] r : rows) width = Math.max(width, r.length);
        List<String> out = new ArrayList<>(width);
        Map<String, Integer> seen = new HashMap<>();
        boolean renamed = false;
        for (int i = 0; i < width; i++) {
            String h = i < raw.size() && raw.get(i) != null ? raw.get(i).strip().replaceAll("\\s+", " ") : "";
            if (h.isEmpty()) { h = "column_" + (i + 1); renamed = true; }
            String key = h.toLowerCase(Locale.ROOT);
            int n = seen.merge(key, 1, Integer::sum);
            if (n > 1) { h = h + "_" + n; renamed = true; }
            out.add(h);
        }
        if (renamed) warnings.add("Some headers were empty or duplicated and have been renamed.");
        return out;
    }

    static Column profileColumn(int idx, String name, List<String[]> rows) {
        int nonNull = 0;
        Set<String> distinct = new HashSet<>();
        boolean capped = false;
        LinkedHashSet<String> samples = new LinkedHashSet<>();
        boolean isBool = true, isInt = true, isDec = true, isDate = true, isDateTime = true;
        BigDecimal minN = null, maxN = null;
        String minS = null, maxS = null;
        for (String[] r : rows) {
            String v = r[idx];
            if (v == null) continue;
            nonNull++;
            if (!capped) {
                distinct.add(v);
                if (distinct.size() >= DISTINCT_CAP) capped = true;
            }
            if (samples.size() < 5) samples.add(v);
            String lower = v.toLowerCase(Locale.ROOT);
            if (isBool && !BOOLS.contains(lower)) isBool = false;
            if (isInt && (!INT.matcher(v).matches() || hasLeadingZero(v))) isInt = false;
            if (isDec && (!DEC.matcher(v).matches() || hasLeadingZero(v))) isDec = false;
            if (isDate && !isIsoDate(v)) isDate = false;
            if (isDateTime && !isIsoDateTime(v)) isDateTime = false;
            if (isDec) {
                BigDecimal d = new BigDecimal(v);
                if (minN == null || d.compareTo(minN) < 0) minN = d;
                if (maxN == null || d.compareTo(maxN) > 0) maxN = d;
            }
            if (minS == null || v.compareTo(minS) < 0) minS = v;
            if (maxS == null || v.compareTo(maxS) > 0) maxS = v;
        }
        ColumnType type;
        if (nonNull == 0) type = ColumnType.EMPTY;
        else if (isBool) type = ColumnType.BOOLEAN;
        else if (isInt) type = ColumnType.INTEGER;
        else if (isDec) type = ColumnType.DECIMAL;
        else if (isDate) type = ColumnType.DATE;
        else if (isDateTime || (isDate || allDateOrDateTime(rows, idx))) type = ColumnType.DATETIME;
        else type = ColumnType.STRING;

        String min = null, max = null;
        if (type.numeric()) { min = minN.toPlainString(); max = maxN.toPlainString(); }
        else if (type == ColumnType.DATE || type == ColumnType.DATETIME) { min = minS; max = maxS; }

        if (type == ColumnType.BOOLEAN) {
            // Normalise yes/no, TRUE/False... to canonical true/false in the IR.
            for (String[] r : rows) if (r[idx] != null) r[idx] = Boolean.toString(r[idx].equalsIgnoreCase("true") || r[idx].equalsIgnoreCase("yes"));
            samples = new LinkedHashSet<>();
            distinct.clear();
            for (String[] r : rows) if (r[idx] != null) { distinct.add(r[idx]); if (samples.size() < 5) samples.add(r[idx]); }
        }
        Column provisional = new Column(idx, name, type, nonNull, distinct.size(), capped,
                List.copyOf(samples), min, max, PiiHint.NONE);
        PiiHint hint = PiiDetector.detect(provisional, rows);
        return new Column(idx, name, type, nonNull, distinct.size(), capped, List.copyOf(samples), min, max, hint);
    }

    private static boolean allDateOrDateTime(List<String[]> rows, int idx) {
        boolean any = false;
        for (String[] r : rows) {
            String v = r[idx];
            if (v == null) continue;
            if (!isIsoDate(v) && !isIsoDateTime(v)) return false;
            any = true;
        }
        return any;
    }

    /** "007" or "0123" are identifiers/codes, not numbers – keep them as text. */
    private static boolean hasLeadingZero(String v) {
        String s = v.startsWith("-") || v.startsWith("+") ? v.substring(1) : v;
        return s.length() > 1 && s.charAt(0) == '0' && Character.isDigit(s.charAt(1));
    }

    static boolean isIsoDate(String v) {
        if (v.length() != 10 || v.charAt(4) != '-') return false;
        try { LocalDate.parse(v); return true; } catch (DateTimeParseException e) { return false; }
    }

    static boolean isIsoDateTime(String v) {
        if (v.length() < 16 || v.charAt(4) != '-') return false;
        String s = v.replace(' ', 'T');
        if (s.endsWith("Z")) s = s.substring(0, s.length() - 1);
        try { LocalDateTime.parse(s); return true; } catch (DateTimeParseException e) { return false; }
    }
}
