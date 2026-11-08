package tablescrub.model;

/**
 * Result of the sensitive-data heuristics for one column.
 *
 * @param category   short label such as "email" or "national id"; null when nothing was found
 * @param reason     human readable explanation of why it was flagged
 * @param level      DIRECT (identifies a person on its own), QUASI (identifies in combination) or NONE
 * @param suggestion the redaction action the UI pre-selects
 */
public record PiiHint(String category, String reason, Level level, String suggestion) {

    public enum Level { NONE, QUASI, DIRECT }

    public static final PiiHint NONE = new PiiHint(null, null, Level.NONE, "KEEP");

    public boolean flagged() {
        return level != Level.NONE;
    }
}
