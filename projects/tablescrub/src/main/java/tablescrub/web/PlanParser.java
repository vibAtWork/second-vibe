package tablescrub.web;

import com.fasterxml.jackson.databind.JsonNode;
import tablescrub.model.Column;
import tablescrub.model.PiiHint;
import tablescrub.model.Table;
import tablescrub.redact.Action;
import tablescrub.redact.ColumnRule;
import tablescrub.redact.Plan;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Builds a {@link Plan} from HTML form fields, from JSON (API) or from the detector's suggestions. */
public final class PlanParser {
    private PlanParser() {}

    public static final int DEFAULT_K = 5;

    /** Rules pre-filled from PII hints: direct identifiers get their suggested action, quasi ones are marked QI. */
    public static List<ColumnRule> suggested(Table t) {
        List<ColumnRule> out = new ArrayList<>();
        for (Column c : t.columns()) out.add(suggested(c));
        return out;
    }

    static ColumnRule suggested(Column c) {
        PiiHint h = c.pii();
        if (!h.flagged()) return ColumnRule.KEEP;
        // Unique record identifiers are pseudonymised, never used as quasi-identifiers (they would force k = 1).
        boolean qi = h.level() == PiiHint.Level.QUASI && !"record identifier".equals(h.category());
        return new ColumnRule(Action.parse(h.suggestion()), defaultParam(c, Action.parse(h.suggestion())), qi, "", "");
    }

    static String defaultParam(Column c, Action a) {
        if (a != Action.GENERALIZE) return "";
        String cat = c.pii().category();
        if ("age".equals(cat)) return "5";
        if ("postal code".equals(cat)) return c.type().numeric() ? "100" : "2";
        if ("geolocation".equals(cat)) return "1";
        return switch (c.type()) {
            case DATE, DATETIME -> "year";
            default -> "";
        };
    }

    public static List<ColumnRule> keepAll(Table t) {
        List<ColumnRule> out = new ArrayList<>();
        for (int i = 0; i < t.columnCount(); i++) out.add(ColumnRule.KEEP);
        return out;
    }

    public static Plan fromForm(Map<String, List<String>> f, Table t, byte[] defaultSecret) {
        List<ColumnRule> rules = new ArrayList<>();
        for (int i = 0; i < t.columnCount(); i++) {
            rules.add(new ColumnRule(Action.parse(first(f, "a" + i)), first(f, "p" + i),
                    f.containsKey("q" + i), first(f, "d" + i), first(f, "n" + i)));
        }
        return new Plan(rules, secret(first(f, "secret"), defaultSecret), parseK(first(f, "k")),
                f.containsKey("suppress"), first(f, "title"), first(f, "description"), first(f, "license"),
                tablescrub.redact.Recipient.parse(first(f, "recipient")));
    }

    /**
     * API plan, e.g. {"auto":true,"k":5,"columns":{"email":{"action":"DROP"},"age":{"action":"GENERALIZE","param":"10","qi":true}}}.
     * With "auto": true, columns not listed get the detector's suggestion; otherwise they are kept.
     */
    public static Plan fromJson(JsonNode n, Table t, byte[] defaultSecret) {
        boolean auto = n.path("auto").asBoolean(false);
        JsonNode cols = n.path("columns");
        List<ColumnRule> rules = new ArrayList<>();
        for (Column c : t.columns()) {
            JsonNode r = cols.path(c.name());
            if (r.isMissingNode()) {
                rules.add(auto ? suggested(c) : ColumnRule.KEEP);
            } else if (r.isTextual()) {
                rules.add(new ColumnRule(Action.parse(r.asText()), "", false, "", ""));
            } else {
                rules.add(new ColumnRule(Action.parse(r.path("action").asText("KEEP")), r.path("param").asText(""),
                        r.path("qi").asBoolean(false), r.path("description").asText(""), r.path("rename").asText("")));
            }
        }
        return new Plan(rules, secret(n.path("secret").asText(""), defaultSecret),
                n.path("k").asInt(DEFAULT_K), n.path("suppressRows").asBoolean(false),
                n.path("title").asText(""), n.path("description").asText(""), n.path("license").asText(""),
                tablescrub.redact.Recipient.parse(n.path("recipient").asText("")));
    }

    static byte[] secret(String userSecret, byte[] dflt) {
        return userSecret == null || userSecret.isBlank() ? dflt : userSecret.getBytes(StandardCharsets.UTF_8);
    }

    static int parseK(String s) {
        try { return s == null || s.isBlank() ? DEFAULT_K : Math.max(1, Math.min(1000, Integer.parseInt(s.strip()))); }
        catch (NumberFormatException e) { return DEFAULT_K; }
    }

    private static String first(Map<String, List<String>> f, String key) {
        List<String> v = f.get(key);
        return v == null || v.isEmpty() ? "" : v.getFirst();
    }
}
