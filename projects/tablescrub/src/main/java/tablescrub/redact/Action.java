package tablescrub.redact;

/** What to do with one column. */
public enum Action {
    KEEP("Keep", "Leave values unchanged"),
    DROP("Drop", "Remove the column entirely"),
    MASK("Mask", "Replace every value with a fixed text (param: replacement, default [REDACTED])"),
    HASH("Keyed hash", "HMAC-SHA256 pseudonym; same input gives same output, so records stay linkable (param: hex length, default 16)"),
    PSEUDONYM("Pseudonym", "Sequential IDs in order of first appearance (param: prefix, default ID-)"),
    GENERALIZE("Generalize", "Dates: year|month|decade. Numbers: bin width (default 10). Text: keep first N chars (default 2)"),
    SUPPRESS_RARE("Suppress rare", "Replace values seen fewer than k times with [RARE] (param: k, default 5)"),
    ROUND("Round", "Round numbers to N decimals; negative N rounds to tens/hundreds (param: N, default 0)");

    public final String label;
    public final String help;

    Action(String label, String help) {
        this.label = label;
        this.help = help;
    }

    public static Action parse(String s) {
        if (s == null || s.isBlank()) return KEEP;
        try {
            return valueOf(s.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return KEEP;
        }
    }
}
