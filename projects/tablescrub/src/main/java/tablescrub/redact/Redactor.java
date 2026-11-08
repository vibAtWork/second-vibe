package tablescrub.redact;

import tablescrub.model.Column;
import tablescrub.model.ColumnType;
import tablescrub.model.Table;
import tablescrub.redact.RedactedTable.KStats;
import tablescrub.redact.RedactedTable.OutColumn;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Applies a {@link Plan} to a {@link Table}. Pure function: the input is never modified. */
public final class Redactor {
    public static final String RARE = "[RARE]";

    private Redactor() {}

    public static RedactedTable apply(Table table, Plan plan) {
        return apply(table, plan, Integer.MAX_VALUE);
    }

    /**
     * @param rowLimit only transform the first rowLimit rows (for previews); statistics such as
     *                 rare-value counts and k-anonymity are still computed over the whole table.
     */
    public static RedactedTable apply(Table table, Plan plan, int rowLimit) {
        List<Column> cols = table.columns();
        int n = cols.size();
        List<String> log = new ArrayList<>();
        Transformer[] tx = new Transformer[n];
        List<Integer> kept = new ArrayList<>();
        for (int c = 0; c < n; c++) {
            ColumnRule rule = plan.rule(c);
            if (rule.action() == Action.DROP) {
                log.add("Dropped column \"" + cols.get(c).name() + "\".");
                continue;
            }
            kept.add(c);
            tx[c] = transformer(table, c, rule, plan.secret(), log);
        }

        // Transform all rows (needed for correct k-anonymity), materialise only what is asked for.
        List<Integer> qi = kept.stream().filter(c -> plan.rule(c).quasiIdentifier()).toList();
        List<String[]> transformed = new ArrayList<>(table.rowCount());
        for (String[] src : table.rows()) {
            String[] out = new String[n];
            for (int c : kept) out[c] = tx[c].apply(src[c]);
            transformed.add(out);
        }

        Map<List<String>, Integer> classes = new HashMap<>();
        if (!qi.isEmpty()) for (String[] r : transformed) classes.merge(key(r, qi), 1, Integer::sum);
        int threshold = Math.max(1, plan.kThreshold());
        int minK = classes.values().stream().mapToInt(Integer::intValue).min().orElse(0);
        int classesBelow = (int) classes.values().stream().filter(v -> v < threshold).count();
        int rowsBelow = classes.values().stream().filter(v -> v < threshold).mapToInt(Integer::intValue).sum();

        int suppressed = 0;
        List<String[]> rows = new ArrayList<>();
        List<String[]> output = new ArrayList<>(transformed.size());
        for (String[] r : transformed) {
            if (!qi.isEmpty() && plan.suppressRows() && classes.get(key(r, qi)) < threshold) {
                suppressed++;
                continue;
            }
            output.add(r);
            if (rows.size() < rowLimit) {
                String[] out = new String[kept.size()];
                for (int i = 0; i < kept.size(); i++) out[i] = r[kept.get(i)];
                rows.add(out);
            }
        }
        if (suppressed > 0)
            log.add("Suppressed " + suppressed + " row(s) whose quasi-identifier combination occurred fewer than "
                    + threshold + " times.");
        int effectiveK = minK;
        if (plan.suppressRows() && !qi.isEmpty())
            effectiveK = classes.values().stream().filter(v -> v >= threshold).mapToInt(Integer::intValue).min().orElse(0);
        KStats kStats = new KStats(qi.stream().map(c -> cols.get(c).name()).toList(), effectiveK, classes.size(),
                classesBelow, rowsBelow, threshold, suppressed);

        List<OutColumn> outCols = new ArrayList<>();
        java.util.Set<String> usedNames = new java.util.HashSet<>();
        for (int i = 0; i < kept.size(); i++) {
            int c = kept.get(i);
            Column col = cols.get(c);
            ColumnRule rule = plan.rule(c);
            int nonNull = 0;
            java.util.Set<String> distinct = new java.util.HashSet<>();
            for (String[] r : output) if (r[c] != null) { nonNull++; if (distinct.size() < 100_000) distinct.add(r[c]); }
            String base = rule.rename().isBlank() ? col.name() : rule.rename().strip();
            String name = base;
            for (int s = 2; !usedNames.add(name.toLowerCase(Locale.ROOT)); s++) name = base + "_" + s;
            outCols.add(new OutColumn(name, col.name(), tx[c].outType, rule.action(), rule.param(),
                    rule.description(), col.pii().category(), col.pii().level(), col.special(), nonNull, distinct.size()));
        }
        List<RedactedTable.DroppedColumn> dropped = new ArrayList<>();
        for (int c = 0; c < n; c++)
            if (plan.rule(c).action() == Action.DROP)
                dropped.add(new RedactedTable.DroppedColumn(cols.get(c).name(), cols.get(c).pii().category(), cols.get(c).special()));
        String title = plan.title() == null || plan.title().isBlank() ? table.name() : plan.title().strip();
        return new RedactedTable(title, table.name(), table.sourceFormat(), table.rowCount(), outCols, dropped, rows, log,
                kStats, plan);
    }

    private static List<String> key(String[] r, List<Integer> qi) {
        String[] k = new String[qi.size()];
        for (int i = 0; i < k.length; i++) k[i] = r[qi.get(i)];
        return Arrays.asList(k);
    }

    /** A per-column value function with its resulting output type. */
    private static final class Transformer {
        final java.util.function.UnaryOperator<String> fn;
        final ColumnType outType;

        Transformer(java.util.function.UnaryOperator<String> fn, ColumnType outType) {
            this.fn = fn;
            this.outType = outType;
        }

        String apply(String v) { return v == null ? null : fn.apply(v); }
    }

    private static Transformer transformer(Table table, int c, ColumnRule rule, byte[] secret, List<String> log) {
        Column col = table.columns().get(c);
        String name = col.name();
        String p = rule.param().strip();
        ColumnType type = col.type();
        return switch (rule.action()) {
            case KEEP, DROP -> new Transformer(v -> v, type);
            case MASK -> {
                String repl = p.isEmpty() ? "[REDACTED]" : p;
                log.add("Masked \"" + name + "\": every non-empty value replaced with \"" + repl + "\".");
                yield new Transformer(v -> repl, ColumnType.STRING);
            }
            case HASH -> {
                int len = clamp(parseInt(p, 16), 8, 64);
                log.add("Pseudonymised \"" + name + "\" with keyed HMAC-SHA256 (" + len
                        + " hex chars). The key is held by the data owner and is not part of this export.");
                Mac mac = hmac(secret);
                yield new Transformer(v -> {
                    synchronized (mac) {
                        return HexFormat.of().formatHex(mac.doFinal(v.getBytes(StandardCharsets.UTF_8))).substring(0, len);
                    }
                }, ColumnType.STRING);
            }
            case PSEUDONYM -> {
                String prefix = p.isEmpty() ? "ID-" : p;
                Map<String, String> ids = new HashMap<>();
                int width = Math.max(4, String.valueOf(col.distinct()).length());
                // Assign in order of first appearance over the whole table so previews match exports.
                for (String[] r : table.rows())
                    if (r[c] != null) ids.computeIfAbsent(r[c], k -> prefix + String.format("%0" + width + "d", ids.size() + 1));
                log.add("Replaced \"" + name + "\" with sequential pseudonyms (" + prefix + "…). The mapping is not exported.");
                yield new Transformer(ids::get, ColumnType.STRING);
            }
            case GENERALIZE -> generalize(col, p, log);
            case SUPPRESS_RARE -> {
                int k = Math.max(2, parseInt(p, 5));
                Map<String, Integer> counts = new HashMap<>();
                for (String[] r : table.rows()) if (r[c] != null) counts.merge(r[c], 1, Integer::sum);
                long rare = counts.values().stream().filter(x -> x < k).count();
                log.add("Suppressed rare values in \"" + name + "\": " + rare + " distinct value(s) occurring fewer than "
                        + k + " times replaced with " + RARE + ".");
                yield new Transformer(v -> counts.get(v) < k ? RARE : v, rare > 0 ? ColumnType.STRING : type);
            }
            case ROUND -> {
                if (!type.numeric()) {
                    log.add("Round requested for non-numeric column \"" + name + "\"; values kept unchanged.");
                    yield new Transformer(v -> v, type);
                }
                int digits = clamp(parseInt(p, 0), -9, 9);
                log.add("Rounded \"" + name + "\" to " + (digits >= 0 ? digits + " decimal(s)." : "the nearest " + BigDecimal.TEN.pow(-digits) + "."));
                yield new Transformer(v -> new BigDecimal(v).setScale(digits, RoundingMode.HALF_UP).stripTrailingZeros()
                        .toPlainString(), digits <= 0 ? ColumnType.INTEGER : ColumnType.DECIMAL);
            }
        };
    }

    private static Transformer generalize(Column col, String p, List<String> log) {
        String name = col.name();
        switch (col.type()) {
            case DATE, DATETIME -> {
                String unit = p.isEmpty() ? "year" : p.toLowerCase(Locale.ROOT);
                return switch (unit) {
                    case "month" -> {
                        log.add("Generalised \"" + name + "\" to year-month (YYYY-MM).");
                        yield new Transformer(v -> v.substring(0, 7), ColumnType.STRING);
                    }
                    case "decade" -> {
                        log.add("Generalised \"" + name + "\" to decade.");
                        yield new Transformer(v -> v.substring(0, 3) + "0s", ColumnType.STRING);
                    }
                    default -> {
                        log.add("Generalised \"" + name + "\" to year.");
                        yield new Transformer(v -> v.substring(0, 4), ColumnType.INTEGER);
                    }
                };
            }
            case INTEGER, DECIMAL -> {
                BigDecimal width = parseDecimal(p, BigDecimal.TEN);
                if (width.signum() <= 0) width = BigDecimal.TEN;
                final BigDecimal w = width;
                boolean intBins = col.type() == ColumnType.INTEGER && w.stripTrailingZeros().scale() <= 0;
                log.add("Generalised \"" + name + "\" into bins of width " + w.toPlainString() + ".");
                return new Transformer(v -> {
                    BigDecimal x = new BigDecimal(v);
                    BigDecimal lo = x.divide(w, 0, RoundingMode.FLOOR).multiply(w);
                    BigDecimal hi = lo.add(w);
                    if (intBins) return lo.toBigInteger() + "-" + hi.subtract(BigDecimal.ONE).toBigInteger();
                    return "[" + lo.stripTrailingZeros().toPlainString() + ", " + hi.stripTrailingZeros().toPlainString() + ")";
                }, ColumnType.STRING);
            }
            case BOOLEAN, EMPTY -> {
                log.add("Generalize has no effect on \"" + name + "\" (" + col.type() + "); values kept.");
                return new Transformer(v -> v, col.type());
            }
            default -> {
                int keep = Math.max(0, parseInt(p, 2));
                log.add("Generalised \"" + name + "\": kept first " + keep + " character(s), rest replaced with *.");
                return new Transformer(v -> v.length() <= keep ? v : v.substring(0, keep) + "*".repeat(Math.min(v.length() - keep, 8)),
                        ColumnType.STRING);
            }
        }
    }

    static Mac hmac(byte[] secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static int parseInt(String s, int dflt) {
        try { return s == null || s.isBlank() ? dflt : Integer.parseInt(s.strip()); }
        catch (NumberFormatException e) { return dflt; }
    }

    static BigDecimal parseDecimal(String s, BigDecimal dflt) {
        try { return s == null || s.isBlank() ? dflt : new BigDecimal(s.strip()); }
        catch (NumberFormatException e) { return dflt; }
    }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }
}
